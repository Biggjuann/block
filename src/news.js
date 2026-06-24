import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getTopTrades, getPressure, getStats, queryHistory } from './db/index.js';

const money = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

export const newsEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
export const newsSignalsConfigured = () => Boolean(config.news.apiUrl);

// Pull sentiment/signal data from the external News engine (the FastAPI
// service: GET /signals). Best-effort — returns null if unset/unreachable.
async function fetchNewsSignals() {
  if (!config.news.apiUrl) return null;
  try {
    const res = await fetch(`${config.news.apiUrl}/signals`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function signalsToText(signals) {
  if (!signals) return null;
  // Be tolerant of shape: array, {signals:[...]}, or object keyed by ticker.
  let list = Array.isArray(signals) ? signals
    : Array.isArray(signals.signals) ? signals.signals
    : typeof signals === 'object' ? Object.values(signals) : [];
  if (!Array.isArray(list) || !list.length) return null;
  const lines = list.slice(0, 40).map((s) => {
    const t = s.ticker || s.symbol || '?';
    const sig = s.signal || s.action || '';
    const sent = s.sentiment ?? s.score;
    const conf = s.confidence;
    const head = s.headline || s.title || s.summary || '';
    const bits = [t];
    if (sig) bits.push(String(sig).toUpperCase());
    if (sent != null) bits.push(`sentiment ${Number(sent).toFixed(2)}`);
    if (conf != null) bits.push(`conf ${Number(conf).toFixed(2)}`);
    let line = `- ${bits.join(' · ')}`;
    if (head) line += ` — ${String(head).slice(0, 160)}`;
    return line;
  });
  return lines.join('\n');
}

/**
 * Generate the Markdown daily brief for a day's block-trade flow, grounded in
 * the News engine's sentiment signals and live web research.
 */
export async function generateDailyNews({ date, since, until }) {
  if (!newsEnabled()) throw new Error('ANTHROPIC_API_KEY not configured');

  const [top, pressure, stats, bigRes, signals] = await Promise.all([
    getTopTrades({ since, until, limit: 15 }),
    getPressure({ since, until, limit: 15 }),
    getStats({ since, until }),
    queryHistory({ from: since, to: until - 1, sort: 'value', order: 'desc', limit: 30 }),
    fetchNewsSignals(),
  ]);
  const big = bigRes.rows;
  if (!big.length) {
    return { content: `_No block trades were recorded for ${date}, so there is nothing to analyze yet._`, empty: true };
  }

  const topLines = top.map((t) => `- ${t.ticker}: ${money(t.value)} notional across ${int(t.trades)} prints (${int(t.volume)} sh)`).join('\n');
  const bigLines = big.map((b) => `- ${b.ticker} ${money(b.value)} — ${int(b.size)} sh @ $${b.price} (${b.bidAsk}${b.pctADV != null ? `, ${b.pctADV}% ADV` : ''})`).join('\n');
  const presLines = pressure.map((p) => `- ${p.ticker}: net ${p.net >= 0 ? '+' : ''}${money(p.net)} (${p.net >= 0 ? 'net buying' : 'net selling'})`).join('\n');
  const sigText = signalsToText(signals);

  const dataBlock = `Date: ${date}
Totals: ${int(stats.trades)} block trades, ${money(stats.value)} total notional.

Top tickers by notional:
${topLines}

Largest individual block prints:
${bigLines}

Net aggressor pressure (buy = lifting offers, sell = hitting bids):
${presLines}${sigText ? `

News sentiment signals from our news engine (real-time; may be sparse for past dates):
${sigText}` : ''}`;

  const system = `You are a senior market-structure and order-flow analyst writing a concise daily brief for active traders. You are given a day's large block-trade flow captured by a monitoring system${sigText ? ', plus real-time news-sentiment signals from the desk\'s own news engine' : ''}, and you have web search to research what actually moved the market that day.

Write in clean Markdown. Be specific and grounded: tie big prints to real catalysts (earnings, guidance, upgrades/downgrades, M&A, regulatory, macro, sector rotation) found via search; when there is no clear catalyst, say so rather than inventing one. Never fabricate news, numbers, or sources. Cite sources as inline Markdown links. Treat the provided sentiment signals as a useful prior, not gospel — corroborate them. Keep it tight and high-signal; a trader should skim it in two minutes.`;

  const user = `Here is the block-trade flow for ${date}:

${dataBlock}

Research the day's market news with web search and produce a brief with exactly these sections:

## TL;DR
3–5 bullets with the day's biggest takeaways.

## Themes of the Day
The dominant sector/macro themes the flow points to.

## Why the Big Trades Happened
For the most notable names above, explain the likely reason for the large prints — tie each to a specific catalyst or news item (with a source link) where one exists; flag names with no obvious catalyst as worth watching.

## Consolidating Setups to Watch
Tickers from the flow that have been consolidating/coiling and are seeing unusual block activity, with the specific news catalysts that could fuel a breakout or breakdown. Use the aggressor pressure for directional bias where relevant.

Focus your research on news from on or around ${date}.`;

  const client = new Anthropic();
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }];
  let messages = [{ role: 'user', content: user }];
  let resp;
  for (let i = 0; i < 5; i++) {
    resp = await client.messages
      .stream({
        model: config.news.model,
        max_tokens: 16000,
        system,
        tools,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        messages,
      })
      .finalMessage();
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }
    break;
  }
  const content = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { content: content || '_No analysis was produced._', empty: false, usedSignals: Boolean(sigText) };
}
