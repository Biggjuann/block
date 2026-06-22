import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, useSimulator } from './config.js';
import { startIngest } from './ingest.js';
import { startFundamentals } from './fundamentals.js';
import { dispatchDiscord, evaluateAlert } from './alerts.js';
import {
  dbBackend,
  getRecentBlockTrades,
  getRecentPrints,
  getStats,
  getTopTrades,
  initDb,
  queryHistory,
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
    status,
  })
);

// Tiny async wrapper so a query error becomes a 500 instead of a hang.
const handle = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('api error', err.message);
    res.status(500).json({ error: 'query failed' });
  });

app.get('/api/recent', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 300, 1, 1000);
  res.json(await getRecentBlockTrades({ limit }));
}));

app.get('/api/top', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 12, 1, 50);
  res.json(await getTopTrades({ limit }));
}));

app.get('/api/prints', handle(async (req, res) => {
  const limit = clamp(Number(req.query.limit) || 30, 1, 200);
  res.json(await getRecentPrints({ limit }));
}));

app.get('/api/stats', handle(async (_req, res) => res.json(await getStats())));

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
    sort: q.sort === 'value' ? 'value' : 'traded_at',
    order: q.order === 'asc' ? 'asc' : 'desc',
    limit: clamp(num(q.limit) || 100, 1, 500),
    offset: Math.max(0, num(q.offset) || 0),
  });
  res.json(result);
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
