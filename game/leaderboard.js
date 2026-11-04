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

  return {
    seed: runLog.seed,
    rulesVersion: runLog.rulesVersion,
    replayVersion: runLog.replayVersion,
    startTimestamp: runLog.startTimestamp,
    activeMs: runLog.activeMs,
    durationMs: typeof runLog.durationMs === 'number' ? runLog.durationMs : (typeof runLog.activeMs === 'number' ? runLog.activeMs : null),
    points: runLog.points ?? runLog.score ?? 0,
    totalMoves: runLog.totalMoves ?? runLog.moveNumberAtDeath ?? 0,
    maxTile: runLog.maxTile ?? 0,
    relicsOwned: Array.isArray(runLog.relicsOwned) ? [...runLog.relicsOwned] : [],
    lastStandFired: Boolean(runLog.lastStandFired),
    endedByPlayer: Boolean(runLog.endedByPlayer),
    capped: Boolean(runLog.capped),
    config: runLog.config,
    events: [...runLog.events],
  };
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
        'Authorization': `Bearer ${anonKey}`,
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

    for (const item of queue) {
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
        'Authorization': `Bearer ${anonKey}`,
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
