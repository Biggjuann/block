import WebSocket from 'ws';
import { config } from './config.js';
import { getToken } from './token.js';

// Field map for the Schwab LEVELONE_EQUITIES streamer service.
// We synthesize the trade tape from last price/size and use Trade Time (36)
// to detect genuine new prints; bid/ask classify the print.
const FIELDS = '0,1,2,3,4,5,8,9,36'; // ...lastSize, tradeTime

// Schwab streamer caps the number of keys per SUBS request; chunk large universes.
const MAX_KEYS_PER_SUB = 250;

/**
 * Fetch the streamer credentials tied to the access token.
 */
async function getStreamerInfo(token) {
  const res = await fetch(`${config.schwab.baseUrl}/trader/v1/userPreference`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    const err = new Error('userPreference unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`userPreference failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const info = data?.streamerInfo?.[0];
  if (!info?.streamerSocketUrl) {
    throw new Error('streamerInfo missing from userPreference response');
  }
  return info;
}

/**
 * Open the Schwab streamer, log in, and subscribe to LEVELONE_EQUITIES across
 * the configured symbol universe. Each detected print is emitted via
 * onTrade({ ticker, price, size, bid, ask, tradedAt }). Returns a stop()
 * function. onStatus(state, detail) reports 'connecting' | 'live' | 'error'.
 */
export function startSchwabStream({ symbols, onTrade, onStatus = () => {} }) {
  let ws = null;
  let stopped = false;
  let retries = 0;
  const state = new Map(); // per-symbol last-seen quote state

  async function connect() {
    if (stopped) return;
    onStatus('connecting');

    let token;
    let info;
    try {
      token = await getToken({ force: retries > 0 });
      info = await getStreamerInfo(token);
    } catch (err) {
      // A stale shared token can 401 — force a refresh on the next attempt.
      if (err.unauthorized) await getToken({ force: true }).catch(() => {});
      onStatus('error', `auth: ${err.message}`);
      scheduleReconnect();
      return;
    }

    ws = new WebSocket(info.streamerSocketUrl);
    let requestId = 0;
    const send = (service, command, parameters) =>
      ws.send(
        JSON.stringify({
          requests: [
            {
              service,
              command,
              requestid: requestId++,
              SchwabClientCustomerId: info.schwabClientCustomerId,
              SchwabClientCorrelId: info.schwabClientCorrelId,
              parameters,
            },
          ],
        })
      );

    ws.on('open', () => {
      retries = 0;
      send('ADMIN', 'LOGIN', {
        Authorization: token,
        SchwabClientChannel: info.schwabClientChannel,
        SchwabClientFunctionId: info.schwabClientFunctionId,
      });
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.response) {
        const login = msg.response.find((r) => r.service === 'ADMIN' && r.command === 'LOGIN');
        if (login) {
          const code = login.content?.code;
          if (code === 0 || code === undefined) {
            subscribeAll(send, symbols);
            onStatus('live', `streaming ${symbols.length} symbols`);
          } else {
            onStatus('error', `login rejected: ${login.content?.msg || code}`);
            // Token likely bad — refresh and reconnect.
            getToken({ force: true }).catch(() => {});
            try { ws.close(); } catch { /* noop */ }
          }
        }
      }

      if (Array.isArray(msg.data)) {
        for (const block of msg.data) {
          if (block.service !== 'LEVELONE_EQUITIES' || !Array.isArray(block.content)) continue;
          for (const item of block.content) handleQuote(item);
        }
      }
    });

    ws.on('close', () => {
      if (!stopped) {
        onStatus('error', 'socket closed');
        scheduleReconnect();
      }
    });
    ws.on('error', (err) => onStatus('error', err.message));
  }

  function scheduleReconnect() {
    if (stopped) return;
    retries = Math.min(retries + 1, 6);
    setTimeout(connect, Math.min(1000 * 2 ** retries, 30000));
  }

  function subscribeAll(send, syms) {
    for (let i = 0; i < syms.length; i += MAX_KEYS_PER_SUB) {
      const chunk = syms.slice(i, i + MAX_KEYS_PER_SUB);
      // First chunk uses SUBS (resets), subsequent chunks ADD to the subscription.
      send('LEVELONE_EQUITIES', i === 0 ? 'SUBS' : 'ADD', {
        keys: chunk.join(','),
        fields: FIELDS,
      });
    }
  }

  function handleQuote(item) {
    const ticker = item['key'] || item['0'];
    if (!ticker) return;
    const prev = state.get(ticker) || {};
    const bid = num(item['1'], prev.bid);
    const ask = num(item['2'], prev.ask);
    const last = num(item['3'], prev.last);
    const lastSize = num(item['9'], prev.lastSize);
    const tradeTime = num(item['36'], prev.tradeTime);
    state.set(ticker, { bid, ask, last, lastSize, tradeTime, seen: true });

    // Skip the initial snapshot (Schwab sends each symbol's last-known, often
    // stale, values on SUBS and on every reconnect) and only emit when the
    // Trade Time actually advances — i.e. a real, fresh print. This is what
    // stops phantom trades from showing up when the market is closed.
    if (!prev.seen) return;
    if (tradeTime == null || tradeTime === prev.tradeTime) return;
    if (!lastSize) return;
    onTrade({
      ticker,
      price: last,
      // Schwab LAST_SIZE for equities is in round lots (x100 shares).
      size: lastSize * 100,
      bid,
      ask,
      tradedAt: tradeTime,
    });
  }

  connect();

  return function stop() {
    stopped = true;
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

const num = (v, fallback = null) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
