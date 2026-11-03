// Earnings and dividend calendars, news, financial statements and key stats. Nasdaq's public API
// for US stocks; Cointelegraph's and Decrypt's RSS feeds for crypto headlines.
import { getJson, cached, NQ, resolve } from "./providers.js";

const OFFLINE = process.env.QT_OFFLINE === "1";
const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const ymd = (d) => d.toISOString().slice(0, 10);

// The next n weekdays starting today (UTC).
function weekdays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function earnings(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`earnings:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
          NQ,
        );
        return (j?.data?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.name,
          when:
            r.time === "time-pre-market"
              ? "Before the open"
              : r.time === "time-after-hours"
                ? "After the close"
                : "Time not given",
          marketCap: num(r.marketCap),
          epsForecast: r.epsForecast || "",
          quarter: r.fiscalQuarterEnding || "",
          lastYearEps: r.lastYearEPS || "",
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

// IPOs from Nasdaq's IPO calendar: upcoming (expected), priced and filed, this month and next.
export async function ipos() {
  if (OFFLINE) return { upcoming: [], priced: [], filed: [] };
  const now = new Date();
  const months = [0, 1].map((k) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const pages = await Promise.all(
    months.map((m) =>
      cached(`ipos:${m}`, 60 * 60e3, async () => (await getJson(`https://api.nasdaq.com/api/ipo/calendar?date=${m}`, NQ))?.data || {}).catch(() => ({})),
    ),
  );
  const row = (r, kind) => ({
    kind,
    ticker: r.proposedTickerSymbol || "",
    symbol: r.proposedTickerSymbol ? `US:${r.proposedTickerSymbol}` : "",
    name: r.companyName || "",
    exchange: r.proposedExchange || "",
    price: r.proposedSharePrice || "",
    shares: num(r.sharesOffered),
    value: num(r.dollarValueOfSharesOffered),
    date: r.expectedPriceDate || r.pricedDate || r.filedDate || "",
  });
  const seen = new Set();
  const uniq = (list) => list.filter((r) => !seen.has(`${r.kind}|${r.name}`) && seen.add(`${r.kind}|${r.name}`));
  const pick = (k, kind) => uniq(pages.flatMap((p) => (k === "upcoming" ? p.upcoming?.upcomingTable?.rows : p[k]?.rows) || []).map((r) => row(r, kind)));
  return { upcoming: pick("upcoming", "upcoming"), priced: pick("priced", "priced"), filed: pick("filed", "filed") };
}

export async function dividends(days = 5) {
  if (OFFLINE) return [];
  const dates = weekdays(Math.min(10, Math.max(1, days)));
  const perDay = await Promise.all(
    dates.map((date) =>
      cached(`dividends:${date}`, 30 * 60e3, async () => {
        const j = await getJson(
          `https://api.nasdaq.com/api/calendar/dividends?date=${date}`,
          NQ,
        );
        return (j?.data?.calendar?.rows || []).map((r) => ({
          date,
          symbol: `US:${r.symbol}`,
          ticker: r.symbol,
          name: r.companyName,
          exDate: r.dividend_Ex_Date,
          payDate: r.payment_Date,
          recordDate: r.record_Date,
          amount: r.dividend_Rate,
          annual: r.indicated_Annual_Dividend,
        }));
      }).catch(() => []),
    ),
  );
  return perDay.flat();
}

// ---------- news ----------
const COIN_NAMES = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  SOL: ["solana", "sol"],
  XRP: ["xrp", "ripple"],
  BNB: ["bnb", "binance coin"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link"],
  DOT: ["polkadot"],
  LTC: ["litecoin", "ltc"],
  TRX: ["tron", "trx"],
  TON: ["toncoin", "ton"],
  SHIB: ["shiba inu", "shib"],
  PEPE: ["pepe"],
  SUI: ["sui"],
  NEAR: ["near protocol", "near"],
  ZEC: ["zcash", "zec"],
};
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();

export function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) =>
      decode(
        (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block) ||
          [])[1] || "",
      );
    const title = pick("title");
    if (!title) continue;
    items.push({
      title,
      url: pick("link"),
      source,
      time: Date.parse(pick("pubDate")) || null,
      summary: pick("description").slice(0, 280),
    });
  }
  return items;
}

async function cryptoNews() {
  return cached("news:crypto", 10 * 60e3, async () => {
    const feeds = [
      ["https://cointelegraph.com/rss", "Cointelegraph"],
      ["https://decrypt.co/feed", "Decrypt"],
    ];
    const lists = await Promise.all(
      feeds.map(async ([url, name]) => {
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 QuantTerminal" },
            signal: AbortSignal.timeout(10000),
          });
          return res.ok ? parseRss(await res.text(), name) : [];
        } catch {
          return [];
        }
      }),
    );
    return lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
  });
}

export async function news(symbol) {
  if (OFFLINE) return { items: [], note: "" };
  const sym = await resolve(symbol);
  if (["BINANCE", "COINBASE", "KRAKEN"].includes(sym.exchange)) {
    const base =
      sym.ticker
        .replace(/-|\.P$/g, "")
        .replace(/(USDT|USDC|FDUSD|USD|BTC|ETH|EUR)$/, "")
        .replace(/^XBT$/, "BTC") || "BTC";
    const all = await cryptoNews();
    const words = COIN_NAMES[base] || [base.toLowerCase()];
    const re = new RegExp(
      `\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "i",
    );
    const hits = all.filter((n) => re.test(`${n.title} ${n.summary}`));
    return hits.length >= 3
      ? { items: hits.slice(0, 30), note: `Headlines mentioning ${base}` }
      : {
          items: all.slice(0, 30),
          note: `Few headlines mention ${base} right now, so these are the latest crypto headlines`,
        };
  }
  if (sym.exchange === "US") {
    const items = await cached(`news:${sym.ticker}`, 10 * 60e3, async () => {
      for (const cls of ["stocks", "etf", "index"]) {
        const j = await getJson(
          `https://api.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(`${sym.ticker.toLowerCase()}|${cls}`)}&offset=0&limit=30&fallback=true`,
          NQ,
        ).catch(() => null);
        const rows = j?.data?.rows || [];
        if (rows.length)
          return rows.map((r) => ({
            title: r.title,
            url: r.url?.startsWith("http")
              ? r.url
              : `https://www.nasdaq.com${r.url}`,
            source: r.publisher,
            time: Date.parse(r.created) || null,
            ago: r.ago,
            summary: r.description || "",
          }));
      }
      return [];
    });
    return {
      items,
      note: items.length
        ? `Headlines for ${sym.ticker} from Nasdaq`
        : `No headlines found for ${sym.ticker}`,
    };
  }
  return {
    items: [],
    note: "Headlines are available for crypto and US stocks.",
  };
}

// ---------- fundamentals ----------
function table(t) {
  if (!t?.headers || !t?.rows) return null;
  const keys = Object.keys(t.headers).filter((k) => k !== "value1");
  return {
    periods: keys.map((k) => t.headers[k]),
    rows: t.rows.map((r) => ({
      label: r.value1,
      values: keys.map((k) => r[k] ?? ""),
    })),
  };
}

export async function financials(symbol, frequency = "annual") {
  if (OFFLINE) return null;
  const sym = await resolve(symbol);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error("Financial statements are for US-listed stocks."),
      { status: 422 },
    );
  const f = frequency === "quarterly" ? 2 : 1;
  return cached(`fin:${sym.ticker}:${f}`, 6 * 3600e3, async () => {
    const [fin, sum, ed] = await Promise.all([
      getJson(
        `https://api.nasdaq.com/api/company/${sym.ticker}/financials?frequency=${f}`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/quote/${sym.ticker}/summary?assetclass=stocks`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/analyst/${sym.ticker}/earnings-date`,
        NQ,
      ).catch(() => null),
    ]);
    const d = fin?.data || {};
    const stats = Object.values(sum?.data?.summaryData || {})
      .map((x) => ({ label: x.label, value: x.value }))
      .filter((x) => x.value && x.value !== "N/A");
    const out = {
      symbol: sym.id,
      frequency,
      stats,
      nextEarnings: (ed?.data?.reportText || "").replace(/\s+/g, " ").trim(),
      income: table(d.incomeStatementTable),
      balance: table(d.balanceSheetTable),
      cashflow: table(d.cashFlowTable),
      ratios: table(d.financialRatiosTable),
      note: "Statement figures are in thousands of US dollars, as Nasdaq reports them.",
    };
    if (!out.income && !stats.length)
      throw Object.assign(
        new Error(
          `Nasdaq has no financials for ${sym.ticker} (ETFs and funds don't file them).`,
        ),
        { status: 404 },
      );
    return out;
  });
}
