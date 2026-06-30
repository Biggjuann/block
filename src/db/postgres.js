import pg from 'pg';

const { Pool } = pg;
let pool;

function needsSsl(url) {
  if (process.env.PGSSL === 'false') return false;
  if (process.env.PGSSL === 'true' || /sslmode=require/.test(url)) return true;
  // Railway internal networking and localhost don't need SSL; public hosts do.
  return !/\.railway\.internal|localhost|127\.0\.0\.1/.test(url);
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: url,
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : false,
    max: 8,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS block_trades (
      id         BIGSERIAL PRIMARY KEY,
      ticker     TEXT             NOT NULL,
      price      DOUBLE PRECISION NOT NULL,
      size       BIGINT           NOT NULL,
      value      DOUBLE PRECISION NOT NULL,
      bid_ask    TEXT             NOT NULL,
      pct_adv    DOUBLE PRECISION,
      traded_at  BIGINT           NOT NULL,
      created_at BIGINT           NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_block_trades_traded_at ON block_trades(traded_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_block_trades_ticker    ON block_trades(ticker)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_block_trades_value     ON block_trades(value)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      date         TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      model        TEXT,
      generated_at BIGINT NOT NULL
    )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brief_themes (
      id BIGSERIAL PRIMARY KEY, date TEXT NOT NULL, theme TEXT NOT NULL, summary TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brief_ideas (
      id BIGSERIAL PRIMARY KEY, date TEXT NOT NULL, ticker TEXT NOT NULL,
      thesis TEXT, catalyst TEXT, bias TEXT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brief_themes_date  ON brief_themes(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brief_ideas_date   ON brief_ideas(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brief_ideas_ticker ON brief_ideas(ticker)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      week_ending  TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      model        TEXT,
      generated_at BIGINT NOT NULL
    )`);
}

export async function getWeeklyReport(weekEnding) {
  const r = await pool.query('SELECT week_ending, content, model, generated_at FROM weekly_reports WHERE week_ending = $1', [weekEnding]);
  if (!r.rows[0]) return null;
  const x = r.rows[0];
  return { weekEnding: x.week_ending, content: x.content, model: x.model, generatedAt: Number(x.generated_at) };
}

export async function saveWeeklyReport({ weekEnding, content, model, generatedAt }) {
  await pool.query(
    `INSERT INTO weekly_reports (week_ending, content, model, generated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (week_ending) DO UPDATE SET content = EXCLUDED.content, model = EXCLUDED.model,
       generated_at = EXCLUDED.generated_at`,
    [weekEnding, content, model, generatedAt]
  );
}

export async function getDailyReport(date) {
  const r = await pool.query('SELECT date, content, model, generated_at FROM daily_reports WHERE date = $1', [date]);
  if (!r.rows[0]) return null;
  const x = r.rows[0];
  return { date: x.date, content: x.content, model: x.model, generatedAt: Number(x.generated_at) };
}

export async function saveDailyReport({ date, content, model, generatedAt }) {
  await pool.query(
    `INSERT INTO daily_reports (date, content, model, generated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (date) DO UPDATE SET content = EXCLUDED.content, model = EXCLUDED.model,
       generated_at = EXCLUDED.generated_at`,
    [date, content, model, generatedAt]
  );
}

export async function saveBriefStructured(date, themes = [], ideas = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM brief_themes WHERE date = $1', [date]);
    await c.query('DELETE FROM brief_ideas WHERE date = $1', [date]);
    for (const t of themes) {
      if (!t?.theme) continue;
      await c.query('INSERT INTO brief_themes (date, theme, summary) VALUES ($1,$2,$3)',
        [date, String(t.theme).slice(0, 200), String(t.summary || '').slice(0, 600)]);
    }
    for (const i of ideas) {
      if (!i?.ticker) continue;
      await c.query('INSERT INTO brief_ideas (date, ticker, thesis, catalyst, bias) VALUES ($1,$2,$3,$4,$5)',
        [date, String(i.ticker).toUpperCase().slice(0, 10), String(i.thesis || '').slice(0, 600), String(i.catalyst || '').slice(0, 400), String(i.bias || '').slice(0, 16)]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally {
    c.release();
  }
}

export async function getRecentThemes({ since, before, limit = 12 } = {}) {
  const r = await pool.query(
    `SELECT theme, COUNT(DISTINCT date)::int AS days, MAX(date) AS "lastDate", MAX(summary) AS summary
       FROM brief_themes WHERE date >= $1 AND date < $2
      GROUP BY theme ORDER BY days DESC, MAX(date) DESC LIMIT $3`,
    [since, before, limit]
  );
  return r.rows;
}

export async function getRecentIdeas({ since, before, limit = 40 } = {}) {
  const r = await pool.query(
    `SELECT date, ticker, thesis, catalyst, bias FROM brief_ideas
      WHERE date >= $1 AND date < $2 ORDER BY date DESC LIMIT $3`,
    [since, before, limit]
  );
  return r.rows;
}

export async function getIdeasByTicker(ticker, limit = 20) {
  const r = await pool.query(
    'SELECT date, ticker, thesis, catalyst, bias FROM brief_ideas WHERE ticker = $1 ORDER BY date DESC LIMIT $2',
    [String(ticker).toUpperCase(), limit]
  );
  return r.rows;
}

const startOfTodayMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const MAX = Number.MAX_SAFE_INTEGER;

// Postgres BIGINT comes back as a string; coerce numeric columns for the API.
function coerce(r) {
  return {
    ticker: r.ticker,
    price: Number(r.price),
    size: Number(r.size),
    value: Number(r.value),
    bidAsk: r.bid_ask,
    pctADV: r.pct_adv != null ? Number(r.pct_adv) : null,
    tradedAt: Number(r.traded_at),
  };
}

export async function insertBlockTrade(t) {
  const r = await pool.query(
    `INSERT INTO block_trades (ticker, price, size, value, bid_ask, pct_adv, traded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.ticker, t.price, t.size, t.value, t.bidAsk, t.pctADV ?? null, t.tradedAt]
  );
  return r.rows[0].id;
}

export async function getTopTrades({ since = startOfTodayMs(), until = MAX, limit = 12 } = {}) {
  const r = await pool.query(
    `SELECT ticker, COUNT(*)::int AS trades, SUM(size)::bigint AS volume, SUM(value) AS value,
            MAX(traded_at) AS last_at,
            (SELECT price FROM block_trades b2 WHERE b2.ticker = b1.ticker
               AND b2.traded_at >= $1 AND b2.traded_at < $2
               ORDER BY traded_at DESC LIMIT 1) AS price
       FROM block_trades b1
      WHERE traded_at >= $1 AND traded_at < $2
      GROUP BY ticker ORDER BY value DESC LIMIT $3`,
    [since, until, limit]
  );
  return r.rows.map((x) => ({
    ticker: x.ticker, trades: Number(x.trades), volume: Number(x.volume),
    value: Number(x.value), last_at: Number(x.last_at), price: Number(x.price),
  }));
}

export async function getRecentPrints({ minSize, limit = 30 } = {}) {
  const r = await pool.query(
    `SELECT ticker, price, size, value, bid_ask, pct_adv, traded_at
       FROM block_trades WHERE size >= $1 ORDER BY traded_at DESC LIMIT $2`,
    [minSize, limit]
  );
  return r.rows.map(coerce);
}

export async function getRecentBlockTrades({ minSize, limit = 300 } = {}) {
  const r = await pool.query(
    `SELECT ticker, price, size, value, bid_ask, pct_adv, traded_at
       FROM block_trades WHERE size >= $1 ORDER BY traded_at DESC LIMIT $2`,
    [minSize, limit]
  );
  return r.rows.map(coerce);
}

export async function getStats({ since = startOfTodayMs(), until = MAX } = {}) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS trades, COALESCE(SUM(value),0) AS value, COALESCE(SUM(size),0)::bigint AS volume
       FROM block_trades WHERE traded_at >= $1 AND traded_at < $2`,
    [since, until]
  );
  const row = r.rows[0];
  return { trades: Number(row.trades), value: Number(row.value), volume: Number(row.volume) };
}

export async function getPressure({ since = startOfTodayMs(), until = MAX, limit = 14 } = {}) {
  const r = await pool.query(
    `SELECT ticker,
            SUM(CASE WHEN bid_ask IN ('Above Ask','At Ask') THEN value ELSE 0 END) AS buy_value,
            SUM(CASE WHEN bid_ask IN ('Below Bid','At Bid') THEN value ELSE 0 END) AS sell_value,
            COUNT(*)::int AS trades
       FROM block_trades WHERE traded_at >= $1 AND traded_at < $2
      GROUP BY ticker
      ORDER BY ABS(SUM(CASE WHEN bid_ask IN ('Above Ask','At Ask') THEN value ELSE 0 END)
                 - SUM(CASE WHEN bid_ask IN ('Below Bid','At Bid') THEN value ELSE 0 END)) DESC
      LIMIT $3`,
    [since, until, limit]
  );
  return r.rows.map((x) => {
    const buyValue = Number(x.buy_value);
    const sellValue = Number(x.sell_value);
    return { ticker: x.ticker, buyValue, sellValue, trades: Number(x.trades), net: buyValue - sellValue };
  });
}

export async function purgeBlockTrades() {
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM block_trades');
  await pool.query('TRUNCATE block_trades RESTART IDENTITY');
  return Number(c.rows[0].n);
}

const SORT_COLS = {
  traded_at: 'traded_at', ticker: 'ticker', price: 'price',
  size: 'size', value: 'value', pct_adv: 'pct_adv', bid_ask: 'bid_ask',
};

export async function queryHistory(f = {}) {
  const where = [];
  const args = [];
  const add = (sql, val) => { args.push(val); where.push(sql.replace('?', `$${args.length}`)); };
  if (f.from != null) add('traded_at >= ?', f.from);
  if (f.to != null) add('traded_at <= ?', f.to);
  if (f.ticker) add('ticker = ?', f.ticker);
  if (f.minSize) add('size >= ?', f.minSize);
  if (f.minNotional) add('value >= ?', f.minNotional);
  if (f.bidAsk) add('bid_ask = ?', f.bidAsk);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = f.order === 'asc' ? 'ASC' : 'DESC';
  const sort = SORT_COLS[f.sort] || 'traded_at';
  const limit = f.limit ?? 100;
  const offset = f.offset ?? 0;

  const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM block_trades ${clause}`, args);
  const rowsRes = await pool.query(
    `SELECT ticker, price, size, value, bid_ask, pct_adv, traded_at
       FROM block_trades ${clause} ORDER BY ${sort} ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, limit, offset]
  );
  return { rows: rowsRes.rows.map(coerce), total: Number(totalRes.rows[0].n), limit, offset };
}
