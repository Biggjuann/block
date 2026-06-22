// Storage backend selector: Postgres when DATABASE_URL is set (Railway
// Postgres), otherwise the local SQLite file. Both expose the same async API.

export const dbBackend = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

const impl = dbBackend === 'postgres'
  ? await import('./postgres.js')
  : await import('./sqlite.js');

export const initDb = impl.initDb;
export const insertBlockTrade = impl.insertBlockTrade;
export const getTopTrades = impl.getTopTrades;
export const getRecentPrints = impl.getRecentPrints;
export const getRecentBlockTrades = impl.getRecentBlockTrades;
export const getStats = impl.getStats;
export const getPressure = impl.getPressure;
export const queryHistory = impl.queryHistory;
