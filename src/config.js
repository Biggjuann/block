import 'dotenv/config';
import { UNIVERSE } from './universe.js';

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true' || v === '1';
};

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

// Size thresholds that define the tape columns. Columns are RANGES:
// each column holds trades from its own threshold up to the next one,
// and the last column is open-ended.
const thresholds = (list(process.env.BLOCK_THRESHOLDS).length
  ? list(process.env.BLOCK_THRESHOLDS).map(Number)
  : [50000, 400000, 500000, 800000]
).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

const columns = thresholds.map((min, i) => ({
  min,
  max: i < thresholds.length - 1 ? thresholds[i + 1] : null, // null = open-ended
}));

// The ticker universe the Schwab streamer subscribes to. Override with
// SCHWAB_SYMBOLS for a custom watchlist, otherwise use the curated universe.
const symbols = list(process.env.SCHWAB_SYMBOLS).length
  ? list(process.env.SCHWAB_SYMBOLS)
  : UNIVERSE;

const authMode = (process.env.SCHWAB_AUTH_MODE || 'auto').toLowerCase();

export const config = {
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || './data/blocktrades.sqlite',
  schwab: {
    authMode, // 'shared' | 'token' | 'auto'
    baseUrl: (process.env.SCHWAB_BASE_URL || 'https://api.schwabapi.com').replace(/\/+$/, ''),
    token: process.env.SCHWAB_TOKEN || '',
    tokenUrl: process.env.SCHWAB_TOKEN_URL || '',
    tokenShareKey: process.env.SCHWAB_TOKEN_SHARE_KEY || '',
    symbols,
  },
  // Smallest column min is the floor for what we treat as a block trade.
  blockMinSize: num(process.env.BLOCK_MIN_SIZE, thresholds[0] || 50000),
  printMinSize: num(process.env.PRINT_MIN_SIZE, 400000),
  forceSimulator: bool(process.env.FORCE_SIMULATOR, false),
  // Keep the simulator generating tape 24/7 (e.g. for demos). Off by default
  // so simulated tape pauses when the market is closed, matching reality.
  simulateAlways: bool(process.env.SIMULATE_ALWAYS, false),
  // When streaming from Schwab and the stream errors, optionally fall back to
  // the simulator to keep the UI alive. OFF by default so real deployments
  // never persist synthetic prints into the database during a hiccup.
  simFallback: bool(process.env.SIM_FALLBACK, false),
  thresholds,
  columns,
  // How often to refresh Schwab fundamentals (ADV) in ms.
  fundamentalsRefreshMs: num(process.env.FUNDAMENTALS_REFRESH_MS, 15 * 60 * 1000),
  // Server-side "whale" alert thresholds + optional Discord push.
  alerts: {
    minNotional: num(process.env.ALERT_MIN_NOTIONAL, 50_000_000),
    minPctADV: num(process.env.ALERT_MIN_PCT_ADV, 10),
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  },
  // Sweep detection: N+ same-side aggressive prints within a rolling window
  // summing to at least the notional threshold flags an intraday sweep.
  sweeps: {
    windowMs: num(process.env.SWEEP_WINDOW_MS, 8000),
    minPrints: num(process.env.SWEEP_MIN_PRINTS, 3),
    minNotional: num(process.env.SWEEP_MIN_NOTIONAL, 5_000_000),
    cooldownMs: num(process.env.SWEEP_COOLDOWN_MS, 30000),
  },
  // AI Daily News brief (Claude) + optional external news-signal engine.
  news: {
    model: process.env.NEWS_MODEL || 'claude-opus-4-8',
    // Cheaper model used to extract structured themes/ideas from each brief.
    extractModel: process.env.NEWS_EXTRACT_MODEL || 'claude-haiku-4-5',
    // Base URL of the News sentiment/signals service (the FastAPI engine):
    // exposes GET /signals and GET /signals/{ticker}. Leave empty to skip it.
    apiUrl: (process.env.NEWS_API_URL || '').replace(/\/+$/, ''),
  },
};

const hasShare = Boolean(config.schwab.tokenUrl);
const hasStatic = Boolean(config.schwab.token);

function decideSimulator() {
  if (config.forceSimulator) return true;
  switch (authMode) {
    case 'shared':
    case 'share':
      return !hasShare;
    case 'token':
    case 'static':
      return !hasStatic;
    default: // auto
      return !(hasShare || hasStatic);
  }
}

export const useSimulator = decideSimulator();
