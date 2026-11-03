# Local API: drive Quant Terminal from your own code

Everything the app does goes through a small HTTP API on your own computer, so your scripts can use it too: pull bars and quotes, run backtests with the quant checks, and set alerts that call your webhook. Working examples in Python and Rust are in [`examples/`](../examples).

- **Address:** `http://127.0.0.1:3777` (or the port `npm start` printed). `PORT=4000 npm start` picks one.
- **This computer only.** The server answers requests addressed to `localhost` or `127.0.0.1`.
- **Writes need one header.** Every `POST`, `PUT`, `PATCH` and `DELETE` carries `x-qt: 1`. Reads need nothing.
- **JSON in and out.** Errors come back as `{ "error": "..." }` with a 4xx or 5xx status.
- **Times** are Unix seconds (UTC). Symbols are `EXCHANGE:TICKER` like the app's search (`BINANCE:BTCUSDT`, `US:AAPL`, `FX:EURUSD`, `CME:NQ1!`), and plain tickers (`btc`, `aapl`) are resolved for you.
- **Timeframes:** `1m`, `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`, and custom ones like `7m`, `2h`, `3D`.

The API reads data and runs research. Placing real orders isn't part of it.

## Market data

| Request | Returns |
|---|---|
| `GET /api/health` | `{ ok, version, providers, feeds, alerts }`: is it running, which sources answer, which of your own keys are set |
| `GET /api/resolve?symbol=btc` | `{ id, exchange, ticker }`: what a typed symbol means |
| `GET /api/search?q=apple` | Up to 30 `{ symbol, name, type, exchange }` matches |
| `GET /api/candles?symbol=BTCUSDT&tf=1h&limit=500` | `{ symbol, tf, provider, candles: [{ time, open, high, low, close, volume }], notes }`, oldest first. `limit` is 10 to 20000 (default 1500) |
| `GET /api/quotes?symbols=BTCUSDT,AAPL` | `{ "BINANCE:BTCUSDT": { price, changePct, volume }, ... }`, up to 200 symbols |
| `GET /api/screener?universe=crypto` | Screener rows for `crypto`, `stocks` or `etf` |
| `GET /api/calendar` | This week's economic events |
| `GET /api/earnings?days=5`, `GET /api/dividends?days=5` | US earnings and dividends for the next trading days |
| `GET /api/news?symbol=AAPL` | Headlines |
| `GET /api/indicators` | Every indicator id with its inputs (key, type, default) and output keys |
| `GET /api/financials?symbol=AAPL&frequency=annual` | Income statement, balance sheet, cash flow and ratios |

`provider` and `notes` say where the bars came from (and whether they're delayed), the same text the chart shows.

## Backtests

`POST /api/backtest` runs the strategy tester on the server. The strategy is the same JSON the tester's "Edit as JSON" shows (the README's Strategy format section):

```json
{
  "symbol": "BTCUSDT",
  "tf": "1D",
  "limit": 1500,
  "strategy": {
    "indicators": { "fast": { "id": "ema", "params": { "length": 9 } }, "slow": { "id": "ema", "params": { "length": 21 } } },
    "entryLong": [{ "left": "fast", "op": "crossesAbove", "right": "slow" }],
    "exitLong": [{ "left": "fast", "op": "crossesBelow", "right": "slow" }],
    "feePct": 0.1, "slippagePct": 0.05
  },
  "quantChecks": true,
  "equity": false
}
```

It returns `{ symbol, tf, provider, bars, from, to, stats, trades }`:

- `stats`: `netProfitPct`, `buyHoldPct`, `maxDrawdownPct`, `totalTrades`, `winRatePct`, `profitFactor`, `sharpe`, `sortino`, `avgTradePct`, `exposurePct` and more.
- `trades`: `[{ side, entryTime, exitTime, entryPrice, exitPrice, pnlPct, bars, entryReason, exitReason }]`.
- `equity` (when you send `"equity": true`): `[{ time, value }]` per bar.
- `quantChecks` (when you send `"quantChecks": true`): `{ passed, total, gates: [{ label, value, pass }], walkForward, monteCarlo }`. The same walk-forward, overfitting, deflated Sharpe, cost stress, nearby settings and Monte Carlo checks as the tester's gold box.

`POST /api/scan` checks rules on the latest bar of many symbols at once: `{ symbols: [...], tf, indicators, rules: [{ left, op, right }] }` returns `[{ symbol, pass, passes, close }]`.

Indicator ids are the built-in ones (`ema`, `rsi`, `macd`, `bb`...) and your own (`custom:<file name>`). `GET /api/indicators` lists every one with its inputs and outputs.

## Your own data files

| Request | Does |
|---|---|
| `POST /api/import/bars?name=NAME` | Body: an OHLCV CSV. Saves it and returns `{ symbol: "CSV:NAME", bars, tf, from, to }`. Chart or backtest it as `CSV:NAME` on its own timeframe or longer |
| `POST /api/import/signal?name=NAME` | Body: a `time, position` CSV (1, 0, -1). Returns `{ id, strategy }`: send that `strategy` to `/api/backtest` with the bars it was made on |
| `GET /api/imports` | Your imported bar files |

The README's "Your own data files" section has the column and time formats.

## Alerts and webhooks

Alerts run inside the app every 15 seconds, as long as it's running.

| Request | Does |
|---|---|
| `GET /api/alerts` | Lists alerts |
| `POST /api/alerts` | Adds one (body below) and returns it with its `id` |
| `PATCH /api/alerts/<id>` | Changes fields, e.g. `{ "active": false }` |
| `DELETE /api/alerts/<id>` | Deletes it |
| `GET /api/alerts/log` | The last 500 times an alert fired |
| `POST /api/alerts/check` | Checks every alert now instead of waiting |
| `GET /api/events` | A live stream (server-sent events) with an `alert` event each time one fires |

```json
{
  "symbol": "BINANCE:BTCUSDT", "tf": "1h",
  "conditions": [{ "left": "close", "op": "crossesAbove", "right": 100000 }],
  "match": "all",
  "indicators": {},
  "trigger": "oncePerBarClose",
  "webhook": "https://your-server.example/hook",
  "message": "BTC closed above 100k"
}
```

- `op`: `>`, `<`, `>=`, `<=`, `crossesAbove`, `crossesBelow`, `crosses`. Up to 5 conditions; `match` is `all` or `any`.
- `trigger`: `once` (then it switches off), `oncePerBar` or `oncePerBarClose`.
- `watchlist`: send the name of one of your watchlists instead of `symbol` and the alert checks every symbol on it. `once` then means once per symbol, and the alert stops when every symbol on the list has fired. Each event's `symbol` says which one fired. To turn a list's alert into one symbol's, `PATCH` it with `watchlist: null` and the `symbol`.
- `webhook`: when it fires, the app POSTs JSON to this URL. Discord, Slack and Telegram URLs get their own message format; any other URL gets `{ text, alert, event }`, where `event` is `{ alertId, symbol, tf, text, price, barTime, at }`. That's the hook for your own code: point it at a small server of yours and act on the alert there.
