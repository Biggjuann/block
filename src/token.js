import { config } from './config.js';

// Resolves the Schwab OAuth access token used by the streamer/API client.
//
// In `shared` mode the token is fetched from another app you control
// (SCHWAB_TOKEN_URL), authenticated with a Bearer share key
// (SCHWAB_TOKEN_SHARE_KEY). The response is expected to be JSON shaped like
// `{ access_token, expires_in }`. The token is cached and refreshed shortly
// before it expires. In `token`/`auto` mode a static SCHWAB_TOKEN is used.

const { authMode, token: staticToken, tokenUrl, tokenShareKey } = config.schwab;

let cache = { token: null, expiresAt: 0 };
let inflight = null;

const usesShare =
  (authMode === 'shared' || authMode === 'share' || authMode === 'auto') && Boolean(tokenUrl);

async function fetchShared() {
  const res = await fetch(tokenUrl, {
    headers: {
      Authorization: `Bearer ${tokenShareKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token endpoint ${res.status}: ${body.slice(0, 200)}`);
  }

  // Be tolerant of response shape: JSON {access_token|token} or raw string.
  const ct = res.headers.get('content-type') || '';
  let token;
  let expiresIn = 1800; // default 30m if unspecified
  if (ct.includes('application/json')) {
    const data = await res.json();
    token = data.access_token || data.accessToken || data.token;
    expiresIn = Number(data.expires_in || data.expiresIn) || expiresIn;
  } else {
    token = (await res.text()).trim();
  }
  if (!token) throw new Error('token endpoint returned no token');

  // Refresh 60s early to avoid using a token mid-expiry.
  cache = { token, expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
  return token;
}

/**
 * Returns a valid access token, fetching/refreshing as needed.
 * Pass { force: true } to bypass the cache (e.g. after a 401).
 */
export async function getToken({ force = false } = {}) {
  if (!usesShare) {
    if (!staticToken) throw new Error('no SCHWAB_TOKEN configured');
    return staticToken;
  }
  if (!force && cache.token && Date.now() < cache.expiresAt) return cache.token;
  if (!inflight) {
    inflight = fetchShared().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export const tokenSource = usesShare ? 'shared' : staticToken ? 'static' : 'none';
