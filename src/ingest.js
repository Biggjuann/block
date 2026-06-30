import { config, useSimulator } from './config.js';
import { insertBlockTrade } from './db/index.js';
import { getADV } from './fundamentals.js';
import { isTradingHours } from './market.js';
import { startSchwabStream } from './schwab.js';

/**
 * Classify a trade against the prevailing quote.
 * Returns one of: Above Ask | At Ask | Between | At Bid | Below Bid
 */
export function classify(price, bid, ask) {
  if (bid == null || ask == null) return 'Between';
  if (price > ask) return 'Above Ask';
  if (price >= ask) return 'At Ask';
  if (price < bid) return 'Below Bid';
  if (price <= bid) return 'At Bid';
  return 'Between';
}

function finalize(raw) {
  const price = round2(raw.price);
  const size = Math.round(raw.size);
  const adv = getADV(raw.ticker);
  return {
    ticker: raw.ticker,
    price,
    size,
    value: round2(price * size),
    bidAsk: classify(price, raw.bid, raw.ask),
    // % of average daily volume this single print represents — the context
    // that separates a routine block from an outlier.
    pctADV: adv ? round2((size / adv) * 100) : null,
    tradedAt: raw.tradedAt || Date.now(),
  };
}

/**
 * Wire up the data source (Schwab streamer or simulator) to the broadcaster and
 * the database. `broadcast(trade)` is called for every block trade; trades at or
 * above BLOCK_MIN_SIZE are also persisted.
 */
export function startIngest({ broadcast, onStatus = () => {} }) {
  const handle = (raw) => {
    const trade = finalize(raw);
    if (trade.size < config.blockMinSize) return; // only block-sized prints matter
    // Broadcast immediately for a snappy UI; persist in the background so a
    // (possibly remote Postgres) write never blocks the live tape.
    broadcast(trade);
    insertBlockTrade(trade).catch((err) => console.error('db insert failed', err.message));
  };

  if (useSimulator) {
    onStatus('live', 'simulator');
    return startSimulator(handle);
  }

  onStatus('connecting', 'schwab');
  let sim = null; // active fallback simulator, if any
  const stopStream = startSchwabStream({
    symbols: config.schwab.symbols,
    onTrade: handle,
    onStatus: (state, detail) => {
      onStatus(state, `schwab: ${detail || ''}`);
      // Optional fallback simulator — only if explicitly enabled. It self-stops
      // the moment Schwab is live again so synthetic prints never linger
      // alongside (or get persisted with) real data.
      if (state === 'error' && config.simFallback && !sim) {
        onStatus('live', 'simulator (schwab fallback)');
        sim = startSimulator(handle);
      } else if (state === 'live' && sim) {
        sim();
        sim = null;
      }
    },
  });

  return () => {
    sim?.();
    stopStream?.();
  };
}

// ---------------------------------------------------------------------------
// Simulator: generates realistic block-trade tape so the app is fully live
// without a Schwab token (and as a fallback if streaming fails).
// ---------------------------------------------------------------------------

const UNIVERSE = [
  // [ticker, basePrice, sizeScale] — sizeScale skews how large its blocks run
  ['SPY', 744.39, 1.3], ['QQQ', 737.95, 1.2], ['TSLA', 422.68, 2.0],
  ['IWM', 245.0, 1.4], ['AAPL', 233.27, 1.6], ['NVDA', 175.64, 2.0],
  ['MSFT', 510.0, 0.8], ['GLD', 380.0, 1.0], ['HYG', 80.92, 1.2],
  ['ORCL', 305.0, 1.0], ['AMZN', 228.1, 0.9], ['PFE', 23.97, 1.6],
  ['NIO', 6.45, 1.8], ['HIVE', 4.05, 1.7], ['BITF', 2.51, 2.2],
  ['SOFI', 27.35, 1.2], ['SNAP', 7.36, 1.4], ['KWEB', 41.09, 1.2],
  ['WOLF', 2.38, 1.6], ['IONQ', 57.19, 1.1], ['ACHR', 9.43, 2.2],
  ['QBTS', 17.76, 1.4], ['NAKA', 1.23, 2.4], ['OPEN', 9.76, 2.0],
  ['GRAB', 5.89, 1.6], ['NXTT', 0.14, 3.0], ['ATCH', 0.95, 2.0],
  ['CORZ', 16.35, 1.3], ['WULF', 10.57, 1.4], ['T', 29.67, 1.0],
  ['ADAP', 0.06, 2.4], ['RARE', 30.0, 0.6], ['CHEK', 2.65, 1.2],
  ['TSLL', 18.8, 1.4], ['ZETA', 20.92, 0.9], ['FYBR', 37.51, 0.8],
  ['MUB', 106.58, 0.7], ['XOM', 112.24, 1.0], ['RIG', 3.3, 1.6],
  ['ARKK', 78.48, 0.9], ['ATYR', 1.25, 1.8], ['BTG', 4.29, 1.2],
];

function startSimulator(handle) {
  let timer = null;
  const tick = () => {
    // Mirror reality: only generate tape during market hours unless explicitly
    // told to always run (handy for demos). SIMULATE_ALWAYS=true overrides.
    if (config.simulateAlways || isTradingHours()) {
      if (Math.random() < 0.04) emitSweepBurst(handle); // occasional aggressive sweep
      const burst = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < burst; i++) emitOne(handle);
    }
    timer = setTimeout(tick, 250 + Math.random() * 650);
  };
  tick();
  return () => clearTimeout(timer);
}

// Emit a directional burst of same-side aggressive prints on one liquid name,
// so sweep detection has something to catch in simulator/demo mode.
function emitSweepBurst(handle) {
  const liquid = UNIVERSE.filter(([, base]) => base > 20);
  const [ticker, base] = liquid[Math.floor(Math.random() * liquid.length)];
  const price = base * (1 + (Math.random() - 0.5) * 0.01);
  const spread = Math.max(0.01, price * 0.0008);
  const bid = price - spread;
  const ask = price + spread;
  const buy = Math.random() > 0.5;
  const n = 3 + Math.floor(Math.random() * 4); // 3–6 prints
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const tradePrice = buy ? ask + spread * i * 0.5 : bid - spread * i * 0.5;
    handle({
      ticker, price: tradePrice, size: rand(50000, 220000),
      bid, ask, tradedAt: now + i * 30,
    });
  }
}

function emitOne(handle) {
  const [ticker, base, scale] = UNIVERSE[Math.floor(Math.random() * UNIVERSE.length)];
  // Drift the price a touch so the tape looks live.
  const price = base * (1 + (Math.random() - 0.5) * 0.01);
  const spread = Math.max(0.01, price * 0.0008);
  const bid = price - spread;
  const ask = price + spread;

  // Pick one of the configured size ranges so every column populates, weighting
  // toward the smaller bands (which is how real block flow is distributed).
  const cols = config.columns;
  const r0 = Math.random();
  // ~55% smallest band, then tapering across the rest.
  let bandIdx = 0;
  if (r0 > 0.55) bandIdx = 1 + Math.floor(Math.random() * Math.max(1, cols.length - 1));
  bandIdx = Math.min(bandIdx, cols.length - 1);
  const band = cols[bandIdx];
  const lo = band.min;
  const hi = band.max ?? band.min * (2 + scale); // open-ended whale band cap
  // Keep the size strictly inside the band so it lands in the right column.
  const size = rand(lo, hi);

  // Trade somewhere around the inside market, leaning to ask/bid edges.
  const r = Math.random();
  let tradePrice;
  if (r > 0.82) tradePrice = ask + spread * Math.random(); // above ask
  else if (r > 0.6) tradePrice = ask; // at ask
  else if (r > 0.4) tradePrice = (bid + ask) / 2; // between
  else if (r > 0.18) tradePrice = bid; // at bid
  else tradePrice = bid - spread * Math.random(); // below bid

  handle({ ticker, price: tradePrice, size, bid, ask, tradedAt: Date.now() });
}

const rand = (min, max) => min + Math.random() * (max - min);
const round2 = (n) => Math.round(n * 100) / 100;
