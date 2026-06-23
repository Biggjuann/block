import {
  api, connectWS, fmt, setStatus, tagClass, pctAdvClass, setMarketBadge,
  loadSettings, saveSettings, loadWatchlist, saveWatchlist,
  requestNotifyPermission, notify, beep,
} from './common.js';
import { enableTickerClicks } from './chart.js';

const MAX_ROWS = 60;
const BUFFER_CAP = 800;

let columns = [
  { min: 50000, max: 400000 }, { min: 400000, max: 500000 },
  { min: 500000, max: 800000 }, { min: 800000, max: null },
];
const bodies = [];
const buffer = [];              // recent trades, newest first
let settings = loadSettings();
let watchlist = loadWatchlist();
const alertsState = [];         // recent alerts, newest first
let unseen = 0;
const lastAlertAt = new Map();  // client-side throttle per ticker

// ---------- Tape rendering ----------
const rangeLabel = (c) => (c.max ? `${fmt.compact(c.min)}–${fmt.compact(c.max)}` : `${fmt.compact(c.min)}+`);

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
            <th class="num">Size</th><th class="num">Value</th><th>Bid&nbsp;Ask</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    viewer.appendChild(col);
    bodies.push(col.querySelector('tbody'));
  }
}

function columnIndexFor(size) {
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (size >= c.min && (c.max == null || size < c.max)) return i;
  }
  return -1;
}

function passesFilter(t) {
  if (t.value < settings.minNotional) return false;
  if (settings.watchlistOnly && !watchlist.has(t.ticker)) return false;
  return true;
}

function rowTR(t, flash) {
  const star = watchlist.has(t.ticker) ? '<span class="star">★</span>' : '';
  const adv = t.pctADV != null
    ? `<span class="adv ${pctAdvClass(t.pctADV)}">${t.pctADV}%</span>` : '';
  const cls = [flash ? 'flash' : '', watchlist.has(t.ticker) ? 'watched' : ''].join(' ').trim();
  return `<tr class="${cls}">
    <td class="t-time">${fmt.time(t.tradedAt)}</td>
    <td class="ticker">${star}${t.ticker}</td>
    <td class="num t-price">${fmt.price(t.price)}</td>
    <td class="num t-size">${fmt.int(t.size)} ${adv}</td>
    <td class="num t-val">${fmt.money(t.value)}</td>
    <td><span class="${tagClass(t.bidAsk)}">${t.bidAsk}</span></td>
  </tr>`;
}

function addRow(t) {
  if (!passesFilter(t)) return;
  const idx = columnIndexFor(t.size);
  if (idx < 0) return;
  const tbody = bodies[idx];
  tbody.insertAdjacentHTML('afterbegin', rowTR(t, true));
  while (tbody.children.length > MAX_ROWS) tbody.removeChild(tbody.lastChild);
}

function renderAll() {
  const perCol = columns.map(() => []);
  for (const t of buffer) {
    if (!passesFilter(t)) continue;
    const idx = columnIndexFor(t.size);
    if (idx >= 0 && perCol[idx].length < MAX_ROWS) perCol[idx].push(rowTR(t, false));
  }
  perCol.forEach((rows, i) => { bodies[i].innerHTML = rows.join(''); });
}

// ---------- Alerts ----------
function clientAlert(t) {
  if (settings.alertWatchlistOnly && !watchlist.has(t.ticker)) return null;
  const reasons = [];
  if (settings.alertMinNotional && t.value >= settings.alertMinNotional) reasons.push(fmt.money(t.value));
  if (settings.alertMinPctADV && t.pctADV != null && t.pctADV >= settings.alertMinPctADV) {
    reasons.push(`${t.pctADV}% ADV`);
  }
  if (!reasons.length) return null;
  const now = Date.now();
  if (now - (lastAlertAt.get(t.ticker) || 0) < 30000) return null;
  lastAlertAt.set(t.ticker, now);
  return { trade: t, reasons, at: t.tradedAt, source: 'you' };
}

const alertedKeys = new Set();   // dedup so a trade can't alert twice (you + market)
let lastToastAt = 0;             // global throttle for intrusive surfaces

function fireAlert(alert) {
  const key = alert.source === 'sweep'
    ? `sweep:${alert.sweep.ticker}:${alert.sweep.at}`
    : (alert.trade.id ?? `${alert.trade.ticker}:${alert.trade.tradedAt}`);
  if (alertedKeys.has(key)) return;
  alertedKeys.add(key);
  if (alertedKeys.size > 600) alertedKeys.clear();

  alertsState.unshift(alert);
  if (alertsState.length > 60) alertsState.pop();
  unseen += 1;
  renderBadge();
  renderAlertsList();

  // The drawer logs every alert, but throttle toast/sound/notification globally
  // so a burst of qualifying blocks can't flood the screen.
  const now = Date.now();
  if (now - lastToastAt < 3500) return;
  lastToastAt = now;
  showToast(alert);
  if (settings.notify) {
    if (alert.source === 'sweep') {
      notify(`${alert.sweep.ticker} ${alert.sweep.side} sweep`, `${fmt.money(alert.sweep.totalValue)} across ${alert.sweep.count} prints`);
    } else {
      notify(`${alert.trade.ticker} block`, alert.reasons.join(' · '));
    }
  }
  if (settings.sound) beep();
}

function fireSweep(sweep) {
  if (settings.sweepAlerts === false) return;
  fireAlert({ source: 'sweep', sweep, at: sweep.at });
}

function renderBadge() {
  const b = document.getElementById('bell-badge');
  if (unseen > 0) { b.hidden = false; b.textContent = unseen > 99 ? '99+' : unseen; }
  else b.hidden = true;
}

function alertHTML(a) {
  if (a.source === 'sweep') {
    const s = a.sweep;
    const arrow = s.side === 'buy' ? '▲' : '▼';
    return `<div class="alert-item sweep ${s.side}">
      <div class="ai-top"><span class="ai-icon">⚡</span>
        <span class="ai-ticker">${s.ticker}</span>
        <span class="sweep-tag ${s.side}">${arrow} ${s.side.toUpperCase()} SWEEP</span>
        <span class="ai-val">${fmt.money(s.totalValue)}</span>
        <span class="ai-time">${fmt.time(a.at)}</span></div>
      <div class="ai-sub">${s.count} prints · ${fmt.int(s.totalSize)} sh ·
        ${fmt.price(s.priceLow)}–${fmt.price(s.priceHigh)}</div>
    </div>`;
  }
  const t = a.trade;
  const icon = a.source === 'market' ? '🐋' : '⭐';
  return `<div class="alert-item ${a.source}">
    <div class="ai-top"><span class="ai-icon">${icon}</span>
      <span class="ai-ticker">${t.ticker}</span>
      <span class="ai-val">${fmt.money(t.value)}</span>
      <span class="ai-time">${fmt.time(a.at)}</span></div>
    <div class="ai-sub">${fmt.int(t.size)} sh @ ${fmt.price(t.price)} ·
      <span class="${tagClass(t.bidAsk)}">${t.bidAsk}</span> · ${a.reasons.join(' · ')}</div>
  </div>`;
}

function renderAlertsList() {
  const el = document.getElementById('alerts-list');
  el.innerHTML = alertsState.length
    ? alertsState.map(alertHTML).join('')
    : '<div class="empty">No alerts yet. Set your rules in ⚙ Alert rules.</div>';
}

let toastTimer;
function showToast(a) {
  const wrap = document.getElementById('toasts');
  const div = document.createElement('div');
  div.className = `toast ${a.source}`;
  div.innerHTML = alertHTML(a);
  wrap.appendChild(div);
  setTimeout(() => div.classList.add('show'), 10);
  setTimeout(() => {
    div.classList.remove('show');
    setTimeout(() => div.remove(), 300);
  }, 6000);
  // keep the stack small
  while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
  clearTimeout(toastTimer);
}

// ---------- Watchlist UI ----------
function renderChips() {
  const el = document.getElementById('watch-chips');
  el.innerHTML = [...watchlist]
    .map((s) => `<span class="chip-tag">${s}<button data-rm="${s}">✕</button></span>`)
    .join('');
}

// ---------- Toolbar wiring ----------
function wireToolbar() {
  // Min notional segmented control
  const seg = document.getElementById('notional-seg');
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    if (Number(b.dataset.val) === settings.minNotional) {
      seg.querySelector('.seg-btn.active')?.classList.remove('active');
      b.classList.add('active');
    }
    b.addEventListener('click', () => {
      seg.querySelector('.seg-btn.active')?.classList.remove('active');
      b.classList.add('active');
      settings.minNotional = Number(b.dataset.val);
      saveSettings(settings);
      renderAll();
    });
  });

  // Watchlist
  const input = document.getElementById('watch-input');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const sym = input.value.trim().toUpperCase();
    if (sym) { watchlist.add(sym); saveWatchlist(watchlist); renderChips(); renderAll(); }
    input.value = '';
  });
  document.getElementById('watch-chips').addEventListener('click', (e) => {
    const sym = e.target.dataset?.rm;
    if (sym) { watchlist.delete(sym); saveWatchlist(watchlist); renderChips(); renderAll(); }
  });
  const watchOnly = document.getElementById('watch-only');
  watchOnly.checked = settings.watchlistOnly;
  watchOnly.addEventListener('change', () => {
    settings.watchlistOnly = watchOnly.checked; saveSettings(settings); renderAll();
  });

  // Alert settings popover
  const pop = document.getElementById('alert-pop');
  const fields = {
    notional: document.getElementById('al-notional'),
    pctadv: document.getElementById('al-pctadv'),
    watchOnly: document.getElementById('al-watch-only'),
    sweeps: document.getElementById('al-sweeps'),
    notify: document.getElementById('al-notify'),
    sound: document.getElementById('al-sound'),
  };
  fields.notional.value = settings.alertMinNotional;
  fields.pctadv.value = settings.alertMinPctADV;
  fields.watchOnly.checked = settings.alertWatchlistOnly;
  fields.sweeps.checked = settings.sweepAlerts !== false;
  fields.notify.checked = settings.notify;
  fields.sound.checked = settings.sound;
  fields.sweeps.addEventListener('change', () => { settings.sweepAlerts = fields.sweeps.checked; saveSettings(settings); });

  document.getElementById('alert-settings-btn').addEventListener('click', () => { pop.hidden = !pop.hidden; });
  document.getElementById('al-close').addEventListener('click', () => { pop.hidden = true; });
  fields.notional.addEventListener('input', () => { settings.alertMinNotional = Number(fields.notional.value) || 0; saveSettings(settings); });
  fields.pctadv.addEventListener('input', () => { settings.alertMinPctADV = Number(fields.pctadv.value) || 0; saveSettings(settings); });
  fields.watchOnly.addEventListener('change', () => { settings.alertWatchlistOnly = fields.watchOnly.checked; saveSettings(settings); });
  fields.sound.addEventListener('change', () => { settings.sound = fields.sound.checked; saveSettings(settings); });
  fields.notify.addEventListener('change', async () => {
    settings.notify = fields.notify.checked && (await requestNotifyPermission());
    fields.notify.checked = settings.notify;
    saveSettings(settings);
  });

  // Alerts drawer
  const drawer = document.getElementById('alerts-drawer');
  document.getElementById('bell').addEventListener('click', () => {
    drawer.classList.toggle('open');
    unseen = 0; renderBadge();
  });
  document.getElementById('drawer-close').addEventListener('click', () => drawer.classList.remove('open'));
  document.getElementById('alerts-clear').addEventListener('click', () => {
    alertsState.length = 0; unseen = 0; renderBadge(); renderAlertsList();
  });
}

// ---------- Live data ----------
function onTrade(t) {
  buffer.unshift(t);
  if (buffer.length > BUFFER_CAP) buffer.pop();
  addRow(t);
  const a = clientAlert(t);
  if (a) fireAlert(a);
}

// Rebuild the tape buffer from the server's continuously-recorded history.
async function resync() {
  try {
    const recent = await api('/api/recent?limit=400');
    buffer.length = 0;
    recent.reverse().forEach((t) => buffer.unshift(t));
    renderAll();
  } catch { /* ignore */ }
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
  renderChips();
  wireToolbar();
  renderAlertsList();
  enableTickerClicks();

  await resync();

  // Re-sync from the server-side record whenever the tab regains focus, so any
  // gap from background throttling is filled instantly. (Capture itself runs
  // continuously on the server regardless of whether this page is open.)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { resync(); refreshStats(); }
  });

  refreshStats();
  setInterval(refreshStats, 5000);
  setMarketBadge();
  setInterval(setMarketBadge, 30000);

  connectWS((msg) => {
    if (msg.type === 'trade') onTrade(msg.trade);
    else if (msg.type === 'sweep') fireSweep(msg.sweep);
    // Server "whale" alerts are intentionally NOT surfaced here — the browser
    // evaluates every trade against YOUR Alert Rules locally, so your settings
    // are the single source of truth. Server alerts drive Discord push only.
    else if (msg.type === 'status') setStatus(msg.status);
  });
}

init();
