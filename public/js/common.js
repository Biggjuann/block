// Shared helpers + a tiny reconnecting WebSocket wrapper.

export const fmt = {
  price(n) {
    if (n == null) return '--';
    return '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  },
  int(n) {
    if (n == null) return '--';
    return Math.round(Number(n)).toLocaleString('en-US');
  },
  // Compact money: 1.2B / 348.8M / 56.4K
  money(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  },
  compact(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  },
  time(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  },
  datetime(ms) {
    const d = new Date(ms);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
  },
};

export const tagClass = (label) =>
  'tag ' + (label || 'between').toLowerCase().replace(/\s+/g, '-');

export async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

export function connectWS(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let retry = 0;
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 500 * retry);
    };
    ws.onerror = () => ws.close();
  };
  open();
  return () => ws && ws.close();
}

// ---- Persisted settings + watchlist (localStorage) ----
const SETTINGS_KEY = 'bti.settings';
const WATCH_KEY = 'bti.watchlist';
const SETTINGS_VERSION = 2; // bump to re-seed alert thresholds for existing users

const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION,
  minNotional: 0, // tape filter: minimum $ notional
  watchlistOnly: false,
  // Alerts should flag the exceptional, not every block — so these default
  // high. Tune them in the ⚙ Alert rules popover.
  alertMinNotional: 50_000_000,
  alertMinPctADV: 10,
  alertWatchlistOnly: false,
  sweepAlerts: true, // surface server-detected sweeps
  notify: false, // browser notifications
  sound: true,
};

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch { /* ignore */ }
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // Migration: earlier versions shipped noisy low thresholds — re-seed them.
  if (stored.v !== SETTINGS_VERSION) {
    s.alertMinNotional = DEFAULT_SETTINGS.alertMinNotional;
    s.alertMinPctADV = DEFAULT_SETTINGS.alertMinPctADV;
    s.v = SETTINGS_VERSION;
    saveSettings(s);
  }
  return s;
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadWatchlist() {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
export function saveWatchlist(set) {
  localStorage.setItem(WATCH_KEY, JSON.stringify([...set]));
}

// ---- Notifications + sound ----
export async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const res = await Notification.requestPermission();
  return res === 'granted';
}

export function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/favicon.ico' });
    } catch { /* ignore */ }
  }
}

let audioCtx;
export function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.07;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.12);
  } catch { /* ignore */ }
}

export function pctAdvClass(pct) {
  if (pct == null) return '';
  if (pct >= 10) return 'adv-hot';
  if (pct >= 3) return 'adv-warm';
  return 'adv-cool';
}

// ---- Market session (Eastern Time) ----
export function marketSession(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  if (m >= 570 && m < 960) return 'regular';
  if (m >= 240 && m < 570) return 'pre';
  if (m >= 960 && m < 1200) return 'post';
  return 'closed';
}

export function setMarketBadge() {
  const el = document.getElementById('market');
  if (!el) return;
  const map = {
    regular: ['OPEN', 'mk-open'],
    pre: ['PRE-MKT', 'mk-ext'],
    post: ['AFTER-HRS', 'mk-ext'],
    closed: ['CLOSED', 'mk-closed'],
  };
  const [label, cls] = map[marketSession()];
  el.className = 'market-badge ' + cls;
  el.textContent = '● ' + label;
}

export function setStatus(status) {
  const el = document.getElementById('status');
  if (!el) return;
  const live = status?.state === 'live';
  const connecting = status?.state === 'connecting';
  el.className = 'status-pill ' + (live ? '' : connecting ? 'warn' : 'down');
  const label = live ? 'LIVE' : connecting ? 'CONNECTING' : 'OFFLINE';
  const detail = status?.detail ? ` · ${status.detail}` : '';
  el.innerHTML = `<span class="dot"></span>${label}${detail}`;
}
