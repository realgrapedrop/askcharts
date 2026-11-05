# Quick start

AskCharts works like TradingView. If you've used that, most of this will feel familiar. If you haven't,
here's the screen, then the things everyone does first.

## The screen

- **Top bar**, left to right: the AskCharts logo, the symbol, the interval, the chart type, Indicators,
  Compare, the layout (one chart or several), Replay and Alert. On the right: your layout's name, chart
  image and data downloads, Settings (the gear), light or dark, and a dot that's green when data is live.
- **Left:** the drawing tools. Each button is a group; the small arrow beside it opens the rest.
- **The chart** in the middle. Indicators like RSI and MACD get their own panes underneath. Drag the line
  between two panes to make one taller.
- **Right:** a column of buttons that open panels: the watchlist, alerts, the object tree, then the robot
  (AskCharts AI) and the other tools. The round grid button at the bottom lists everything.
- **Bottom:** the date ranges (1D, 5D, 1M and so on) and the clock, then tabs: Strategy tester, Screener,
  Heatmap, Seasonals, Financials, Paper trading and Indicator editor.

## First things

1. **Pick a symbol.** Click the symbol at the top left, or just start typing on the chart: `BTC`, `AAPL`,
   `EURUSD`. Tabs in the search filter by type: crypto, stocks, forex and more.
2. **Change the interval.** Click the interval (like `1D`), or type a number on the chart: `5` for 5
   minutes, `4h`, `1D`.
3. **Move around.** Scroll to zoom, drag to pan. Drag the price scale on the right to stretch it.
   Double-click a pane to make it fill the chart, and again to put it back.
4. **Add an indicator.** Indicators, then search or browse: Technicals for the usual ones, On chain for
   the XRP Ledger, and Editors' picks, Top, Trending and Marketplace for community scripts. Click one to add
   it. Its settings are behind the gear in its row at the top left of the chart.
5. **Draw.** Pick a tool on the left, then click on the chart. Click a drawing to change its colour or
   style, drag it to move it, or drag one of its handles to reshape it.
6. **Set an alert.** Alert in the top bar, or the plus on the price scale at your crosshair. Alerts pop up
   in the app and can play a sound.
7. **Your layout is kept.** Autosave is on, so changes are saved as you go. The name at the top right has
   Save (Ctrl or Cmd + S), Rename, New and Open, for keeping more than one.

## Ask AskCharts AI

Click the robot on the right. The first time, it asks for your AI key: Settings (the gear), AskCharts AI,
pick the provider, paste the key, press Test, pick a model, Ok. Then type what you want, in your own words:

- "Show me Ethereum on the 1 hour chart with Bollinger Bands"
- "Put Bitcoin, Ethereum and Solana side by side"
- "Mark support and resistance on this chart"
- "What does RSI say right now?"
- "How do I compare two symbols?"
- "Find a strategy for XRP"

Each change it makes shows as a step with Undo. If you'd rather it ask before every change, tick "Ask
before each change" in Settings, AskCharts AI.

## Practice without risk

- **Bar replay:** Replay in the top bar, click the bar to start from, then play it forward and trade it
  as if it were live.
- **Paper trading:** the Paper trading tab under the chart, or the SELL and BUY buttons at the top left
  of the chart. It's practice money.
- **Strategy tester:** add a strategy from Indicators (they have a small spark by their name) and the
  Strategy tester tab shows how it would have done: profit, drawdown, every trade. If you don't have a strategy
  yet, click the script's name at the top of the Pine Editor and pick Strategy from a template… under Create new.
  There are eight to add and they need no key, or you can describe one in the empty Strategy tester's box and
  AskCharts AI builds it.

## More data

- **Stock history** (Settings, Stock data): years of 1-minute bars for US stocks and ETFs, the whole market's
  trades since 2016, with a free Alpaca key. About 85 MB and under a minute a stock.
- **Kraken history** (Settings, Crypto data): years of Kraken's own bars for KRAKEN charts and longer
  backtests. The first download is about 10 GB.
- **Binance history** (Settings, Crypto data): Binance's own bars for BINANCE charts, from each coin's first
  month on Binance, every file checked. About 400 MB and two minutes for a coin traded since 2017.
- **XRPL On chain** (Settings, On chain data): the XRP Ledger's activity for the indicators under
  Indicators, On chain. Following the ledger through a public server is about 15 GB of downloads a day.

All four start off, and nothing big downloads until you turn it on.

- **Your own data keys (optional):** if you have an Alpaca or Polygon (now Massive) account, paste its key in
  Settings, Stock data and press Save and check. AskCharts asks the provider first and only saves a key
  it accepts. Later, the same place checks, replaces or removes it.

## Where your things are

Everything you make (layouts, watchlists, alerts, indicators, settings) is kept in the `data` folder of
your AskCharts folder (`~/AskCharts/data` on a Mac or Linux, `AskCharts\data` in your user folder on
Windows). Updating AskCharts never touches it. Back that folder up and you've backed up AskCharts.
