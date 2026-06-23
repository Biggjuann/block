import { config, useSimulator } from './config.js';
import { getToken } from './token.js';
import { queryHistory } from './db/index.js';
import { sideOf } from './sweeps.js';

// Daily-timeframe lookback for the chart line + print overlay.
const LOOKBACK_DAYS = 183; // ~6 months
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 3600e3;

// Deterministic PRNG so the synthesized intraday line is stable per symbol/day.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// Fetch a real daily line (~6 months) from Schwab.
async function schwabSeries(symbol) {
  const token = await getToken();
  const url =
    `${config.schwab.baseUrl}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(symbol)}` +
    `&periodType=month&period=6&frequencyType=daily&frequency=1&needExtendedHoursData=false`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`pricehistory ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.candles)) throw new Error('no candles');
  return data.candles.map((c) => ({ t: c.datetime, price: c.close }));
}

// Build a plausible daily line around an anchor price (simulator / fallback).
function synthSeries(symbol, anchor) {
  const end = Date.now();
  const stepMs = 24 * 3600e3;
  const n = 126; // ~6 months of trading days
  const rnd = mulberry32(hash(symbol + 'daily'));
  // Walk backward from the anchor (latest known price) so the line ends at it.
  const closes = new Array(n);
  let p = anchor;
  for (let i = n - 1; i >= 0; i--) {
    closes[i] = p;
    p = p * (1 + (rnd() - 0.5) * 0.03); // daily-scale volatility
  }
  return closes.map((price, i) => ({ t: end - (n - 1 - i) * stepMs, price: Math.round(price * 100) / 100 }));
}

/**
 * Chart payload for a symbol: intraday price line, today's block prints as
 * markers, and a net buy/sell pressure summary.
 */
export async function getChartData(symbol) {
  const sym = symbol.toUpperCase();
  const { rows: prints } = await queryHistory({
    ticker: sym, from: Date.now() - LOOKBACK_MS, order: 'asc', limit: 2000,
  });

  const markers = prints.map((p) => ({
    t: p.tradedAt, price: p.price, size: p.size, value: p.value,
    bidAsk: p.bidAsk, pctADV: p.pctADV, side: sideOf(p.bidAsk),
  }));

  const anchor = prints.length ? prints[prints.length - 1].price : 100;
  let series;
  try {
    series = useSimulator ? synthSeries(sym, anchor) : await schwabSeries(sym);
  } catch {
    series = synthSeries(sym, anchor);
  }

  let buyValue = 0, sellValue = 0;
  for (const m of markers) {
    if (m.side === 'buy') buyValue += m.value;
    else if (m.side === 'sell') sellValue += m.value;
  }

  return {
    symbol: sym,
    series,
    prints: markers,
    summary: {
      last: series.length ? series[series.length - 1].price : anchor,
      buyValue: Math.round(buyValue),
      sellValue: Math.round(sellValue),
      net: Math.round(buyValue - sellValue),
      count: markers.length,
    },
  };
}
