import { config } from './config.js';
import { getToken } from './token.js';

// Provides average daily volume (ADV) per symbol so each block print can be
// expressed as a % of a typical day's volume — the context that turns a raw
// size into a signal. In Schwab mode we pull real ADV from the quotes
// fundamentals endpoint; otherwise we use reasonable static estimates so the
// feature is meaningful in simulator mode too.

const M = 1e6;

// Rough average daily share volumes for common, liquid names + ETFs.
const STATIC_ADV = {
  SPY: 75 * M, QQQ: 45 * M, IWM: 30 * M, DIA: 4 * M, VOO: 6 * M, VTI: 4 * M,
  EEM: 40 * M, EFA: 20 * M, XLF: 45 * M, XLK: 9 * M, XLE: 18 * M, XLV: 9 * M,
  XLI: 12 * M, XLY: 6 * M, XLU: 14 * M, SMH: 8 * M, SOXX: 6 * M, KWEB: 30 * M,
  ARKK: 25 * M, GLD: 8 * M, SLV: 25 * M, GDX: 30 * M, USO: 4 * M, TLT: 40 * M,
  HYG: 50 * M, LQD: 20 * M, VXX: 30 * M, UVXY: 40 * M, SQQQ: 80 * M, TQQQ: 70 * M,
  SOXL: 90 * M, SOXS: 60 * M, TSLL: 50 * M, TNA: 25 * M, JETS: 4 * M, MUB: 1 * M,
  AAPL: 55 * M, MSFT: 22 * M, NVDA: 220 * M, AMZN: 45 * M, GOOGL: 28 * M,
  GOOG: 18 * M, META: 16 * M, TSLA: 100 * M, AVGO: 25 * M, ORCL: 12 * M,
  ADBE: 3 * M, CRM: 7 * M, AMD: 50 * M, INTC: 55 * M, CSCO: 18 * M, QCOM: 9 * M,
  IBM: 5 * M, NOW: 2 * M, PANW: 6 * M, SNOW: 6 * M, PLTR: 70 * M, MU: 25 * M,
  AMAT: 9 * M, ARM: 12 * M, SMCI: 60 * M, JPM: 9 * M, BAC: 40 * M, WFC: 18 * M,
  C: 18 * M, GS: 2 * M, MS: 8 * M, SCHW: 9 * M, V: 7 * M, MA: 3 * M, PYPL: 14 * M,
  SOFI: 60 * M, COIN: 12 * M, HOOD: 30 * M, UNH: 5 * M, JNJ: 7 * M, LLY: 4 * M,
  PFE: 45 * M, MRK: 12 * M, ABBV: 6 * M, GILD: 8 * M, AMGN: 3 * M, CVS: 12 * M,
  MRNA: 10 * M, WMT: 18 * M, COST: 2 * M, HD: 3 * M, NKE: 11 * M, MCD: 3 * M,
  SBUX: 9 * M, DIS: 12 * M, KO: 14 * M, PEP: 6 * M, PG: 7 * M, XOM: 18 * M,
  CVX: 9 * M, COP: 7 * M, OXY: 18 * M, SLB: 12 * M, RIG: 25 * M, BA: 8 * M,
  CAT: 4 * M, GE: 6 * M, F: 70 * M, GM: 16 * M, UBER: 20 * M, LYFT: 18 * M,
  ABNB: 5 * M, GRAB: 25 * M, T: 35 * M, VZ: 18 * M, TMUS: 5 * M, NIO: 50 * M,
  LCID: 60 * M, RIVN: 40 * M, ACHR: 30 * M, OPEN: 50 * M, SNAP: 35 * M, NU: 30 * M,
  BBAI: 30 * M, IONQ: 25 * M, QBTS: 30 * M, RGTI: 30 * M, WULF: 25 * M, CORZ: 20 * M,
  HIVE: 15 * M, BITF: 20 * M, MARA: 40 * M, RIOT: 30 * M, CLSK: 30 * M, MSTR: 12 * M,
  CCJ: 10 * M, NAKA: 20 * M, BTG: 15 * M, ZETA: 8 * M, WOLF: 30 * M, ATCH: 15 * M,
};
const DEFAULT_ADV = 8 * M;

const advMap = new Map();

export function getADV(ticker) {
  return advMap.get(ticker) || STATIC_ADV[ticker] || DEFAULT_ADV;
}

function seedStatic(symbols) {
  for (const s of symbols) {
    if (!advMap.has(s)) advMap.set(s, STATIC_ADV[s] || DEFAULT_ADV);
  }
}

async function fetchBatch(symbols, token) {
  const url = `${config.schwab.baseUrl}/marketdata/v1/quotes?symbols=${encodeURIComponent(
    symbols.join(',')
  )}&fields=fundamental`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  const data = await res.json();
  for (const [sym, obj] of Object.entries(data)) {
    const f = obj?.fundamental || {};
    const adv = f.avg10DaysVolume || f.avg1YearVolume || f.averageVolume;
    if (adv) advMap.set(sym, Number(adv));
  }
}

async function refresh(symbols) {
  let token;
  try {
    token = await getToken();
  } catch {
    return; // no token -> keep static estimates
  }
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    try {
      await fetchBatch(chunk, token);
    } catch {
      /* keep static for this chunk */
    }
  }
}

/**
 * Seed static ADV and, when streaming from Schwab, periodically refresh with
 * real fundamentals. Returns a stop() function.
 */
export function startFundamentals({ symbols, useSchwab }) {
  seedStatic(symbols);
  if (!useSchwab) return () => {};
  refresh(symbols);
  const timer = setInterval(() => refresh(symbols), config.fundamentalsRefreshMs);
  return () => clearInterval(timer);
}
