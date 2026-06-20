// US equity market session detection (Eastern Time, weekends excluded).
// Holidays are not handled — close enough for gating synthetic tape; the
// Schwab trade-time check is the real guard against stale prints.

const REGULAR_OPEN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE = 16 * 60; //    16:00 ET
const PRE_OPEN = 4 * 60; //          04:00 ET
const POST_CLOSE = 20 * 60; //       20:00 ET

function etParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Returns 'regular' | 'pre' | 'post' | 'closed'.
 */
export function marketSession(date = new Date()) {
  const { weekday, minutes } = etParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) return 'regular';
  if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) return 'pre';
  if (minutes >= REGULAR_CLOSE && minutes < POST_CLOSE) return 'post';
  return 'closed';
}

// Regular or extended hours — i.e. trades can legitimately print.
export function isTradingHours(date = new Date()) {
  return marketSession(date) !== 'closed';
}
