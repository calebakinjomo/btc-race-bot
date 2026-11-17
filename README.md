# V-Recovery — a cbBTC/USDC bounce trader

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/calebakinjomo/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/calebakinjomo/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A trading bot for make.fun's **"Race a BTC trading bot live for 24 hours"**
(`btc-race-24h-20261117-0603`) bounty. It trades Coinbase Wrapped BTC
(cbBTC) against USDC, minute by minute, in the `agent-fun/bars-replay/v1`
replay. It starts with 1,000 USDC of paper money, goes long only, and holds
at most one position.

## The strategy

BTC spends most of a day chopping sideways, and every round trip costs
roughly 35 bps in fees, slippage and price impact — so chasing every wiggle
loses. This bot waits for a real washout and buys the bounce:

- **V entry (full size):** the 60-minute return is below **-85 bps** and the
  15-minute return has turned back up above **+12 bps**. It buys ~all of the
  cash (99.9%).
- **Exits:** take profit **+250 bps** from the entry fill, trailing stop
  **90 bps** under the best close since entry, hard stop **-50 bps**, max
  hold **360 bars** (6 hours).
- **Fallback (quarter size):** if no trade has filled by bar 1350, it buys
  25% on a dip of **-40 bps** under the 60-bar average, so a quiet window
  never ends with zero trades. Exits: +80 / trailing 40 / stop -40 / max
  hold 60 bars.
- **Drawdown guard:** if equity falls under 92% of its peak, it flattens at
  once and stays out for 120 bars.

Everything is deterministic: every decision comes from the bars the harness
sends — no clock, no environment, no randomness — so two runs on the same
data produce byte-identical action logs.

## Dev-window result

Graded locally with the kit's grader on the frozen 24-hour dev window
(1,440 one-minute bars):

- **Net PnL: +$21.76 USDC** (2 round trips, both winners)
- **Max drawdown: 1.32%** (guardrail: 25%)
- **Trades: 2** (buy 393 → sell 543, +107 bps; buy 579 → sell 939, +126 bps)

The dev gate needs net PnL above 0; this clears it with margin.

## Layout

- `main.ts` — the bot (Node 22, stdlib only). Speaks the replay protocol
  through the vendored SDK shim.
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-for-byte (excluded
  from authorship counts by the competition's rules).

## Grade it

From inside the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-bot --driver process
```

(The process driver runs the Node bot directly; Docker does not run on this
machine, so `--driver docker` is not usable here.)

---

<sub>Entered on [make.fun](https://make.fun/?ref=hdavhdvz&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
