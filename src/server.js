import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config, useSimulator } from './config.js';
import { startIngest } from './ingest.js';
import {
  getRecentBlockTrades,
  getRecentPrints,
  getStats,
  getTopTrades,
} from './db.js';

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
    status,
  })
);

app.get('/api/recent', (req, res) => {
  const limit = clamp(Number(req.query.limit) || 300, 1, 1000);
  res.json(getRecentBlockTrades({ limit }));
});

app.get('/api/top', (req, res) => {
  const limit = clamp(Number(req.query.limit) || 12, 1, 50);
  res.json(getTopTrades({ limit }));
});

app.get('/api/prints', (req, res) => {
  const limit = clamp(Number(req.query.limit) || 30, 1, 200);
  res.json(getRecentPrints({ limit }));
});

app.get('/api/stats', (_req, res) => res.json(getStats()));

// ---- Static frontend ----
app.use(express.static(publicDir));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---- Start ingestion ----
startIngest({
  broadcast: (trade) => broadcast({ type: 'trade', trade }),
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
