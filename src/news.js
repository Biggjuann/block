import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  getTopTrades, getPressure, getStats, queryHistory,
  getRecentThemes, getRecentIdeas,
} from './db/index.js';

const LOOKBACK_DAYS = 21; // how far back to cross-reference prior briefs
const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
};

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

  const priorSince = addDays(date, -LOOKBACK_DAYS);
  const [top, pressure, stats, bigRes, signals, priorThemes, priorIdeas] = await Promise.all([
    getTopTrades({ since, until, limit: 15 }),
    getPressure({ since, until, limit: 15 }),
    getStats({ since, until }),
    queryHistory({ from: since, to: until - 1, sort: 'value', order: 'desc', limit: 30 }),
    fetchNewsSignals(),
    getRecentThemes({ since: priorSince, before: date, limit: 12 }),
    getRecentIdeas({ since: priorSince, before: date, limit: 40 }),
  ]);
  const big = bigRes.rows;
  if (!big.length) {
    return { content: `_No block trades were recorded for ${date}, so there is nothing to analyze yet._`, empty: true };
  }

  const topLines = top.map((t) => `- ${t.ticker}: ${money(t.value)} notional across ${int(t.trades)} prints (${int(t.volume)} sh)`).join('\n');
  const bigLines = big.map((b) => `- ${b.ticker} ${money(b.value)} — ${int(b.size)} sh @ $${b.price} (${b.bidAsk}${b.pctADV != null ? `, ${b.pctADV}% ADV` : ''})`).join('\n');
  const presLines = pressure.map((p) => `- ${p.ticker}: net ${p.net >= 0 ? '+' : ''}${money(p.net)} (${p.net >= 0 ? 'net buying' : 'net selling'})`).join('\n');
  const sigText = signalsToText(signals);

  // Prior knowledge base: themes and ideas from recent briefs, for continuity.
  const themeLines = (priorThemes || []).map((t) => `- ${t.theme} (seen ${t.days} day${t.days > 1 ? 's' : ''}, last ${t.lastDate})`).join('\n');
  const ideaLines = (priorIdeas || []).slice(0, 30).map((i) => `- ${i.ticker} [${i.bias || 'n/a'}] ${i.date}: ${i.thesis || ''}${i.catalyst ? ` — catalyst: ${i.catalyst}` : ''}`).join('\n');
  const priorBlock = (themeLines || ideaLines)
    ? `\n\nPRIOR KNOWLEDGE BASE (from briefs over the last ${LOOKBACK_DAYS} days — use this to track continuity):
${themeLines ? `Recurring themes:\n${themeLines}\n` : ''}${ideaLines ? `Tracked ideas/setups:\n${ideaLines}` : ''}`
    : '';

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

Write in clean Markdown. Be specific and grounded: tie big prints to real catalysts (earnings, guidance, upgrades/downgrades, M&A, regulatory, macro, sector rotation) found via search; when there is no clear catalyst, say so rather than inventing one. Never fabricate news, numbers, or sources. Cite sources as inline Markdown links. Treat the provided sentiment signals as a useful prior, not gospel — corroborate them. Keep it tight and high-signal; a trader should skim it in two minutes.

Output ONLY the finished brief. Do not narrate your research process or include any preamble, status updates, or "let me search…" commentary. Your reply must begin directly with the first Markdown heading and contain nothing before it.`;

  const user = `Here is the block-trade flow for ${date}:

${dataBlock}${priorBlock}

Research the day's market news with web search and produce a brief with exactly these sections:

## TL;DR
3–5 bullets with the day's biggest takeaways.

## Themes of the Day
The dominant sector/macro themes the flow points to. Where a theme also appears in the prior knowledge base above, say whether it is building, persisting, or fading.

## Why the Big Trades Happened
For the most notable names above, explain the likely reason for the large prints — tie each to a specific catalyst or news item (with a source link) where one exists; flag names with no obvious catalyst as worth watching.

## Continuity & Follow-ups
Cross-reference today's flow against the prior knowledge base: tickers reappearing in the flow, prior setups that are progressing or have triggered their catalyst, and theses that have been confirmed or invalidated. If there is no prior context yet, say so briefly.

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
  const raw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const content = stripPreamble(raw);
  const structured = await extractStructured(client, content);
  return { content: content || '_No analysis was produced._', empty: false, usedSignals: Boolean(sigText), structured };
}

// The model sometimes narrates its research ("Let me run some searches…") before
// the brief, despite instructions. Drop everything before the first Markdown
// heading so only the brief itself is ever stored or shown.
function stripPreamble(md) {
  if (!md) return md;
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return idx > 0 ? lines.slice(idx).join('\n').trim() : md.trim();
}

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { theme: { type: 'string' }, summary: { type: 'string' } },
        required: ['theme', 'summary'],
      },
    },
    ideas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ticker: { type: 'string' },
          thesis: { type: 'string' },
          catalyst: { type: 'string' },
          bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        },
        required: ['ticker', 'thesis', 'catalyst', 'bias'],
      },
    },
  },
  required: ['themes', 'ideas'],
};

// Pull structured themes + per-ticker ideas out of the finished brief so they
// can be stored and cross-referenced by future briefs. Best-effort.
async function extractStructured(client, markdown) {
  if (!markdown) return { themes: [], ideas: [] };
  try {
    const res = await client.messages.create({
      model: config.news.extractModel,
      max_tokens: 4000,
      output_config: { format: { type: 'json_schema', name: 'brief_extract', schema: EXTRACT_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Extract the key themes and per-ticker trade ideas from this market brief. Use short theme labels (2-5 words) and concise theses. Normalize tickers to uppercase symbols.\n\n${markdown}`,
      }],
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    return { themes: parsed.themes || [], ideas: parsed.ideas || [] };
  } catch (err) {
    console.error('brief extraction failed', err.message);
    return { themes: [], ideas: [] };
  }
}
