import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Ensure the directory for the SQLite file exists (Railway volume or local).
const dir = path.dirname(config.dbPath);
if (dir && dir !== '.' && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS block_trades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker     TEXT    NOT NULL,
    price      REAL    NOT NULL,
    size       INTEGER NOT NULL,
    value      REAL    NOT NULL,
    bid_ask    TEXT    NOT NULL,
    traded_at  INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_block_trades_traded_at ON block_trades(traded_at);
  CREATE INDEX IF NOT EXISTS idx_block_trades_ticker    ON block_trades(ticker);
  CREATE INDEX IF NOT EXISTS idx_block_trades_value     ON block_trades(value);
`);

const insertStmt = db.prepare(`
  INSERT INTO block_trades (ticker, price, size, value, bid_ask, traded_at)
  VALUES (@ticker, @price, @size, @value, @bidAsk, @tradedAt)
`);

export function insertBlockTrade(trade) {
  const info = insertStmt.run({
    ticker: trade.ticker,
    price: trade.price,
    size: trade.size,
    value: trade.value,
    bidAsk: trade.bidAsk,
    tradedAt: trade.tradedAt,
  });
  return info.lastInsertRowid;
}

const startOfTodayMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Aggregated "Top Trades" leaderboard, grouped by ticker for a time window.
export function getTopTrades({ since = startOfTodayMs(), limit = 12 } = {}) {
  return db
    .prepare(
      `SELECT ticker,
              COUNT(*)                AS trades,
              SUM(size)               AS volume,
              SUM(value)              AS value,
              MAX(traded_at)          AS last_at,
              (SELECT price FROM block_trades b2
                 WHERE b2.ticker = b1.ticker
                 ORDER BY traded_at DESC LIMIT 1) AS price
         FROM block_trades b1
        WHERE traded_at >= ?
        GROUP BY ticker
        ORDER BY value DESC
        LIMIT ?`
    )
    .all(since, limit);
}

// Most recent large prints for the dashboard "Prints" feed.
export function getRecentPrints({ minSize = config.printMinSize, limit = 30 } = {}) {
  return db
    .prepare(
      `SELECT ticker, price, size, value, bid_ask AS bidAsk, traded_at AS tradedAt
         FROM block_trades
        WHERE size >= ?
        ORDER BY traded_at DESC
        LIMIT ?`
    )
    .all(minSize, limit);
}

// Recent block trades used to backfill the viewer columns on page load.
export function getRecentBlockTrades({ minSize = config.blockMinSize, limit = 300 } = {}) {
  return db
    .prepare(
      `SELECT ticker, price, size, value, bid_ask AS bidAsk, traded_at AS tradedAt
         FROM block_trades
        WHERE size >= ?
        ORDER BY traded_at DESC
        LIMIT ?`
    )
    .all(minSize, limit);
}

export function getStats({ since = startOfTodayMs() } = {}) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(value),0) AS value,
              COALESCE(SUM(size),0) AS volume
         FROM block_trades WHERE traded_at >= ?`
    )
    .get(since);
  return row;
}

export default db;
