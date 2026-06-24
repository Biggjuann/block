import { config } from './config.js';
import { queryHistory } from './db/index.js';

// Aggressor-side helpers (matches the bid/ask classification we store).
const isBuy = (ba) => ba === 'Above Ask' || ba === 'At Ask';
const isSell = (ba) => ba === 'At Bid' || ba === 'Below Bid';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stddev = (xs, mu) => (xs.length ? Math.sqrt(mean(xs.map((x) => (x - mu) ** 2))) : 0);

/**
 * Find tickers whose recent flow contains abnormally large / unusual single
 * prints, then classify each as a bullish or bearish setup based on where the
 * current price sits relative to where those big trades occurred.
 *
 * @param {object} o
 * @param {number} o.since  window start (epoch ms)
 * @param {number} o.until  window end (epoch ms, exclusive)
 * @param {number} [o.limit]
 */
export async function getSetups({ since, until, limit = 24 } = {}) {
  const cfg = config.setups;
  const { rows } = await queryHistory({
    from: since,
    to: until - 1,
    minSize: config.blockMinSize,
    sort: 'traded_at',
    order: 'desc',
    limit: 8000,
  });
  if (!rows.length) return [];

  // Group prints by ticker (rows arrive newest-first).
  const byTicker = new Map();
  for (const r of rows) {
    let g = byTicker.get(r.ticker);
    if (!g) { g = []; byTicker.set(r.ticker, g); }
    g.push(r);
  }

  const setups = [];
  for (const [ticker, prints] of byTicker) {
    const sizes = prints.map((p) => p.size);
    const mu = mean(sizes);
    const med = median(sizes);
    const sd = stddev(sizes, mu);
    const hasBaseline = prints.length >= cfg.minBaseline;

    const unusual = (p) =>
      p.value >= cfg.minNotional &&
      (
        (p.pctADV != null && p.pctADV >= cfg.pctAdvUnusual) ||
        (hasBaseline && med > 0 && p.size >= cfg.medianMult * med) ||
        (hasBaseline && sd > 0 && p.size >= mu + cfg.sigma * sd)
      );

    const outliers = prints.filter(unusual);
    if (!outliers.length) continue;

    // Where the big trades printed: share-weighted average price of outliers.
    const shares = outliers.reduce((a, p) => a + p.size, 0);
    const keyLevel = shares ? outliers.reduce((a, p) => a + p.price * p.size, 0) / shares : outliers[0].price;

    // Aggressor balance among the unusual prints.
    const buyNotional = outliers.filter((p) => isBuy(p.bidAsk)).reduce((a, p) => a + p.value, 0);
    const sellNotional = outliers.filter((p) => isSell(p.bidAsk)).reduce((a, p) => a + p.value, 0);
    const outlierNotional = outliers.reduce((a, p) => a + p.value, 0);

    // Current price proxy: the ticker's most recent print in the window.
    const last = prints[0];
    const lastPrice = last.price;
    const distPct = keyLevel ? ((lastPrice - keyLevel) / keyLevel) * 100 : 0;

    const biggest = outliers.reduce((a, p) => (p.value > a.value ? p : a), outliers[0]);
    const maxPctADV = outliers.reduce((a, p) => (p.pctADV != null && p.pctADV > a ? p.pctADV : a), 0) || null;

    // ---- Classify ----
    const conviction = buyNotional + sellNotional > 0
      ? Math.abs(buyNotional - sellNotional) / (buyNotional + sellNotional)
      : 0;
    const dominantBuy = buyNotional > sellNotional;
    const dominantSell = sellNotional > buyNotional;
    const above = lastPrice >= keyLevel;

    let bias = 'mixed';
    let watch = false;
    let setup = 'Two-sided block interest — no clear edge';
    if (conviction < 0.2) {
      bias = 'mixed';
      setup = above
        ? 'Mixed blocks, price above the level — leaning constructive'
        : 'Mixed blocks, price below the level — leaning heavy';
    } else if (dominantBuy) {
      bias = 'bullish';
      if (above) setup = 'Aggressive block buying — price holding above their level (accumulation in control)';
      else { watch = true; setup = 'Aggressive block buying — price pulled back below their level (potential support / re-load)'; }
    } else if (dominantSell) {
      bias = 'bearish';
      if (!above) setup = 'Aggressive block selling — price below their level (distribution in control)';
      else { watch = true; setup = 'Aggressive block selling — price extended above their level (overhead supply / fade risk)'; }
    }

    // ---- Strength score (0-100) for ranking ----
    const notionalScore = Math.min(50, Math.round(Math.log10(outlierNotional / 1e6 + 1) * 28));
    const convictionScore = Math.round(conviction * 30);
    const alignment = bias === 'mixed' ? 0 : watch ? 8 : 20;
    const score = Math.min(100, notionalScore + convictionScore + alignment);

    setups.push({
      ticker,
      bias,
      watch,
      setup,
      lastPrice,
      lastAt: last.tradedAt,
      keyLevel: Math.round(keyLevel * 100) / 100,
      distPct: Math.round(distPct * 10) / 10,
      outlierCount: outliers.length,
      outlierNotional,
      buyNotional,
      sellNotional,
      maxPctADV: maxPctADV != null ? Math.round(maxPctADV * 10) / 10 : null,
      biggest: {
        price: biggest.price,
        size: biggest.size,
        value: biggest.value,
        bidAsk: biggest.bidAsk,
        pctADV: biggest.pctADV ?? null,
        tradedAt: biggest.tradedAt,
      },
      score,
    });
  }

  setups.sort((a, b) => b.score - a.score || b.outlierNotional - a.outlierNotional);
  return setups.slice(0, limit);
}
