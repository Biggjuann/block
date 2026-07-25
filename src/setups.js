import { config } from './config.js';
import { queryHistory } from './db/index.js';
import { marketSession } from './market.js';

// Block-level analysis should ignore overnight/weekend prints — a 15M-share
// SLV print at 1:35am ET is a data artifact (creation/redemption or bad tape),
// not a tradeable level, and it badly skews both the bias and %ADV.
const inSession = (ms) => marketSession(ms) !== 'closed';

// Aggressor-side helpers (matches the bid/ask classification we store).
const isBuy = (ba) => ba === 'Above Ask' || ba === 'At Ask';
const isSell = (ba) => ba === 'At Bid' || ba === 'Below Bid';
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Find tickers whose recent flow contains abnormally large / unusual single
 * prints, then classify each as a bullish or bearish setup based on where the
 * current price sits relative to where those big trades printed — including the
 * big trades from previous days, not just the anchor day.
 *
 * @param {object} o
 * @param {number} o.since  window start (epoch ms)
 * @param {number} o.until  window end (epoch ms, exclusive)
 * @param {number} [o.limit]
 */
export async function getSetups({ since, until, limit = 24 } = {}) {
  const cfg = config.setups;

  // (1) The big prints over the FULL window. Floor by notional so this returns
  //     the large trades across all 10 days — sorting the whole tape by time and
  //     capping rows would truncate the lookback to ~today on a busy universe,
  //     hiding prior-day blocks (the bug where a name read "1 day / at level").
  const bigRes = await queryHistory({
    from: since, to: until - 1, minNotional: cfg.minNotional,
    sort: 'value', order: 'desc', limit: 6000,
  });
  const big = bigRes.rows.filter((r) => inSession(r.tradedAt));
  if (!big.length) return [];

  // (2) Most-recent prints, for a current-price proxy per ticker.
  const recentRes = await queryHistory({
    from: since, to: until - 1, sort: 'traded_at', order: 'desc', limit: 3000,
  });
  const lastByTicker = new Map();
  for (const r of recentRes.rows) if (inSession(r.tradedAt) && !lastByTicker.has(r.ticker)) lastByTicker.set(r.ticker, r);

  // Group the big prints by ticker.
  const byTicker = new Map();
  for (const r of big) {
    let g = byTicker.get(r.ticker);
    if (!g) { g = []; byTicker.set(r.ticker, g); }
    g.push(r);
  }

  const setups = [];
  for (const [ticker, prints] of byTicker) {
    // "Unusual" = clears the notional floor AND, where we have ADV, is a large
    // share of average daily volume. (All `prints` already clear the floor.)
    const outliers = prints.filter((p) => p.pctADV == null || p.pctADV >= cfg.pctAdvUnusual);
    if (!outliers.length) continue;

    const outlierNotional = outliers.reduce((a, p) => a + p.value, 0);
    const buyNotional = outliers.filter((p) => isBuy(p.bidAsk)).reduce((a, p) => a + p.value, 0);
    const sellNotional = outliers.filter((p) => isSell(p.bidAsk)).reduce((a, p) => a + p.value, 0);

    // Where the big trades printed (share-weighted), for reference.
    const shares = outliers.reduce((a, p) => a + p.size, 0);
    const keyLevel = shares ? outliers.reduce((a, p) => a + p.price * p.size, 0) / shares : outliers[0].price;

    // Current price: most recent print (any size); fall back to newest big print.
    const newest = prints.reduce((a, p) => (p.tradedAt > a.tradedAt ? p : a), prints[0]);
    const lastRow = lastByTicker.get(ticker) || newest;
    const lastPrice = lastRow.price;

    // ---- Structure: big trades above vs below the current price ----
    // This is the heart of "where is price vs where the big trades occurred":
    // blocks above current price are overhead supply; blocks below are support.
    const band = 0.005; // ignore prints within ±0.5% of price (effectively "at")
    let aboveNot = 0, belowNot = 0, atNot = 0, aSh = 0, bSh = 0, aShPx = 0, bShPx = 0;
    for (const p of outliers) {
      if (p.price > lastPrice * (1 + band)) { aboveNot += p.value; aSh += p.size; aShPx += p.price * p.size; }
      else if (p.price < lastPrice * (1 - band)) { belowNot += p.value; bSh += p.size; bShPx += p.price * p.size; }
      else atNot += p.value;
    }
    const aboveVwap = aSh ? r2(aShPx / aSh) : null;
    const belowVwap = bSh ? r2(bShPx / bSh) : null;

    // ---- Directional read ----
    // Price position vs the big trades is the primary signal (this is literally
    // "where is price vs where the large trades occurred"); aggressor flow
    // refines it and flags conflicts.
    // posConv: +1 = price above essentially all the block volume (support beneath);
    //          -1 = price has dropped below the block volume (overhead supply).
    // flowConv: +1 = the big prints were aggressive buying; -1 = aggressive selling.
    // Two views of "where is price vs the big trades", blended so neither a lone
    // deep print nor a far-overhead shelf can dominate on its own:
    //  - posSplit: notional above vs below price (volume-at-price support/resist).
    //  - vwapConv: price vs the share-weighted center of all the big trades.
    const posDenom = aboveNot + belowNot + atNot || 1;
    const posSplit = (belowNot - aboveNot) / posDenom;
    const vwapConv = keyLevel ? Math.max(-1, Math.min(1, (lastPrice - keyLevel) / (lastPrice * 0.04))) : 0;
    const posConv = 0.5 * posSplit + 0.5 * vwapConv; // + = price above the blocks
    const flowConv = buyNotional + sellNotional > 0 ? (buyNotional - sellNotional) / (buyNotional + sellNotional) : 0;
    const posBull = posConv > 0.2, posBear = posConv < -0.2;
    const flowBuy = flowConv > 0.2, flowSell = flowConv < -0.2;

    let bias = 'mixed';
    let watch = false;
    let setup;
    if (posBull) {
      bias = 'bullish';
      watch = flowSell; // price above blocks, but those blocks were selling
      setup = flowSell
        ? 'Price holding above the block volume — earlier selling has been absorbed, support beneath'
        : 'Price holding above the bulk of block volume — buyers in profit, support beneath';
    } else if (posBear) {
      bias = 'bearish';
      watch = flowBuy; // price below blocks that were *buying* — buyers underwater
      setup = flowBuy
        ? 'Price has fallen below the block volume — big buyers now underwater, overhead supply'
        : 'Price has fallen below the bulk of block volume — sellers in control, breaking lower';
    } else if (flowBuy) {
      bias = 'bullish'; watch = true;
      setup = 'Price inside the block-volume zone — aggressor flow is net buying';
    } else if (flowSell) {
      bias = 'bearish'; watch = true;
      setup = 'Price inside the block-volume zone — aggressor flow is net selling';
    } else {
      setup = 'Price within the block-volume zone — two-sided flow, no clear edge';
    }

    // ---- Multi-day continuity (prior days' big trades vs today) ----
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

    const flowSign = buyNotional >= sellNotional ? 1 : -1;
    let continuity = 'new';
    if (daysActive > 1) {
      const prior = days.slice(0, -1);
      const latest = days[days.length - 1];
      const priorNet = prior.reduce((a, s) => a + s.net, 0);
      if (Math.sign(priorNet) === flowSign) {
        continuity = Math.sign(latest.net) === flowSign ? 'building' : 'persisting';
      } else {
        continuity = 'flipping';
      }
    }
    if (daysActive > 1) {
      const side = buyNotional >= sellNotional ? 'buying' : 'selling';
      const tail = continuity === 'building' ? `block ${side} building across ${daysActive} days`
        : continuity === 'persisting' ? `prior ${daysActive}-day block ${side} persisting`
        : `today flips a prior multi-day block ${side === 'buying' ? 'selling' : 'buying'} bias`;
      setup += ` · ${tail}`;
    }

    const biggest = outliers.reduce((a, p) => (p.value > a.value ? p : a), outliers[0]);
    const maxPctADV = outliers.reduce((a, p) => (p.pctADV != null && p.pctADV > a ? p.pctADV : a), 0) || null;

    // ---- Strength score (0-100) ----
    const convict = Math.min(1, Math.abs(posConv) * 0.6 + Math.abs(flowConv) * 0.4);
    const notionalScore = Math.min(40, Math.round(Math.log10(outlierNotional / 1e6 + 1) * 16));
    const dirScore = bias === 'mixed' ? 0 : Math.round(convict * 25);
    const advScore = Math.min(15, Math.round((maxPctADV || 0) * 2));
    const continuityBonus = continuity === 'building' ? 10 : continuity === 'persisting' ? 6 : continuity === 'flipping' ? -3 : 0;
    const daysBonus = Math.min(8, (daysActive - 1) * 3);
    const score = Math.max(0, Math.min(100, notionalScore + dirScore + advScore + continuityBonus + daysBonus));

    setups.push({
      ticker,
      bias,
      watch,
      setup,
      lastPrice,
      lastAt: lastRow.tradedAt,
      keyLevel: r2(keyLevel),
      distPct: keyLevel ? r2(((lastPrice - keyLevel) / keyLevel) * 100) : 0,
      aboveNotional: aboveNot,
      belowNotional: belowNot,
      aboveVwap,
      belowVwap,
      outlierCount: outliers.length,
      outlierNotional,
      buyNotional,
      sellNotional,
      daysActive,
      continuity,
      days, // per-day net flow, oldest→newest (multi-day trail)
      maxPctADV: maxPctADV != null ? r2(maxPctADV) : null,
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
