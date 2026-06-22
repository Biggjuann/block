import { api, fmt, tagClass, pctAdvClass, setMarketBadge } from './common.js';

const PAGE = 100;
let offset = 0;
let total = 0;

const $ = (id) => document.getElementById(id);
const toMs = (v) => (v ? new Date(v).getTime() : undefined);

function filters() {
  const f = {
    from: toMs($('f-from').value),
    to: toMs($('f-to').value),
    ticker: $('f-ticker').value.trim().toUpperCase() || undefined,
    minSize: Number($('f-size').value) || undefined,
    minNotional: Number($('f-notional').value) || undefined,
    bidAsk: $('f-side').value || undefined,
    sort: $('f-sort').value,
    limit: PAGE,
    offset,
  };
  return f;
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== '') p.set(k, v);
  return p.toString();
}

function rowHTML(t) {
  const adv = t.pctADV != null
    ? `<span class="adv ${pctAdvClass(t.pctADV)}">${t.pctADV}%</span>` : '';
  return `<tr>
    <td class="t-time">${fmt.datetime(t.tradedAt)}</td>
    <td class="ticker">${t.ticker}</td>
    <td class="num t-price">${fmt.price(t.price)}</td>
    <td class="num t-size">${fmt.int(t.size)}</td>
    <td class="num t-val">${fmt.money(t.value)}</td>
    <td class="num">${adv}</td>
    <td><span class="${tagClass(t.bidAsk)}">${t.bidAsk}</span></td>
  </tr>`;
}

async function load() {
  $('hist-body').innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
  try {
    const res = await api('/api/history?' + qs(filters()));
    total = res.total;
    const rows = res.rows || [];
    $('hist-body').innerHTML = rows.length
      ? rows.map(rowHTML).join('')
      : '<tr><td colspan="7" class="empty">No trades match these filters.</td></tr>';
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE, total);
    $('result-info').textContent = `${total.toLocaleString()} trades`;
    $('page-info').textContent = `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
    $('prev').disabled = offset <= 0;
    $('next').disabled = offset + PAGE >= total;
  } catch {
    $('hist-body').innerHTML = '<tr><td colspan="7" class="empty">Failed to load history.</td></tr>';
  }
}

function applyAndReload() { offset = 0; load(); }

$('apply').addEventListener('click', applyAndReload);
$('f-ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyAndReload(); });
$('f-sort').addEventListener('change', applyAndReload);
$('f-side').addEventListener('change', applyAndReload);
$('reset').addEventListener('click', () => {
  ['f-from', 'f-to', 'f-ticker', 'f-size', 'f-notional'].forEach((id) => ($(id).value = ''));
  $('f-side').value = ''; $('f-sort').value = 'traded_at';
  applyAndReload();
});
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); load(); });
$('next').addEventListener('click', () => { if (offset + PAGE < total) { offset += PAGE; load(); } });

async function init() {
  try {
    const cfg = await api('/api/config');
    $('storage').textContent = (cfg.storage || 'db').toUpperCase();
  } catch { /* ignore */ }
  setMarketBadge();
  setInterval(setMarketBadge, 30000);
  load();
}

init();
