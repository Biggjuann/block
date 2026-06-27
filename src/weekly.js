import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  getDailyReport, getRecentThemes, getRecentIdeas,
  getTopTrades, getPressure, getStats, queryHistory,
} from './db/index.js';
import { getSetups } from './setups.js';

export const weeklyEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const money = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};

// ---- Chicago-time helpers (4pm CST schedule, DST-aware) ----
function chicagoParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dows[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const CLOSE_MIN = 16 * 60; // 16:00 Central

/**
 * The most recent Friday-16:00 Central that has already passed, as a YYYY-MM-DD
 * date (the "week ending" key). Returns null defensively never — always a string.
 */
export function currentWeekEnding(ms = Date.now()) {
  const { dow, date, minutes } = chicagoParts(ms);
  // Days back to the most recent Friday on/before today.
  let back = (dow - 5 + 7) % 7;
  // If today *is* Friday but it's before 16:00, the last completed one is a week ago.
  if (back === 0 && minutes < CLOSE_MIN) back = 7;
  return addDays(date, -back);
}

// Trade window for the week ending on `weekEnding` (its Friday): Monday→Friday.
export function weekWindow(weekEnding) {
  const [y, m, d] = weekEnding.split('-').map(Number);
  const friMid = Date.UTC(y, m - 1, d); // Friday 00:00 UTC
  return { since: friMid - 4 * 86400000, until: friMid + 86400000 }; // Mon 00:00 → Sat 00:00 UTC
}

function stripPreamble(md) {
  if (!md) return md;
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return idx > 0 ? lines.slice(idx).join('\n').trim() : md.trim();
}

/**
 * Generate the weekly "Week in Review + Week Ahead" brief: the week's biggest
 * themes synthesized from the daily briefs, setups and trade flow, plus a list
 * of tickers and themes to trade next week.
 */
export async function generateWeeklyReview({ weekEnding, since, until }) {
  if (!weeklyEnabled()) throw new Error('ANTHROPIC_API_KEY not configured');

  const monDate = addDays(weekEnding, -4);
  const dayDates = [0, 1, 2, 3, 4].map((i) => addDays(monDate, i)); // Mon..Fri

  const [stats, top, pressure, bigRes, setups, themes, ideas, ...dailyReports] = await Promise.all([
    getStats({ since, until }),
    getTopTrades({ since, until, limit: 20 }),
    getPressure({ since, until, limit: 16 }),
    queryHistory({ from: since, to: until - 1, sort: 'value', order: 'desc', limit: 40 }),
    getSetups({ since, until, limit: 30 }),
    getRecentThemes({ since: monDate, before: addDays(weekEnding, 1), limit: 20 }),
    getRecentIdeas({ since: monDate, before: addDays(weekEnding, 1), limit: 60 }),
    ...dayDates.map((d) => getDailyReport(d)),
  ]);

  const big = bigRes.rows;
  if (!big.length && !dailyReports.some(Boolean)) {
    return { empty: true, reason: `No block-trade data or daily briefs for the week ending ${weekEnding}.` };
  }

  // ---- Build the grounding data block ----
  const topLines = top.map((t) => `- ${t.ticker}: ${money(t.value)} across ${int(t.trades)} prints`).join('\n');
  const bigLines = big.slice(0, 25).map((b) => `- ${b.ticker} ${money(b.value)} — ${int(b.size)} sh @ $${b.price} (${b.bidAsk}${b.pctADV != null ? `, ${b.pctADV}% ADV` : ''})`).join('\n');
  const presLines = pressure.map((p) => `- ${p.ticker}: net ${p.net >= 0 ? '+' : ''}${money(p.net)} (${p.net >= 0 ? 'net buying' : 'net selling'})`).join('\n');
  const setupLines = setups.slice(0, 20).map((s) => {
    const where = s.aboveNotional > s.belowNotional
      ? `price below the bulk of blocks (overhead supply ${money(s.aboveNotional)}${s.aboveVwap ? ` @ ~$${s.aboveVwap}` : ''})`
      : `price above the bulk of blocks (support ${money(s.belowNotional)}${s.belowVwap ? ` @ ~$${s.belowVwap}` : ''})`;
    return `- ${s.ticker} [${s.bias}${s.watch ? ' · watch' : ''}] last $${s.lastPrice}, ${where}; ${s.outlierCount} unusual prints, ${money(s.outlierNotional)}, ${s.continuity}/${s.daysActive}d`;
  }).join('\n');
  const themeLines = themes.map((t) => `- ${t.theme} (seen ${t.days} day${t.days > 1 ? 's' : ''})`).join('\n');
  const ideaLines = ideas.slice(0, 40).map((i) => `- ${i.ticker} [${i.bias || 'n/a'}] ${i.date}: ${i.thesis || ''}${i.catalyst ? ` — catalyst: ${i.catalyst}` : ''}`).join('\n');

  const briefsBlock = dayDates.map((d, i) => {
    const r = dailyReports[i];
    if (!r || !r.content) return `### ${d}\n_(no daily brief generated)_`;
    return `### ${d}\n${r.content}`;
  }).join('\n\n');

  const dataBlock = `Week ending: ${weekEnding} (Mon ${monDate} → Fri ${weekEnding})
Week totals: ${int(stats.trades)} block trades, ${money(stats.value)} total notional.

Top tickers by weekly notional:
${topLines || '- (none)'}

Largest individual block prints of the week:
${bigLines || '- (none)'}

Net aggressor pressure across the week:
${presLines || '- (none)'}

Unusual-print setups as of week's end (bias = where price sits vs the big trades):
${setupLines || '- (none)'}

Recurring themes captured across the week's briefs:
${themeLines || '- (none)'}

Per-ticker ideas captured across the week's briefs:
${ideaLines || '- (none)'}

The week's daily briefs (for reference):
${briefsBlock}`;

  const system = `You are the head of a trading desk writing the Friday "week in review and week ahead" note for active traders. You are given a full week of large block-trade flow, unusual-print setups, and the desk's own daily briefs, and you have web search to research what drove the week and what is on next week's calendar.

Write in clean Markdown. Be specific and grounded: synthesize the week into the few themes that actually mattered, tie them to real catalysts found via search, and turn the flow + setups into an actionable watchlist for next week. Never fabricate news, numbers, or sources; cite sources as inline Markdown links. Prefer names that show up in BOTH the flow/setups and a real forward catalyst. Be decisive but honest about uncertainty.

Output ONLY the finished note — no preamble, no narration of your research process. Begin directly with the first Markdown heading.`;

  const user = `Here is the full week's desk data for the week ending ${weekEnding}:

${dataBlock}

Research the week's market news and next week's calendar with web search, then produce the note with exactly these sections:

## Week in Review — Week Ending ${weekEnding}
A 3–5 bullet executive summary of how the week went and what the flow was really saying.

## The Week's Biggest Themes
The 3–6 dominant sector/macro themes the week's flow, setups and briefs point to. For each: what it is, the evidence from the flow/setups, and whether it built or faded into Friday.

## What the Flow Confirmed or Rejected
Where the big prints and setups played out vs. where they failed — call out underwater buyers / overhead supply and setups that triggered.

## Tickers & Themes to Trade Next Week
A ranked watchlist. For each name: **TICKER** — bias (bullish/bearish) — the thesis (tie to the week's blocks/setups: where price sits vs the big trades) — the specific catalyst next week that could fuel a breakout or breakdown — and the level to watch. Group by theme where it helps.

## Calendar & Catalysts Next Week
The key earnings, economic releases, and events next week that the watchlist hinges on (with source links).

Today is Friday ${weekEnding}. Focus the forward-looking research on the week starting ${addDays(weekEnding, 3)}.`;

  const client = new Anthropic();
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }];
  let messages = [{ role: 'user', content: user }];
  let resp;
  for (let i = 0; i < 5; i++) {
    resp = await client.messages
      .stream({
        model: config.news.model,
        max_tokens: 20000,
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
  return { content: content || '_No analysis was produced._', empty: false };
}
