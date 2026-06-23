import { api, fmt, tagClass } from './common.js';

// Click-through chart: a price line with block prints overlaid as markers
// (green = buy, red = sell, violet = between; size = $ notional). The biggest
// prints are ranked and highlighted both on the chart and in a Top-5 list, and
// a timeframe toggle lets you see where the big ones hit over time.

const COLORS = {
  buy: '#2bd4a0', sell: '#ff5d6c', neutral: '#9b7bff',
  line: '#2f8fff', grid: 'rgba(80,110,160,0.18)', text: '#7e92b4', top: '#f2b14e',
};
const TIMEFRAMES = ['1D', '5D', '1M', '6M'];

let modal, canvas, ctx, current;
let curSym = '';
let curTf = '1D';

function build() {
  modal = document.createElement('div');
  modal.className = 'chart-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="chart-backdrop" data-close></div>
    <div class="chart-dialog">
      <div class="chart-head">
        <div class="chart-title">
          <span class="ct-sym" id="ct-sym">—</span>
          <span class="ct-last" id="ct-last"></span>
          <span class="ct-count" id="ct-count"></span>
        </div>
        <div class="seg ct-tf" id="ct-tf">
          ${TIMEFRAMES.map((t) => `<button class="seg-btn${t === '1D' ? ' active' : ''}" data-tf="${t}">${t}</button>`).join('')}
        </div>
        <button class="ghost-btn sm" data-close>✕</button>
      </div>
      <div class="pressure-bar" id="ct-pressure"></div>
      <div class="chart-canvas-wrap"><canvas id="ct-canvas"></canvas>
        <div class="chart-tip" id="ct-tip" hidden></div>
      </div>
      <div class="chart-legend">
        <span><i style="background:${COLORS.buy}"></i>Buy (lift offer)</span>
        <span><i style="background:${COLORS.sell}"></i>Sell (hit bid)</span>
        <span><i style="background:${COLORS.neutral}"></i>Between</span>
        <span><i style="background:${COLORS.top}"></i>Top 5</span>
        <span class="ct-hint">marker size = $ notional</span>
      </div>
      <div class="ct-top5" id="ct-top5"></div>
      <div class="chart-prints"><table><thead><tr>
        <th>#</th><th>Time</th><th>Price</th><th class="num">Size</th><th class="num">Value</th><th>Side</th>
      </tr></thead><tbody id="ct-prints"></tbody></table></div>
    </div>`;
  document.body.appendChild(modal);
  canvas = modal.querySelector('#ct-canvas');
  ctx = canvas.getContext('2d');
  modal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) close(); });
  modal.querySelector('#ct-tf').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (b) openChart(curSym, b.dataset.tf);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  canvas.addEventListener('mousemove', onHover);
  canvas.addEventListener('mouseleave', () => { modal.querySelector('#ct-tip').hidden = true; });
  window.addEventListener('resize', () => { if (!modal.hidden && current) draw(current); });
}

function close() { modal.hidden = true; current = null; }

export async function openChart(symbol, tf = curTf) {
  if (!modal) build();
  curSym = String(symbol).toUpperCase();
  curTf = TIMEFRAMES.includes(tf) ? tf : '1D';
  modal.hidden = false;
  modal.querySelector('#ct-sym').textContent = curSym;
  modal.querySelector('#ct-count').textContent = 'loading…';
  modal.querySelectorAll('#ct-tf .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tf === curTf));
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(curSym)}&tf=${curTf}`);
    current = data;
    renderHeader(data);
    renderTop5(data);
    renderPrints(data);
    draw(data);
  } catch {
    modal.querySelector('#ct-count').textContent = 'no data';
  }
}

const isIntraday = () => curTf === '1D' || curTf === '5D';
const xLabel = (t) => (curTf === '1D' ? fmt.time(t) : isIntraday() ? fmt.datetime(t) : fmt.date(t));

function renderHeader(d) {
  modal.querySelector('#ct-last').textContent = fmt.price(d.summary.last);
  modal.querySelector('#ct-count').textContent = `${d.summary.count} block prints · ${d.timeframe}`;
  const { buyValue, sellValue, net } = d.summary;
  const total = buyValue + sellValue || 1;
  const buyPct = (buyValue / total) * 100;
  const netCls = net >= 0 ? 'pos' : 'neg';
  modal.querySelector('#ct-pressure').innerHTML = `
    <div class="pb-track">
      <div class="pb-buy" style="width:${buyPct}%"></div>
      <div class="pb-sell" style="width:${100 - buyPct}%"></div>
    </div>
    <div class="pb-labels">
      <span class="pb-b">▲ ${fmt.money(buyValue)} buy</span>
      <span class="pb-net ${netCls}">Net ${net >= 0 ? '+' : '−'}${fmt.money(Math.abs(net))}</span>
      <span class="pb-s">${fmt.money(sellValue)} sell ▼</span>
    </div>`;
}

function renderTop5(d) {
  const el = modal.querySelector('#ct-top5');
  if (!d.topPrints?.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="ct-top5-label">Top ${d.topPrints.length} by $</div>` +
    d.topPrints.map((p) => `
      <div class="ct-top5-chip ${p.side || 'neutral'}">
        <span class="ct-rank">#${p.rank}</span>
        <b>${fmt.money(p.value)}</b>
        <span>${fmt.int(p.size)} sh</span>
        <span class="ct-top5-time">${xLabel(p.t)}</span>
      </div>`).join('');
}

function renderPrints(d) {
  // Top 10 trades of the window by notional, largest first.
  const top = [...d.prints].sort((a, b) => b.value - a.value).slice(0, 10);
  const rows = top.map((p, i) => `
    <tr class="${i < 5 ? 'ct-row-top' : ''}">
      <td class="rank">${i + 1}</td>
      <td class="t-time">${isIntraday() ? fmt.datetime(p.t) : fmt.date(p.t)}</td>
      <td class="t-price">${fmt.price(p.price)}</td>
      <td class="num t-size">${fmt.int(p.size)}</td>
      <td class="num t-val">${fmt.money(p.value)}</td>
      <td><span class="${tagClass(p.bidAsk)}">${p.bidAsk}</span></td></tr>`).join('');
  modal.querySelector('#ct-prints').innerHTML = rows ||
    '<tr><td colspan="6" class="empty">No prints in this window.</td></tr>';
}

// ---- Canvas drawing ----
let plot;

// Keep only each calendar day's N largest prints, so the chart shows the day's
// big trades over time instead of every print.
function topPerDay(prints, n = 5) {
  const byDay = new Map();
  for (const p of prints) {
    const d = new Date(p.t); d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }
  const out = [];
  for (const arr of byDay.values()) {
    arr.sort((a, b) => b.value - a.value);
    out.push(...arr.slice(0, n));
  }
  return out;
}

function draw(d) {
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth;
  const H = Math.max(240, Math.min(420, Math.round(W * 0.42)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Only plot each day's top-5 trades as markers.
  const markers = topPerDay(d.prints, 5);

  const pad = { l: 56, r: 14, t: 14, b: 24 };
  const series = d.series.length ? d.series : markers.map((p) => ({ t: p.t, price: p.price }));
  if (!series.length) return;

  const xs = series.map((p) => p.t).concat(markers.map((p) => p.t));
  const ys = series.map((p) => p.price).concat(markers.map((p) => p.price));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const padY = (yMax - yMin) * 0.08 || yMax * 0.01 || 1;
  yMin -= padY; yMax += padY;

  const X = (t) => pad.l + ((t - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - (p - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = COLORS.text; ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = yMin + (i / 4) * (yMax - yMin);
    const y = Y(p);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(fmt.price(p), 6, y + 3);
  }
  ctx.textAlign = 'center';
  [xMin, (xMin + xMax) / 2, xMax].forEach((t) => ctx.fillText(xLabel(t), X(t), H - 8));
  ctx.textAlign = 'start';

  ctx.beginPath(); ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1.6;
  series.forEach((p, i) => { const x = X(p.t), y = Y(p.price); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.lineTo(X(series[series.length - 1].t), H - pad.b);
  ctx.lineTo(X(series[0].t), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = 'rgba(47,143,255,0.08)'; ctx.fill();

  const maxVal = Math.max(1, ...markers.map((p) => p.value));
  plot = { pts: [], X, Y };
  // Normal markers first, then ranked ones on top so the big ones stand out.
  const ranked = [];
  for (const p of markers) {
    const r = 3 + Math.sqrt(p.value / maxVal) * 9;
    const x = X(p.t), y = Y(p.price);
    plot.pts.push({ x, y, r: Math.max(r, 6), p });
    if (p.rank) { ranked.push({ x, y, r, p }); continue; }
    const c = p.side === 'buy' ? COLORS.buy : p.side === 'sell' ? COLORS.sell : COLORS.neutral;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = c + '88'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = c; ctx.stroke();
  }
  for (const { x, y, r, p } of ranked) {
    const c = p.side === 'buy' ? COLORS.buy : p.side === 'sell' ? COLORS.sell : COLORS.neutral;
    const rr = Math.max(r, 7);
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fillStyle = c + 'cc'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = COLORS.top; ctx.stroke();
    ctx.fillStyle = COLORS.top; ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('#' + p.rank, x, y - rr - 3);
    ctx.textAlign = 'start';
  }
}

function onHover(e) {
  if (!plot) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let hit = null, best = 1e9;
  for (const pt of plot.pts) {
    const d2 = (pt.x - mx) ** 2 + (pt.y - my) ** 2;
    if (d2 < pt.r * pt.r && d2 < best) { best = d2; hit = pt; }
  }
  const tip = modal.querySelector('#ct-tip');
  if (!hit) { tip.hidden = true; return; }
  const p = hit.p;
  tip.hidden = false;
  tip.innerHTML = `<b>${current.symbol}${p.rank ? ` · #${p.rank}` : ''}</b> ${fmt.datetime(p.t)}<br>` +
    `${fmt.int(p.size)} sh @ ${fmt.price(p.price)}<br>${fmt.money(p.value)} · ${p.bidAsk}`;
  tip.style.left = Math.min(hit.x + 12, canvas.clientWidth - 150) + 'px';
  tip.style.top = Math.max(hit.y - 10, 4) + 'px';
}

// ---- Global ticker-click wiring ----
const SYMBOL_RE = /[A-Z][A-Z.]{0,5}/;
export function enableTickerClicks() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.ticker, .sym, .ai-ticker, .ct-sym');
    if (!el || el.classList.contains('ct-sym')) return;
    const m = (el.textContent || '').match(SYMBOL_RE);
    if (m) openChart(m[0], '1D');
  });
}
