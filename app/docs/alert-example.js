// Example: a custom indicator that alerts can watch, like Pine's alertcondition().
// Each signal is an output that is 1 on a bar where it's true and 0 where it isn't.
// Copy this file to custom/<name>.js, then Create alert > pick this indicator > choose the
// output (buy or sell) > "greater than" > Value 0. See "Alerts from your indicator" in
// docs/custom-indicators.md.
//
// Pine:  alertcondition(ta.crossover(fast, slow) and rsi < 70, "Buy", "Fast EMA crossed up")
// Here:  buy[i] = crossover && rsi < 70 ? 1 : 0
export default {
  name: "EMA cross with RSI filter (alerts)",
  overlay: false,
  inputs: [
    { key: "fast", label: "Fast EMA", type: "int", default: 9, min: 1 },
    { key: "slow", label: "Slow EMA", type: "int", default: 21, min: 1 },
    { key: "rsiLength", label: "RSI length", type: "int", default: 14, min: 1 },
  ],
  outputs: [
    { key: "buy", label: "Buy signal", kind: "histogram", color: "#26a69a" },
    { key: "sell", label: "Sell signal", kind: "histogram", color: "#ef5350" },
  ],
  calc(bars, p, ta) {
    const close = ta.source(bars, "close");
    const fast = ta.ema(close, p.fast);
    const slow = ta.ema(close, p.slow);
    const rsi = ta.rsi(close, p.rsiLength);
    const up = ta.crossover(fast, slow);
    const down = ta.crossunder(fast, slow);
    const buy = bars.map((_, i) => (up[i] && rsi[i] < 70 ? 1 : 0));
    const sell = bars.map((_, i) => (down[i] && rsi[i] > 30 ? 1 : 0));
    const markers = bars.flatMap((bar, i) =>
      buy[i]
        ? [
            {
              time: bar.time,
              position: "belowBar",
              shape: "arrowUp",
              color: "#26a69a",
              text: "Buy",
            },
          ]
        : sell[i]
          ? [
              {
                time: bar.time,
                position: "aboveBar",
                shape: "arrowDown",
                color: "#ef5350",
                text: "Sell",
              },
            ]
          : [],
    );
    return { buy, sell, markers };
  },
};
