# Custom indicator format

A custom indicator is one JavaScript file in the `custom/` folder. Every file follows the same shape, so anyone (or any AI agent) can read, write and share one. Start from `docs/indicator-template.js`.

## The file

```js
export default {
  name: 'RSI with bands',          // shown in the indicator list and the legend
  overlay: false,                  // true: on the price chart. false: its own pane under it
  inputs: [ /* settings people can change */ ],
  outputs: [ /* what gets plotted */ ],
  levels: [30, 70],                // optional: dashed horizontal lines in the indicator's pane
  calc(bars, p, ta) { /* return one array per output */ },
};
```

| Field | Required | What it is |
|---|---|---|
| `name` | Yes | Text, up to 80 characters |
| `calc` | Yes | A function `calc(bars, p, ta)` that returns an object |
| `overlay` | No | `true` (default) draws on the price chart, `false` gives it its own pane |
| `inputs` | No | A list of settings, below. Leave it out for none |
| `outputs` | No | A list of plots, below. Leave it out for one orange line called `value` |
| `levels` | No | A list of numbers, drawn as dashed lines in the indicator's own pane |

## Inputs

Each input is a setting in the indicator's settings box. Its value reaches `calc` as `p.<key>`.

| Field | Required | What it is |
|---|---|---|
| `key` | Yes | A name made of letters, digits and `_`, starting with a letter. Unique in the file |
| `type` | Yes | `int`, `float`, `select`, `source` or `time` |
| `default` | Yes | The starting value (see below) |
| `label` | No | What the settings box shows. Defaults to the key |
| `min`, `max` | No | Numbers, for `int` and `float` |
| `options` | For `select` | The list of choices, as text |

| Type | Default must be |
|---|---|
| `int` | A whole number |
| `float` | A number |
| `select` | One of its `options` |
| `source` | A price field: `close`, `open`, `high`, `low`, `hl2`, `hlc3`, `ohlc4`, `hlcc4` or `volume`. Its key must be `source` (one per indicator), and people can then build it on another indicator's output too |
| `time` | A bar time in seconds, or `0` for "pick a bar on the chart" |

## Outputs

Each output is one plot. `calc` must return an array for it under the same key.

| Field | Required | What it is |
|---|---|---|
| `key` | Yes | Same rules as an input key. Unique in the file |
| `kind` | No | `line` (default) or `histogram` |
| `label` | No | The name in the legend and colour settings. Defaults to the key |
| `color` | No | A colour. Use hex, like `#2962ff`, so the colour picker in the settings box can show it |
| `lineWidth` | No | 1 to 4, for lines |

## calc(bars, p, ta)

- `bars` is the chart's bars, oldest first: `{ time, open, high, low, close, volume }`, with `time` in seconds (UTC).
- `p` holds your inputs, `p.length` and so on.
- `ta` holds the building blocks: `sma, ema, rma, wma, vwma, hma, dema, tema, alma, linreg, stdev, dev, highest, lowest, change, sum, rsi, atr, tr, crossover, crossunder, macd, supertrend, psar, dmi, source`, and `compute(id, bars, params)` for any of the 87 built-in indicators. They follow the Pine Script `ta.*` formulas.

Return an object with one plain array per output, each exactly as long as `bars`. Use `NaN` (or `null`) where there's no value yet, like the first 13 bars of a 14-bar average. Optional extras:

| Key | What it does |
|---|---|
| `markers` | Arrows or labels on the price chart: `[{ time, position, shape, color, text }]`. `position` is `aboveBar`, `belowBar` or `inBar`; `shape` is `arrowUp`, `arrowDown`, `circle` or `square` |
| `colors` | For a histogram: one hex colour per bar, to colour each column |

Only look at bars up to the one you're computing (`i` and before). Looking ahead makes an indicator look better on the chart than it could ever be live.

## Alerts from your indicator (Pine's `alertcondition`)

Alerts watch an indicator's outputs, so an alert signal is just another output: an array that is `1` on a bar where the signal is true and `0` where it isn't. Each Pine `alertcondition(cond, "Buy", ...)` becomes one output like that. [`docs/alert-example.js`](alert-example.js) is a complete one to copy:

```js
outputs: [{ key: 'buy', label: 'Buy signal', kind: 'histogram' }, { key: 'sell', label: 'Sell signal', kind: 'histogram' }],
calc(bars, p, ta) {
  const close = ta.source(bars, 'close');
  const up = ta.crossover(ta.ema(close, p.fast), ta.ema(close, p.slow));
  return { buy: up.map((x) => (x ? 1 : 0)), sell: /* the same for the sell condition */ };
},
```

Then set the alert:

- **In the app:** Create alert, pick your indicator on the left, choose the output (`buy`), set it to "greater than" Value `0`, and pick "Once per bar close" so it only fires on a finished bar. To run it on every symbol of a watchlist, click the symbol at the top of the dialog and pick the list, or use Add alert on the list… in the watchlist's list menu.
- **From code:** `POST /api/alerts` (see [`api.md`](api.md)) with your indicator under `indicators` and its output as `key.output`:

```json
{
  "symbol": "BINANCE:BTCUSDT", "tf": "1h",
  "indicators": { "sig": { "id": "custom:alert-example", "params": { "fast": 9, "slow": 21 } } },
  "conditions": [{ "left": "sig.buy", "op": ">", "right": 0 }],
  "trigger": "oncePerBarClose",
  "message": "Buy signal"
}
```

The id is `custom:` plus the file name without `.js`. Plotted values work too: `{ "left": "sig.fast", "op": "crossesAbove", "right": "sig.slow" }`.

## Registering it

Save the file as `custom/<name>.js`. Two ways:

1. **In the app.** Open the Indicator editor tab, paste the code, press Save. It's checked before it's saved.
2. **As a file.** Put it in `custom/` (or ask your AI agent to). The app checks every file when it starts, and the editor tab lists any that failed with the reason.

Every file is checked against this format and run once on test bars. A file that breaks a rule isn't loaded, and the message names each problem, for example:

```
This indicator doesn't follow the format (docs/custom-indicators.md):
- output "upper": calc() returned 99 values, but there are 300 bars. Return one value per bar (NaN where there isn't one)
- input "length": an int input needs a whole-number default
```

Once it's loaded, an indicator works everywhere a built-in one does: on charts, inside other indicators, in the strategy tester, alerts and the screener.
