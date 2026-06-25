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

    // Break the unusual flow down by calendar day so we can see whether the
    // bullish/bearish bias is building across days, persisting from prior days,
    // or being flipped today — i.e. track conviction from previous big trades.
    const dayMap = new Map();
    for (const p of outliers) {
      const b = Math.floor(p.tradedAt / 86400000); // UTC-day bucket
      let g = dayMap.get(b);
      if (!g) { g = { b, buy: 0, sell: 0 }; dayMap.set(b, g); }
      if (isBuy(p.bidAsk)) g.buy += p.value;
      else if (isSell(p.bidAsk)) g.sell += p.value;
    }
    const days = [...dayMap.values()].sort((a, c) => a.b - c.b).map((g) => ({
      date: new Date(g.b * 86400000).toISOString().slice(0, 10),
      net: g.buy - g.sell,
      notional: g.buy + g.sell,
    }));
    const daysActive = days.length;

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

    // ---- Multi-day continuity: how prior days' big trades relate to today ----
    // building   = prior days AND the latest day agree with the overall bias
    // persisting = prior days set the bias; the latest day is quiet/opposite
    // flipping   = the latest day reversed a prior multi-day bias
    // new        = only one day of unusual flow so far
    const biasSign = buyNotional >= sellNotional ? 1 : -1;
    let continuity = 'new';
    let priorAligned = 0;
    if (daysActive > 1) {
      const prior = days.slice(0, -1);
      const latest = days[days.length - 1];
      const priorNet = prior.reduce((a, s) => a + s.net, 0);
      priorAligned = prior.filter((s) => Math.sign(s.net) === biasSign).length;
      if (Math.sign(priorNet) === biasSign) {
        continuity = Math.sign(latest.net) === biasSign ? 'building' : 'persisting';
      } else {
        continuity = 'flipping';
      }
    }
    if (bias !== 'mixed' && daysActive > 1) {
      const tail = continuity === 'building' ? `block ${dominantBuy ? 'buying' : 'selling'} building across ${daysActive} days`
        : continuity === 'persisting' ? `prior ${daysActive}-day ${dominantBuy ? 'buying' : 'selling'} bias persisting`
        : `today flips a prior multi-day ${dominantBuy ? 'selling' : 'buying'} bias`;
      setup += ` · ${tail}`;
    }

    // ---- Strength score (0-100) for ranking ----
    const notionalScore = Math.min(50, Math.round(Math.log10(outlierNotional / 1e6 + 1) * 28));
    const convictionScore = Math.round(conviction * 30);
    const alignment = bias === 'mixed' ? 0 : watch ? 8 : 20;
    // Reward multi-day persistence; gently dock a same-day-only flip.
    const continuityBonus = continuity === 'building' ? 15 : continuity === 'persisting' ? 8 : continuity === 'flipping' ? -4 : 0;
    const daysBonus = Math.min(12, (daysActive - 1) * 4);
    const score = Math.max(0, Math.min(100, notionalScore + convictionScore + alignment + continuityBonus + daysBonus));

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
      daysActive,
      continuity,
      days, // per-day net flow, oldest→newest (for the multi-day trail)
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
