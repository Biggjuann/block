import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db;

export async function initDb() {
  const dir = path.dirname(config.dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_trades (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker     TEXT    NOT NULL,
      price      REAL    NOT NULL,
      size       INTEGER NOT NULL,
      value      REAL    NOT NULL,
      bid_ask    TEXT    NOT NULL,
      pct_adv    REAL,
      traded_at  INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_block_trades_traded_at ON block_trades(traded_at);
    CREATE INDEX IF NOT EXISTS idx_block_trades_ticker    ON block_trades(ticker);
    CREATE INDEX IF NOT EXISTS idx_block_trades_value     ON block_trades(value);
  `);
  // Migration for DBs created before pct_adv existed.
  const cols = db.prepare(`PRAGMA table_info(block_trades)`).all().map((c) => c.name);
  if (!cols.includes('pct_adv')) db.exec(`ALTER TABLE block_trades ADD COLUMN pct_adv REAL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      date         TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      model        TEXT,
      generated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brief_themes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, theme TEXT NOT NULL, summary TEXT
    );
    CREATE TABLE IF NOT EXISTS brief_ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, ticker TEXT NOT NULL, thesis TEXT, catalyst TEXT, bias TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_brief_themes_date  ON brief_themes(date);
    CREATE INDEX IF NOT EXISTS idx_brief_ideas_date   ON brief_ideas(date);
    CREATE INDEX IF NOT EXISTS idx_brief_ideas_ticker ON brief_ideas(ticker);
    CREATE TABLE IF NOT EXISTS weekly_reports (
      week_ending  TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      model        TEXT,
      generated_at INTEGER NOT NULL
    );
  `);
}

export async function getWeeklyReport(weekEnding) {
  return db
    .prepare('SELECT week_ending AS weekEnding, content, model, generated_at AS generatedAt FROM weekly_reports WHERE week_ending = ?')
    .get(weekEnding) || null;
}

export async function saveWeeklyReport({ weekEnding, content, model, generatedAt }) {
  db.prepare(
    `INSERT INTO weekly_reports (week_ending, content, model, generated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(week_ending) DO UPDATE SET content = excluded.content, model = excluded.model,
       generated_at = excluded.generated_at`
  ).run(weekEnding, content, model, generatedAt);
}

export async function getDailyReport(date) {
  return db
    .prepare('SELECT date, content, model, generated_at AS generatedAt FROM daily_reports WHERE date = ?')
    .get(date) || null;
}

export async function saveDailyReport({ date, content, model, generatedAt }) {
  db.prepare(
    `INSERT INTO daily_reports (date, content, model, generated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET content = excluded.content, model = excluded.model,
       generated_at = excluded.generated_at`
  ).run(date, content, model, generatedAt);
}

// Replace the structured themes/ideas extracted from a day's brief.
export async function saveBriefStructured(date, themes = [], ideas = []) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM brief_themes WHERE date = ?').run(date);
    db.prepare('DELETE FROM brief_ideas WHERE date = ?').run(date);
    const ti = db.prepare('INSERT INTO brief_themes (date, theme, summary) VALUES (?, ?, ?)');
    for (const t of themes) if (t?.theme) ti.run(date, String(t.theme).slice(0, 200), String(t.summary || '').slice(0, 600));
    const ii = db.prepare('INSERT INTO brief_ideas (date, ticker, thesis, catalyst, bias) VALUES (?, ?, ?, ?, ?)');
    for (const i of ideas) if (i?.ticker) ii.run(date, String(i.ticker).toUpperCase().slice(0, 10), String(i.thesis || '').slice(0, 600), String(i.catalyst || '').slice(0, 400), String(i.bias || '').slice(0, 16));
  });
  tx();
}

// Recurring themes within [since, before): grouped by theme with day counts.
export async function getRecentThemes({ since, before, limit = 12 } = {}) {
  return db
    .prepare(
      `SELECT theme, COUNT(DISTINCT date) AS days, MAX(date) AS lastDate, MAX(summary) AS summary
         FROM brief_themes WHERE date >= ? AND date < ?
        GROUP BY theme ORDER BY days DESC, lastDate DESC LIMIT ?`
    )
    .all(since, before, limit);
}

export async function getRecentIdeas({ since, before, limit = 40 } = {}) {
  return db
    .prepare(
      `SELECT date, ticker, thesis, catalyst, bias FROM brief_ideas
        WHERE date >= ? AND date < ? ORDER BY date DESC LIMIT ?`
    )
    .all(since, before, limit);
}

export async function getIdeasByTicker(ticker, limit = 20) {
  return db
    .prepare('SELECT date, ticker, thesis, catalyst, bias FROM brief_ideas WHERE ticker = ? ORDER BY date DESC LIMIT ?')
    .all(String(ticker).toUpperCase(), limit);
}

const startOfTodayMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const MAX = Number.MAX_SAFE_INTEGER;

export async function insertBlockTrade(t) {
  const info = db
    .prepare(
      `INSERT INTO block_trades (ticker, price, size, value, bid_ask, pct_adv, traded_at)
       VALUES (@ticker, @price, @size, @value, @bidAsk, @pctADV, @tradedAt)`
    )
    .run({
      ticker: t.ticker, price: t.price, size: t.size, value: t.value,
      bidAsk: t.bidAsk, pctADV: t.pctADV ?? null, tradedAt: t.tradedAt,
    });
  return info.lastInsertRowid;
}

export async function getTopTrades({ since = startOfTodayMs(), until = MAX, limit = 12 } = {}) {
  return db
    .prepare(
      `SELECT ticker, COUNT(*) AS trades, SUM(size) AS volume, SUM(value) AS value,
              MAX(traded_at) AS last_at,
              (SELECT price FROM block_trades b2 WHERE b2.ticker = b1.ticker
                 AND b2.traded_at >= ? AND b2.traded_at < ?
                 ORDER BY traded_at DESC LIMIT 1) AS price
         FROM block_trades b1
        WHERE traded_at >= ? AND traded_at < ?
        GROUP BY ticker ORDER BY value DESC LIMIT ?`
    )
    .all(since, until, since, until, limit);
}

export async function getRecentPrints({ minSize = config.printMinSize, limit = 30 } = {}) {
  return db
    .prepare(
      `SELECT ticker, price, size, value, bid_ask AS bidAsk, pct_adv AS pctADV, traded_at AS tradedAt
         FROM block_trades WHERE size >= ? ORDER BY traded_at DESC LIMIT ?`
    )
    .all(minSize, limit);
}

export async function getRecentBlockTrades({ minSize = config.blockMinSize, limit = 300 } = {}) {
  return db
    .prepare(
      `SELECT ticker, price, size, value, bid_ask AS bidAsk, pct_adv AS pctADV, traded_at AS tradedAt
         FROM block_trades WHERE size >= ? ORDER BY traded_at DESC LIMIT ?`
    )
    .all(minSize, limit);
}

export async function getStats({ since = startOfTodayMs(), until = MAX } = {}) {
  return db
    .prepare(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(value),0) AS value, COALESCE(SUM(size),0) AS volume
         FROM block_trades WHERE traded_at >= ? AND traded_at < ?`
    )
    .get(since, until);
}

// Net buy/sell pressure per ticker: aggressive buys (Above/At Ask) vs
// aggressive sells (Below/At Bid), by notional.
export async function getPressure({ since = startOfTodayMs(), until = MAX, limit = 14 } = {}) {
  const rows = db
    .prepare(
      `SELECT ticker,
              SUM(CASE WHEN bid_ask IN ('Above Ask','At Ask') THEN value ELSE 0 END) AS buyValue,
              SUM(CASE WHEN bid_ask IN ('Below Bid','At Bid') THEN value ELSE 0 END) AS sellValue,
              COUNT(*) AS trades
         FROM block_trades WHERE traded_at >= ? AND traded_at < ?
        GROUP BY ticker
        ORDER BY ABS(SUM(CASE WHEN bid_ask IN ('Above Ask','At Ask') THEN value ELSE 0 END)
                   - SUM(CASE WHEN bid_ask IN ('Below Bid','At Bid') THEN value ELSE 0 END)) DESC
        LIMIT ?`
    )
    .all(since, until, limit);
  return rows.map((r) => ({ ...r, net: r.buyValue - r.sellValue }));
}

// Delete all stored block trades. Returns the number of rows removed.
export async function purgeBlockTrades() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM block_trades').get().n;
  db.prepare('DELETE FROM block_trades').run();
  return n;
}

// Whitelist of sortable columns (maps API field -> safe SQL column).
const SORT_COLS = {
  traded_at: 'traded_at', ticker: 'ticker', price: 'price',
  size: 'size', value: 'value', pct_adv: 'pct_adv', bid_ask: 'bid_ask',
};

// Flexible historical query backing the History page.
export async function queryHistory(f = {}) {
  const where = [];
  const args = [];
  if (f.from != null) { where.push('traded_at >= ?'); args.push(f.from); }
  if (f.to != null) { where.push('traded_at <= ?'); args.push(f.to); }
  if (f.ticker) { where.push('ticker = ?'); args.push(f.ticker); }
  if (f.minSize) { where.push('size >= ?'); args.push(f.minSize); }
  if (f.minNotional) { where.push('value >= ?'); args.push(f.minNotional); }
  if (f.bidAsk) { where.push('bid_ask = ?'); args.push(f.bidAsk); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = f.order === 'asc' ? 'ASC' : 'DESC';
  const sort = SORT_COLS[f.sort] || 'traded_at';
  const limit = f.limit ?? 100;
  const offset = f.offset ?? 0;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM block_trades ${clause}`).get(...args).n;
  const rows = db
    .prepare(
      `SELECT ticker, price, size, value, bid_ask AS bidAsk, pct_adv AS pctADV, traded_at AS tradedAt
         FROM block_trades ${clause} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);
  return { rows, total, limit, offset };
}
