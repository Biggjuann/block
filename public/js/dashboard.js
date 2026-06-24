import { api, connectWS, fmt, setStatus, tagClass, pctAdvClass, setMarketBadge, mdToHtml } from './common.js';
import { enableTickerClicks } from './chart.js';
import { initSortable } from './sortable.js';

let activeTab = 'top';
let topData = [];
let pressureData = [];
let bigPrints = [];
let dateLabel = 'today';
let newsByDate = {};      // date -> report object
let newsLoading = false;
let newsLoadingDate = null;
let cfg = {};             // /api/config snapshot (newsEnabled, newsSignals)
const PRINT_MIN = 400000;
const printsBody = document.getElementById('prints-body');
const mainPanel = document.getElementById('main-panel');
let printRows = 0;

// ---- Tabs ----
document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  activeTab = tab.dataset.tab;
  if (activeTab === 'news' && newsByDate[dateKey()] === undefined) loadNews();
  renderMain(false); // switching tabs resets scroll to top
});

// ---- Main panel renderers ----
const SCROLLERS = '.table-wrap, .pressure-list, .bars, .heatmap';

function renderMain(preserveScroll = true) {
  // Preserve the scroll position across re-renders (live + 15s refresh) so the
  // list doesn't jump back to the top while you're reading it.
  const prev = preserveScroll ? mainPanel.querySelector(SCROLLERS)?.scrollTop || 0 : 0;
  if (activeTab === 'top') renderTop();
  else if (activeTab === 'bigprints') renderBigPrints();
  else if (activeTab === 'pressure') renderPressure();
  else if (activeTab === 'premarket') renderVolume();
  else if (activeTab === 'heatmap') renderHeatmap();
  else if (activeTab === 'news') renderNews();
  else if (activeTab === 'earnings') renderSoon('Earnings Calendar', '📅',
    'Upcoming earnings ranked by block-flow interest. Connect a fundamentals feed to populate this view.');
  else if (activeTab === 'exdiv') renderSoon('Ex-Dividend', '💸',
    'Stocks going ex-dividend, cross-referenced with block activity. Requires a corporate-actions feed.');
  if (preserveScroll && prev) {
    const sc = mainPanel.querySelector(SCROLLERS);
    if (sc) sc.scrollTop = prev;
  }
}

function renderTop() {
  const max = Math.max(1, ...topData.map((d) => d.value));
  const bars = topData
    .map(
      (d) => `
      <div class="bar-row">
        <div class="sym">${d.ticker}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(d.value / max) * 100}%"></div></div>
        <div class="val">${fmt.money(d.value)}</div>
      </div>`
    )
    .join('');

  const rows = topData
    .map(
      (d) => `
      <tr>
        <td class="ticker">${d.ticker}</td>
        <td class="num t-price">${fmt.price(d.price)}</td>
        <td class="num">${fmt.int(d.trades)}</td>
        <td class="num">${fmt.int(d.volume)}</td>
        <td class="num t-size">${fmt.money(d.value)}</td>
      </tr>`
    )
    .join('');

  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Top Trades</h2><span class="hint">by notional value · ${dateLabel}</span></div>
      <div class="top-layout">
        <div class="bars">${bars || emptyMsg()}</div>
        <div class="table-wrap">
          <table class="sortable" data-sort-key="top">
            <thead><tr><th>Ticker</th><th class="num">Price</th><th class="num">Trades</th><th class="num">Volume</th><th class="num">Value</th></tr></thead>
            <tbody>${rows || ''}</tbody>
          </table>
        </div>
      </div>
    </section>`;
}

function renderBigPrints() {
  const rows = bigPrints
    .map((t, i) => {
      const adv = t.pctADV != null ? `<span class="adv ${pctAdvClass(t.pctADV)}">${t.pctADV}%</span>` : '';
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td class="t-time">${fmt.time(t.tradedAt)}</td>
        <td class="ticker">${t.ticker}</td>
        <td class="num t-price">${fmt.price(t.price)}</td>
        <td class="num t-size">${fmt.int(t.size)}</td>
        <td class="num t-val">${fmt.money(t.value)}</td>
        <td class="num">${adv}</td>
        <td><span class="${tagClass(t.bidAsk)}">${t.bidAsk}</span></td>
      </tr>`;
    })
    .join('');
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Biggest Trades</h2>
        <span class="hint">largest individual prints · ${dateLabel} · by notional</span></div>
      <div class="table-wrap" style="max-height:calc(100vh - 180px)">
        <table class="sortable" data-sort-key="bigprints" data-rank-col="0">
          <thead><tr><th>#</th><th>Time</th><th>Ticker</th><th class="num">Price</th>
            <th class="num">Size</th><th class="num">Value</th><th class="num">%ADV</th><th>Bid&nbsp;Ask</th></tr></thead>
          <tbody>${rows || ''}</tbody>
        </table>
      </div>
      ${bigPrints.length ? '' : emptyMsg()}
    </section>`;
}

function renderPressure() {
  const max = Math.max(1, ...pressureData.flatMap((d) => [d.buyValue, d.sellValue]));
  const rows = pressureData
    .map((d) => {
      const fb = (d.buyValue / max) * 100;
      const fs = (d.sellValue / max) * 100;
      const netCls = d.net >= 0 ? 'pos' : 'neg';
      return `<div class="pr-row">
        <div class="sym">${d.ticker}</div>
        <div class="pr-track">
          <div class="pr-half left"><div class="pr-sell" style="width:${fs}%"></div></div>
          <div class="pr-half right"><div class="pr-buy" style="width:${fb}%"></div></div>
        </div>
        <div class="pr-net ${netCls}">${d.net >= 0 ? '+' : '−'}${fmt.money(Math.abs(d.net))}</div>
      </div>`;
    })
    .join('');
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Net Buy / Sell Pressure</h2>
        <span class="hint">aggressor side · ${dateLabel} · <span style="color:var(--green)">▲ buy</span> / <span style="color:var(--red)">sell ▼</span></span></div>
      <div class="pressure-list">${rows || emptyMsg()}</div>
    </section>`;
}

function renderVolume() {
  const byVol = [...topData].sort((a, b) => b.volume - a.volume);
  const max = Math.max(1, ...byVol.map((d) => d.volume));
  const bars = byVol
    .map(
      (d) => `
      <div class="bar-row">
        <div class="sym">${d.ticker}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(d.volume / max) * 100}%"></div></div>
        <div class="val">${fmt.compact(d.volume)}</div>
      </div>`
    )
    .join('');
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Volume Leaders</h2><span class="hint">block share volume · ${dateLabel}</span></div>
      <div class="bars">${bars || emptyMsg()}</div>
    </section>`;
}

function renderHeatmap() {
  const max = Math.max(1, ...topData.map((d) => d.value));
  const cells = topData
    .map((d) => {
      const intensity = d.value / max; // 0..1
      const bg = `rgba(47, 143, 255, ${0.10 + intensity * 0.5})`;
      const border = `rgba(80, 130, 220, ${0.3 + intensity * 0.5})`;
      return `
        <div class="heat-cell" style="background:${bg};border-color:${border};flex-grow:${1 + intensity * 4}">
          <div class="sym">${d.ticker}</div>
          <div class="v">${fmt.money(d.value)}</div>
          <div class="sz">${fmt.compact(d.volume)} sh · ${fmt.int(d.trades)} trades</div>
        </div>`;
    })
    .join('');
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Flow Heatmap</h2><span class="hint">sized by notional value</span></div>
      <div class="heatmap">${cells || emptyMsg()}</div>
    </section>`;
}

function renderSoon(title, icon, desc) {
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>${title}</h2></div>
      <div class="coming"><div class="big">${icon}</div><div>${desc}</div></div>
    </section>`;
}

const emptyMsg = () => `<div class="empty">Waiting for block trades…</div>`;

// ---- Daily News (AI brief) ----
const dateKey = () => toInputValue(selectedDate);

function renderNews() {
  const key = dateKey();
  const report = newsByDate[key];
  let body;
  if (newsLoading && newsLoadingDate === key) {
    body = `<div class="news-loading"><div class="spinner"></div>
      <div>Researching ${dateLabel === 'today' ? "today's" : dateLabel} news &amp; flow…</div>
      <div class="news-sub">Reading sources and writing the brief — this can take 30–60s.</div></div>`;
  } else if (report && report.content) {
    const when = report.generatedAt ? `generated ${fmt.datetime(report.generatedAt)}` : '';
    body = `<div class="news-meta"><span>${when}${report.model ? ` · ${report.model}` : ''}</span>
        <button class="ghost-btn sm" data-gen-news>↻ Regenerate</button></div>
      <article class="md">${mdToHtml(report.content)}</article>`;
  } else {
    const err = report && report.error ? `<div class="news-err">${report.error}</div>` : '';
    const canGen = cfg.newsEnabled;
    const hint = canGen
      ? `Generate an AI brief tying the day's biggest block trades to real news catalysts${cfg.newsSignals ? ', using your news engine + web research' : ' via web research'}.`
      : 'Set <code>ANTHROPIC_API_KEY</code> on the server to enable AI news briefs.';
    body = `<div class="news-empty"><div class="big">✨</div>
        <div>${hint}</div>${err}
        <button class="gen-btn" data-gen-news ${canGen ? '' : 'disabled'}>Generate brief for ${dateLabel}</button>
      </div>`;
  }
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Daily News ✨</h2><span class="hint">AI brief · ${dateLabel}</span></div>
      <div class="news-wrap">${body}</div>
    </section>`;
}

async function loadNews() {
  const key = dateKey();
  try {
    newsByDate[key] = await api(`/api/news?date=${key}`);
  } catch { /* ignore */ }
  if (activeTab === 'news') renderMain(false);
}

async function generateNews() {
  if (!cfg.newsEnabled || newsLoading) return;
  const key = dateKey();
  const { from, to } = dayBounds();
  newsLoading = true; newsLoadingDate = key; renderMain(false);
  try {
    const r = await fetch(`/api/news/generate?date=${key}&from=${from}&to=${to}`, { method: 'POST' });
    if (r.status >= 400 && r.status !== 429) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); msg = j.error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    // Generation runs in the background — poll until the brief is ready.
    const deadline = Date.now() + 4 * 60 * 1000;
    let done = false;
    while (Date.now() < deadline) {
      await sleep(4000);
      let rep;
      try { rep = await api(`/api/news?date=${key}`); } catch { continue; }
      if (rep && rep.content) { newsByDate[key] = rep; done = true; break; }
      if (rep && rep.status === 'error') {
        newsByDate[key] = { date: key, content: null, error: rep.error || 'generation failed' };
        done = true; break;
      }
      // status 'running' (or no content yet) → keep polling
    }
    if (!done) newsByDate[key] = { date: key, content: null, error: 'Timed out — try again.' };
  } catch (err) {
    newsByDate[key] = { date: key, content: null, error: err.message };
  } finally {
    newsLoading = false; newsLoadingDate = null; renderMain(false);
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- Prints feed ----
function addPrint(t, animate = true) {
  if (t.size < PRINT_MIN) return;
  const tr = document.createElement('tr');
  if (animate) tr.className = 'flash';
  tr.innerHTML = `
    <td class="ticker">${t.ticker}</td>
    <td class="num t-price">${fmt.price(t.price)}</td>
    <td class="num t-size">${fmt.int(t.size)}</td>
    <td class="num t-val">${fmt.money(t.value)}</td>
    <td class="t-time">${fmt.time(t.tradedAt)}</td>`;
  printsBody.insertBefore(tr, printsBody.firstChild);
  while (printsBody.children.length > 60) printsBody.removeChild(printsBody.lastChild);
  printRows = Math.min(printRows + 1, 60);
  document.getElementById('prints-count').textContent = printRows;
}

// Keep the "Biggest Trades" list live: insert the print if it ranks today.
function foldBigPrint(t) {
  bigPrints.push(t);
  bigPrints.sort((a, b) => b.value - a.value);
  bigPrints = bigPrints.slice(0, 30);
}

// Fold a live trade into the aggregated top-trades dataset.
function foldTrade(t) {
  let row = topData.find((d) => d.ticker === t.ticker);
  if (!row) {
    row = { ticker: t.ticker, trades: 0, volume: 0, value: 0, price: t.price };
    topData.push(row);
  }
  row.trades += 1;
  row.volume += t.size;
  row.value += t.value;
  row.price = t.price;
  topData.sort((a, b) => b.value - a.value);
  topData = topData.slice(0, 18);
}

async function refreshStats() {
  try {
    const s = await api(`/api/stats?${dayQS()}`);
    document.getElementById('stat-trades').textContent = fmt.int(s.trades);
    document.getElementById('stat-value').textContent = fmt.money(s.value);
  } catch { /* ignore */ }
}

let lastRender = 0;
function maybeRender() {
  const now = Date.now();
  if (now - lastRender > 1200) { lastRender = now; renderMain(); }
}

// ---- Date selection ----
const startOfLocalDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
let selectedDate = startOfLocalDay(new Date());
function dayBounds() { const from = selectedDate.getTime(); return { from, to: from + 86400000 }; }
function dayQS() { const { from, to } = dayBounds(); return `from=${from}&to=${to}`; }
function isTodaySelected() { return selectedDate.getTime() === startOfLocalDay(new Date()).getTime(); }
const toInputValue = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadDay() {
  const qs = dayQS();
  try {
    [topData, pressureData, bigPrints] = await Promise.all([
      api(`/api/top?limit=18&${qs}`), api(`/api/pressure?limit=16&${qs}`), api(`/api/top-prints?limit=30&${qs}`),
    ]);
  } catch { topData = []; pressureData = []; bigPrints = []; }
  printsBody.innerHTML = ''; printRows = 0;
  document.getElementById('prints-count').textContent = '--';
  try {
    const prints = await api(`/api/prints?limit=60&${qs}`);
    prints.reverse().forEach((p) => addPrint(p, false));
  } catch { /* ignore */ }
  renderMain(false);
  refreshStats();
}

function setDate(d) {
  const today = startOfLocalDay(new Date());
  selectedDate = startOfLocalDay(d);
  if (selectedDate > today) selectedDate = today; // no future dates
  document.getElementById('day-date').value = toInputValue(selectedDate);
  dateLabel = isTodaySelected()
    ? 'today'
    : selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  document.querySelector('.date-nav').classList.toggle('snapshot', !isTodaySelected());
  document.getElementById('day-next').disabled = isTodaySelected();
  loadDay();
  if (activeTab === 'news') loadNews();
}

function wireDateNav() {
  const shift = (days) => setDate(new Date(selectedDate.getTime() + days * 86400000));
  document.getElementById('day-prev').addEventListener('click', () => shift(-1));
  document.getElementById('day-next').addEventListener('click', () => shift(1));
  document.getElementById('day-today').addEventListener('click', () => setDate(new Date()));
  document.getElementById('day-date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split('-').map(Number);
    setDate(new Date(y, m - 1, d));
  });
}

async function init() {
  try {
    cfg = await api('/api/config');
    setStatus(cfg.status);
  } catch { /* ignore */ }

  enableTickerClicks();
  initSortable();
  wireDateNav();
  mainPanel.addEventListener('click', (e) => {
    if (e.target.closest('[data-gen-news]')) generateNews();
  });
  setMarketBadge();
  setInterval(setMarketBadge, 30000);

  setDate(new Date()); // loads today's snapshot

  // Refresh the live (today) snapshot periodically; past days are static.
  setInterval(async () => {
    if (!isTodaySelected()) return;
    const qs = dayQS();
    try {
      [topData, pressureData, bigPrints] = await Promise.all([
        api(`/api/top?limit=18&${qs}`), api(`/api/pressure?limit=16&${qs}`), api(`/api/top-prints?limit=30&${qs}`),
      ]);
      renderMain();
    } catch { /* ignore */ }
  }, 15000);
  setInterval(() => { if (isTodaySelected()) refreshStats(); }, 5000);

  connectWS((msg) => {
    if (msg.type === 'trade') {
      if (!isTodaySelected()) return; // don't mutate a historical snapshot
      foldTrade(msg.trade);
      foldBigPrint(msg.trade);
      addPrint(msg.trade);
      maybeRender();
    } else if (msg.type === 'status') {
      setStatus(msg.status);
    }
  });
}

init();
