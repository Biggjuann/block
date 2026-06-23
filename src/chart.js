import { config, useSimulator } from './config.js';
import { getToken } from './token.js';
import { queryHistory } from './db/index.js';
import { sideOf } from './sweeps.js';

const DAY = 24 * 3600e3;
const startOfTodayMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Timeframe presets: Schwab pricehistory params, the print/overlay lookback
// window, and the synthetic-line spacing/volatility used in simulator mode.
const TF = {
  '1D': { ph: 'periodType=day&period=1&frequencyType=minute&frequency=1&needExtendedHoursData=true',
          windowFrom: () => startOfTodayMs(), step: 60e3, vol: 0.0025, from: () => startOfTodayMs() },
  '5D': { ph: 'periodType=day&period=5&frequencyType=minute&frequency=5&needExtendedHoursData=true',
          step: 5 * 60e3, vol: 0.004, from: () => Date.now() - 5 * DAY },
  '1M': { ph: 'periodType=month&period=1&frequencyType=daily&frequency=1',
          step: DAY, vol: 0.02, from: () => Date.now() - 31 * DAY },
  '6M': { ph: 'periodType=month&period=6&frequencyType=daily&frequency=1',
          step: DAY, vol: 0.03, from: () => Date.now() - 183 * DAY },
};
const TOP_N = 5;

// Deterministic PRNG so the synthesized line is stable per symbol/timeframe.
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

async function schwabSeries(symbol, tf) {
  const token = await getToken();
  const url = `${config.schwab.baseUrl}/marketdata/v1/pricehistory?symbol=${encodeURIComponent(symbol)}&${tf.ph}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`pricehistory ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.candles)) throw new Error('no candles');
  return data.candles.map((c) => ({ t: c.datetime, price: c.close }));
}

function synthSeries(symbol, anchor, tf) {
  const end = Date.now();
  const start = tf.from();
  const n = Math.max(2, Math.min(800, Math.floor((end - start) / tf.step)));
  const rnd = mulberry32(hash(symbol + start));
  const closes = new Array(n);
  let p = anchor;
  for (let i = n - 1; i >= 0; i--) { closes[i] = p; p = p * (1 + (rnd() - 0.5) * tf.vol); }
  return closes.map((price, i) => ({ t: end - (n - 1 - i) * tf.step, price: Math.round(price * 100) / 100 }));
}

/**
 * Chart payload for a symbol over the requested timeframe: a price line, the
 * block prints in that window as markers (the biggest tagged rank 1..N so the
 * UI can highlight where the big ones hit), the top N by notional, and a net
 * buy/sell pressure summary.
 */
export async function getChartData(symbol, timeframe = '1D') {
  const sym = symbol.toUpperCase();
  const tf = TF[timeframe] || TF['1D'];

  const { rows: prints } = await queryHistory({
    ticker: sym, from: tf.from(), order: 'asc', limit: 3000,
  });

  // Rank the biggest prints by notional so the chart + list can spotlight them.
  const rankByValue = [...prints].sort((a, b) => b.value - a.value);
  const rankOf = new Map();
  rankByValue.slice(0, TOP_N).forEach((p, i) => rankOf.set(p, i + 1));

  const markers = prints.map((p) => ({
    t: p.tradedAt, price: p.price, size: p.size, value: p.value,
    bidAsk: p.bidAsk, pctADV: p.pctADV, side: sideOf(p.bidAsk), rank: rankOf.get(p) || null,
  }));
  const topPrints = rankByValue.slice(0, TOP_N).map((p, i) => ({
    rank: i + 1, t: p.tradedAt, price: p.price, size: p.size, value: p.value,
    bidAsk: p.bidAsk, pctADV: p.pctADV, side: sideOf(p.bidAsk),
  }));

  const anchor = prints.length ? prints[prints.length - 1].price : 100;
  let series;
  try {
    series = useSimulator ? synthSeries(sym, anchor, tf) : await schwabSeries(sym, tf);
  } catch {
    series = synthSeries(sym, anchor, tf);
  }

  let buyValue = 0, sellValue = 0;
  for (const m of markers) {
    if (m.side === 'buy') buyValue += m.value;
    else if (m.side === 'sell') sellValue += m.value;
  }

  return {
    symbol: sym,
    timeframe: TF[timeframe] ? timeframe : '1D',
    series,
    prints: markers,
    topPrints,
    summary: {
      last: series.length ? series[series.length - 1].price : anchor,
      buyValue: Math.round(buyValue),
      sellValue: Math.round(sellValue),
      net: Math.round(buyValue - sellValue),
      count: markers.length,
    },
  };
}
