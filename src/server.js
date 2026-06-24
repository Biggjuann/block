import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, useSimulator } from './config.js';
import { startIngest } from './ingest.js';
import { startFundamentals } from './fundamentals.js';
import { dispatchDiscord, dispatchDiscordSweep, evaluateAlert } from './alerts.js';
import { detectSweep } from './sweeps.js';
import { getChartData } from './chart.js';
import { generateDailyNews, newsEnabled, newsSignalsConfigured } from './news.js';
import {
  dbBackend,
  getDailyReport,
  getIdeasByTicker,
  getPressure,
  getRecentBlockTrades,
  getRecentIdeas,
  getRecentPrints,
  getRecentThemes,
  getStats,
  getTopTrades,
  initDb,
  purgeBlockTrades,
  queryHistory,
  saveBriefStructured,
  saveDailyReport,
} from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let status = { state: useSimulator ? 'live' : 'connecting', detail: useSimulator ? 'simulator' : 'schwab' };

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status }));
});

// ---- REST API ----
app.get('/api/health', (_req, res) => res.json({ ok: true, status }));

app.get('/api/config', (_req, res) =>
  res.json({
    columns: config.columns, // [{ min, max|null }] — size ranges per column
    thresholds: config.thresholds,
    blockMinSize: config.blockMinSize,
    printMinSize: config.printMinSize,
    mode: useSimulator ? 'simulator' : 'schwab',
    symbolCount: config.schwab.symbols.length,
    alerts: { minNotional: config.alerts.minNotional, minPctADV: config.alerts.minPctADV },
    storage: dbBackend,
    newsEnabled: newsEnabled(),
    newsSignals: newsSignalsConfigured(),
    status,
  })
);

// Tiny async wrapper so a query error becomes a 500 instead of a hang.
const handle = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('api error', err.message);
    res.status(500).json({ error: 'query failed' });
  });

const startOfTodayMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Optional day window (epoch ms) so the dashboard can snapshot any single day.
const dayWindow = (q) => {
  const from = Number(q.from), to = Number(q.to);
  return {
    since: Number.isFinite(from) ? from : startOfTodayMs(),
    until: Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER,
  };
};

app.get('/api/recent', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 300, 1, 1000);
  res.json(await getRecentBlockTrades({ limit }));
}));

app.get('/api/top', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 12, 1, 50);
  res.json(await getTopTrades({ ...dayWindow(req.query), limit }));
}));

app.get('/api/prints', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 30, 1, 200);
  // Day-windowed feed when from/to given; otherwise the live recent feed.
  if (req.query.from || req.query.to) {
    const { since, until } = dayWindow(req.query);
    const { rows } = await queryHistory({
      from: since, to: until - 1, minSize: config.printMinSize, sort: 'traded_at', order: 'desc', limit,
    });
    return res.json(rows);
  }
  res.json(await getRecentPrints({ limit }));
}));

app.get('/api/stats', handle(async (req, res) => res.json(await getStats(dayWindow(req.query)))));

// Largest individual block prints for the window, ranked by notional (not summed).
app.get('/api/top-prints', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 25, 1, 100);
  const { since, until } = dayWindow(req.query);
  const { rows } = await queryHistory({ from: since, to: until - 1, sort: 'value', order: 'desc', limit });
  res.json(rows);
}));

app.get('/api/pressure', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 14, 1, 50);
  res.json(await getPressure({ ...dayWindow(req.query), limit }));
}));

app.get('/api/chart', handle(async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  res.json(await getChartData(symbol, String(req.query.tf || '1D')));
}));

// Destructive: wipe all stored block trades. Disabled unless ADMIN_KEY is set,
// and requires that key via the x-admin-key header or ?key= query param.
app.post('/api/admin/purge', handle(async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(403).json({ error: 'purge disabled (set ADMIN_KEY)' });
  const provided = req.get('x-admin-key') || req.query.key;
  if (provided !== key) return res.status(401).json({ error: 'invalid admin key' });
  const purged = await purgeBlockTrades();
  console.log(`[admin] purged ${purged} block trades`);
  res.json({ purged });
}));

// Historical query backing the History page.
app.get('/api/history', handle(async (req, res) => {
  const q = req.query;
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const result = await queryHistory({
    from: num(q.from),
    to: num(q.to),
    ticker: q.ticker ? String(q.ticker).trim().toUpperCase() : undefined,
    minSize: num(q.minSize),
    minNotional: num(q.minNotional),
    bidAsk: q.bidAsk ? String(q.bidAsk) : undefined,
    sort: q.sort ? String(q.sort) : 'traded_at',
    order: q.order === 'asc' ? 'asc' : 'desc',
    limit: clamp(num(q.limit) || 100, 1, 500),
    offset: Math.max(0, num(q.offset) || 0),
  });
  res.json(result);
}));

// ---- AI Daily News brief ----
// Generation is long (LLM + web search), so it runs in the background and the
// client polls GET /api/news — holding the HTTP request open would hit the
// platform's proxy timeout (which returns a non-JSON "upstream error" body).
const newsJobs = new Map(); // date -> { status: 'running'|'error', error?, at }

app.get('/api/news', handle(async (req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  if (!date) return res.status(400).json({ error: 'date required' });
  const report = await getDailyReport(date);
  if (report) return res.json(report);
  const job = newsJobs.get(date);
  if (job) return res.json({ date, content: null, status: job.status, error: job.error });
  res.json({ date, content: null });
}));

app.post('/api/news/generate', handle(async (req, res) => {
  if (!newsEnabled()) return res.status(400).json({ error: 'AI news disabled — set ANTHROPIC_API_KEY' });
  const date = String(req.query.date || '').slice(0, 10);
  if (!date) return res.status(400).json({ error: 'date required' });
  const job = newsJobs.get(date);
  if (job && job.status === 'running') return res.status(202).json({ date, status: 'generating' });

  const { since, until } = dayWindow(req.query);
  newsJobs.set(date, { status: 'running', at: Date.now() });
  // Fire and forget — respond immediately; client polls /api/news for the result.
  (async () => {
    try {
      const out = await generateDailyNews({ date, since, until });
      if (out.empty) {
        newsJobs.set(date, { status: 'error', error: 'No block trades were recorded for this day.', at: Date.now() });
      } else {
        await saveDailyReport({ date, content: out.content, model: config.news.model, generatedAt: Date.now() });
        if (out.structured) {
          await saveBriefStructured(date, out.structured.themes, out.structured.ideas).catch((e) => console.error('save structured failed', e.message));
        }
        newsJobs.delete(date); // result now lives in the DB
      }
    } catch (err) {
      console.error('news generation failed', err.message);
      newsJobs.set(date, { status: 'error', error: err.message, at: Date.now() });
    }
  })();
  res.status(202).json({ date, status: 'generating' });
}));

// ---- Knowledge base: themes & ideas accumulated from briefs ----
const todayStr = () => new Date().toISOString().slice(0, 10);
const shiftDay = (str, n) => {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * 86400000).toISOString().slice(0, 10);
};

app.get('/api/themes', handle(async (req, res) => {
  const anchor = String(req.query.date || '').slice(0, 10) || todayStr();
  const days = clamp(Number(req.query.days) || 30, 1, 180);
  res.json(await getRecentThemes({ since: shiftDay(anchor, days), before: shiftDay(anchor, -1), limit: clamp(Number(req.query.limit) || 15, 1, 50) }));
}));

app.get('/api/ideas', handle(async (req, res) => {
  const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : '';
  if (ticker) return res.json(await getIdeasByTicker(ticker, clamp(Number(req.query.limit) || 20, 1, 100)));
  const anchor = String(req.query.date || '').slice(0, 10) || todayStr();
  const days = clamp(Number(req.query.days) || 30, 1, 180);
  res.json(await getRecentIdeas({ since: shiftDay(anchor, days), before: shiftDay(anchor, -1), limit: clamp(Number(req.query.limit) || 60, 1, 200) }));
}));

// ---- Static frontend ----
app.use(express.static(publicDir));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/history', (_req, res) => res.sendFile(path.join(publicDir, 'history.html')));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---- Initialize storage, then start fundamentals (ADV) + ingestion ----
await initDb();
console.log(`Storage: ${dbBackend.toUpperCase()}`);

startFundamentals({ symbols: config.schwab.symbols, useSchwab: !useSimulator });

startIngest({
  broadcast: (trade) => {
    broadcast({ type: 'trade', trade });
    // Server-side whale alert: broadcast + optional Discord push.
    const alert = evaluateAlert(trade);
    if (alert) {
      broadcast({ type: 'alert', alert });
      dispatchDiscord(alert);
    }
    // Sweep detection: directional burst of aggressive same-side prints.
    const sweep = detectSweep(trade);
    if (sweep) {
      broadcast({ type: 'sweep', sweep });
      dispatchDiscordSweep(sweep);
    }
  },
  onStatus: (state, detail) => {
    status = { state, detail };
    broadcast({ type: 'status', status });
    console.log(`[ingest] ${state} — ${detail || ''}`);
  },
});

server.listen(config.port, () => {
  console.log(`Block Trade Viewer listening on :${config.port}`);
  console.log(`Mode: ${useSimulator ? 'SIMULATOR' : 'SCHWAB'} | block>=${config.blockMinSize} print>=${config.printMinSize}`);
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
