# Block Trade Indicator (BTI)

A real-time **block trade viewer** with persistent storage and a top-trades
dashboard. Large prints stream into a multi-column tape, the biggest blocks are
written to a database, and that data powers a second page with top-trade
rankings, a live prints feed, and a flow heatmap.

Built to run on [Railway](https://railway.app) with Schwab API access via a
shared token. When no token is present it runs in **simulator mode** and
generates realistic block-trade tape, so the UI is fully live out of the box.

## Features

- **Tape (`/`)** — columns are size **ranges** (default `50K–400K / 400K–500K /
  500K–800K / 800K+`); each print lands in exactly one column and shows time,
  ticker, price, size, **$ notional value**, **% of ADV**, and a bid/ask
  classification (`Above Ask`, `At Ask`, `Between`, `At Bid`, `Below Bid`)
  color-coded like a pro terminal.
- **Trader controls (toolbar)**:
  - **Min $ notional filter** — focus on the dollars that matter, not raw shares.
  - **% of ADV context** — each print shows what fraction of a typical day's
    volume it represents (color-coded), so outliers stand out from routine size.
  - **Watchlist** — star your tickers, optionally filter the tape to only them.
  - **Alerts** — set rules (min notional, min %ADV, watchlist-only) and get
    in-app toasts, optional **browser notifications**, and a sound when a
    matching block prints. A bell + drawer keeps a running alert feed.
- **Server-side "whale" alerts** — globally significant blocks (by notional or
  %ADV) are broadcast to all clients and optionally pushed to **Discord**.
- **Dashboard (`/dashboard`)** — Top Trades (notional bar chart + table),
  Volume Leaders, a value Heatmap, and a live **Prints** feed. Earnings &
  Ex-Dividend tabs are scaffolded for a future fundamentals feed.
- **Persistence** — block-sized trades are stored in SQLite (with %ADV) and
  aggregated for the dashboard and for page-load backfill.
- **Real-time** — trades and alerts stream to every connected browser over
  WebSocket.

## Architecture

```
src/
  config.js   env-driven config + simulator toggle
  db.js       SQLite schema, inserts, and aggregation queries
  schwab.js   Schwab streamer client (LEVELONE_EQUITIES -> trade tape)
  ingest.js   trade classification, persistence, and the simulator
  server.js   Express REST API + WebSocket broadcast + static hosting
public/
  index.html      block trade tape
  dashboard.html  top-trades dashboard
  js/             frontend logic (vanilla, no build step)
  css/styles.css  dark trading-terminal theme
```

The trade tape is synthesized from the Schwab `LEVELONE_EQUITIES` streamer:
each fresh last-price/last-size update is treated as a print and classified
against the prevailing bid/ask. If the streamer can't be reached the app
transparently falls back to the simulator so the UI stays live.

## Local development

```bash
cp .env.example .env      # optionally add SCHWAB_TOKEN
npm install
npm start                 # http://localhost:3000
```

Without a token you get simulator mode immediately. Set `SCHWAB_TOKEN` to a
valid Schwab OAuth **access token** to stream real data.

## Environment variables

| Variable          | Default                       | Description |
|-------------------|-------------------------------|-------------|
| `PORT`            | `3000`                        | HTTP port |
| `DB_PATH`         | `./data/blocktrades.sqlite`   | SQLite file path (use a Railway volume) |
| `SCHWAB_TOKEN`    | _(empty)_                     | Shared Schwab OAuth access token |
| `SCHWAB_SYMBOLS`  | `SPY,QQQ,TSLA,…`              | Comma-separated watchlist |
| `BLOCK_MIN_SIZE`  | `50000`                       | Min shares to be stored as a block |
| `PRINT_MIN_SIZE`  | `400000`                      | Min shares to appear in the Prints feed |
| `FORCE_SIMULATOR` | `false`                       | Force simulator even with a token |
| `FUNDAMENTALS_REFRESH_MS` | `900000`              | How often to refresh Schwab ADV (ms) |
| `ALERT_MIN_NOTIONAL` | `25000000`                 | $ notional that triggers a server "whale" alert (0 disables) |
| `ALERT_MIN_PCT_ADV`  | `5`                        | % of ADV that triggers a server alert (0 disables) |
| `DISCORD_WEBHOOK_URL`| _(empty)_                  | Optional Discord webhook for off-screen alert push |

## Deploying to Railway

1. Push this repo to GitHub and create a new Railway project from it.
2. Railway auto-detects Node via Nixpacks (`npm start`, see `railway.json`).
3. Add the environment variables above (at minimum `SCHWAB_TOKEN`).
4. Add a **Volume** mounted at `/data` and set `DB_PATH=/data/blocktrades.sqlite`
   so stored trades survive deploys/restarts.
5. Deploy. Railway provides `PORT` automatically.

## API

| Endpoint        | Description |
|-----------------|-------------|
| `GET /api/health` | health + data-source status |
| `GET /api/config` | columns, thresholds, mode, symbols |
| `GET /api/recent` | recent block trades (tape backfill) |
| `GET /api/top`    | top trades aggregated by ticker (today) |
| `GET /api/prints` | recent large prints |
| `GET /api/stats`  | block count / notional / volume (today) |
| `WS  /ws`         | live `trade` and `status` messages |

> **Note on Schwab data:** the standard Schwab market-data API does not expose a
> raw trade-by-trade tape, so block prints are derived from `LEVELONE_EQUITIES`
> last-price/last-size updates. This is a close approximation; for exact
> consolidated-tape block data, swap `src/schwab.js` for a dedicated tape feed.
