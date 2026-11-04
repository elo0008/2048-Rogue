// game/daily.js
// Pure daily run seed and calendar utilities (no DOM, no Node-specific APIs)

/**
 * 32-bit FNV-1a hash over 'rogue2048-daily-v1:' + date
 * Identical algorithm to verify/profile.js (zero verify/ imports in game bundle).
 *
 * @param {string} dayUTC - ISO date string 'YYYY-MM-DD'
 * @returns {number} Unsigned 32-bit integer (0 <= n <= 4294967295)
 */
export function dailySeed(dayUTC) {
  if (typeof dayUTC !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayUTC)) {
    throw new Error(`Invalid dayUTC format: expected 'YYYY-MM-DD', got ${dayUTC}`);
  }
  const input = 'rogue2048-daily-v1:' + dayUTC;
  let hash = 0x811c9dc5; // FNV offset basis 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime 16777619
  }
  return hash >>> 0;
}

/**
 * Returns UTC date string 'YYYY-MM-DD' for a given Date or timestamp.
 *
 * @param {Date|number|string} [now=new Date()]
 * @returns {string}
 */
export function utcDateString(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the milliseconds remaining until the next UTC midnight (00:00:00.000 UTC).
 *
 * @param {Date|number|string} [now=new Date()]
 * @returns {number}
 */
export function msUntilNextUtcMidnight(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const nextMidnightMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0
  );
  return Math.max(0, nextMidnightMs - d.getTime());
}

/**
 * Formats a duration in milliseconds into "Xh Ym".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Returns the local time string of the next UTC midnight reset (e.g. "5:30 AM").
 *
 * @param {Date|number|string} [now=new Date()]
 * @returns {string}
 */
export function formatNextResetLocalTime(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const nextMidnight = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  try {
    return nextMidnight.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return `${String(nextMidnight.getHours()).padStart(2, '0')}:${String(nextMidnight.getMinutes()).padStart(2, '0')}`;
  }
}

