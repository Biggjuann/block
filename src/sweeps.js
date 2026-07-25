import { config } from './config.js';

// Sweep detection: an aggressive directional burst — several same-side prints
// hitting the tape in a short window. Above/At Ask = buyers lifting offers;
// At/Below Bid = sellers hitting bids; Between is treated as non-aggressive.

const BUY = new Set(['Above Ask', 'At Ask']);
const SELL = new Set(['Below Bid', 'At Bid']);

export function sideOf(bidAsk) {
  if (BUY.has(bidAsk)) return 'buy';
  if (SELL.has(bidAsk)) return 'sell';
  return null;
}

const recent = new Map(); // ticker -> [{ side, value, price, size, at }]
const lastSweepAt = new Map();

/**
 * Feed every trade in. Returns a sweep object when a fresh sweep is detected,
 * otherwise null.
 */
export function detectSweep(trade) {
  const side = sideOf(trade.bidAsk);
  if (!side) return null;

  const { windowMs, minPrints, minNotional, cooldownMs } = config.sweeps;
  const now = trade.tradedAt || Date.now();

  const list = (recent.get(trade.ticker) || []).filter((p) => now - p.at <= windowMs);
  list.push({ side, value: trade.value, price: trade.price, size: trade.size, at: now });
  recent.set(trade.ticker, list);

  // Same-side prints inside the window.
  const sameSide = list.filter((p) => p.side === side);
  const count = sameSide.length;
  const totalValue = sameSide.reduce((s, p) => s + p.value, 0);
  if (count < minPrints || totalValue < minNotional) return null;

  if (now - (lastSweepAt.get(trade.ticker) || 0) < cooldownMs) return null;
  lastSweepAt.set(trade.ticker, now);

  const prices = sameSide.map((p) => p.price);
  return {
    ticker: trade.ticker,
    side,
    count,
    totalValue: Math.round(totalValue),
    totalSize: sameSide.reduce((s, p) => s + p.size, 0),
    priceLow: Math.min(...prices),
    priceHigh: Math.max(...prices),
    at: now,
  };
}
