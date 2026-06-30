import { api, connectWS, fmt, setStatus, tagClass, pctAdvClass, setMarketBadge, mdToHtml } from './common.js';
import { enableTickerClicks } from './chart.js';
import { initSortable } from './sortable.js';

let activeTab = 'top';
let topData = [];
let pressureData = [];
let bigPrints = [];
let setupsData = [];
let setupsFilter = 'all';
let setupsLoaded = false;
let dateLabel = 'today';
let newsByDate = {};      // date -> report object
let kbByDate = {};        // date -> { themes, ideas } knowledge base
let newsLoading = false;
let newsLoadingDate = null;
let weeklyReport = null;  // current week's review { weekEnding, content, ... }
let weeklyLoading = false;
let weeklyPolling = false;
let cfg = {};             // /api/config snapshot (newsEnabled, newsSignals)
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (activeTab === 'news') ensureNewsLoaded();
  if (activeTab === 'setups' && !setupsLoaded) loadSetups();
  if (activeTab === 'weekly') ensureWeeklyLoaded();
  renderMain(false); // switching tabs resets scroll to top
});

// ---- Main panel renderers ----
const SCROLLERS = '.table-wrap, .pressure-list, .bars, .heatmap, .setup-grid';

function renderMain(preserveScroll = true) {
  // Preserve the scroll position across re-renders (live + 15s refresh) so the
  // list doesn't jump back to the top while you're reading it.
  const prev = preserveScroll ? mainPanel.querySelector(SCROLLERS)?.scrollTop || 0 : 0;
  if (activeTab === 'top') renderTop();
  else if (activeTab === 'bigprints') renderBigPrints();
  else if (activeTab === 'setups') renderSetups();
  else if (activeTab === 'pressure') renderPressure();
  else if (activeTab === 'premarket') renderVolume();
  else if (activeTab === 'heatmap') renderHeatmap();
  else if (activeTab === 'news') renderNews();
  else if (activeTab === 'weekly') renderWeekly();
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

function renderSetups() {
  const counts = { all: setupsData.length, bullish: 0, bearish: 0 };
  setupsData.forEach((s) => { if (s.bias === 'bullish') counts.bullish++; else if (s.bias === 'bearish') counts.bearish++; });
  const list = setupsData.filter((s) => setupsFilter === 'all' || s.bias === setupsFilter);

  const seg = ['all', 'bullish', 'bearish']
    .map((f) => `<button class="seg-btn ${setupsFilter === f ? 'active' : ''}" data-setup-filter="${f}">${f[0].toUpperCase() + f.slice(1)} <b>${counts[f]}</b></button>`)
    .join('');

  const cards = list.map(setupCard).join('');
  let body;
  if (!setupsLoaded) body = emptyMsg();
  else if (cards) body = cards;
  else if (setupsData.length) body = `<div class="empty">No ${setupsFilter} setups — try another filter.</div>`;
  else body = `<div class="empty">No unusual block prints detected in the lookback window.</div>`;

  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Unusual Print Setups 🎯</h2>
        <span class="hint">abnormal single prints · 10-day lookback · as of ${dateLabel}</span></div>
      <div class="setup-bar"><div class="seg">${seg}</div>
        <span class="setup-legend">price vs <b>block level</b> (where the big trades printed)</span></div>
      <div class="setup-grid">${body}</div>
    </section>`;
}

function setupCard(s) {
  const biasLabel = s.bias === 'bullish' ? 'Bullish' : s.bias === 'bearish' ? 'Bearish' : 'Mixed';
  const adv = s.maxPctADV != null ? ` · up to <span class="${pctAdvClass(s.maxPctADV)}" style="padding:0 4px;border-radius:4px">${s.maxPctADV}% ADV</span>` : '';
  const b = s.biggest;
  // Multi-day trail: one dot per active day (oldest→newest), green = net buying.
  const trail = (s.days || []).slice(-8).map((d) =>
    `<i class="d-dot ${d.net > 0 ? 'buy' : d.net < 0 ? 'sell' : 'flat'}" title="${d.date}: ${d.net >= 0 ? '+' : '−'}${fmt.money(Math.abs(d.net))} net"></i>`).join('');
  const contLabel = { building: 'Building', persisting: 'Persisting', flipping: 'Flipping', new: 'New' }[s.continuity] || '';
  const cont = s.daysActive > 1
    ? `<span class="setup-cont ${s.continuity}" title="how prior days' big trades relate to today">${contLabel} · ${s.daysActive}d</span>`
    : `<span class="setup-cont new" title="first day of unusual flow">New · 1d</span>`;

  // Supply/support structure: block volume above vs below the current price.
  const above = s.aboveNotional || 0;
  const below = s.belowNotional || 0;
  const tot = above + below || 1;
  const belowPct = (below / tot) * 100;
  const nowPos = Math.max(8, Math.min(92, belowPct)); // keep the price label on-card
  const supplyTxt = above > 0 ? `${fmt.money(above)}${s.aboveVwap ? ` @ ~${fmt.price(s.aboveVwap)}` : ''}` : 'none';
  const supportTxt = below > 0 ? `${fmt.money(below)}${s.belowVwap ? ` @ ~${fmt.price(s.belowVwap)}` : ''}` : 'none';

  return `<div class="setup-card ${s.bias}${s.watch ? ' watch' : ''}">
    <div class="setup-top">
      <span class="ticker setup-sym">${s.ticker}</span>
      <span class="setup-bias ${s.bias}">${biasLabel}${s.watch ? ' · watch' : ''}</span>
      <span class="setup-score" title="setup strength">${s.score}</span>
    </div>
    <div class="setup-trail">${cont}<span class="d-dots">${trail}</span></div>
    <div class="setup-desc">${s.setup}</div>
    <div class="sg-gauge">
      <div class="sg-nowlabel" style="left:${nowPos}%">now ${fmt.price(s.lastPrice)}</div>
      <div class="sg-track">
        <div class="sg-below" style="width:${belowPct}%"></div>
        <div class="sg-above" style="width:${100 - belowPct}%"></div>
        <div class="sg-now" style="left:${belowPct}%"></div>
      </div>
      <div class="sg-cap"><span class="sg-sup">▼ support: ${supportTxt}</span><span class="sg-sly">supply: ${supplyTxt} ▲</span></div>
    </div>
    <div class="setup-meta">${s.outlierCount} unusual print${s.outlierCount > 1 ? 's' : ''} · ${fmt.money(s.outlierNotional)}${adv}</div>
    <div class="setup-biggest">Largest: <b>${fmt.money(b.value)}</b> · ${fmt.int(b.size)} sh @ ${fmt.price(b.price)}
      <span class="${tagClass(b.bidAsk)}">${b.bidAsk}</span> · ${fmt.date(b.tradedAt)}</div>
  </div>`;
}

async function loadSetups() {
  try {
    setupsData = await api(`/api/setups?to=${dayBounds().to}&days=10&limit=30`);
  } catch { setupsData = []; }
  setupsLoaded = true;
  // Preserve scroll: this also runs on the 15s auto-refresh, and resetting to
  // the top there yanks the page back while you're reading. Tab-switch and
  // day-change resets are handled by their own renderMain(false) calls.
  if (activeTab === 'setups') renderMain(true);
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

const emptyMsg = () => `<div class="empty">Waiting for block trades…</div>`;

// ---- Daily News (AI brief) ----
const dateKey = () => toInputValue(selectedDate);

// Drop any research narration the model emitted before the brief: everything
// before the first Markdown heading. Belt-and-suspenders for reports stored
// before the server-side strip existed.
function stripPreamble(md) {
  if (!md) return md;
  const lines = String(md).split('\n');
  const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return idx > 0 ? lines.slice(idx).join('\n').trim() : String(md).trim();
}

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
    body = `<div class="news-meta"><span>${when}</span>
        <button class="ghost-btn sm" data-gen-news>↻ Regenerate</button></div>
      <article class="md">${mdToHtml(stripPreamble(report.content))}</article>`;
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
      <div class="news-wrap">${kbHtml(key)}${body}</div>
    </section>`;
}

// Accumulated knowledge base (themes + ideas tracked across briefs).
function kbHtml(key) {
  const kb = kbByDate[key];
  if (!kb) return '';
  const themes = (kb.themes || []).slice(0, 12);
  const ideas = (kb.ideas || []).slice(0, 18);
  if (!themes.length && !ideas.length) return '';
  const tchips = themes.map((t) => `<span class="kb-theme" title="${esc(t.summary)}">${esc(t.theme)} <b>×${t.days}</b></span>`).join('');
  const ilines = ideas.map((i) => `<div class="kb-idea">
      <span class="ticker">${esc(i.ticker)}</span>
      <span class="kb-bias ${esc(i.bias) || 'neutral'}">${esc(i.bias) || '—'}</span>
      <span class="kb-date">${esc(i.date)}</span>
      <div class="kb-thesis">${esc(i.thesis)}</div></div>`).join('');
  return `<details class="kb"${themes.length || ideas.length ? ' open' : ''}>
    <summary>📚 Knowledge base — recurring themes &amp; tracked ideas (last 30 days)</summary>
    ${themes.length ? `<div class="kb-themes">${tchips}</div>` : ''}
    ${ideas.length ? `<div class="kb-ideas">${ilines}</div>` : ''}
  </details>`;
}

async function loadKB() {
  const key = dateKey();
  try {
    const [themes, ideas] = await Promise.all([
      api(`/api/themes?date=${key}&days=30`),
      api(`/api/ideas?date=${key}&days=30`),
    ]);
    kbByDate[key] = { themes, ideas };
  } catch { /* ignore */ }
  if (activeTab === 'news') renderMain(false);
}

function ensureNewsLoaded() {
  const key = dateKey();
  if (newsByDate[key] === undefined) loadNews();
  if (kbByDate[key] === undefined) loadKB();
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
      if (rep && rep.content) { newsByDate[key] = rep; kbByDate[key] = undefined; loadKB(); done = true; break; }
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

// ---- Weekly review (Week in Review + Week Ahead) ----
function weekLabel(we) {
  if (!we) return 'this week';
  const [y, m, d] = we.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderWeekly() {
  const r = weeklyReport;
  const we = r?.weekEnding;
  let body;
  if (weeklyLoading || (r && !r.content && r.status === 'running') || weeklyPolling) {
    body = `<div class="news-loading"><div class="spinner"></div>
      <div>Synthesizing the week's flow, setups &amp; briefs into a week-ahead plan…</div>
      <div class="news-sub">Reviewing the week and researching next week's catalysts — this can take 1–2 min.</div></div>`;
  } else if (r && r.content) {
    const when = r.generatedAt ? `generated ${fmt.datetime(r.generatedAt)}` : '';
    body = `<div class="news-meta"><span>${when}</span>
        <button class="ghost-btn sm" data-gen-weekly>↻ Regenerate</button></div>
      <article class="md">${mdToHtml(stripPreamble(r.content))}</article>`;
  } else {
    const err = r && r.error ? `<div class="news-err">${esc(r.error)}</div>` : '';
    const canGen = cfg.weeklyEnabled;
    const hint = canGen
      ? `Runs automatically every <b>Friday at 4:00pm CT</b>. Synthesizes the full week's biggest themes from the daily briefs, setups and block flow, then lays out the tickers &amp; themes to trade next week.`
      : 'Set <code>ANTHROPIC_API_KEY</code> on the server to enable the weekly review.';
    body = `<div class="news-empty"><div class="big">🗓️</div>
        <div>${hint}</div>${err}
        <button class="gen-btn" data-gen-weekly ${canGen ? '' : 'disabled'}>Generate week-ahead plan</button>
      </div>`;
  }
  mainPanel.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Week Ahead 🗓️</h2><span class="hint">week ending ${weekLabel(we)}</span></div>
      <div class="news-wrap">${body}</div>
    </section>`;
}

async function ensureWeeklyLoaded() {
  if (weeklyReport === null && !weeklyLoading) loadWeekly();
}

async function loadWeekly() {
  weeklyLoading = true;
  if (activeTab === 'weekly') renderMain(false);
  try {
    const rep = await api('/api/weekly');
    weeklyReport = rep;
    weeklyLoading = false;
    if (activeTab === 'weekly') renderMain(false);
    // If the server kicked off generation (or it was already running), poll.
    if (rep && !rep.content && rep.status === 'running') pollWeekly(rep.weekEnding);
  } catch {
    weeklyLoading = false;
    if (activeTab === 'weekly') renderMain(false);
  }
}

async function generateWeekly() {
  if (!cfg.weeklyEnabled || weeklyPolling) return;
  weeklyLoading = true; if (activeTab === 'weekly') renderMain(false);
  try {
    const r = await fetch('/api/weekly/generate', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    weeklyLoading = false;
    pollWeekly(j.weekEnding);
  } catch (err) {
    weeklyLoading = false;
    weeklyReport = { content: null, error: err.message };
    if (activeTab === 'weekly') renderMain(false);
  }
}

async function pollWeekly(week) {
  if (weeklyPolling) return;
  weeklyPolling = true;
  if (activeTab === 'weekly') renderMain(false);
  const deadline = Date.now() + 5 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(5000);
      let rep;
      try { rep = await api(`/api/weekly${week ? `?week=${week}` : ''}`); } catch { continue; }
      if (rep && rep.content) { weeklyReport = rep; break; }
      if (rep && rep.status === 'error') { weeklyReport = { weekEnding: week, content: null, error: rep.error || 'generation failed' }; break; }
    }
  } finally {
    weeklyPolling = false;
    if (activeTab === 'weekly') renderMain(false);
  }
}

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
  // Setups use a multi-day lookback; reload them for the new anchor day.
  setupsLoaded = false; setupsData = [];
  if (activeTab === 'setups') loadSetups();
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
  if (activeTab === 'news') ensureNewsLoaded();
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
    if (e.target.closest('[data-gen-weekly]')) generateWeekly();
    const f = e.target.closest('[data-setup-filter]');
    if (f) { setupsFilter = f.dataset.setupFilter; renderMain(false); }
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
      if (activeTab === 'setups') loadSetups(); else renderMain();
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
