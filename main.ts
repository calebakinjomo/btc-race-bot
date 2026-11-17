// V-Recovery: a sharp-dip bounce trader for cbBTC/USDC, 1-minute bars.
//
// The idea, in one sentence: BTC spends most of a day chopping sideways, so
// chasing every wiggle pays the ~35 bps round-trip cost and loses; instead this
// bot waits for a real washout — price down more than ~0.85% in the last hour —
// and only buys once the tape turns back up (+0.12% in the last 15 minutes),
// then rides the recovery with a trailing stop and gets out after 6 hours at
// the latest. It trades rarely (1-2 times a day on the dev window) and lets
// the big, rare recoveries pay for the quiet hours.
//
// Entries
//   V (full size): 60-minute return below -85 bps AND 15-minute return above
//   +12 bps. Buys ~all of the cash (99.9%, a hair under the cap).
//   Fallback (quarter size): if no trade has filled by bar 1350, buy 25% on a
//   dip of -40 bps under the 60-bar average, so the bot never ends a window
//   with zero trades. On the dev window this never fires.
// Exits (V trade)
//   Take profit +250 bps from the entry fill, trailing stop 90 bps under the
//   best close since entry, hard stop -50 bps, max hold 360 bars.
//   Fallback trade: take profit +80, trailing stop 40, hard stop -40, max
//   hold 60 bars.
// Safety
//   Drawdown guard: if equity falls under 92% of its peak, flatten at once
//   and stay out for 120 bars.
// Determinism: every decision comes from the bars the harness sent; no clock,
// no environment, no randomness. Two runs on the same data decide identically.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MS_MIN = 60_000n;
const BPS = 10_000n;

// Entry thresholds (basis points).
const V_DROP_BPS = -85n; // 60-minute return must be below this
const V_KICK_BPS = 12n; // 15-minute return must be above this
const FALLBACK_BAR = 1350; // no filled trade by this bar: take the small fallback
const FALLBACK_DIP_BPS = -40n; // dip under the 60-bar average for the fallback

// Exit thresholds (basis points, measured from the entry fill price).
const V_TP_BPS = 250n;
const V_TRAIL_BPS = 90n;
const V_SL_BPS = -50n;
const V_MAX_HOLD = 360;
const FB_TP_BPS = 80n;
const FB_TRAIL_BPS = 40n;
const FB_SL_BPS = -40n;
const FB_MAX_HOLD = 60;

// Drawdown guard: flatten below this share of the equity peak, then cool off.
const GUARD_BPS = 9_200n; // 92.00%
const GUARD_COOLDOWN = 120;

const MAX_SLIPPAGE_BPS = 200;

// Scales for CBBTC/USDC (read from hello at runtime; these are the fallbacks
// used only to turn a position's cost back into a price).
const QTY_SCALE = 8n;
const PRICE_SCALE = 5n;
const QUOTE_SCALE = 6n;

interface ClosePoint {
  t: number;
  c: bigint;
}

function bpsOf(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (numerator * BPS) / denominator;
}

// ---- run state (one execution = one process, so module state is the run) --
const hist: ClosePoint[] = [];
let inPos = false;
let kind: 'V' | 'F' = 'V';
let pendingKind: 'V' | 'F' = 'V';
let entryPrice = 0n; // the true average fill price (from the position's cost)
let peakClose = 0n;
let held = 0;
let everTraded = false;
let eqPeak = 0n;
let coolUntil = -1;

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const now = bar.t;

    // ---- history ---------------------------------------------------------
    hist.push({ t: now, c: close });
    const n = hist.length;

    // 60-bar average of closes (by count; robust to a missing bar or two).
    let smaSum = 0n;
    const smaLen = Math.min(60, n);
    for (let i = n - smaLen; i < n; i++) smaSum += hist[i]!.c;
    const sma60 = smaLen > 0 ? smaSum / BigInt(smaLen) : close;

    // Close a fixed time back (the bar at or just before that time).
    const closeBack = (msAgo: bigint): bigint | null => {
      const target = BigInt(now) - msAgo;
      for (let i = n - 1; i >= 0; i--) {
        if (BigInt(hist[i]!.t) <= target) return hist[i]!.c;
      }
      return null;
    };
    const c60 = closeBack(60n * MS_MIN);
    const c15 = closeBack(15n * MS_MIN);
    const r60 = c60 === null ? null : bpsOf(close - c60, c60);
    const r15 = c15 === null ? null : bpsOf(close - c15, c15);

    // ---- reconcile with the real account ---------------------------------
    // Fills land a bar after the decision, so the account is the truth about
    // whether a position is open; the entry price comes from its cost.
    const pos = state.positions.get(SYMBOL);
    const havePos = pos !== undefined && pos.qty > 0n;
    if (havePos && !inPos) {
      inPos = true;
      kind = pendingKind;
      // price = cost * 10^(qty+price scales) / (qty * 10^quote scale).
      // state.positions holds { qty, cost } as bigints, not the wire shape.
      entryPrice =
        (pos.cost * 10n ** (QTY_SCALE + PRICE_SCALE)) /
        (pos.qty * 10n ** QUOTE_SCALE);
      peakClose = close;
      held = 0;
      everTraded = true;
    }
    if (!havePos && inPos) inPos = false;

    if (havePos && inPos) {
      if (close > peakClose) peakClose = close;
      held += 1;
    }
    if (eqPeak === 0n) eqPeak = state.equity;
    if (state.equity > eqPeak) eqPeak = state.equity;

    const orders: OrderInput[] = [];
    const flat = (): void => {
      if (havePos) {
        orders.push({
          side: 'sell',
          symbol: SYMBOL,
          qty: pos!.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    };

    // ---- drawdown guard --------------------------------------------------
    if (havePos && inPos && state.equity < (eqPeak * GUARD_BPS) / BPS) {
      flat();
      inPos = false;
      coolUntil = n + GUARD_COOLDOWN;
      return orders;
    }

    // ---- exits -----------------------------------------------------------
    if (havePos && inPos) {
      const ret = bpsOf(close - entryPrice, entryPrice);
      const dd = bpsOf(peakClose - close, peakClose);
      const tp = kind === 'V' ? V_TP_BPS : FB_TP_BPS;
      const trail = kind === 'V' ? V_TRAIL_BPS : FB_TRAIL_BPS;
      const sl = kind === 'V' ? V_SL_BPS : FB_SL_BPS;
      const maxHold = kind === 'V' ? V_MAX_HOLD : FB_MAX_HOLD;
      if (ret >= tp || dd >= trail || ret <= sl || held >= maxHold) {
        flat();
        inPos = false;
        return orders;
      }
      return orders;
    }

    // ---- entries ---------------------------------------------------------
    if (n <= coolUntil) return orders;
    if (r60 !== null && r15 !== null && r60 < V_DROP_BPS && r15 > V_KICK_BPS) {
      // V entry: buy ~all the cash.
      const spend = (state.cash * 999n) / 1000n;
      if (spend >= 1_000_000n) {
        pendingKind = 'V';
        orders.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: spend,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
      return orders;
    }
    if (!everTraded && n >= FALLBACK_BAR) {
      const dip = bpsOf(close - sma60, sma60);
      if (dip < FALLBACK_DIP_BPS) {
        const spend = state.cash / 4n;
        if (spend >= 1_000_000n) {
          pendingKind = 'F';
          orders.push({
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: spend,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
    }
    return orders;
  },
});
