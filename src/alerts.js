import { config } from './config.js';

// Server-side "whale" alerting: when a print clears the global notional or
// %ADV thresholds, emit an alert (broadcast to browsers) and optionally push
// it to a Discord webhook so traders get notified off-screen. Throttled per
// ticker so a burst of prints doesn't spam.

const THROTTLE_MS = 60_000;
const lastAlertAt = new Map();

const money = (n) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

/**
 * Returns an alert object if the trade clears global thresholds, else null.
 */
export function evaluateAlert(trade) {
  const { minNotional, minPctADV } = config.alerts;
  const reasons = [];
  if (minNotional && trade.value >= minNotional) reasons.push(`${money(trade.value)} notional`);
  if (minPctADV && trade.pctADV != null && trade.pctADV >= minPctADV) {
    reasons.push(`${trade.pctADV}% of ADV`);
  }
  if (!reasons.length) return null;

  const now = Date.now();
  if (now - (lastAlertAt.get(trade.ticker) || 0) < THROTTLE_MS) return null;
  lastAlertAt.set(trade.ticker, now);

  return { trade, reasons, at: now };
}

export async function dispatchDiscordSweep(sweep) {
  if (!config.alerts.discordWebhook) return;
  const arrow = sweep.side === 'buy' ? '🟢▲' : '🔴▼';
  const line =
    `${arrow} **SWEEP · ${sweep.ticker}** ${sweep.side.toUpperCase()} — ` +
    `${money(sweep.totalValue)} across ${sweep.count} prints ` +
    `($${sweep.priceLow}–$${sweep.priceHigh})`;
  try {
    await fetch(config.alerts.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: line }),
    });
  } catch (err) {
    console.error('discord sweep failed', err.message);
  }
}

export async function dispatchDiscord(alert) {
  if (!config.alerts.discordWebhook) return;
  const t = alert.trade;
  const line =
    `🐋 **${t.ticker}** block — ${money(t.value)} · ${int(t.size)} sh @ $${t.price} ` +
    `(${t.bidAsk}${t.pctADV != null ? ` · ${t.pctADV}% ADV` : ''})`;
  try {
    await fetch(config.alerts.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: line }),
    });
  } catch (err) {
    console.error('discord alert failed', err.message);
  }
}
