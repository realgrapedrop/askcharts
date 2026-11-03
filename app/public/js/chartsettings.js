// The chart Settings dialog (the gear at the top right), after TradingView's: Symbol, Status line,
// Scales and lines, Canvas, Trading, Alerts and Events, plus AskCharts AI, Stock data (your own keys for live US stock prices), Crypto data (the Kraken history store) and On chain data (XRPL On chain). Changes show on the charts as they're made;
// Cancel, Esc or the close button put everything back, Ok keeps them.
import { esc, exchange, ticker } from "./api.js";
import { aiSettings } from "./copilot.js";
import { marketData } from "./marketdata.js";
import { onchainData } from "./onchaindata.js";
import { dataKeys } from "./datakeys.js";
import { stockHistory } from "./stockhistory.js";
import { binanceHistory } from "./binancehistory.js";
import { PRODUCTS } from "./products.js";
import { updatesPage } from "./updates.js";
import { PALETTE, rgbOf, hexOf, cssOf, lineIcon, STYLES } from "./drawtoolbar.js";

// ---------- defaults ----------
// "" for a colour means "the theme's own", so light and dark both look right until one is picked.
export const CHART_DEFAULTS = {
  // Symbol
  prevClose: false,
  body: true, bodyUp: "#089981", bodyDown: "#f23645",
  borders: true, borderUp: "#089981", borderDown: "#f23645",
  wick: true, wickUp: "#089981", wickDown: "#f23645",
  barUp: "#089981", barDown: "#f23645", hlcBars: false, thinBars: true,
  lineColor: "#2962ff", lineWidth: 2, lineStyle: "solid",
  areaLine: "#2962ff", areaWidth: 2, areaTop: "rgba(41,98,255,0.28)", areaBottom: "rgba(41,98,255,0.05)",
  baseTop: "#089981", baseBottom: "#f23645",
  colUp: "rgba(8,153,129,0.5)", colDown: "rgba(242,54,69,0.5)",
  hlcHigh: "#089981", hlcLow: "#f23645", hlcClose: "#2962ff", hlcUpFill: "rgba(8,153,129,0.2)", hlcDownFill: "rgba(242,54,69,0.2)",
  hiloColor: "#2962ff", hiloBorders: true, hiloLabels: true,
  svpPeriod: "Auto", svpRows: 24, svpWidth: 70, svpVA: 70,
  precision: "default",
  timezone: "",
  // Status line
  logo: true, title: true, titleMode: "name", marketStatus: true, chartValues: true, barChange: true,
  legendVolume: true, lastDayChange: false, buySell: true,
  indTitles: true, indInputs: true, indValues: true, legendBg: true, legendBgOpacity: 50,
  // Scales and lines
  currencyUnit: "hover", scaleModes: "hover", lockRatio: false, lockRatioValue: 0, placement: "auto",
  noOverlap: true, plusButton: true, countdown: true,
  symName: false, symValue: true, symLine: true, symLabelValue: "scale", symLineColor: "", symLineStyle: "dotted", symLineWidth: 1,
  indName: false, indValue: true,
  hlValue: false, hlLine: false, highLowColor: "#f23645", highLowStyle: "dotted", highLowWidth: 1,
  pdcValue: false, pdcLine: false, pdcColor: "#ffeb3b", pdcStyle: "dotted", pdcWidth: 1,
  baValue: false, baLine: false, bidColor: "#2962ff", askColor: "#f7525f",
  dayOfWeek: false, dateFormat: "dd MMM 'yy", hours: "24", keepLeftEdge: false,
  // Canvas
  bgType: "solid", bg: "", bgTop: "", bgBottom: "",
  vertGrid: true, vertGridColor: "", vertGridStyle: "solid", vertGridWidth: 1,
  horzGrid: true, horzGridColor: "", horzGridStyle: "solid", horzGridWidth: 1,
  separatorColor: "", crosshairColor: "", crosshairStyle: "dashed", crosshairWidth: 1,
  watermark: "replay", watermarkColor: "",
  scaleTextColor: "", scaleFontSize: 12, scaleLineColor: "",
  navButtons: "hover", paneButtons: "hover",
  marginTop: 10, marginBottom: 8, marginRight: 10,
  // Trading
  oneClick: false, execSound: true, execVolume: 50, execSoundName: "alarm", rejectOnly: false,
  positions: true, reverseButton: true, projectOrder: false, pnl: true,
  pnlPos: true, pnlPositions: "money", pnlBr: true, pnlBrackets: "money",
  execMarks: true, execLabels: true, extendLines: true, alignment: "right", inSnapshots: true,
  // Alerts
  alertLines: true, alertLineColor: "", onlyActiveAlerts: true, alertSound: true, alertVolume: 50, autoHideToasts: true,
  // Events
  econEvents: true, onlyFuture: true, eventBreaks: false, eventBreaksColor: "#787b86", eventBreaksStyle: "dashed", eventBreaksWidth: 1,
  latestNews: true, newsNotify: false,
};

// Colours the theme decides until one is picked. Switching the theme drops picked ones (as
// TradingView does), so a dark background never sticks to the light theme.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const THEME_KEYS = ["bg", "bgTop", "bgBottom", "vertGridColor", "horzGridColor", "separatorColor", "crosshairColor", "watermarkColor", "scaleTextColor", "scaleLineColor"];
export function themeColor(key) {
  const dark = document.documentElement.dataset.theme !== "light";
  switch (key) {
    case "bg": case "bgTop": case "bgBottom": return css("--bg");
    case "vertGridColor": case "horzGridColor": return css("--grid");
    case "separatorColor": case "scaleLineColor": return css("--border");
    case "crosshairColor": return "#9598a1";
    case "watermarkColor": return dark ? "rgba(178,181,190,0.15)" : "rgba(19,23,34,0.08)";
    case "scaleTextColor": return css("--text");
    case "alertLineColor": return "#2962ff";
    default: return "";
  }
}
export const colorOf = (cs, key) => cs[key] || themeColor(key);
export const LINE_STYLE = { solid: 0, dotted: 1, dashed: 2, "large-dashed": 3, "sparse-dotted": 4 };

// ---------- time zones ----------
// TradingView's list. Labels carry today's offset, so they follow daylight saving.
const ZONES = [
  "Etc/UTC", "Africa/Cairo", "Africa/Casablanca", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi", "Africa/Tunis",
  "America/Anchorage", "America/Argentina/Buenos_Aires", "America/Bogota", "America/Caracas", "America/Chicago",
  "America/El_Salvador", "America/Halifax", "America/Juneau", "America/Lima", "America/Los_Angeles", "America/Mexico_City",
  "America/New_York", "America/Phoenix", "America/Santiago", "America/Sao_Paulo", "America/Toronto", "America/Vancouver",
  "Asia/Almaty", "Asia/Ashkhabad", "Asia/Bahrain", "Asia/Bangkok", "Asia/Chongqing", "Asia/Colombo", "Asia/Dhaka",
  "Asia/Dubai", "Asia/Ho_Chi_Minh", "Asia/Hong_Kong", "Asia/Jakarta", "Asia/Jerusalem", "Asia/Kabul", "Asia/Karachi", "Asia/Kathmandu",
  "Asia/Kolkata", "Asia/Kuala_Lumpur", "Asia/Kuwait", "Asia/Manila", "Asia/Muscat", "Asia/Nicosia", "Asia/Qatar", "Asia/Riyadh", "Asia/Seoul",
  "Asia/Shanghai", "Asia/Singapore", "Asia/Taipei", "Asia/Tehran", "Asia/Tokyo", "Asia/Yangon", "Atlantic/Azores",
  "Atlantic/Reykjavik", "Australia/Adelaide", "Australia/Brisbane", "Australia/Perth", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Athens", "Europe/Belgrade", "Europe/Berlin", "Europe/Bratislava", "Europe/Brussels",
  "Europe/Bucharest", "Europe/Budapest", "Europe/Copenhagen", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul",
  "Europe/Lisbon", "Europe/Ljubljana", "Europe/London", "Europe/Luxembourg", "Europe/Madrid", "Europe/Malta", "Europe/Moscow",
  "Europe/Oslo", "Europe/Paris", "Europe/Prague", "Europe/Riga", "Europe/Rome", "Europe/Sofia", "Europe/Stockholm",
  "Europe/Tallinn", "Europe/Vienna", "Europe/Vilnius", "Europe/Warsaw", "Europe/Zagreb", "Europe/Zurich", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Fakaofo", "Pacific/Honolulu", "Pacific/Norfolk", "US/Mountain",
];
const CITY = { "Etc/UTC": "UTC", "US/Mountain": "Denver", "Asia/Ashkhabad": "Ashgabat", "America/Argentina/Buenos_Aires": "Buenos Aires" };
const cityOf = (tz) => CITY[tz] || tz.split("/").pop().replace(/_/g, " ");
let here = null;
export const localZone = () => {
  if (here) return here;
  try {
    here = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {
    here = "Etc/UTC";
  }
  return here;
};
const fmtCache = new Map(),
  offCache = new Map();
// Seconds to add to a UTC time to read the zone's wall clock at that moment.
export function tzOffset(tz, sec) {
  if (!tz || tz === "Etc/UTC" || tz === "UTC") return 0;
  const q = Math.floor(sec / 900),
    key = `${tz}|${q}`;
  let off = offCache.get(key);
  if (off === undefined) {
    try {
      let f = fmtCache.get(tz);
      if (!f) fmtCache.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
      const p = {};
      for (const x of f.formatToParts(new Date(q * 900000))) p[x.type] = x.value;
      off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - q * 900;
    } catch {
      off = 0;
    }
    if (offCache.size > 50000) offCache.clear();
    offCache.set(key, off);
  }
  return off;
}
// A wall-clock time in the zone back to UTC (right everywhere except inside a clock change).
export const fromZone = (tz, wall) => wall - tzOffset(tz, wall - tzOffset(tz, wall));
// The clocks going back within two hours of a UTC time: { at, d, off }, the UTC second the zone's offset drops, by
// how much, and the offset after it; or null. Offsets change on the quarter hour, the grid tzOffset reads them on.
function fallBackNear(tz, sec) {
  let lo = Math.floor(sec / 900) * 900 - 7200,
    hi = lo + 14400;
  const a = tzOffset(tz, lo),
    b = tzOffset(tz, hi);
  if (!(a > b)) return null;
  while (hi - lo > 900) {
    const mid = lo + Math.floor((hi - lo) / 1800) * 900;
    if (tzOffset(tz, mid) === a) lo = mid;
    else hi = mid;
  }
  return { at: hi, d: a - b, off: b };
}
// A UTC time as a chart time: the zone's wall clock, so the time scale reads local time. Where the clocks go back,
// an hour happens twice; those two hours share the one wall-clock hour, each bar at half the spacing, so chart times
// keep going up (the chart library needs them in order; a bar from each pass on the same time stopped intraday
// charts drawing after 1 November) and every other bar keeps its true local time.
export function chartTime(tz, sec) {
  const fb = fallBackNear(tz, sec);
  if (fb && sec >= fb.at - fb.d && sec < fb.at + fb.d) return fb.at + fb.off + (sec - (fb.at - fb.d)) / 2;
  return sec + tzOffset(tz, sec);
}
// A chart time back to UTC: chartTime's inverse.
export function chartToUtc(tz, t) {
  const u = fromZone(tz, t),
    fb = fallBackNear(tz, u);
  if (fb && t >= fb.at + fb.off && t < fb.at + fb.off + fb.d) return fb.at - fb.d + (t - (fb.at + fb.off)) * 2;
  return u;
}

// "Exchange": crypto runs on UTC, US stocks and FX on New York, CME futures on Chicago.
export function exchangeZone(symbol) {
  const s = String(symbol || "");
  if (s.startsWith("SPREAD:")) return exchangeZone(s.slice(7).split(" ")[0]);
  const ex = exchange(s);
  if (ex === "US" || ex === "FX" || ex === "YAHOO") return "America/New_York";
  if (ex === "CME") return "America/Chicago";
  return "Etc/UTC";
}
export function zoneOf(cs, symbol) {
  if (!cs.timezone) return localZone();
  if (cs.timezone === "exchange") return exchangeZone(symbol);
  return cs.timezone;
}
export function offsetLabel(tz) {
  const m = Math.round(tzOffset(tz, Date.now() / 1000) / 60);
  if (!m) return "UTC";
  const a = Math.abs(m);
  return `UTC${m < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}
export function zoneOptions() {
  const here = localZone(),
    list = ZONES.includes(here) || here === "UTC" ? [...ZONES] : [...ZONES, here];
  const now = Date.now() / 1000;
  const rows = list.map((tz) => [tz, `(${offsetLabel(tz)}) ${cityOf(tz)}`, tzOffset(tz, now)]);
  rows.sort((a, b) => a[2] - b[2] || (a[0] === "Etc/UTC" ? -1 : b[0] === "Etc/UTC" ? 1 : a[1].localeCompare(b[1])));
  return [["exchange", "Exchange"], ...rows.map(([tz, label]) => [tz, label])];
}
export const zoneLabel = (cs) => {
  if (cs.timezone === "exchange") return "Exchange";
  const tz = cs.timezone || localZone();
  return `(${offsetLabel(tz)}) ${tz === "UTC" ? "UTC" : cityOf(tz)}`;
};

// ---------- dates and prices ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");
// TradingView's date formats, shown with its sample day (29 Sep 1997).
export const DATE_FORMATS = ["dd MMM 'yy", "MMM dd, yyyy", "MMM d, yyyy", "dd MMM", "MMM dd", "yyyy-MM-dd", "yy-MM-dd", "yy/MM/dd", "yyyy/MM/dd", "dd-MM-yyyy", "dd-MM-yy", "dd/MM/yy", "dd/MM/yyyy", "MM/dd/yy", "MM/dd/yyyy"];
// `sec` is a wall-clock time (already moved into the chart's zone), so it's read with UTC getters.
export function fmtDate(sec, fmt = "dd MMM 'yy", dow = false) {
  const d = new Date(sec * 1000),
    y = d.getUTCFullYear();
  const out = fmt.replace(/yyyy|yy|MMM|MM|dd|d/g, (t) => ({ yyyy: y, yy: pad(y % 100), MMM: MON[d.getUTCMonth()], MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), d: d.getUTCDate() })[t]);
  return dow ? `${DOW[d.getUTCDay()]} ${out}` : out;
}
export function fmtClock(sec, h12 = false, seconds = false) {
  const d = new Date(sec * 1000),
    h = d.getUTCHours(),
    tail = `${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return h12 ? `${h % 12 || 12}:${tail} ${h < 12 ? "AM" : "PM"}` : `${pad(h)}:${tail}`;
}
const SAMPLE = Date.UTC(1997, 8, 29) / 1000;
const dateOptions = (dow) => DATE_FORMATS.map((f) => [f, fmtDate(SAMPLE, f, dow)]);

export const PRECISIONS = [
  ["default", "Default"],
  ["0", "Integer"],
  ...Array.from({ length: 15 }, (_, i) => [String(i + 1), `${i + 1} decimal${i ? "s" : ""}`]),
  ...["1/2", "1/4", "1/8", "1/16", "1/32", "1/64", "1/128", "1/320"].map((f) => [f, f]),
];
// Fractions are shown the way bond and grain futures quote them: 105'16 is 105 and 16/32.
export function precisionFormatter(p) {
  if (!p || p === "default") return null;
  if (p.includes("/")) {
    const den = Number(p.split("/")[1]),
      w = String(den - 1).length;
    return (v) => {
      if (!Number.isFinite(v)) return "—";
      const a = Math.abs(v),
        whole = Math.floor(a + 1e-9);
      let num = Math.round((a - whole) * den);
      const W = num >= den ? whole + 1 : whole;
      if (num >= den) num = 0;
      return `${v < 0 ? "-" : ""}${W.toLocaleString()}'${String(num).padStart(w, "0")}`;
    };
  }
  const n = Number(p);
  return (v) => (Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: n, maximumFractionDigits: n }) : "—");
}
export const minMoveOf = (p) => (p?.includes("/") ? 1 / Number(p.split("/")[1]) : 10 ** -Number(p));

// ---------- option lists ----------
const VIS = [["always", "Always visible"], ["hover", "Visible on mouse over"], ["hidden", "Always invisible"]];
const OPTS = {
  titleMode: [["name", "Name"], ["symbol", "Symbol"], ["both", "Symbol and name"]],
  precision: PRECISIONS,
  currencyUnit: VIS,
  scaleModes: VIS,
  placement: [["auto", "Auto"], ["left", "Left"], ["right", "Right"]],
  symLabelValue: [["scale", "Value according to scale"], ["percent", "Price and % value"]],
  hours: [["24", "24-hours"], ["12", "12-hours"]],
  bgType: [["solid", "Solid"], ["gradient", "Gradient"]],
  watermark: [["replay", "Replay mode"], ["visible", "Always visible"], ["hidden", "Always invisible"]],
  scaleFontSize: [10, 11, 12, 13, 14, 16, 18, 20, 24, 28].map((n) => [n, String(n)]),
  navButtons: VIS,
  paneButtons: VIS,
  execSoundName: [["alarm", "Alarm Clock"], ["bell", "Bell"], ["chirp", "Chirp"], ["ding", "Ding"], ["drum", "Drum"], ["pop", "Pop"], ["tick", "Tick"]],
  pnlPositions: [["money", "Money"], ["ticks", "Ticks"], ["percent", "Percentage"]],
  pnlBrackets: [["money", "Money"], ["ticks", "Ticks"], ["percent", "Percentage"]],
  alignment: [["left", "Left"], ["center", "Center"], ["right", "Right"]],
  ideasMode: [["all", "All ideas"], ["mine", "My ideas"], ["following", "Following"]],
  svpPeriod: [["Auto", "Auto"], ["Day", "Day"], ["Week", "Week"], ["Month", "Month"]],
};

// Price label rows are checklists; the button shows what's ticked ("Name, value, line").
const MULTI = {
  sym: [["symName", "Name"], ["symValue", "Value"], ["symLine", "Line"]],
  ind: [["indName", "Name"], ["indValue", "Value"]],
  hl: [["hlValue", "Value"], ["hlLine", "Line"]],
  pdc: [["pdcValue", "Value"], ["pdcLine", "Line"]],
  ba: [["baValue", "Value"], ["baLine", "Line"]],
};
const multiLabel = (cs, m) => {
  const on = MULTI[m].filter(([k]) => cs[k]).map(([, l], i) => (i ? l.toLowerCase() : l));
  return on.length ? on.join(", ") : "Hidden";
};

// ---------- sounds ----------
// Short synthesised sounds for fills and alerts (no audio files to ship).
export const SOUNDS = {
  alarm: [[1047, 0, 0.09], [1319, 0.11, 0.09], [1047, 0.22, 0.09], [1319, 0.33, 0.12]],
  bell: [[880, 0, 0.6, "sine", 1.5]],
  chirp: [[1800, 0, 0.06], [2400, 0.07, 0.06]],
  ding: [[1568, 0, 0.35, "sine", 1]],
  drum: [[110, 0, 0.18, "triangle"], [90, 0.2, 0.18, "triangle"]],
  pop: [[600, 0, 0.05, "square"]],
  tick: [[2000, 0, 0.02, "square"]],
};
let audio = null;
export function playSound(name = "alarm", volume = 50) {
  if (!(volume > 0)) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audio.currentTime + 0.01,
      peak = 0.25 * (volume / 100);
    for (const [hz, at, dur, type = "sine", decay] of SOUNDS[name] || SOUNDS.alarm) {
      const o = audio.createOscillator(),
        g = audio.createGain();
      o.type = type;
      o.frequency.value = hz;
      o.connect(g);
      g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + (decay || dur));
      o.start(t0 + at);
      o.stop(t0 + at + (decay || dur) + 0.05);
    }
  } catch {
    /* no audio */
  }
}

// ---------- the dialog ----------
const svg = (body) => `<svg viewBox="0 0 28 28">${body}</svg>`;
const TAB_ICONS = {
  symbol: svg('<path d="M9 5v4M9 19v4M19 4v5M19 17v6"/><rect x="6.5" y="9" width="5" height="10" rx="1"/><rect x="16.5" y="9" width="5" height="8" rx="1"/>'),
  status: svg('<path d="M5 7.5h18M5 12.5h18M5 17.5h11M5 22.5h7"/>'),
  scales: svg('<path d="M6 4v18h18M6 22l2-2M10 22v-2M14 22v-2M18 22v-2M6 18h2M6 14h2M6 10h2M21 19l3 3-3 3M3 7l3-3 3 3"/>'),
  canvas: svg('<path d="M18.5 5.5l4 4L10 22H6v-4zM15.5 8.5l4 4"/>'),
  trading: svg('<path d="M4 20l6-6 4 4 8-9M17 9h5v5M4 24h20"/>'),
  alerts: svg('<circle cx="14" cy="15" r="8"/><path d="M14 10.5V15l3 2M6 6.5l3-2.5M22 6.5L19 4"/>'),
  events: svg('<rect x="5" y="6.5" width="18" height="16.5" rx="2"/><path d="M5 11.5h18M10 4v5M18 4v5"/>'),
  // AskCharts AI's robot, the same as its button on the right toolbar, in a box wide enough for its ears
  ai: `<svg viewBox="-1.5 0 31 28">${PRODUCTS.find((p) => p.id === "copilot").icon}</svg>`,
  about: svg('<circle cx="14" cy="14" r="9.5"/><path d="M14 12.5v7M14 8.6v.4"/>'),
  market: svg('<ellipse cx="14" cy="7.5" rx="8" ry="3"/><path d="M6 7.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13M6 14c0 1.66 3.58 3 8 3s8-1.34 8-3"/>'),
  keys: svg('<circle cx="10" cy="18" r="5"/><path d="M13.5 14.5L23 5M18.5 9.5l3 3M16 12l2.5 2.5"/>'),
  onchain: svg('<rect x="4.5" y="4.5" width="9" height="9" rx="2"/><rect x="14.5" y="14.5" width="9" height="9" rx="2"/><path d="M13.5 9h5v5.5M9 13.5v5h5.5"/>'),
  updates: svg('<path d="M14 4.5v13M8.5 12.5l5.5 5.5 5.5-5.5M5.5 22.5h17"/>'),
};
const TABS = [
  ["symbol", "Symbol"],
  ["status", "Status line"],
  ["scales", "Scales and lines"],
  ["canvas", "Canvas"],
  ["trading", "Trading"],
  ["alerts", "Alerts"],
  ["events", "Events"],
  ["ai", "AskCharts AI"],
  ["keys", "Stock data"],
  ["market", "Crypto data"],
  ["onchain", "On chain data"],
  ["updates", "Updates"],
  ["about", "About"],
];
// the AskCharts mark, for the About tab
const ABOUT_MARK = `<defs><linearGradient id="acAbout" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c4dff"/><stop offset="1" stop-color="#2962ff"/></linearGradient></defs><path d="M14 6H50A10 10 0 0 1 60 16V40A10 10 0 0 1 50 50H27L15 60V50H14A10 10 0 0 1 4 40V16A10 10 0 0 1 14 6Z" fill="none" stroke="url(#acAbout)" stroke-width="3.5" stroke-linejoin="round"/><rect x="17.1" y="16.35" width="2.8" height="24.299999999999997" rx="1.4" fill="#f23645"/><rect x="14.2" y="20.8" width="8.6" height="14.4" rx="1.6" fill="#f23645"/><rect x="32.1" y="12.45" width="2.8" height="26.099999999999998" rx="1.4" fill="#089981"/><rect x="29.2" y="15.95" width="8.6" height="17.1" rx="1.6" fill="#089981"/><path fill="url(#acAbout)" d="M48.6 11.099999999999998Q50.06 16.939999999999998 55.9 18.4Q50.06 19.86 48.6 25.7Q47.14 19.86 41.300000000000004 18.4Q47.14 16.939999999999998 48.6 11.099999999999998Z"/>`;
const CHEVRON = '<svg viewBox="0 0 18 18" class="cs-chev"><path d="M5 7.5l4 4 4-4"/></svg>';
const INFO = (tip) => `<span class="cs-help" title="${esc(tip)}">i</span>`;
const HELP = (tip) => `<span class="cs-help q" title="${esc(tip)}">?</span>`;
const SPEAKER = '<svg viewBox="0 0 18 18" class="cs-spk"><path d="M3 7h3l4-3v10l-4-3H3zM12.5 6.5a3.5 3.5 0 0 1 0 5"/></svg>';
const CANDLE_LIKE = ["candles", "hollow", "volcandles", "heikin", "renko", "linebreak", "range", "pnf"];

export function openChartSettings(app, chartTypes, start) {
  const cs = app.settings.chart;
  const appKeys = ["bars", "volume", "syncCrosshair"];
  const before = { chart: structuredClone(cs), app: Object.fromEntries(appKeys.map((k) => [k, app.settings[k]])) };
  let tab = start || app.settings.chartSettingsTab || "symbol";
  if (!TABS.some(([k]) => k === tab)) tab = "symbol";
  const card = app.modal(
    "Settings",
    `<div class="cs-wrap"><nav class="cs-nav">${TABS.map(([k, label]) => `<button data-tab="${k}">${TAB_ICONS[k]}<span>${label}</span></button>`).join("")}</nav><div class="cs-page"></div></div>`,
    { foot: `<button class="cs-dd cs-tpl" data-x="tpl">Template${CHEVRON}</button><span class="spacer"></span><button class="btn" data-x="cancel">Cancel</button><button class="btn primary cs-ok" data-x="ok">Ok</button>` },
  );
  card.classList.add("cs-card");
  // AskCharts AI's provider, key and model live on the server; this tab only edits them until Ok.
  const ai = aiSettings(app);
  ai.load().then(() => {
    if (tab === "ai" && card.isConnected) redraw();
  });
  const page = card.querySelector(".cs-page");
  // Crypto data: the history store's status, read every few seconds while its tab is open. The card is
  // reused by the next dialog, so it's the page that says whether this one is still open.
  const md = marketData();
  let mdStale = false;
  md.load().then(() => {
    if (tab === "market" && page.isConnected) redraw();
  });
  // XRPL On chain: its settings and what the collector reports, read every few seconds while its tab is open
  const oc = onchainData();
  let ocStale = false;
  oc.load().then(() => {
    if (tab === "onchain" && page.isConnected) redraw();
  });
  // Stock data: your own keys for live US stock prices, and the stock history under them (read every few
  // seconds while the tab is open, as Crypto data is)
  const dk = dataKeys();
  dk.load().then(() => {
    if (tab === "keys" && page.isConnected) redraw();
  });
  // Crypto data's Binance section, read every few seconds while the tab is open
  const bh = binanceHistory(app);
  let bhStale = false;
  bh.load().then(() => {
    if (tab === "market" && page.isConnected) redraw();
  });
  const sh = stockHistory(app);
  let shStale = false;
  sh.load().then(() => {
    if (tab === "keys" && page.isConnected) redraw();
  });
  // the version, and Check now and Update now
  const up = updatesPage();
  up.load().then(() => {
    if (tab === "updates" && page.isConnected) redraw();
  });
  const poll = setInterval(async () => {
    if (!page.isConnected) return clearInterval(poll);
    if (tab !== "market" || document.hidden) return;
    if (await md.load()) mdStale = true;
    // a change that arrives while a coin is being typed waits until the typing stops
    if (mdStale && tab === "market" && page.isConnected && !md.typing(page)) {
      mdStale = false;
      redraw();
    }
  }, 4000);
  const bhPoll = setInterval(async () => {
    if (!page.isConnected) return clearInterval(bhPoll);
    if (tab !== "market" || document.hidden) return;
    if (await bh.load()) bhStale = true;
    if (bhStale && tab === "market" && page.isConnected && !bh.typing(page) && !md.typing(page)) {
      bhStale = false;
      redraw();
    }
  }, 4000);
  const shPoll = setInterval(async () => {
    if (!page.isConnected) return clearInterval(shPoll);
    if (tab !== "keys" || document.hidden) return;
    if (await sh.load()) shStale = true;
    if (shStale && tab === "keys" && page.isConnected && !sh.typing(page)) {
      shStale = false;
      redraw();
    }
  }, 4000);
  const ocPoll = setInterval(async () => {
    if (!page.isConnected) return clearInterval(ocPoll);
    if (tab !== "onchain" || document.hidden) return;
    if (await oc.load()) ocStale = true;
    // a change that arrives while a server is being typed waits until it's saved or put back
    if (ocStale && tab === "onchain" && page.isConnected && !oc.typing(page)) {
      ocStale = false;
      redraw();
    }
  }, 4000);
  const restore = () => {
    for (const k of Object.keys(cs)) delete cs[k];
    Object.assign(cs, before.chart);
    Object.assign(app.settings, before.app);
    app.applyChartSettings();
  };
  app.onModalClose = restore;

  const get = (k) => (k[0] === "@" ? app.settings[k.slice(1)] : cs[k]);
  const set = (k, v) => {
    if (k[0] === "@") app.settings[k.slice(1)] = v;
    else cs[k] = v;
    app.applyChartSettings();
  };
  const optLabel = (k, v) => (k === "timezone" ? zoneLabel(cs) : k === "dateFormat" ? fmtDate(SAMPLE, v, cs.dayOfWeek) : (OPTS[k] || []).find(([x]) => String(x) === String(v))?.[1] ?? String(v));

  // ---- controls ----
  const chk = (k, label, { dis = false, tip = "" } = {}) =>
    `<label class="cs-chk${dis ? " dis" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><input type="checkbox" data-k="${k}" ${get(k) ? "checked" : ""} ${dis ? "disabled" : ""}><span class="cs-box"></span><span>${label}</span></label>`;
  const dd = (k, { dis = false, wide = false, tip = "" } = {}) =>
    `<button class="cs-dd${wide ? " wide" : ""}" data-dd="${k}" ${dis ? "disabled" : ""}${tip ? ` title="${esc(tip)}"` : ""}><span>${esc(optLabel(k, k === "timezone" ? cs.timezone : get(k)))}</span>${CHEVRON}</button>`;
  const sw = (k, { dis = false, op = true, title = "" } = {}) =>
    `<button class="cs-sw${k === "alertLineColor" && !cs[k] ? " auto" : ""}" data-sw="${k}" data-op="${op ? 1 : 0}" style="--c:${esc(colorOf(cs, k) || "#089981")}" ${dis ? "disabled" : ""} title="${esc(title || (k === "alertLineColor" && !cs[k] ? "Green for alerts above the price, red below" : ""))}"></button>`;
  const multi = (m, { dis = false } = {}) =>
    `<button class="cs-dd" data-multi="${m}" ${dis ? "disabled" : ""}><span>${esc(multiLabel(cs, m))}</span>${CHEVRON}</button>`;
  const ln = (ck, sk, wk, { dis = false } = {}) =>
    `<button class="cs-ln" data-ln="${ck},${sk || ""},${wk || ""}" ${dis ? "disabled" : ""}>${ck ? `<span class="cs-sw-in" style="--c:${esc(colorOf(cs, ck) || "#787b86")}"></span>` : ""}${sk || wk ? lineIcon(STYLES.find(([s]) => s === (cs[sk] || "solid"))?.[2] ?? "", Math.min(3, cs[wk] || 1)) : ""}</button>`;
  const num = (k, { min = 0, max = 100, step = 1, unit = "", dis = false } = {}) =>
    `<span class="cs-numw"><input class="cs-num" type="number" data-n="${k}" min="${min}" max="${max}" step="${step}" value="${get(k) ?? ""}" ${dis ? "disabled" : ""}>${unit ? `<span class="cs-unit">${unit}</span>` : ""}</span>`;
  const range = (k, { dis = false } = {}) => `<input class="cs-range" type="range" min="0" max="100" data-r="${k}" value="${get(k)}" ${dis ? "disabled" : ""}>`;

  // ---- rows: a two-column grid, like TradingView's ----
  const sec = (t) => `<div class="cs-sec">${t}</div>`;
  // A row with nothing on the right spans both columns, so long labels don't push the controls over.
  const row = (left, right = "", { ind = false, hint = "", dis = false } = {}) =>
    `<div class="cs-l${right ? "" : " span"}${ind ? " ind" : ""}${dis ? " dis" : ""}">${left}</div>${right ? `<div class="cs-c${dis ? " dis" : ""}">${right}</div>` : ""}${hint ? `<div class="cs-hint${ind ? " ind" : ""}">${hint}</div>` : ""}`;
  const label = (t) => `<span class="cs-lab">${t}</span>`;

  const PAGES = {
    symbol() {
      const t = app.active?.cfg.type || "candles",
        name = (chartTypes.find(([k]) => k === t)?.[1] || "Candles").toUpperCase();
      let h = sec(name);
      if (CANDLE_LIKE.includes(t)) {
        if (t !== "hollow" && t !== "pnf") h += row(chk("prevClose", "Color bars based on previous close"));
        h += row(chk("body", "Body"), `${sw("bodyUp")}${sw("bodyDown")}`);
        h += row(chk("borders", "Borders"), `${sw("borderUp")}${sw("borderDown")}`);
        h += row(chk("wick", "Wick"), `${sw("wickUp")}${sw("wickDown")}`);
      } else if (t === "bars") {
        h += row(chk("prevClose", "Color bars based on previous close"));
        h += row(chk("hlcBars", "HLC bars"));
        h += row(label("Up color"), sw("barUp"));
        h += row(label("Down color"), sw("barDown"));
        h += row(chk("thinBars", "Thin bars"));
      } else if (t === "kagi") {
        h += row(label("Up line"), sw("bodyUp"));
        h += row(label("Down line"), sw("bodyDown"));
        h += row(label("Line width"), ln("", "", "lineWidth"));
      } else if (["line", "linemarkers", "step"].includes(t)) {
        h += row(label("Line"), ln("lineColor", "lineStyle", "lineWidth"));
      } else if (t === "area") {
        h += row(label("Line"), ln("areaLine", "", "areaWidth"));
        h += row(label("Fill"), `${sw("areaTop")}${sw("areaBottom")}`);
      } else if (t === "baseline") {
        h += row(label("Top line"), sw("baseTop"));
        h += row(label("Bottom line"), sw("baseBottom"));
      } else if (t === "columns") {
        h += row(chk("prevClose", "Color bars based on previous close"));
        h += row(label("Up color"), sw("colUp"));
        h += row(label("Down color"), sw("colDown"));
      } else if (t === "hlcarea") {
        h += row(label("High line"), sw("hlcHigh"));
        h += row(label("Low line"), sw("hlcLow"));
        h += row(label("Close line"), sw("hlcClose"));
        h += row(label("Fill"), `${sw("hlcUpFill", { title: "Between high and close" })}${sw("hlcDownFill", { title: "Between close and low" })}`);
      } else if (t === "highlow") {
        h += row(label("Body"), sw("hiloColor"));
        h += row(chk("hiloBorders", "Borders"));
        h += row(chk("hiloLabels", "Labels"), "", { hint: "The high and low values above and below each bar, when there's room" });
      } else if (t === "svp") {
        h += row(label("Session"), dd("svpPeriod"));
        h += row(label("Rows"), num("svpRows", { min: 4, max: 200 }));
        h += row(label("Width"), num("svpWidth", { min: 5, max: 100, unit: "% of session" }));
        h += row(label("Value area"), num("svpVA", { min: 10, max: 100, unit: "%" }));
      }
      h += row(chk("@volume", "Volume bars on the chart"));
      h += sec("DATA MODIFICATION");
      h += row(label("Precision"), dd("precision"));
      h += row(label("Timezone"), dd("timezone", { wide: true }));
      h += row(label("Bars to load"), num("@bars", { min: 200, max: 20000, step: 100 }));
      return h;
    },
    status() {
      let h = sec("INSTRUMENT");
      h += row(chk("logo", "Logo"));
      h += row(chk("title", "Title"), dd("titleMode", { dis: !cs.title }));
      h += row(chk("marketStatus", "Open market status"));
      h += row(chk("chartValues", "Chart values"));
      h += row(chk("barChange", "Bar change values"));
      h += row(chk("legendVolume", "Volume"));
      h += row(chk("lastDayChange", "Last day change values"));
      h += row(chk("buySell", "Buy/sell buttons"), "", { hint: "Displays buy and sell buttons directly on the chart" });
      h += sec("INDICATORS");
      h += row(chk("indTitles", "Titles"));
      h += row(chk("indInputs", "Inputs", { dis: !cs.indTitles }), "", { ind: true });
      h += row(chk("indValues", "Values"));
      h += row(chk("legendBg", "Background"), range("legendBgOpacity", { dis: !cs.legendBg }));
      return h;
    },
    scales() {
      let h = sec("PRICE SCALE");
      h += row(label("Currency and Unit"), dd("currencyUnit"));
      h += row(label("Scale modes (A and L)"), dd("scaleModes"));
      h += row(chk("lockRatio", "Lock price to bar ratio"), num("lockRatioValue", { min: 0, max: 1e9, step: "any", dis: !cs.lockRatio }));
      h += row(label("Scales placement"), dd("placement"));
      h += sec("PRICE LABELS &amp; LINES");
      h += row(chk("noOverlap", "No overlapping labels"));
      h += row(`${chk("plusButton", "Plus button")}${HELP("A + on the price scale where the crosshair is: add an alert, an order or a horizontal line at that price.")}`);
      h += row(chk("countdown", "Countdown to bar close"));
      h += row(label("Symbol"), `${multi("sym")}${ln("symLineColor", "symLineStyle", "symLineWidth", { dis: !cs.symLine })}`);
      h += row("", dd("symLabelValue", { dis: !cs.symValue && !cs.symName }));
      h += row(label("Previous day close"), `${multi("pdc")}${ln("pdcColor", "pdcStyle", "pdcWidth", { dis: !cs.pdcValue && !cs.pdcLine })}`);
      h += row(label("Indicators and financials"), multi("ind"));
      h += row(label("High and low"), `${multi("hl")}${ln("highLowColor", "highLowStyle", "highLowWidth", { dis: !cs.hlValue && !cs.hlLine })}`);
      const crypto = ["BINANCE", "COINBASE", "KRAKEN"].includes(exchange(app.active?.cfg.symbol));
      const noBa = !cs.baValue && !cs.baLine;
      h += row(label("Bid and ask"), `${multi("ba")}${sw("bidColor", { dis: noBa, title: "Bid" })}${sw("askColor", { dis: noBa, title: "Ask" })}`, {
        hint: crypto ? "" : "Bid and ask come from Binance, Coinbase and Kraken, so they show on crypto charts only.",
      });
      h += sec("TIME SCALE");
      h += row(chk("dayOfWeek", "Day of week on labels"));
      h += row(label("Date format"), dd("dateFormat"));
      h += row(label("Time hours format"), dd("hours"));
      h += row(chk("keepLeftEdge", "Save chart left edge position when changing interval"));
      return h;
    },
    canvas() {
      let h = sec("CHART BASIC STYLES");
      h += row(label("Background"), `${dd("bgType")}${cs.bgType === "gradient" ? `${sw("bgTop", { op: false })}${sw("bgBottom", { op: false })}` : sw("bg", { op: false })}`);
      h += row(chk("vertGrid", "Vertical grid lines"), ln("vertGridColor", "vertGridStyle", "", { dis: !cs.vertGrid }));
      h += row(chk("horzGrid", "Horizontal grid lines"), ln("horzGridColor", "horzGridStyle", "", { dis: !cs.horzGrid }));
      h += row(label("Pane separators"), sw("separatorColor"));
      h += row(label("Crosshair"), ln("crosshairColor", "crosshairStyle", "crosshairWidth"));
      h += row(chk("@syncCrosshair", "Sync crosshair across charts"));
      h += row(label("Watermark"), `${dd("watermark")}${sw("watermarkColor", { dis: cs.watermark === "hidden" })}`);
      h += sec("SCALES");
      h += row(label("Text"), `${sw("scaleTextColor")}${dd("scaleFontSize")}`);
      h += row(label("Lines"), sw("scaleLineColor"));
      h += sec("BUTTONS");
      h += row(label("Navigation"), dd("navButtons"));
      h += row(label("Pane"), dd("paneButtons"));
      h += sec("MARGINS");
      h += row(label("Top"), num("marginTop", { min: 0, max: 25, unit: "%" }));
      h += row(label("Bottom"), num("marginBottom", { min: 0, max: 25, unit: "%" }));
      h += row(label("Right"), num("marginRight", { min: 0, max: 500, unit: "bars" }));
      return h;
    },
    trading() {
      let h = sec("GENERAL");
      h += row(chk("buySell", "Buy/sell buttons"), "", { hint: "Displays buy and sell buttons directly on the chart" });
      h += row(`${chk("oneClick", "One-click trading")}${HELP("Paper trading only. Off: the chart's Buy and Sell buttons ask before sending the order.")}`, "", { hint: "Instantly place, edit, cancel orders, or close positions without confirmation" });
      h += row(chk("execSound", "Execution sound"), `${SPEAKER}${range("execVolume", { dis: !cs.execSound })}`);
      h += row("", dd("execSoundName", { dis: !cs.execSound }));
      h += row(chk("rejectOnly", "Show only rejection notifications"));
      h += sec("APPEARANCE");
      h += row(`${chk("positions", "Positions and orders")}${INFO("Your paper trading positions and working orders as lines on the chart.")}`);
      h += row(chk("reverseButton", "Reverse position button", { dis: !cs.positions }), "", { ind: true, hint: "Adds the reverse button next to the open position on the chart" });
      h += row(chk("projectOrder", "Project order for market orders"), "", { hint: "Shows a project order on the chart before sending a market order" });
      h += row(`${chk("pnl", "Profit and loss value")}${HELP("Open profit or loss on position lines, and the profit or loss a stop or target would lock in.")}`);
      h += row(chk("pnlPos", "Positions", { dis: !cs.pnl }), dd("pnlPositions", { dis: !cs.pnl || !cs.pnlPos }), { ind: true });
      h += row(chk("pnlBr", "Brackets", { dis: !cs.pnl }), dd("pnlBrackets", { dis: !cs.pnl || !cs.pnlBr }), { ind: true });
      h += row(`${chk("execMarks", "Execution marks")}${INFO("An arrow on the bar where each paper trade filled.")}`);
      h += row(chk("execLabels", "Execution labels", { dis: !cs.execMarks }), "", { ind: true });
      h += row(chk("extendLines", "Extended price lines across the entire chart width"));
      h += row(label("Order and position alignment"), dd("alignment"));
      h += row(chk("inSnapshots", "Orders, executions, and positions in chart snapshots"), "", { hint: "Shows your trades on the chart in snapshots" });
      return h;
    },
    alerts() {
      let h = sec("CHART LINE VISIBILITY");
      h += row(chk("alertLines", "Alert lines"), sw("alertLineColor", { dis: !cs.alertLines }));
      h += row(chk("onlyActiveAlerts", "Only active alerts", { dis: !cs.alertLines }));
      h += sec("NOTIFICATIONS");
      h += row(chk("alertSound", "Alert volume"), `${SPEAKER}${range("alertVolume", { dis: !cs.alertSound })}`);
      h += row(`${chk("autoHideToasts", "Automatically hide toasts")}${HELP("Off: an alert's pop-up stays until you close it.")}`);
      return h;
    },
    ai() {
      return ai.html();
    },
    market() {
      return `${md.html()}${bh.html()}<div class="cs-sec">OTHER EXCHANGES</div><div class="md-wrap"><p class="ai-lead">Coinbase isn't stored yet: its charts use its own feed, up to 20,000 bars.</p></div>`;
    },
    onchain() {
      return oc.html();
    },
    keys() {
      return `${dk.html()}${sh.html()}`;
    },
    updates() {
      return up.html();
    },
    // What AskCharts is built on, with the credits the licences ask for: TradingView's attribution
    // notice and a link to tradingview.com (Lightweight Charts, Apache 2.0; it replaces the logo that
    // used to sit on the chart) and Quant Terminal's MIT notice.
    about() {
      const lw = window.LightweightCharts?.version?.() || "";
      const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return `<div class="cs-sec">ABOUT</div><div class="ab-wrap">
        <div class="ab-head"><div class="ab-name">AskCharts<svg class="ab-mark" viewBox="2.25 4.25 59.5 57.5" width="23" height="22" aria-hidden="true" style="width:23px;height:22px">${ABOUT_MARK}</svg></div><div class="ab-sub">askcharts.pro. Charts, backtests and an AI that works on the chart for you.</div></div>
        <div class="ab-h">Charts</div>
        <p>TradingView Lightweight Charts&trade;${lw ? ` v${esc(lw)}` : ""}<br>Copyright (c) 2026 TradingView, Inc. Licensed under the Apache License 2.0.<br>${link("https://www.tradingview.com/", "tradingview.com")}</p>
        <div class="ab-h">Built on</div>
        <p>Quant Terminal, copyright (c) 2026 Lewis Jackson, MIT licence.</p>
        <div class="ab-h">Market data</div>
        <p>From public sources (Binance, Coinbase, Kraken, Nasdaq, Yahoo Finance and Forex Factory), each under its own terms, and from any data keys you add. For your own analysis. Nothing here is financial advice.</p>
        <p class="ab-small">AskCharts is an independent project, not affiliated with or endorsed by TradingView, Inc. TradingView and Pine Script are trademarks of TradingView, Inc.</p>
      </div>`;
    },
    events() {
      let h = sec("EVENTS");
      const noIdeas = "Ideas are posts from TradingView's community. There's no ideas feed here.";
      h += row(chk("ideas", "Ideas", { dis: true, tip: noIdeas }), `${dd("ideasMode", { dis: true, tip: noIdeas })}${HELP(noIdeas)}`, { dis: true });
      h += row(chk("econEvents", "Economic events"));
      h += row(chk("onlyFuture", "Only future events", { dis: !cs.econEvents }), "", { ind: true });
      h += row(chk("eventBreaks", "Events breaks", { dis: !cs.econEvents }), ln("eventBreaksColor", "eventBreaksStyle", "eventBreaksWidth", { dis: !cs.econEvents || !cs.eventBreaks }), { ind: true });
      h += row(chk("latestNews", "Latest news"));
      h += row(chk("newsNotify", "News notification"));
      return h;
    },
  };
  OPTS.ideasMode ||= [["all", "All ideas"]];
  cs.ideasMode ||= "all";

  const show = (t) => {
    tab = t;
    app.settings.chartSettingsTab = t;
    card.querySelectorAll(".cs-nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    const top = page.dataset.tab === t ? page.scrollTop : 0;
    page.dataset.tab = t;
    page.innerHTML = `<div class="cs-grid">${PAGES[t]()}</div>`;
    page.scrollTop = top;
    if (t === "ai") ai.bind(page, redraw);
    if (t === "market") {
      md.bind(page, redraw);
      bh.bind(page, redraw);
    }
    if (t === "onchain") oc.bind(page, redraw);
    if (t === "keys") {
      dk.bind(page, redraw);
      sh.bind(page, redraw);
    }
    if (t === "updates") up.bind(page, redraw);
    for (const b of page.querySelectorAll("[data-cs-goto]")) b.onclick = () => show(b.dataset.csGoto);
  };
  const redraw = () => show(tab);
  card.querySelector(".cs-nav").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) show(b.dataset.tab);
  };

  // ---- popovers (the floating toolbar's, so Esc and outside clicks close them the same way) ----
  const tb = app.drawToolbar;
  const ddList = (btn, k) => {
    let items = k === "timezone" ? zoneOptions() : k === "dateFormat" ? dateOptions(cs.dayOfWeek) : OPTS[k];
    const cur = k === "timezone" ? cs.timezone : get(k);
    const pop = tb.openPopover(btn, items.map(([v, l]) => `<button data-v="${esc(v)}" class="${String(v) === String(cur) || (k === "timezone" && !cur && v === localZone()) ? "on" : ""}">${esc(l)}</button>`).join(""), "cs-dd");
    pop.classList.add("dtb-list", "cs-ddlist");
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${r.width}px`;
    const h = pop.offsetHeight,
      below = innerHeight - r.bottom - 8,
      above = r.top - 8;
    const room = below >= Math.min(h, 240) || below >= above ? below : above;
    pop.style.maxHeight = `${Math.max(120, room)}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${room === below ? r.bottom + 4 : Math.max(4, r.top - 4 - pop.offsetHeight)}px`;
    pop.querySelector(".on")?.scrollIntoView({ block: "center" });
    pop.onclick = (e) => {
      const it = e.target.closest("[data-v]");
      if (!it) return;
      tb.closePopover();
      let v = it.dataset.v;
      if (k === "scaleFontSize") v = Number(v);
      if (k === "timezone" && v === localZone()) v = "";
      set(k, v);
      redraw();
    };
  };
  const linePop = (btn, [ck, sk, wk]) => {
    const cur = rgbOf(colorOf(cs, ck)),
      curHex = hexOf(cur);
    const grid = PALETTE.map((r) => `<div class="dtb-row">${r.map((c) => `<button data-c="${c}" class="dtb-sw${c === curHex ? " on" : ""}" style="--c:${c}"></button>`).join("")}</div>`).join("");
    const widths = wk ? `<div class="cs-pop-h">Thickness</div><div class="cs-seg">${[1, 2, 3, 4].map((w) => `<button data-w="${w}" class="${(cs[wk] || 1) === w ? "on" : ""}">${lineIcon("", w)}</button>`).join("")}</div>` : "";
    const styles = sk ? `<div class="cs-pop-h">Line style</div><div class="cs-seg">${STYLES.map(([s, l, dash]) => `<button data-s="${s}" title="${l}" class="${(cs[sk] || "solid") === s ? "on" : ""}">${lineIcon(dash, 2)}</button>`).join("")}</div>` : "";
    // a width-only control (Kagi's line) skips the colours
    const colors = ck ? `${grid}<div class="dtb-custom"><label><input type="color" value="${curHex}"> Custom</label><label class="dtb-op">Opacity <input type="range" min="0" max="100" value="${Math.round(cur.a * 100)}"><b>${Math.round(cur.a * 100)}%</b></label></div>` : "";
    const pop = tb.openPopover(btn, `${colors}${widths}${styles}`, "cs-ln");
    pop.classList.add("dtb-colors", "cs-linepop");
    let hex = curHex,
      a = cur.a;
    const paint = () => {
      set(ck, cssOf({ ...rgbOf(hex), a }));
      btn.querySelector(".cs-sw-in")?.style.setProperty("--c", colorOf(cs, ck));
    };
    pop.onclick = (e) => {
      const c = e.target.closest("[data-c]"),
        w = e.target.closest("[data-w]"),
        s = e.target.closest("[data-s]");
      if (c) {
        hex = c.dataset.c;
        pop.querySelectorAll(".dtb-sw").forEach((x) => x.classList.toggle("on", x === c));
        paint();
      }
      if (w) {
        set(wk, Number(w.dataset.w));
        pop.querySelectorAll("[data-w]").forEach((x) => x.classList.toggle("on", x === w));
      }
      if (s) {
        set(sk, s.dataset.s);
        pop.querySelectorAll("[data-s]").forEach((x) => x.classList.toggle("on", x === s));
      }
      if (w || s) {
        const ico = btn.querySelector(".dtb-line");
        if (ico) ico.outerHTML = lineIcon(STYLES.find(([x]) => x === (cs[sk] || "solid"))?.[2] ?? "", Math.min(3, cs[wk] || 1));
      }
    };
    if (!ck) return;
    pop.querySelector("input[type=color]").oninput = (e) => {
      hex = e.target.value;
      paint();
    };
    pop.querySelector("input[type=range]").oninput = (e) => {
      a = Number(e.target.value) / 100;
      pop.querySelector(".dtb-op b").textContent = `${e.target.value}%`;
      paint();
    };
  };

  const multiPop = (btn, m) => {
    const pop = tb.openPopover(btn, MULTI[m].map(([k, l]) => `<button data-k="${k}" class="cs-mi${cs[k] ? " on" : ""}"><span class="cs-tick"></span>${l}</button>`).join(""), "cs-multi");
    pop.classList.add("dtb-list", "cs-ddlist");
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${r.width}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${r.bottom + 4 + pop.offsetHeight < innerHeight ? r.bottom + 4 : r.top - 4 - pop.offsetHeight}px`;
    pop.onclick = (e) => {
      const it = e.target.closest("[data-k]");
      if (!it) return;
      set(it.dataset.k, !cs[it.dataset.k]);
      it.classList.toggle("on", !!cs[it.dataset.k]);
      redraw();
    };
  };

  page.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[type=checkbox][data-k]")) {
      // Locking the ratio starts from the one on screen now.
      if (t.dataset.k === "lockRatio" && t.checked && !(cs.lockRatioValue > 0)) cs.lockRatioValue = app.active?.extras?.currentRatio() || 0;
      set(t.dataset.k, t.checked);
      redraw();
    } else if (t.matches("[data-n]")) {
      const k = t.dataset.n,
        v = Number(t.value);
      if (!Number.isFinite(v) || t.value === "") return (t.value = get(k) ?? "");
      const c = Math.max(Number(t.min), Math.min(Number(t.max), v));
      t.value = c;
      set(k, c);
    }
  });
  page.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches("[data-r]")) set(t.dataset.r, Number(t.value));
  });
  page.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.dd) return ddList(b, b.dataset.dd);
    if (b.dataset.multi) return multiPop(b, b.dataset.multi);
    if (b.dataset.sw) {
      const k = b.dataset.sw;
      return tb.colorPopover(b, colorOf(cs, k), b.dataset.op === "1", (c) => {
        set(k, c);
        b.style.setProperty("--c", c);
      });
    }
    if (b.dataset.ln) return linePop(b, b.dataset.ln.split(","));
  });
  // Enter in a number box applies it without closing the dialog.
  page.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-n]")) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // ---- footer ----
  card.querySelector("[data-x=cancel]").onclick = () => app.closeModal();
  card.querySelector("[data-x=ok]").onclick = () => {
    // a key that was typed but not tested stays here rather than being lost or saved unchecked
    const wait = ai.pending();
    if (wait) {
      show("ai");
      return app.toast(wait, "err");
    }
    app.onModalClose = null;
    tb.closePopover();
    app.closeModal();
    app.persist();
    if (before.app.bars !== app.settings.bars) app.panes.forEach((p) => p.load({ keepView: true }));
    ai.commit().then(
      (msg) => msg && app.toast(msg),
      (e) => app.toast(`AskCharts AI settings weren't saved: ${esc(e.message)}`, "err"),
    );
  };
  card.querySelector("[data-x=tpl]").onclick = (e) => templateMenu(e.currentTarget);
  const templateMenu = (btn) => {
    const saved = (app.settings.chartTemplates ||= {});
    const names = Object.keys(saved).sort((a, b) => a.localeCompare(b));
    const pop = tb.openPopover(
      btn,
      `${names.map((n) => `<div class="cs-tplrow"><button data-t="${esc(n)}">${esc(n)}</button><button class="cs-tplx" data-del="${esc(n)}" title="Remove template">✕</button></div>`).join("")}${names.length ? "<hr>" : ""}<button data-a="defaults">Apply defaults</button><button data-a="save">Save as…</button>`,
      "cs-tpl",
    );
    pop.classList.add("dtb-list", "cs-tplpop");
    const r = btn.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 4 + pop.offsetHeight < innerHeight ? r.bottom + 4 : r.top - 4 - pop.offsetHeight}px`;
    const use = (vals) => {
      const keep = { ideasMode: cs.ideasMode };
      for (const k of Object.keys(cs)) delete cs[k];
      Object.assign(cs, structuredClone(CHART_DEFAULTS), structuredClone(vals || {}), keep);
      app.applyChartSettings();
      redraw();
    };
    pop.onclick = (e) => {
      const t = e.target.closest("[data-t]")?.dataset.t,
        del = e.target.closest("[data-del]")?.dataset.del,
        a = e.target.closest("[data-a]")?.dataset.a;
      if (del) {
        delete saved[del];
        tb.closePopover();
        return templateMenu(btn);
      }
      if (t) {
        tb.closePopover();
        return use(saved[t]);
      }
      if (a === "defaults") {
        tb.closePopover();
        return use(null);
      }
      if (a === "save") {
        pop.innerHTML = `<div class="cs-save"><input class="in" placeholder="Template name" maxlength="40"><button class="btn primary small">Save</button></div>`;
        const inp = pop.querySelector("input");
        inp.focus();
        const save = () => {
          const n = inp.value.trim();
          if (!n) return inp.focus();
          saved[n] = structuredClone(cs);
          tb.closePopover();
          app.toast(`Saved the template "${esc(n)}".`);
        };
        pop.querySelector("button").onclick = save;
        inp.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") save();
          if (ev.key === "Escape") tb.closePopover();
        };
      }
    };
  };

  show(tab);
  return card;
}

// Ticker without the exchange, and the quote currency it's priced in (XRPUSD is in USD).
export function quoteCurrency(symbol) {
  const ex = exchange(symbol),
    t = ticker(symbol).replace(/[-_/]/g, "");
  if (ex === "US" || ex === "CME" || ex === "YAHOO") return "USD";
  return (/(USDT|USDC|USD|EUR|GBP|JPY|CAD|AUD|CHF|BTC|ETH|BNB)$/.exec(t) || [""])[0];
}
