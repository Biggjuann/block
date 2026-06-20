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
