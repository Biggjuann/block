import { api, connectWS, fmt, setStatus, tagClass } from './common.js';

const MAX_ROWS = 60; // rows kept per column
// Columns are size RANGES: { min, max } where max=null means open-ended.
let columns = [
  { min: 50000, max: 400000 },
  { min: 400000, max: 500000 },
  { min: 500000, max: 800000 },
  { min: 800000, max: null },
];
const bodies = []; // index-aligned with columns -> tbody element

function rangeLabel(c) {
  return c.max ? `${fmt.compact(c.min)}–${fmt.compact(c.max)}` : `${fmt.compact(c.min)}+`;
}

function buildColumns() {
  const viewer = document.getElementById('viewer');
  viewer.innerHTML = '';
  bodies.length = 0;
  for (const c of columns) {
    const col = document.createElement('section');
    col.className = 'column';
    col.innerHTML = `
      <div class="column-head">
        <div class="title">${fmt.compact(c.min)}</div>
        <div class="meta">${rangeLabel(c)} shares</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Time</th><th>Ticker</th><th class="num">Price</th>
            <th class="num">Size</th><th>Bid&nbsp;Ask</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    viewer.appendChild(col);
    bodies.push(col.querySelector('tbody'));
  }
}

// A trade belongs to exactly one column: the range that contains its size.
function columnIndexFor(size) {
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (size >= c.min && (c.max == null || size < c.max)) return i;
  }
  return -1;
}

function rowHTML(t) {
  return `
    <td class="t-time">${fmt.time(t.tradedAt)}</td>
    <td class="ticker">${t.ticker}</td>
    <td class="num t-price">${fmt.price(t.price)}</td>
    <td class="num t-size">${fmt.int(t.size)}</td>
    <td><span class="${tagClass(t.bidAsk)}">${t.bidAsk}</span></td>`;
}

function addTrade(t, animate = true) {
  const idx = columnIndexFor(t.size);
  if (idx < 0) return;
  const tbody = bodies[idx];
  const tr = document.createElement('tr');
  if (animate) tr.className = 'flash';
  tr.innerHTML = rowHTML(t);
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.children.length > MAX_ROWS) tbody.removeChild(tbody.lastChild);
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    document.getElementById('stat-trades').textContent = fmt.int(s.trades);
    document.getElementById('stat-value').textContent = fmt.money(s.value);
  } catch { /* ignore */ }
}

async function init() {
  try {
    const cfg = await api('/api/config');
    if (Array.isArray(cfg.columns) && cfg.columns.length) columns = cfg.columns;
    setStatus(cfg.status);
  } catch { /* keep defaults */ }

  buildColumns();

  // Backfill from persisted trades (oldest first so newest ends up on top).
  try {
    const recent = await api('/api/recent?limit=400');
    recent.reverse().forEach((t) => addTrade(t, false));
  } catch { /* ignore */ }

  refreshStats();
  setInterval(refreshStats, 5000);

  connectWS((msg) => {
    if (msg.type === 'trade') addTrade(msg.trade);
    else if (msg.type === 'status') setStatus(msg.status);
  });
}

init();
