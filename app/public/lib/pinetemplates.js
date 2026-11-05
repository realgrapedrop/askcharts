// Ready-made Pine strategies for the Pine Editor's Create new menu (no AI key needed), and the kinds of
// strategy the AI's research tries on a symbol. Each is standard Pine v6 that also runs on TradingView.
// They trade all of the account (100% of equity from 10,000), so returns read as real percentages, and
// the two numbers that define each one come first: the quant checks vary the first two number inputs.
// The fee is filled in for the chart: 0.1% a trade on a crypto exchange, 0 elsewhere (a US stock broker
// with no commission).

export const CRYPTO_EXCHANGES = ["BINANCE", "COINBASE", "KRAKEN"];
export const feeFor = (symbol) => (CRYPTO_EXCHANGES.includes(String(symbol || "").split(":")[0]) ? 0.1 : 0);

const head = (name, about, fee) => `//@version=6
// ${name}: ${about}
// A template from AskCharts. Every number below is a setting you can change from the strategy's Settings
// on the chart. Past results don't promise future ones.
strategy("${name}", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100, commission_type=strategy.commission.percent, commission_value=${fee})
// The fee: ${fee ? `${fee}% of each trade, typical on a crypto exchange. A US stock broker with no commission: 0.` : "0, as at a US stock broker with no commission. On a crypto exchange, 0.1 is typical."}
`;

// a trend strategy's way in and out: long on the signal up, and short too when that's switched on
const trendOrders = (up, down) => `
if ${up}
    strategy.entry("Long", strategy.long)
if ${down}
    if allowShort
        strategy.entry("Short", strategy.short)
    else
        strategy.close("Long")
`;

export const TEMPLATES = [
  {
    id: "ma-cross",
    name: "Moving average cross",
    kind: "Trend",
    about: "buys when a fast moving average crosses above a slow one, and sells when it crosses back below.",
    body: `fastLen = input.int(20, "Fast average length", minval=2)
slowLen = input.int(50, "Slow average length", minval=2)
allowShort = input.bool(false, "Also trade short")

fast = ta.ema(close, fastLen)
slow = ta.sma(close, slowLen)
plot(fast, "Fast average", color=color.orange)
plot(slow, "Slow average", color=color.blue)
${trendOrders("ta.crossover(fast, slow)", "ta.crossunder(fast, slow)")}`,
  },
  {
    id: "macd-cross",
    name: "MACD cross",
    kind: "Trend",
    about: "buys when the MACD line crosses above its signal line, and sells when it crosses back below.",
    body: `fastLen = input.int(12, "Fast length", minval=2)
slowLen = input.int(26, "Slow length", minval=2)
signalLen = input.int(9, "Signal length", minval=1)
allowShort = input.bool(false, "Also trade short")

[macdLine, signalLine, hist] = ta.macd(close, fastLen, slowLen, signalLen)
${trendOrders("ta.crossover(macdLine, signalLine)", "ta.crossunder(macdLine, signalLine)")}`,
  },
  {
    id: "supertrend",
    name: "Supertrend",
    kind: "Trend",
    about: "buys when the Supertrend line flips below the price, and sells when it flips back above.",
    body: `atrLen = input.int(10, "ATR length", minval=1)
factor = input.float(3.0, "Factor", minval=0.5, step=0.5)
allowShort = input.bool(false, "Also trade short")

[line, dir] = ta.supertrend(factor, atrLen)
plot(line, "Supertrend", color=dir < 0 ? color.green : color.red)
// dir is -1 while the trend is up, as on TradingView
${trendOrders("ta.change(dir) < 0", "ta.change(dir) > 0")}`,
  },
  {
    id: "channel-breakout",
    name: "Channel breakout",
    kind: "Breakout",
    about: "buys when the price closes above its highest high of recent bars, and sells when it closes below a shorter low.",
    body: `entryLen = input.int(20, "Breakout length (bars)", minval=2)
exitLen = input.int(10, "Exit length (bars)", minval=2)

top = ta.highest(high, entryLen)[1]
bottom = ta.lowest(low, exitLen)[1]
plot(top, "Breakout level", color=color.green)
plot(bottom, "Exit level", color=color.red)

if close > top
    strategy.entry("Long", strategy.long)
if close < bottom
    strategy.close("Long")
`,
  },
  {
    id: "rsi-bounce",
    name: "RSI bounce",
    kind: "Bounce",
    about: "buys when RSI climbs back out of oversold, and sells when it reaches overbought.",
    body: `rsiLen = input.int(14, "RSI length", minval=2)
buyLevel = input.int(30, "Buy when RSI rises back above", minval=1, maxval=99)
sellLevel = input.int(70, "Sell when RSI reaches", minval=1, maxval=99)

r = ta.rsi(close, rsiLen)

if ta.crossover(r, buyLevel)
    strategy.entry("Long", strategy.long)
if ta.crossover(r, sellLevel)
    strategy.close("Long")
`,
  },
  {
    id: "bollinger-bounce",
    name: "Bollinger bounce",
    kind: "Bounce",
    about: "buys when the price closes back inside the lower Bollinger band, and sells at the middle line.",
    body: `len = input.int(20, "Length", minval=2)
mult = input.float(2.0, "Width (standard deviations)", minval=0.5, step=0.5)

[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "Middle line", color=color.orange)
plot(upper, "Upper band", color=color.blue)
plot(lower, "Lower band", color=color.blue)

if ta.crossover(close, lower)
    strategy.entry("Long", strategy.long)
if close >= basis
    strategy.close("Long")
`,
  },
  {
    id: "trend-pullback",
    name: "Pullback in an uptrend",
    kind: "Bounce",
    about: "buys a short dip while the price is above its long average, and sells when it closes above a short average.",
    body: `trendLen = input.int(200, "Trend average length", minval=2)
dipLevel = input.int(10, "Buy when short RSI falls under", minval=1, maxval=99)
rsiLen = input.int(2, "Short RSI length", minval=1)
exitLen = input.int(5, "Exit average length", minval=1)

trend = ta.sma(close, trendLen)
exitLine = ta.sma(close, exitLen)
r = ta.rsi(close, rsiLen)
plot(trend, "Trend average", color=color.blue)

if close > trend and r < dipLevel
    strategy.entry("Long", strategy.long)
if close > exitLine
    strategy.close("Long")
`,
  },
  {
    id: "momentum",
    name: "Momentum",
    kind: "Momentum",
    about: "buys when the price is up on recent bars and above its average, and sells when it turns down.",
    body: `rocLen = input.int(20, "Momentum length (bars)", minval=1)
trendLen = input.int(50, "Trend average length", minval=2)

roc = ta.roc(close, rocLen)
trend = ta.sma(close, trendLen)
plot(trend, "Trend average", color=color.blue)

if ta.crossover(roc, 0) and close > trend
    strategy.entry("Long", strategy.long)
if ta.crossunder(roc, 0)
    strategy.close("Long")
`,
  },
];

// A template's whole script, with the fee for `symbol` (or a fee given).
export function templateCode(t, { symbol, fee } = {}) {
  return head(t.name, t.about, fee ?? feeFor(symbol)) + "\n" + t.body;
}
