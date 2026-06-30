// Generic client-side table sorter. Any <table class="sortable"> gets
// click-to-sort headers automatically — including tables that re-render or
// stream new rows (a MutationObserver re-applies the active sort). Cell values
// are parsed for money ($1.2B / 348.8M), counts (1,234,567), percents, and
// dates; otherwise compared as text. Use data-sort on a cell to override the
// value used for sorting.
//
// Optional table attributes:
//   data-sort-key   stable id so the chosen sort survives re-renders
//   data-rank-col   index of a rank column to renumber 1..N after sorting

const sorts = new Map(); // key -> { col, dir }
let applying = false;
let started = false;

function toComparable(raw) {
  const s = (raw ?? '').trim();
  if (s === '' || s === '--') return { n: -Infinity, s: '' };
  const cleaned = s.replace(/[,$%\s]/g, '');
  const m = /^(-?\d*\.?\d+)([KMB])?$/i.exec(cleaned);
  if (m) {
    const mult = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()];
    return { n: parseFloat(m[1]) * mult, s: '' };
  }
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return { n: d, s: '' };
  return { n: NaN, s: s.toLowerCase() };
}

function cellRaw(tr, col) {
  const td = tr.children[col];
  if (!td) return '';
  return td.getAttribute('data-sort') ?? td.textContent ?? '';
}

function dataRows(tbody) {
  return [...tbody.rows].filter((r) => !r.querySelector('td.empty'));
}

function sortTable(table, col, dir) {
  const tb = table.tBodies[0];
  if (!tb) return;
  const rows = dataRows(tb);
  if (rows.length < 2) return;
  const sorted = [...rows].sort((a, b) => {
    const A = toComparable(cellRaw(a, col));
    const B = toComparable(cellRaw(b, col));
    let cmp;
    if (!Number.isNaN(A.n) && !Number.isNaN(B.n)) cmp = A.n - B.n;
    else cmp = A.s < B.s ? -1 : A.s > B.s ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
  // Only touch the DOM if the order actually changes (prevents observer loops).
  let changed = false;
  for (let i = 0; i < rows.length; i++) if (rows[i] !== sorted[i]) { changed = true; break; }
  if (changed) sorted.forEach((r) => tb.appendChild(r));
  const rankCol = table.dataset.rankCol;
  if (rankCol != null) sorted.forEach((r, i) => { if (r.cells[+rankCol]) r.cells[+rankCol].textContent = i + 1; });
}

function indicators(table, col, dir) {
  const ths = table.tHead?.rows[0]?.cells || [];
  [...ths].forEach((th, i) => {
    th.classList.toggle('sort-asc', i === col && dir === 'asc');
    th.classList.toggle('sort-desc', i === col && dir === 'desc');
  });
}

function reapplyAll() {
  for (const t of document.querySelectorAll('table.sortable[data-sort-key]')) {
    const s = sorts.get(t.dataset.sortKey);
    if (s && s.col >= 0) { sortTable(t, s.col, s.dir); indicators(t, s.col, s.dir); }
  }
}

export function initSortable() {
  if (started) return;
  started = true;

  document.addEventListener('click', (e) => {
    const th = e.target.closest('table.sortable thead th');
    if (!th) return;
    const table = th.closest('table');
    const col = [...th.parentNode.children].indexOf(th);
    const key = table.dataset.sortKey || '';
    const cur = sorts.get(key) || { col: -1, dir: 'desc' };
    const dir = cur.col === col && cur.dir === 'desc' ? 'asc' : 'desc';
    sorts.set(key, { col, dir });
    sortTable(table, col, dir);
    indicators(table, col, dir);
  });

  // Re-apply the active sort when sortable tables re-render or stream new rows.
  const obs = new MutationObserver(() => {
    if (applying) return;
    applying = true;
    requestAnimationFrame(() => { reapplyAll(); applying = false; });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
