import WebSocket from 'ws';

const BASE = 'https://api.schwabapi.com';

// Field map for the Schwab LEVELONE_EQUITIES streamer service.
// We use last price/size to synthesize the trade tape and bid/ask to classify it.
const FIELDS = '0,1,2,3,4,5,8,9'; // sym, bid, ask, last, bidSize, askSize, totalVol, lastSize

/**
 * Fetch the streamer credentials tied to the shared access token.
 */
async function getStreamerInfo(token) {
  const res = await fetch(`${BASE}/trader/v1/userPreference`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
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
 * Open the Schwab streamer, log in, and subscribe to LEVELONE_EQUITIES for the
 * requested symbols. Each detected trade is emitted via onTrade({ ticker,
 * price, size, bid, ask, tradedAt }). Returns a stop() function.
 *
 * onStatus(state, detail) is called with 'connecting' | 'live' | 'error'.
 */
export function startSchwabStream({ token, symbols, onTrade, onStatus = () => {} }) {
  let ws = null;
  let stopped = false;
  // Per-symbol last-seen state so we only emit on an actual print.
  const state = new Map();

  async function connect() {
    if (stopped) return;
    onStatus('connecting');
    let info;
    try {
      info = await getStreamerInfo(token);
    } catch (err) {
      onStatus('error', `auth: ${err.message}`);
      throw err;
    }

    ws = new WebSocket(info.streamerSocketUrl);
    let requestId = 0;
    const send = (service, command, parameters) => {
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
    };

    ws.on('open', () => {
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

      // Login acknowledgement -> subscribe.
      if (msg.response) {
        const login = msg.response.find((r) => r.service === 'ADMIN' && r.command === 'LOGIN');
        if (login) {
          if (login.content?.code === 0 || login.content?.code === undefined) {
            send('LEVELONE_EQUITIES', 'SUBS', { keys: symbols.join(','), fields: FIELDS });
            onStatus('live', `subscribed to ${symbols.length} symbols`);
          } else {
            onStatus('error', `login rejected: ${login.content?.msg || 'unknown'}`);
          }
        }
      }

      if (Array.isArray(msg.data)) {
        for (const block of msg.data) {
          if (block.service !== 'LEVELONE_EQUITIES' || !Array.isArray(block.content)) continue;
          for (const item of block.content) {
            handleQuote(item);
          }
        }
      }
    });

    ws.on('close', () => {
      if (!stopped) {
        onStatus('error', 'socket closed, retrying');
        setTimeout(connect, 3000);
      }
    });
    ws.on('error', (err) => onStatus('error', err.message));
  }

  function handleQuote(item) {
    const ticker = item['key'] || item['0'];
    if (!ticker) return;
    const prev = state.get(ticker) || {};
    const bid = num(item['1'], prev.bid);
    const ask = num(item['2'], prev.ask);
    const last = num(item['3'], prev.last);
    const lastSize = num(item['9'], prev.lastSize);
    const next = { bid, ask, last, lastSize };
    state.set(ticker, next);

    // Emit a trade only when a fresh print arrives (last price or size moved).
    const printed = last != null && (last !== prev.last || lastSize !== prev.lastSize);
    if (printed && lastSize) {
      onTrade({
        ticker,
        price: last,
        // Schwab LAST_SIZE is in round lots (x100) for equities.
        size: lastSize * 100,
        bid,
        ask,
        tradedAt: Date.now(),
      });
    }
  }

  connect().catch(() => {
    /* surfaced via onStatus; ingest layer will fall back */
  });

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
