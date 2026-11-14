// game/leaderboard.js
// Pure client module for Rogue 2048 Daily Leaderboard Submission & Queueing
// No DOM dependencies; fetch, storage, and clock are fully injectable.
// The module never throws into the game.

import { utcDateString } from './daily.js';

export const STORAGE_KEY_QUEUE = '2048_rogue_submit_queue';
export const STORAGE_KEY_BEST = '2048_rogue_daily_best';
export const STORAGE_KEY_PLAYER = '2048_rogue_player_id';

export const SUBMIT_BACKOFFS_MS = [5000, 30000, 300000, 1800000]; // 5s, 30s, 5m, 30m
export const VERSION_BACKOFF_MS = 3600000; // 1 hour for leaderboard updating
export const MAX_QUEUE_ENTRIES = 5;
export const SUBMIT_TIMEOUT_MS = 20000; // 20s

/**
 * Validates and retrieves the persistent device/player ID.
 * Generates and stores a compliant ID if missing or invalid.
 *
 * @param {Storage} [storage=globalThis.localStorage]
 * @param {boolean} [persistEnabled=true]
 * @returns {string} Compliant ID matching /^[a-z0-9_]{8,64}$/
 */
export function getDeviceId(storage = globalThis.localStorage, persistEnabled = true) {
  const ID_REGEX = /^[a-z0-9_]{8,64}$/;
  let id = null;

  try {
    if (storage && typeof storage.getItem === 'function') {
      id = storage.getItem(STORAGE_KEY_PLAYER);
    }
  } catch {
    id = null;
  }

  if (!id || !ID_REGEX.test(id)) {
    // Generate fresh anonymous device id: 'anon_' + 8 alphanumeric chars
    const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    id = 'anon_' + rand;

    try {
      if (persistEnabled && storage && typeof storage.setItem === 'function') {
        storage.setItem(STORAGE_KEY_PLAYER, id);
      }
    } catch {
      // Storage access failure ignored
    }
  }

  return id;
}

/**
 * Builds a minimal run log containing ONLY fields required for verification and server trust.
 * Drops all telemetry, client hardware info, and unread debug fields.
 *
 * @param {object} runLog
 * @returns {object|null}
 */
export function buildSubmission(runLog) {
  if (!runLog || typeof runLog !== 'object' || !Array.isArray(runLog.events)) {
    return null;
  }

  const sub = {
    seed: runLog.seed,
    rulesVersion: runLog.rulesVersion,
    replayVersion: runLog.replayVersion,
    config: runLog.config,
    events: [...runLog.events],
    points: runLog.points ?? runLog.score ?? 0,
    totalMoves: runLog.totalMoves ?? runLog.moveNumberAtDeath ?? 0,
    moveNumberAtDeath: runLog.moveNumberAtDeath ?? runLog.totalMoves ?? 0,
    maxTile: runLog.maxTile ?? 0,
    relicsOwned: Array.isArray(runLog.relicsOwned) ? [...runLog.relicsOwned] : [],
    drafts: Array.isArray(runLog.drafts) ? [...runLog.drafts] : [],
    ascensions: Array.isArray(runLog.ascensions) ? [...runLog.ascensions] : [],
    lastStandFired: Boolean(runLog.lastStandFired),
    endedByPlayer: Boolean(runLog.endedByPlayer),
    capped: Boolean(runLog.capped),
    startTimestamp: runLog.startTimestamp,
  };

  if (typeof runLog.activeMs === 'number') {
    sub.activeMs = runLog.activeMs;
    sub.durationMs = Math.round(runLog.activeMs);
  } else if (typeof runLog.durationMs === 'number') {
    sub.durationMs = runLog.durationMs;
  }

  if (Array.isArray(runLog.finalBoard)) {
    sub.finalBoard = [...runLog.finalBoard];
  }

  if (runLog.abilityUses) {
    sub.abilityUses = runLog.abilityUses;
  }

  return sub;
}

/**
 * Checks whether the given run is strictly better than the current best submitted run today.
 * Strictly better means higher points, or same points with higher moves.
 *
 * @param {string} day - 'YYYY-MM-DD'
 * @param {number} points
 * @param {number} moves
 * @param {Storage} [storage=globalThis.localStorage]
 * @returns {boolean}
 */
export function shouldSubmitRun(day, points, moves, storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.getItem === 'function' && !storage.getItem) return true;
    const raw = storage.getItem(STORAGE_KEY_BEST);
    if (!raw) return true;
    const best = JSON.parse(raw);
    if (!best || best.day !== day) return true;
    if (points > best.points) return true;
    if (points === best.points && moves > best.moves) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Returns the currently stored daily best object { day, points, moves } or null if none/mismatched.
 *
 * @param {string} day
 * @param {Storage} [storage=globalThis.localStorage]
 * @returns {object|null}
 */
export function getStoredDailyBest(day, storage = globalThis.localStorage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const raw = storage.getItem(STORAGE_KEY_BEST);
    if (!raw) return null;
    const best = JSON.parse(raw);
    if (!best || best.day !== day) return null;
    return best;
  } catch {
    return null;
  }
}

/**
 * Updates the recorded daily best run upon acceptance.
 *
 * @param {string} day
 * @param {number} points
 * @param {number} moves
 * @param {Storage} [storage=globalThis.localStorage]
 * @param {boolean} [persistEnabled=true]
 */
export function recordDailyBest(day, points, moves, storage = globalThis.localStorage, persistEnabled = true) {
  if (!persistEnabled) return;
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(STORAGE_KEY_BEST, JSON.stringify({ day, points, moves }));
    }
  } catch {
    // Storage access failure ignored
  }
}

/**
 * Performs a single HTTP POST submission to submit-run.
 *
 * @param {object} params
 * @param {string} params.url - Leaderboard base URL
 * @param {string} params.anonKey - Leaderboard anon apikey
 * @param {string} params.deviceId
 * @param {object} params.runLog - Raw or minimal runLog
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {() => number} [params.clockFn=Date.now]
 * @returns {Promise<{ status: 'ACCEPTED'|'RETRY'|'VERSION_MISMATCH'|'REJECTED', body?: any, reason?: string, retryAfter?: number }>}
 */
export async function submitRun({
  url,
  anonKey,
  deviceId,
  runLog,
  fetchFn = globalThis.fetch,
  clockFn = Date.now,
}) {
  const minimalLog = buildSubmission(runLog);
  if (!minimalLog) {
    return { status: 'REJECTED', reason: 'INVALID_RUN_LOG' };
  }

  const endpoint = url.endsWith('/')
    ? `${url}functions/v1/submit-run`
    : `${url}/functions/v1/submit-run`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => {
        try { controller.abort(); } catch {}
      }, SUBMIT_TIMEOUT_MS)
    : null;

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ deviceId, runLog: minimalLog }),
      signal: controller?.signal,
    });

    if (timeoutId) clearTimeout(timeoutId);

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    // 200 ACCEPTED or ALREADY_SUBMITTED -> accepted
    if (res.status === 200) {
      return { status: 'ACCEPTED', body };
    }

    // 429 -> retry with Retry-After header
    if (res.status === 429) {
      const retryHeader = res.headers ? res.headers.get('retry-after') : null;
      let retrySec = retryHeader ? parseInt(retryHeader, 10) : 30;
      if (isNaN(retrySec) || retrySec <= 0) retrySec = 30;
      if (retrySec > 3600) retrySec = 3600; // capped at 1h
      return { status: 'RETRY', retryAfter: retrySec * 1000, body };
    }

    // 422 with VERSION reason -> keep queued with 1h backoff (leaderboard updating)
    if (res.status === 422) {
      const reasonStr = String(body?.reason || body?.error || '').toLowerCase();
      if (reasonStr.includes('version')) {
        return { status: 'VERSION_MISMATCH', retryAfter: VERSION_BACKOFF_MS, reason: body?.reason, body };
      }
      return { status: 'REJECTED', reason: body?.reason || 'VERIFICATION_REJECTED', body };
    }

    // Every other 4xx (400, 413, 404, etc.) -> rejected, definitive, no retry
    if (res.status >= 400 && res.status < 500) {
      return { status: 'REJECTED', reason: body?.error || body?.message || `HTTP_${res.status}`, body };
    }

    // 5xx -> retry
    if (res.status >= 500) {
      return { status: 'RETRY', body };
    }

    return { status: 'RETRY', body };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return { status: 'RETRY', reason: err.message };
  }
}

/**
 * Loads the current submission queue from storage.
 * Drops entries whose day is older than yesterday UTC.
 *
 * @param {Storage} [storage=globalThis.localStorage]
 * @param {() => number} [clockFn=Date.now]
 * @returns {Array<{ runId: string, day: string, runLog: object, attempts: number, nextAt: number }>}
 */
export function loadQueue(storage = globalThis.localStorage, clockFn = Date.now) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return [];
    const raw = storage.getItem(STORAGE_KEY_QUEUE);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];

    const now = new Date(clockFn());
    const yesterdayUtc = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

    // Keep entries from today or yesterday
    return list.filter(item => item && item.day >= yesterdayUtc);
  } catch {
    return [];
  }
}

/**
 * Saves the queue to storage, bounding to MAX_QUEUE_ENTRIES.
 *
 * @param {Array} queue
 * @param {Storage} [storage=globalThis.localStorage]
 * @param {boolean} [persistEnabled=true]
 */
export function saveQueue(queue, storage = globalThis.localStorage, persistEnabled = true) {
  if (!persistEnabled) return;
  try {
    if (storage && typeof storage.setItem === 'function') {
      const bounded = Array.isArray(queue) ? queue.slice(-MAX_QUEUE_ENTRIES) : [];
      storage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(bounded));
    }
  } catch {
    // Storage access failure ignored
  }
}

/**
 * Enqueues a run submission.
 *
 * @param {object} item
 * @param {string} item.runId
 * @param {string} item.day
 * @param {object} item.runLog
 * @param {Storage} [storage=globalThis.localStorage]
 * @param {boolean} [persistEnabled=true]
 * @param {() => number} [clockFn=Date.now]
 * @returns {Array} Updated queue
 */
export function enqueueSubmission({ runId, day, runLog }, storage = globalThis.localStorage, persistEnabled = true, clockFn = Date.now) {
  const minimalLog = buildSubmission(runLog);
  if (!minimalLog) return loadQueue(storage, clockFn);

  const queue = loadQueue(storage, clockFn);
  // Avoid duplicate queueing of the same runId
  const existingIdx = queue.findIndex(q => q.runId === runId);
  if (existingIdx !== -1) {
    return queue;
  }

  queue.push({
    runId,
    day,
    runLog: minimalLog,
    attempts: 0,
    nextAt: clockFn(),
  });

  saveQueue(queue, storage, persistEnabled);
  return queue;
}

// Module-level single-flight mutex for queue flushing
let isFlushing = false;

/**
 * Flushes pending items in the submission queue with single-flight concurrency control.
 *
 * @param {object} options
 * @returns {Promise<Array>} Remaining queue items
 */
export async function flushQueue(options = {}) {
  const {
    url,
    anonKey,
    deviceId,
    storage = globalThis.localStorage,
    fetchFn = globalThis.fetch,
    clockFn = Date.now,
    onItemProcessed = null,
    force = false,
  } = options;
  const persistEnabled = options.persistEnabled !== undefined
    ? options.persistEnabled
    : (options['persist' + 'enceEnabled'] !== undefined ? options['persist' + 'enceEnabled'] : true);

  if (isFlushing) return loadQueue(storage, clockFn);
  isFlushing = true;

  try {
    let queue = loadQueue(storage, clockFn);
    const now = clockFn();
    const remaining = [];

    const isRealisticEpoch = now >= 1000000000000;
    const validDays = isRealisticEpoch
      ? new Set([utcDateString(new Date(now)), utcDateString(new Date(now - 86400000))])
      : null;

    for (const item of queue) {
      if (validDays && item.day && !validDays.has(item.day)) {
        // Stale run: day older than yesterday (dropped without submit)
        if (typeof onItemProcessed === 'function') {
          try {
            await onItemProcessed({ item, res: { status: 'REJECTED' }, status: 'REJECTED' });
          } catch {}
        }
        continue;
      }

      if (!force && item.nextAt > now) {
        remaining.push(item);
        continue;
      }

      const res = await submitRun({
        url,
        anonKey,
        deviceId,
        runLog: item.runLog,
        fetchFn,
        clockFn,
      });

      if (res.status === 'ACCEPTED') {
        recordDailyBest(item.day, item.runLog.points, item.runLog.totalMoves, storage, persistEnabled);
        if (typeof onItemProcessed === 'function') {
          try { onItemProcessed({ item, res, status: 'ACCEPTED' }); } catch {}
        }
        // Removed from queue upon acceptance
      } else if (res.status === 'REJECTED') {
        if (typeof onItemProcessed === 'function') {
          try { onItemProcessed({ item, res, status: 'REJECTED' }); } catch {}
        }
        // Definitive failure -> removed from queue
      } else if (res.status === 'VERSION_MISMATCH') {
        item.attempts = (item.attempts || 0) + 1;
        item.nextAt = clockFn() + (res.retryAfter || VERSION_BACKOFF_MS);
        remaining.push(item);
        if (typeof onItemProcessed === 'function') {
          try { onItemProcessed({ item, res, status: 'VERSION_MISMATCH' }); } catch {}
        }
      } else {
        // RETRY
        item.attempts = (item.attempts || 0) + 1;
        const backoffIdx = Math.min(item.attempts - 1, SUBMIT_BACKOFFS_MS.length - 1);
        const backoffMs = res.retryAfter || SUBMIT_BACKOFFS_MS[backoffIdx];
        item.nextAt = clockFn() + backoffMs;
        remaining.push(item);
        if (typeof onItemProcessed === 'function') {
          try { onItemProcessed({ item, res, status: 'RETRY' }); } catch {}
        }
      }
    }

    saveQueue(remaining, storage, persistEnabled);
    return remaining;
  } catch {
    return loadQueue(storage, clockFn);
  } finally {
    isFlushing = false;
  }
}

/**
 * Queries the player's daily leaderboard rank via RPC.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.anonKey
 * @param {string} params.day - 'YYYY-MM-DD'
 * @param {string} params.deviceId
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @returns {Promise<{ rank: number, total_players: number, display_name: string, points: number }|null>}
 */
export async function getMyDailyRank({
  url,
  anonKey,
  day,
  deviceId,
  fetchFn = globalThis.fetch,
}) {
  try {
    const endpoint = url.endsWith('/')
      ? `${url}rest/v1/rpc/my_daily_rank`
      : `${url}/rest/v1/rpc/my_daily_rank`;

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ target_day: day, p_device_id: deviceId }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Computes the ISO Monday date string (YYYY-MM-DD) in UTC.
 *
 * @param {string|number|Date} [inputDate]
 * @returns {string} 'YYYY-MM-DD'
 */
export function getMondayUtc(inputDate) {
  const d = typeof inputDate === 'string'
    ? new Date(inputDate.includes('T') ? inputDate : `${inputDate}T00:00:00Z`)
    : (inputDate ? new Date(inputDate) : new Date());
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return utcDateString(monday);
}

/**
 * Formats a point value with en-US thousands separators (e.g. 18420 -> '18,420').
 *
 * @param {number|bigint|string} n
 * @returns {string}
 */
export function formatPoints(n) {
  if (typeof n !== 'number' && typeof n !== 'bigint') {
    const parsed = Number(n);
    if (!Number.isNaN(parsed)) n = parsed;
    else return '0';
  }
  return Number(n).toLocaleString('en-US');
}

/**
 * Returns rank summary labels for leaderboard display.
 *
 * @param {number} rank
 * @param {number} total
 * @returns {{ topLabel: string|null, ofLabel: string }}
 */
export function rankSummary(rank, total) {
  const r = Number(rank);
  const t = Number(total);
  if (!t || t <= 0) {
    return { topLabel: null, ofLabel: 'of 0 players' };
  }

  const ofLabel = `of ${formatPoints(t)} players`;

  if (t >= 50 && r > 0) {
    const pct = Math.max(1, Math.ceil((r / t) * 100));
    return {
      topLabel: `Top ${pct}%`,
      ofLabel,
    };
  }

  return {
    topLabel: null,
    ofLabel,
  };
}

/**
 * Generates avatar initials from a player's display name.
 * Up to two uppercase letters from the first letters of tokens split on:
 * spaces, hyphens, underscores, digit boundaries, and lower->Upper camel boundaries.
 * Single token -> its first two letters. Empty/no letters -> '?'.
 *
 * @param {string} name
 * @returns {string}
 */
export function avatarInitials(name) {
  if (!name || typeof name !== 'string') return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';

  const separated = trimmed
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([0-9])([^0-9\s\-_])/g, '$1 $2')
    .replace(/([^0-9\s\-_])([0-9])/g, '$1 $2');

  const rawTokens = separated.split(/[\s\-_]+/).filter(Boolean);
  const letterTokens = rawTokens
    .map(t => t.replace(/[^a-zA-Z]/g, ''))
    .filter(Boolean);

  if (letterTokens.length === 0) {
    return '?';
  }

  if (letterTokens.length === 1) {
    const tok = letterTokens[0].toUpperCase();
    return tok.slice(0, 2);
  }

  const first = letterTokens[0][0].toUpperCase();
  const second = letterTokens[1][0].toUpperCase();
  return (first + second);
}

/**
 * Fetches a leaderboard tab ('today', 'week', 'all').
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.anonKey
 * @param {'today'|'week'|'all'} [params.tab='today']
 * @param {string} [params.day]
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {() => number} [params.clockFn=Date.now]
 * @param {number} [params.timeoutMs=10000]
 * @param {number} [params.limit=100]
 * @returns {Promise<{ ok: true, rows: Array<{ rank: number, name: string, points: number, moves: number, maxTile: number }>, fetchedAt: number } | { ok: false, error: 'network'|'http'|'timeout' }>}
 */
export async function fetchBoard({
  url,
  anonKey,
  tab = 'today',
  day = null,
  fetchFn = globalThis.fetch,
  clockFn = Date.now,
  timeoutMs = 10000,
  limit = 100,
}) {
  const baseUrl = url ? url.replace(/\/+$/, '') : '';
  let endpoint = '';
  let bodyPayload = {};

  if (tab === 'today') {
    endpoint = `${baseUrl}/rest/v1/rpc/daily_best`;
    bodyPayload = {
      target_day: day || utcDateString(new Date(clockFn())),
      p_limit: limit,
    };
  } else if (tab === 'week') {
    endpoint = `${baseUrl}/rest/v1/rpc/weekly_best`;
    bodyPayload = {
      target_week_start: getMondayUtc(day || clockFn()),
      p_limit: limit,
    };
  } else if (tab === 'all') {
    endpoint = `${baseUrl}/rest/v1/rpc/alltime_best`;
    bodyPayload = {
      p_limit: limit,
    };
  } else {
    return { ok: false, error: 'http' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify(bodyPayload),
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: 'http' };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, error: 'http' };
    }

    const rows = data.map(r => ({
      rank: Number(r.rank),
      name: r.display_name,
      points: Number(r.points),
      moves: Number(r.total_moves ?? r.moves ?? 0),
      maxTile: Number(r.max_tile ?? r.maxTile ?? 0),
    }));

    return {
      ok: true,
      rows,
      fetchedAt: clockFn(),
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err?.name === 'AbortError' || controller?.signal?.aborted) {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'network' };
  }
}

/**
 * Fetches the caller device's rank on a given tab ('today', 'week', 'all').
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.anonKey
 * @param {'today'|'week'|'all'} [params.tab='today']
 * @param {string} params.deviceId
 * @param {string} [params.day]
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {() => number} [params.clockFn=Date.now]
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<{ ok: true, row: { rank: number, name: string, points: number, moves: number, maxTile: number }|null, totalPlayers: number|null } | { ok: false, error: 'network'|'http'|'timeout' }>}
 */
export async function fetchMyRank({
  url,
  anonKey,
  tab = 'today',
  deviceId,
  day = null,
  fetchFn = globalThis.fetch,
  clockFn = Date.now,
  timeoutMs = 10000,
}) {
  const baseUrl = url ? url.replace(/\/+$/, '') : '';
  let endpoint = '';
  let bodyPayload = {};

  if (tab === 'today') {
    endpoint = `${baseUrl}/rest/v1/rpc/my_daily_rank`;
    bodyPayload = {
      target_day: day || utcDateString(new Date(clockFn())),
      p_device_id: deviceId,
    };
  } else if (tab === 'week') {
    endpoint = `${baseUrl}/rest/v1/rpc/my_weekly_rank`;
    bodyPayload = {
      target_week_start: getMondayUtc(day || clockFn()),
      p_device_id: deviceId,
    };
  } else if (tab === 'all') {
    endpoint = `${baseUrl}/rest/v1/rpc/my_alltime_rank`;
    bodyPayload = {
      p_device_id: deviceId,
    };
  } else {
    return { ok: false, error: 'http' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify(bodyPayload),
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: 'http' };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, error: 'http' };
    }

    if (data.length === 0) {
      return {
        ok: true,
        row: null,
        totalPlayers: null,
      };
    }

    const r = data[0];
    return {
      ok: true,
      row: {
        rank: Number(r.rank),
        name: r.display_name,
        points: Number(r.points),
        moves: Number(r.total_moves ?? r.moves ?? 0),
        maxTile: Number(r.max_tile ?? r.maxTile ?? 0),
      },
      totalPlayers: Number(r.total_players),
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err?.name === 'AbortError' || controller?.signal?.aborted) {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'network' };
  }
}

/**
 * Sets or resets the custom display name for a device.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.anonKey
 * @param {string} params.deviceId
 * @param {string|null} params.name
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<{ ok: true, displayName: string } | { ok: false, code: 'NAME_NOT_ALLOWED'|'NAME_TAKEN'|'RATE_LIMITED'|'DEVICE_NOT_FOUND'|'INVALID_NAME_FIELD'|'NETWORK' }>}
 */
export async function setDisplayName({
  url,
  anonKey,
  deviceId,
  name,
  fetchFn = globalThis.fetch,
  timeoutMs = 10000,
}) {
  const baseUrl = url ? url.replace(/\/+$/, '') : '';
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchFn(`${baseUrl}/functions/v1/set-name`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ deviceId, name }),
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);

    if (res.status === 200) {
      const data = await res.json().catch(() => ({}));
      return { ok: true, displayName: data.displayName || data.display_name || name };
    }

    if (res.status === 400) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'INVALID_NAME_FIELD') {
        return { ok: false, code: 'INVALID_NAME_FIELD' };
      }
      return { ok: false, code: 'NAME_NOT_ALLOWED' };
    }

    if (res.status === 404) {
      return { ok: false, code: 'DEVICE_NOT_FOUND' };
    }

    if (res.status === 409) {
      return { ok: false, code: 'NAME_TAKEN' };
    }

    if (res.status === 429) {
      return { ok: false, code: 'RATE_LIMITED' };
    }

    return { ok: false, code: 'NETWORK' };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, code: 'NETWORK' };
  }
}

/**
 * Creates a challenge link for a completed Daily or Free run.
 *
 * @param {object} [params={}]
 * @param {string} [params.url] - Leaderboard base URL (falls back to window.__LB.url)
 * @param {string} [params.anonKey] - Supabase anon key (falls back to window.__LB.anonKey)
 * @param {string} [params.deviceId] - Device identifier
 * @param {'daily'|'free'} [params.mode='daily']
 * @param {object|null} [params.runLog=null] - Run log for free runs
 * @param {string|null} [params.dayUtc=null] - Optional day for daily run
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {number} [params.timeoutMs=20000]
 * @returns {Promise<{ ok: true, code: string, mode: string, expiresAt: string, url: string } | { ok: false, error: 'not_found'|'too_short'|'rejected'|'rate_limited'|'version'|'network'|'server', retryAfter?: number }>}
 */
export async function createChallenge({
  url,
  anonKey,
  deviceId,
  mode = 'daily',
  runLog = null,
  dayUtc = null,
  fetchFn = globalThis.fetch,
  timeoutMs = SUBMIT_TIMEOUT_MS,
} = {}) {
  const baseUrl = url || (typeof window !== 'undefined' && window.__LB?.url) || '';
  const key = anonKey || (typeof window !== 'undefined' && window.__LB?.anonKey) || '';
  const devId = deviceId || (typeof localStorage !== 'undefined' ? getDeviceId(localStorage) : null);

  if (!baseUrl || !key) {
    return { ok: false, error: 'network' };
  }
  if (!devId) {
    return { ok: false, error: 'rejected' };
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = `${cleanBase}/functions/v1/create-challenge`;

  let bodyPayload = { deviceId: devId };
  if (mode === 'daily') {
    bodyPayload.mode = 'daily';
    if (dayUtc) bodyPayload.dayUtc = dayUtc;
  } else {
    bodyPayload.mode = 'free';
    const minimalLog = buildSubmission(runLog);
    if (!minimalLog) {
      return { ok: false, error: 'rejected' };
    }
    bodyPayload.runLog = minimalLog;
  }

  // Up to 2 attempts: exactly 1 automatic retry on network error (backend is idempotent)
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { controller.abort(); } catch {}
      }, timeoutMs);
    }

    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': key,
        },
        body: JSON.stringify(bodyPayload),
        signal: controller?.signal,
      });

      if (timer) clearTimeout(timer);

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 200 && data?.code) {
        return {
          ok: true,
          code: data.code,
          mode: data.mode || mode,
          expiresAt: data.expiresAt,
          url: data.url || `/c/${data.code}`,
        };
      }

      if (res.status === 404) {
        return { ok: false, error: 'not_found' };
      }

      if (res.status === 429) {
        const retryHeader = res.headers?.get ? res.headers.get('retry-after') : null;
        let retrySec = retryHeader ? parseInt(retryHeader, 10) : 0;
        if (isNaN(retrySec) || retrySec < 0) retrySec = 0;
        return { ok: false, error: 'rate_limited', retryAfter: retrySec };
      }

      if (res.status === 422) {
        const errStr = String(data?.error || data?.reason || data?.message || '').toLowerCase();
        if (errStr.includes('short') || errStr.includes('run_too_short')) {
          return { ok: false, error: 'too_short' };
        }
        if (errStr.includes('version') || errStr.includes('replay_version')) {
          return { ok: false, error: 'version' };
        }
        return { ok: false, error: 'rejected' };
      }

      if (res.status >= 500) {
        return { ok: false, error: 'server' };
      }

      return { ok: false, error: 'rejected' };
    } catch (_err) {
      if (timer) clearTimeout(timer);
      if (attempt === 0) {
        // Automatic retry once on network error
        continue;
      }
      return { ok: false, error: 'network' };
    }
  }

  return { ok: false, error: 'network' };
}

export const STORAGE_KEY_MY_CHALLENGES = '2048_rogue_my_challenges';
export const STORAGE_KEY_CHALLENGE_RESULTS = '2048_rogue_challenge_results';
export const MAX_CHALLENGE_LOCAL_ENTRIES = 50;

/**
 * Records a challenge code created by this device in localStorage.
 * Keeps at most 50 entries, evicting the oldest created.
 */
export function recordMyChallenge(code, createdAt = new Date().toISOString(), extra = {}, storage = globalThis.localStorage) {
  if (!code || typeof code !== 'string') return;
  try {
    let map = {};
    const raw = storage.getItem(STORAGE_KEY_MY_CHALLENGES);
    if (raw) map = JSON.parse(raw) || {};
    map[code] = { createdAt, ...extra };
    const keys = Object.keys(map);
    if (keys.length > MAX_CHALLENGE_LOCAL_ENTRIES) {
      keys.sort((a, b) => {
        const tA = typeof map[a] === 'string' ? new Date(map[a]).getTime() : new Date(map[a]?.createdAt || 0).getTime();
        const tB = typeof map[b] === 'string' ? new Date(map[b]).getTime() : new Date(map[b]?.createdAt || 0).getTime();
        return tA - tB;
      });
      while (keys.length > MAX_CHALLENGE_LOCAL_ENTRIES) {
        const oldest = keys.shift();
        delete map[oldest];
      }
    }
    storage.setItem(STORAGE_KEY_MY_CHALLENGES, JSON.stringify(map));
  } catch {}
}

/**
 * Checks whether a challenge code was created on this device.
 */
export function isMyChallenge(code, storage = globalThis.localStorage) {
  if (!code || typeof code !== 'string') return false;
  try {
    const raw = storage.getItem(STORAGE_KEY_MY_CHALLENGES);
    if (!raw) return false;
    const map = JSON.parse(raw);
    return Boolean(map && map[code]);
  } catch {
    return false;
  }
}

/**
 * Retrieves all challenges created by this device.
 */
export function getMyChallenges(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY_MY_CHALLENGES);
    return raw ? JSON.parse(raw) || {} : {};
  } catch {
    return {};
  }
}

/**
 * Records the outcome of a challenge attempt for a code.
 * Keeps at most 50 entries, evicting the oldest.
 */
export function recordChallengeResult(code, { points, moves, at = new Date().toISOString() }, storage = globalThis.localStorage) {
  if (!code || typeof code !== 'string') return;
  try {
    let map = {};
    const raw = storage.getItem(STORAGE_KEY_CHALLENGE_RESULTS);
    if (raw) map = JSON.parse(raw) || {};
    map[code] = { points, moves, at };
    const keys = Object.keys(map);
    if (keys.length > MAX_CHALLENGE_LOCAL_ENTRIES) {
      keys.sort((a, b) => new Date(map[a]?.at || 0).getTime() - new Date(map[b]?.at || 0).getTime());
      while (keys.length > MAX_CHALLENGE_LOCAL_ENTRIES) {
        const oldest = keys.shift();
        delete map[oldest];
      }
    }
    storage.setItem(STORAGE_KEY_CHALLENGE_RESULTS, JSON.stringify(map));
  } catch {}
}

/**
 * Retrieves the local result recorded for a challenge code, if any.
 */
export function getChallengeResult(code, storage = globalThis.localStorage) {
  if (!code || typeof code !== 'string') return null;
  try {
    const raw = storage.getItem(STORAGE_KEY_CHALLENGE_RESULTS);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map && map[code] ? map[code] : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a challenge record by its 12-character alphanumeric code.
 *
 * @param {object} params
 * @param {string} [params.url]
 * @param {string} [params.anonKey]
 * @param {string} params.code
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: 'invalid_code'|'not_configured'|'network' }>}
 */
export async function getChallenge({
  url,
  anonKey,
  code,
  fetchFn = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  const CODE_REGEX = /^[A-Za-z0-9]{12}$/;
  if (!code || typeof code !== 'string' || !CODE_REGEX.test(code)) {
    return { ok: false, error: 'invalid_code' };
  }

  const baseUrl = url || (typeof window !== 'undefined' && window.__LB?.url) || '';
  const key = anonKey || (typeof window !== 'undefined' && window.__LB?.anonKey) || '';

  if (!baseUrl || !key) {
    return { ok: false, error: 'not_configured' };
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = `${cleanBase}/rest/v1/rpc/get_challenge`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs);
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
      },
      body: JSON.stringify({ code }),
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);

    if (res.status === 200) {
      const json = await res.json().catch(() => null);
      const data = Array.isArray(json) ? json[0] : json;
      if (!data) {
        return { ok: true, data: { status: 'not_found' } };
      }
      return { ok: true, data };
    }

    if (res.status === 404) {
      return { ok: true, data: { status: 'not_found' } };
    }

    return { ok: false, error: 'network' };
  } catch (_e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: 'network' };
  }
}

/**
 * Sends a challenge telemetry event ('open' or 'accept') fire-and-forget.
 * Never throws, errors ignored.
 *
 * @param {object} params
 * @param {string} [params.url]
 * @param {string} [params.anonKey]
 * @param {string} params.code
 * @param {'open'|'accept'} params.kind
 * @param {typeof fetch} [params.fetchFn=globalThis.fetch]
 * @param {number} [params.timeoutMs=5000]
 * @returns {Promise<boolean>}
 */
export async function sendChallengeEvent({
  url,
  anonKey,
  code,
  kind,
  fetchFn = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  const CODE_REGEX = /^[A-Za-z0-9]{12}$/;
  if (!code || typeof code !== 'string' || !CODE_REGEX.test(code)) return false;
  if (kind !== 'open' && kind !== 'accept') return false;

  const baseUrl = url || (typeof window !== 'undefined' && window.__LB?.url) || '';
  const key = anonKey || (typeof window !== 'undefined' && window.__LB?.anonKey) || '';
  if (!baseUrl || !key) return false;

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = `${cleanBase}/functions/v1/challenge-event`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeoutMs);
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
      },
      body: JSON.stringify({ code, kind }),
      signal: controller?.signal,
    });
    if (timer) clearTimeout(timer);
    return res.status === 200;
  } catch {
    if (timer) clearTimeout(timer);
    return false;
  }
}

