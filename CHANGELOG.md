# Changelog

## 0.1.25 (2026-11-05)

AskCharts AI can now write Pine strategies, backtest them and look for one that suits a coin or a stock. It puts its
own results through the quant checks before it shows you anything, and the eight strategy templates work without an
AI key.

- You can ask something like "Find a strategy for XRP" or "Which indicators work best on BTC on the 4 hour?". The AI
  then tests eight kinds of strategy on the 1 hour, 4 hour and daily charts, with a range of settings for each one.
  It looks at the last 2 years and trades long only unless you say otherwise. The settings are picked on the first
  70% of the bars and scored once on the last 30%, which they never saw. Fees are on too, 0.1% a side for crypto and
  none for US stocks unless you name one. The answer compares the pick with buy and hold and says how many versions
  it tried. It also says what the interval means for how long a trade lasts, and offers to test shorts. If nothing
  holds up it says so, and it never promises a profit.
- Or describe the strategy you want, like "Build me a strategy that buys when RSI crosses up through 30 and sells at
  70". The AI writes it in standard Pine v6, checks that it runs and fixes its own errors, then saves it to My
  scripts, puts it on the chart and opens its report. The card it leaves in the chat has Open in Pine Editor,
  Strategy tester and Show the code, and Undo takes the script back off the chart and out of My scripts. Answers can
  end with next steps to click, like Put it on the chart or Test long and short too. You need an AI key for both of
  these, in Settings, AskCharts AI.
- Pine strategies get a third view in the strategy report called Quant checks, behind the shield next to Metrics and
  List of trades. It runs the script again with nearby values of two of its number settings (you pick which), and
  once more with double the fees. That gives Pine the checks rule strategies already had. They're walk forward, the
  odds the best settings were luck (PBO), the deflated Sharpe ratio, a cost stress test, Monte Carlo on the trades
  and whether nearby settings hold up.
- There's a new quant check as well, 3 months at a time, and it works on Pine and rule strategies alike. It puts the
  strategy beside buy and hold in each 3 month stretch and passes when the strategy made money in at least 60% of
  them. With fewer than 4 stretches it's left out.
- Eight strategies come ready to use, and none of them need an AI key. Click the script's name at the top of the
  Pine Editor and you'll find Strategy from a template… under Create new. The list has Moving average cross, MACD
  cross, Supertrend, Channel breakout, RSI bounce, Bollinger bounce, Pullback in an uptrend and Momentum, each
  explained in plain words. One click saves it to My scripts, adds it to the chart and opens its report, and each
  one trades the whole account with the chart's fee filled in. The three trend ones can trade short too.
- Write with AI…, also under Create new, opens AskCharts AI ready for your description, and the empty Strategy
  tester has a box where you can describe a strategy in plain words. On a Pine strategy's report the menu on its
  name lists the strategies on the chart, then Build a strategy for me and Pick the rules myself.
- When you rename a script with Rename… in the Pine Editor, the new name shows straight away in the Indicators
  dialog and its search, and on the strategy report and its menu. The chart's legend still shows the title from the
  code, with its settings.
- Pine runs more scripts now. It handles several statements on one line split by commas, `type` as a name,
  `ta.percentile_nearest_rank`, more `str.` functions and `runtime.error`. It also has the `strategy.opentrades.`
  details (entry price, bar and time, size, profit and more). `syminfo.description` works, and so do
  `chart.bg_color` and `chart.fg_color`, which come from your theme. Of the 512 community scripts in my test set,
  320 run now where 284 did before.
- A table in an AI answer used to come out as lines of `|`, and now it shows as a table.
- The AI's backtests run in the app server, two at a time, and each one gets its own worker with a 512 MB and 90
  second limit. The interpreter reads Pine one step at a time and never turns it into JavaScript. On a server behind
  the sign in, an account can make 120 research requests in 10 minutes, and app/docs/api.md covers the four new
  routes.
- Alerts on a strategy aren't built yet, and Pine's `request.security`, `time()` sessions and libraries don't run
  yet either. The AI knows that, so it says so and offers what does work.

## 0.1.24 (2026-11-02)

Minute and hour charts draw again after the clocks went back, and one alert can watch a whole watchlist.

- When the clocks went back (25 October in Europe, 1 November in the US), the hour from 1:00 to 2:00 AM happened
  twice. A bar from each pass landed on the same time on the chart and the chart library stops drawing when that
  happens. That left charts of 1 hour and shorter empty if they reached back over that night. Switching to dark or
  light mode also left parts of them in the old colours, like the indicator panes. Now the repeated hour fits into
  one hour on the chart and its labels keep the real times, so 1:00 AM shows twice, as it happened. Daily charts and
  charts set to UTC never had the problem.
- Open the menu on a watchlist's name and pick Add alert on the list…, or pick a list in the new Symbols dropdown at
  the top of Create alert, as on TradingView. The alert checks every symbol on the list and each message names the
  symbol that fired, and the Alerts panel lists it as Watchlist with the list's name. Set to Once only, it stops
  after every symbol on the list has fired once, and renaming a list keeps its alerts on it. The API and custom
  indicator docs cover list alerts, and app/docs/alert-example.js is an indicator for alerts to watch, like Pine's
  alertcondition().
- You can chart Binance's USD-M perpetuals by searching for BTCUSDT.P or BTC.P, with Bybit as the backup. Both of
  them turn away requests from US addresses, so an AskCharts running in the US can't show them.
- If an ad blocker or a browser shield stops the chart library from loading, a note at the top now says so and how
  to fix it. Before, the chart just stayed empty. The note shows on a server with the sign in too.

## 0.1.23 (2026-10-24)

Daily stock charts get the official closes, and search puts the stock you typed first. A history download that's
waiting now says what it's waiting for.

- The free Alpaca key's IEX feed is one exchange, so its daily bars ended on IEX's last trade and counted only a few
  percent of the day's volume. Daily and longer stock charts now come from Nasdaq or Yahoo, which carry the official
  bars, and IEX only fills in when neither of them answers. Minute and hour charts still come live from your key.
- Typing AMD listed Binance's AMD token (AMDBUSDT) above AMD the stock, and it was the same for AAPL, SPY, TSLA and
  the other stocks Binance has a token for. Now what you type in full comes first, and coins, futures, forex and
  gold come up as before.
- Only one history download runs at a time, so a stock or Binance download you asked for during Kraken's hourly
  update said "Starting…" until its turn came. Now it says "Waiting for the Kraken update to finish…". Kraken's own
  section also stops showing the stock and Binance requests as its own, where it said "Waiting to start: undefined".
- A note under the chart's legend, like the one about the IEX feed, now sits on the chart's own colour on one line.
  It used to run across the candles.
- There's a new Architecture page (docs/ARCHITECTURE.md, with a diagram) that shows how the pieces fit and where
  your data lives. The server guide also has a new appendix on free and low cost places to run AskCharts, with
  prices as of October 2026.

## 0.1.22 (2026-10-24)

A coin Binance doesn't list no longer gets onto the Binance history's list or fails its hourly update.

- Download Binance history offers your Kraken coins in USDT, and Binance doesn't list every one of them (XDC, for
  one). So now it asks Binance about each coin first, leaves out the ones it doesn't list and tells you which they
  were.
- A coin on the list that Binance doesn't list, or stops listing later, says so on its row and keeps any bars
  already stored. It isn't counted as a failed update any more.

## 0.1.21 (2026-10-24)

You can keep Binance's own bars on your own computer now for BINANCE charts, going back to each coin's first month
on Binance.

- Settings, Crypto data has a new BINANCE section after Kraken's. It downloads each coin's bars from Binance's
  monthly files, back to its first month on Binance (Bitcoin from August 2017), and checks every file against
  Binance's own checksum. After that it updates every hour from Binance. It offers the Binance coins on your
  watchlists and your Kraken coins in USDT, and you can add or remove coins after. A coin traded since 2017 takes
  about two minutes and 400 MB, and newer ones take less. BINANCE charts and the strategy report's backtests use the
  stored bars with only the newest coming live from Binance, and nothing downloads until you start it.
- A first download, whether it's Kraken's, Binance's or the stocks', now shows on charts and in its CSV link as soon
  as it's in, which used to take a minute or two.

## 0.1.20 (2026-10-24)

You can keep years of 1 minute stock bars on your own computer now, and two open pages no longer write over each
other's charts.

- Settings, Stock data has a new section under the keys. With your free Alpaca key it downloads 1 minute bars for US
  stocks and ETFs since 2016. Those are the whole market's trades from every exchange, and the free live feed only
  sees a small share of them. It offers the US stocks on your watchlists, takes under a minute and about 85 MB a
  stock, then updates every hour. Stock charts and the strategy report's backtests use the stored bars with only the
  newest coming live, and the chart's title says where its bars came from. The bars are regular hours and split
  adjusted, the way stock charts show them, and nothing downloads until you start it.
- With AskCharts open in two windows, or a window and another device, the one that's behind no longer saves its
  older charts over the newer ones. It says your charts were changed elsewhere and offers Reload and Keep this one,
  and it saves nothing until you pick. Coming back to a page that's behind says so too.
- Answers from Grok show how many tokens they used, as the other providers' answers do.
- Settings, AskCharts AI shows the same robot as its button on the right toolbar.

## 0.1.19 (2026-10-24)

Stock data comes first among the data tabs in Settings, then Crypto data and On chain data.

## 0.1.18 (2026-10-24)

The data tabs in Settings are named for the market each one serves: Crypto data, On chain data and Stock data.

- Market data is now Crypto data and Data keys is now Stock data, with On chain data between them. Each tab says
  which market it's for, so someone who only trades crypto can tell they don't need Stock data. Later sources have
  an obvious home too, like Binance and Coinbase history in Crypto data and Alpaca stock history in Stock data. Your
  saved keys and the Kraken history stay where they were.
- Crypto data no longer links to the keys at its bottom. Stock data opens on live US stock prices and says that
  stock and ETF history isn't stored on this computer yet.
- A copy of AskCharts that only reads another copy's XRP Ledger store can set `QT_ONCHAIN_SETTINGS=off`. Its On
  chain data tab then shows the status and what's set with no switches, and it refuses a save, so it can't move the
  other copy's collector. It's the On chain match for `QT_HISTORY_JOBS=off` in Crypto data.

## 0.1.17 (2026-10-24)

AskCharts AI works with OpenAI and xAI as well as Anthropic, and XRPL On chain has a Settings tab of its own.

- AskCharts AI runs on GPT from OpenAI or Grok from xAI now, as well as Claude from Anthropic. In Settings,
  AskCharts AI, pick the provider, paste its key, press Test, choose a model and press Ok. Each provider keeps its
  own key and model, so switching back and forth doesn't mean pasting a key again, and a key is only ever sent to
  its own provider. A Claude key you saved before stays where it was.
- OpenAI models go through OpenAI's Responses API. Its newer models (gpt-5.6 and on) won't use tools on the older
  API while they're reasoning, and every chart change AskCharts AI makes is a tool. AskCharts asks OpenAI not to
  store the conversation.
- AskCharts AI doesn't add an indicator that's already on the chart with the same settings. A chart keeps its
  indicators when the symbol changes, so asking for RSI and MACD on a new symbol used to add a second set. If a
  chart already has two copies, it says so and offers to remove the extra one.
- Kraken calls Bitcoin XBT, so typing XBTUSD in symbol search now finds it, and the chart and AskCharts AI's steps
  call it BTC / USD.
- XRPL On chain moved to its own tab, Settings, On chain data, next to Market data. Market data keeps the price
  history and the new tab has room for other chains later. A saved server now says so in the same section.
- When a provider doesn't report how many tokens an answer used (Grok doesn't), the answer no longer shows "0
  tokens".

## 0.1.16 (2026-10-24)

Download Kraken history works on a fresh install now, and XRPL On chain copes with a public server that says to slow
down.

- Download Kraken history in Settings, Market data now downloads Kraken's archive. Until now it only switched on the
  hourly update, which had nothing to start from, so every update failed with "nothing stored yet". The archive is
  about 10 GB in five parts and each part is checked against Kraken's own checksum. If it stops partway it carries
  on from there next time, and every file in it is tested before it's used. If your computer's unzip can't read it,
  Market data says so and nothing is downloaded twice. It needs about 34 GB free while it comes in and 20 GB after.
  Then each coin catches up at Kraken's pace, which takes minutes for a quiet coin and an hour or more for a busy
  one.
- XRPL On chain on xrplcluster.com kept getting cut off for asking too much at once. Its free allowance turned out
  smaller than one ledger with its transactions every few seconds, so even a well behaved collector falls behind
  there. The default server is now Ripple's wss://s1.ripple.com, which kept up in testing, and an install on
  xrplcluster.com moves to it by itself. A server you picked yourself stays, and if it can't keep up, Market data
  now says it's falling behind and suggests s1.ripple.com or your own node.
- When a server says to slow down, the collector now waits as long as it asks, fills in older ledgers more slowly
  and stays connected. Before, it reconnected straight into the same limit. On a public server it fills in at 2
  ledgers a second, and on your own node it stays at 5.
- The XRP Ledger line in Market data says why it can't connect, for example that the server is rate limiting your
  network, and says when it's filling in more slowly. After Save server it shows "Switching to" the new server until
  the collector is on it.
- A server you've typed but not saved no longer gets lost when the page refreshes underneath it, which sometimes
  swallowed the Save click.

## 0.1.15 (2026-10-24)

The Kraken history updates every hour again. Market data can also add coins in any currency, download a coin as CSV
and shrink the store after a Remove.

- The hourly update runs again, and so do Market data's requests (Update now, Add, Remove) when you ask. When
  AskCharts started the importer it stayed running after its work was done, so after the first run following a
  restart nothing else could start. If your Market data has said "Waiting to start" for a while, that's why, and it
  runs once you update.
- Add coin offers every pair Kraken lists in whatever currency it's quoted in (EUR, USDT, BTC, GBP and the rest),
  not only USD. The coin list shows them by their usual names, like XRP/EUR or ETH/BTC.
- Each stored coin has a download link that gives its bars as a CSV file at the finest interval kept, which is 1
  minute for Kraken. The columns are the ones the app's own CSV import reads, so a file can go straight back in.
- Removing a coin gives its space back when it frees 100 MB or more. Before, the bars were deleted but the store
  file kept its size. Market data says how much it shrank, and if the disk doesn't have room for the rewrite it says
  so and leaves the file alone.
- If you run a second copy of AskCharts that reads the first one's history store, set `QT_HISTORY_JOBS=off` on that
  copy. Its Market data is then read only, so its buttons can't start jobs on the other copy's store.

## 0.1.14 (2026-10-23)

The chart's right edge stays tight after you pick a date range, and images and tables now resize by their corners.

- A date range under the chart (1D to All) now sets your zoom as well, so the next interval keeps it the way
  TradingView does. Pick 1D and then 5m and you get several days of 5 minute bars with the last one next to the
  price scale. Before, the chart went back to the zoom you had earlier and left a wide gap on the right.
- Kraken's live feed fills a minute without trades with a flat bar and no volume, and the stored Kraken history has
  none of those, so one chart mixed both. Now the live bars leave them out too. When I checked ATOM/USD at 1 minute
  that was about a third of the bars. A pair with no trades at all in that window says so instead of drawing a flat
  line.
- Drag a corner of an image or a table to resize it and the opposite corner stays where it is. A picture keeps its
  shape and a table's cells grow or shrink with it, and dragging the middle still moves them.
- When drawings are locked, pressing the one you've selected now tells you so and where to unlock it. Before, the
  press just dragged the chart, so a locked drawing looked like it was broken.

## 0.1.13 (2026-10-23)

XRPL DEX shows the trading on the XRP Ledger's own exchange.

- XRPL DEX is a fifth On chain indicator. It shows the XRP traded on the ledger's own order book and its AMM pools
  in each bar, seen from the taker. Show picks Buys and sells (Bought above zero, Sold below, Net as a line), Order
  book and AMM (volume by venue) or Bridged. Bridged is XRP that only passed through between two other tokens, which
  isn't counted as bought or sold. The ? beside its name explains what counts, and alerts work on it like on the
  other four.
- The XRPL collector counts it from this version on, from what each transaction did, so each trade counts once. Bars
  from before counting began say "No DEX data before ..." rather than showing zero, and with the shared history on,
  the numbers fill in from when they were first published.
- The shared XRPL history carries the new numbers in a second format beside the first, so installs that haven't
  updated keep filling in as before.

## 0.1.12 (2026-10-23)

You can set alerts on the XRPL On chain indicators now.

- Create alert offers XRPL Activity, XRPL Payments, XRPL Exchange flows and XRPL Network next to price and your
  other indicators. You could alert when XRP paid into exchanges goes above 5M in an hour, for example, or when new
  accounts cross 300. The alert reads the same XRP Ledger data the chart draws, and it keeps watching while your
  browser is closed. On XRPL Network it watches the value its Show setting picks. The dialog names it.
- When an indicator has no data for the alert's bars, the alert says so in plain words.
- The Trigger menu in Create alert is readable again, with each trigger's description under its name where it used
  to run into the next one.

## 0.1.11 (2026-10-23)

The server guide covers installs without Docker, and your own indicators load without a warning.

- The server guide (`docs/SERVER.md`) has a Without Docker section. It covers the install line, a small settings
  file for systemd, HTTPS through a Cloudflare tunnel or your own web server, your first passkey, and Update now
  from Settings, Updates.
- Your own indicators get a small `package.json` beside them in the data folder, so Node loads them as the ES
  modules they are with no warning. That works even when there's another `package.json` further up, in your home
  folder say.

## 0.1.10 (2026-10-22)

There's a new XRPL Network indicator, and the economic calendar keeps its last good copy.

- XRPL Network is a fourth On chain indicator. Its Show setting picks one of these. New accounts is the accounts
  created in each bar, and Fees burned is the XRP paid as fees, which is destroyed. Average fee is fees over
  transactions in drops, and it climbs when the ledger is busy. The ? beside its name explains each one. The
  collector already stored these numbers, so it works on all the XRPL history you have.
- The economic calendar keeps its last good copy and shows it while the calendar's feed turns requests away. Once
  it's been turned away it waits 15 minutes before asking again, and it no longer asks on every view.

## 0.1.9 (2026-10-22)

Settings, Updates remembers its last check.

- After an update or a restart the page shows the last check's answer, where it used to say "Not checked yet". A new
  install that hasn't checked yet says it will within the hour.
- A release's notes start with their summary line, then the list of changes.

## 0.1.8 (2026-10-22)

Settings, Updates makes the next step plain.

- When a new version is out, Update comes first in the accent colour, with a line that says to press it.
- Check now always shows that it ran ("Checked just now"), even when nothing changed.
- An install that updates from its own address instead of GitHub says so under the switch.

## 0.1.7 (2026-10-22)

On a server, the app stays on its own port when the sign in is on.

- AskCharts used to move the app to the next free port when its own was taken. With the sign in on, that could be
  the sign in's own port, where your proxy or tunnel sends people. Now it doesn't start and says which port is
  taken, so nothing reaches the app without signing in. On your own computer nothing changes.

## 0.1.6 (2026-10-22)

AskCharts can run on a server without Docker.

- The passkey sign in comes with AskCharts now, since its two packages are in the release. So an install made with
  the install line can run it in front of AskCharts on a server and update itself from Settings, Updates. Docker
  installs are unchanged.

## 0.1.5 (2026-10-22)

AskCharts can update itself now, from Settings, Updates.

- Settings, Updates shows the version you have and the newest one with its notes, with Check now and Update now. On
  a computer AskCharts updates itself. It checks the release's signature and every file before anything stops, keeps
  your charts, settings and keys, and goes back to the old version by itself if the new one doesn't start. On a
  server with Docker the page shows the update commands. A dot on the Settings gear says a newer version is out,
  which it checks once a day, and a switch turns that off.
- Releases are signed with a key that never touches GitHub, so a stolen GitHub login can't push an update.
- The Mac and Linux installer keeps the old version until the new one answers and puts it back if an update fails
  partway. On Windows, update by pasting the install line again for now, and Update now comes to Windows once it's
  been tested there.

## 0.1.4 (2026-10-22)

XRPL On chain starts with up to 90 days of history, and there's a new Exchange flows indicator.

- XRPL Exchange flows is a new On chain indicator that shows the XRP paid into and out of known exchange wallets in
  each bar, and the net. The wallet list is partial, so the numbers are floors, and its ? says so.
- XRPL lines break where the collector wasn't running, a laptop that was off say, instead of drawing a straight line
  across, and the legend says so there.
- When the collector starts it fills in up to 90 days of ledgers from data.askcharts.pro, published hourly by the
  AskCharts collector that runs around the clock. Every file is signed and checked before a row goes in, and only
  the last hour is fetched ledger by ledger. Settings, Market data has a switch to turn it off, and it only
  downloads.

## 0.1.3 (2026-10-22)

AskCharts gets its own colour, and XRPL Activity gets easier to read.

- AskCharts has its own accent colour, the purple from its mark, on buttons, toggles, the BUY box and the sign in
  page. Line and drawing colours are unchanged.
- XRPL Activity draws fine lines in each kind's colour instead of dots, and its values in the legend are split by a
  faint |. A small ? after its name explains what it counts and how.
- AskCharts AI's panel shows the same robot as its toolbar button, where it had a spark.
- XRPL Activity says where its history starts, in the empty part of the pane before it, and fades the newest bar
  while it's still adding up. Its ? explains the edges of the chart and how the collector is doing.
- An indicator's ? opens when the mouse is over it and stays open after a click, and on a touch screen a tap opens
  it.

## 0.1.2 (2026-10-22)

The sign in gateway sends no email any more. This release also adds credits and notices, and changes the look of the
About page.

- The sign in page no longer offers "New device? Email me a link", and the gateway has no route that sends one.
  AskCharts has one owner, so nothing a stranger does should make it send mail. A new device gets its passkey from a
  one time link made on the server, the same way as the first one:
  `docker compose exec askcharts node gateway/link.mjs`. The `MAIL_MODE`, `RESEND_API_KEY` and `MAIL_FROM` settings
  are gone, so you can delete them from `.env`.
- The sign in card no longer shows the site's address in its corner.
- AskCharts has a home page, [askcharts.pro](https://askcharts.pro), with a demo video, and the README and Settings,
  About point to it.
- Settings, About, the README and NOTICE now say that Pine Script, like TradingView, is a trademark of TradingView,
  Inc. AskCharts uses the name only to say what kind of scripts it runs.
- NOTICE carries the MIT notice for Tabler Icons, because the trend up and trend down icons in the emoji picker use
  a line from that set.
- The README shows the AskCharts mark beside its title, and so does Settings, About, with the tagline underneath.

## 0.1.1 (2026-10-21)

This is a security fix for the sign in gateway, which only runs when AskCharts is on a server, so desktop installs
don't use it.

- The gateway used to count each visitor by the `CF-Connecting-IP` header, and anyone could send that header through
  Caddy or nginx, so a visitor could get around the sign in limits. Now it believes a visitor's address header only
  when `ASKCHARTS_TRUST_PROXY` says what's in front of it. That's `cloudflare` for a Cloudflare tunnel, `forwarded`
  for Caddy, nginx and the like, or empty when nothing is in front, and a value it doesn't know stops the gateway
  from starting.
- The account gets at most one sign in email every 10 minutes, so a stranger can't use up the hourly email cap.

To update a server, add `ASKCHARTS_TRUST_PROXY` to `.env` (see `.env.example` and the server guide), then run
`git pull && docker compose up -d --build`. Without it everything still works, but all visitors share one set of
sign in limits and the log says so.

## 0.1.0 (2026-10-21)

The first public release.

- Charts with 19 chart types, intervals from 1 second to 1 month, and up to 16 charts on screen
- 89 built in indicators, a Pine Script editor and community scripts you can add
- Drawing tools, alerts, a screener, a heatmap, calendars, news and company financials
- A strategy tester with a full report, bar replay and paper trading
- AskCharts AI, which works on the chart for you with your own Claude key
- XRPL On chain, the XRP Ledger's activity and payments under your chart (optional)
- Free market data with no key, and optional Alpaca or Polygon keys for live US stock prices
- One line installs for Mac, Linux and Windows, and Docker with a passkey sign in for servers
