import { api, connectWS, fmt, setStatus, tagClass } from './common.js';

const MAX_ROWS = 60; // rows kept per column
let columns = [50000, 400000, 500000, 800000];
const bodies = new Map(); // threshold -> tbody element

function buildColumns() {
  const viewer = document.getElementById('viewer');
  viewer.innerHTML = '';
  for (const threshold of columns) {
    const col = document.createElement('section');
    col.className = 'column';
    col.innerHTML = `
      <div class="column-head">
        <div class="title">${fmt.compact(threshold)}</div>
        <div class="meta">size &ge; ${fmt.int(threshold)}</div>
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
    bodies.set(threshold, col.querySelector('tbody'));
  }
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
  for (const threshold of columns) {
    if (t.size < threshold) continue;
    const tbody = bodies.get(threshold);
    const tr = document.createElement('tr');
    if (animate) tr.className = 'flash';
    tr.innerHTML = rowHTML(t);
    tbody.insertBefore(tr, tbody.firstChild);
    while (tbody.children.length > MAX_ROWS) tbody.removeChild(tbody.lastChild);
  }
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
    const recent = await api('/api/recent?limit=300');
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
