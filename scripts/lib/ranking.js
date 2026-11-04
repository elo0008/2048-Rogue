// scripts/lib/ranking.js
// Shared leaderboard ranking logic and comparators for Daily, Weekly, and All-Time boards.
// Mirrors PostgreSQL SQL/PLpgSQL functions in 0002_leaderboard_reads.sql, 0005_custom_names.sql, and 0009_alltime.sql.

/**
 * Standard attempt comparator.
 * Order:
 *  1. points DESC (higher score wins)
 *  2. total_moves DESC (more moves survived wins)
 *  3. received_at ASC (earlier submission wins)
 *  4. id ASC (lower id wins)
 */
export function compareAttempts(a, b) {
  const pointsA = Number(a.points ?? a.score ?? 0);
  const pointsB = Number(b.points ?? b.score ?? 0);
  if (pointsB !== pointsA) return pointsB - pointsA;

  const movesA = Number(a.total_moves ?? a.totalMoves ?? a.moves ?? 0);
  const movesB = Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0);
  if (movesB !== movesA) return movesB - movesA;

  const recA = String(a.received_at || a.receivedAt || '');
  const recB = String(b.received_at || b.receivedAt || '');
  if (recA !== recB) return recA.localeCompare(recB);

  const idA = Number(a.id ?? 0);
  const idB = Number(b.id ?? 0);
  return idA - idB;
}

/**
 * Resolves the public display name according to name_hidden masking.
 */
export function resolveDisplayName(device) {
  if (!device) return 'Unknown';
  if (device.nameHidden || device.name_hidden) {
    return device.generatedName || device.generated_name || 'Anonymous';
  }
  return device.displayName || device.display_name || device.generatedName || device.generated_name || 'Anonymous';
}

/**
 * Clamps a limit parameter to 1..100 (null/undefined -> 100).
 */
export function clampLimit(pLimit) {
  if (pLimit === null || pLimit === undefined) return 100;
  const n = parseInt(pLimit, 10);
  if (Number.isNaN(n)) return 100;
  return Math.max(1, Math.min(n, 100));
}

/**
 * Normalizes any date to ISO Monday date string (YYYY-MM-DD).
 */
export function getMondayUtc(inputDate) {
  const d = typeof inputDate === 'string'
    ? new Date(inputDate.includes('T') ? inputDate : `${inputDate}T00:00:00Z`)
    : (inputDate ? new Date(inputDate) : new Date());
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}

/**
 * Computes the Daily Best leaderboard for a given target day.
 * Exposes strictly allowed public columns: display_name, points, total_moves, max_tile, rank.
 */
export function computeDailyBest(runs, devicesMap, targetDay, limit = 100) {
  const perDevice = new Map();
  for (const r of runs) {
    const day = r.day_utc || r.dayUtc;
    if (day !== targetDay) continue;
    const devId = r.device_id || r.deviceId;
    const cur = perDevice.get(devId);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevice.set(devId, r);
    }
  }

  const bests = Array.from(perDevice.values());
  bests.sort(compareAttempts);

  const rows = bests.map((b, idx) => {
    const devId = b.device_id || b.deviceId;
    const dev = devicesMap instanceof Map ? devicesMap.get(devId) : devicesMap[devId];
    return {
      display_name: resolveDisplayName(dev),
      points: Number(b.points ?? b.score ?? 0),
      total_moves: Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0),
      max_tile: Number(b.max_tile ?? b.maxTile ?? 0),
      rank: idx + 1,
    };
  });

  return rows.slice(0, clampLimit(limit));
}

/**
 * Computes individual device daily rank lookup.
 */
export function computeMyDailyRank(runs, devicesMap, targetDay, deviceId) {
  const perDevice = new Map();
  for (const r of runs) {
    const day = r.day_utc || r.dayUtc;
    if (day !== targetDay) continue;
    const devId = r.device_id || r.deviceId;
    const cur = perDevice.get(devId);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevice.set(devId, r);
    }
  }

  const bests = Array.from(perDevice.values());
  bests.sort(compareAttempts);

  const total_players = bests.length;
  const matchIdx = bests.findIndex(b => (b.device_id || b.deviceId) === deviceId);
  if (matchIdx === -1) return [];

  const b = bests[matchIdx];
  const dev = devicesMap instanceof Map ? devicesMap.get(deviceId) : devicesMap[deviceId];
  return [{
    rank: matchIdx + 1,
    display_name: resolveDisplayName(dev),
    points: Number(b.points ?? b.score ?? 0),
    total_moves: Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0),
    max_tile: Number(b.max_tile ?? b.maxTile ?? 0),
    total_players,
  }];
}

/**
 * Computes the Weekly Best leaderboard.
 * Days in [monday, monday + 7 days).
 * Best run per (device, day), then sums points & moves per device.
 * Ranked by: total_points DESC, latest_received_at ASC, first_id ASC.
 */
export function computeWeeklyBest(runs, devicesMap, targetWeekStart = null, limit = 100) {
  const monday = targetWeekStart ? getMondayUtc(targetWeekStart) : getMondayUtc(new Date());
  const mondayMs = Date.parse(`${monday}T00:00:00Z`);
  const sundayEndMs = mondayMs + 7 * 86400000;

  // 1. Best attempt per (device, day)
  const perDevDay = new Map();
  for (const r of runs) {
    const day = r.day_utc || r.dayUtc;
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (dayMs < mondayMs || dayMs >= sundayEndMs) continue;

    const devId = r.device_id || r.deviceId;
    const key = `${devId}:${day}`;
    const cur = perDevDay.get(key);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevDay.set(key, r);
    }
  }

  // 2. Aggregate per device
  const perDevAgg = new Map();
  for (const b of perDevDay.values()) {
    const devId = b.device_id || b.deviceId;
    let agg = perDevAgg.get(devId);
    if (!agg) {
      agg = {
        deviceId: devId,
        totalPoints: 0,
        totalMoves: 0,
        highestTile: 0,
        latestReceivedAt: '',
        firstId: Infinity,
      };
      perDevAgg.set(devId, agg);
    }
    agg.totalPoints += Number(b.points ?? b.score ?? 0);
    agg.totalMoves += Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0);
    agg.highestTile = Math.max(agg.highestTile, Number(b.max_tile ?? b.maxTile ?? 0));
    const rec = String(b.received_at || b.receivedAt || '');
    if (!agg.latestReceivedAt || rec > agg.latestReceivedAt) {
      agg.latestReceivedAt = rec;
    }
    const id = Number(b.id ?? 0);
    if (id < agg.firstId) {
      agg.firstId = id;
    }
  }

  // 3. Rank overall: total_points DESC, latest_received_at ASC, first_id ASC
  const sorted = Array.from(perDevAgg.values()).sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (a.latestReceivedAt !== b.latestReceivedAt) return a.latestReceivedAt.localeCompare(b.latestReceivedAt);
    return a.firstId - b.firstId;
  });

  const rows = sorted.map((s, idx) => {
    const dev = devicesMap instanceof Map ? devicesMap.get(s.deviceId) : devicesMap[s.deviceId];
    return {
      display_name: resolveDisplayName(dev),
      points: s.totalPoints,
      total_moves: s.totalMoves,
      max_tile: s.highestTile,
      rank: idx + 1,
    };
  });

  return rows.slice(0, clampLimit(limit));
}

/**
 * Computes individual device weekly rank lookup.
 */
export function computeMyWeeklyRank(runs, devicesMap, targetWeekStart, deviceId) {
  const monday = targetWeekStart ? getMondayUtc(targetWeekStart) : getMondayUtc(new Date());
  const mondayMs = Date.parse(`${monday}T00:00:00Z`);
  const sundayEndMs = mondayMs + 7 * 86400000;

  const perDevDay = new Map();
  for (const r of runs) {
    const day = r.day_utc || r.dayUtc;
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (dayMs < mondayMs || dayMs >= sundayEndMs) continue;

    const devId = r.device_id || r.deviceId;
    const key = `${devId}:${day}`;
    const cur = perDevDay.get(key);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevDay.set(key, r);
    }
  }

  const perDevAgg = new Map();
  for (const b of perDevDay.values()) {
    const devId = b.device_id || b.deviceId;
    let agg = perDevAgg.get(devId);
    if (!agg) {
      agg = {
        deviceId: devId,
        totalPoints: 0,
        totalMoves: 0,
        highestTile: 0,
        latestReceivedAt: '',
        firstId: Infinity,
      };
      perDevAgg.set(devId, agg);
    }
    agg.totalPoints += Number(b.points ?? b.score ?? 0);
    agg.totalMoves += Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0);
    agg.highestTile = Math.max(agg.highestTile, Number(b.max_tile ?? b.maxTile ?? 0));
    const rec = String(b.received_at || b.receivedAt || '');
    if (!agg.latestReceivedAt || rec > agg.latestReceivedAt) {
      agg.latestReceivedAt = rec;
    }
    const id = Number(b.id ?? 0);
    if (id < agg.firstId) {
      agg.firstId = id;
    }
  }

  const sorted = Array.from(perDevAgg.values()).sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (a.latestReceivedAt !== b.latestReceivedAt) return a.latestReceivedAt.localeCompare(b.latestReceivedAt);
    return a.firstId - b.firstId;
  });

  const total_players = sorted.length;
  const matchIdx = sorted.findIndex(s => s.deviceId === deviceId);
  if (matchIdx === -1) return [];

  const s = sorted[matchIdx];
  const dev = devicesMap instanceof Map ? devicesMap.get(deviceId) : devicesMap[deviceId];
  return [{
    rank: matchIdx + 1,
    display_name: resolveDisplayName(dev),
    points: s.totalPoints,
    total_moves: s.totalMoves,
    max_tile: s.highestTile,
    total_players,
  }];
}

/**
 * Computes the All-Time Best leaderboard across all days.
 * Each device's single best run across all days, ranked with standard attempt comparator.
 */
export function computeAlltimeBest(runs, devicesMap, limit = 100) {
  const perDevice = new Map();
  for (const r of runs) {
    const devId = r.device_id || r.deviceId;
    const cur = perDevice.get(devId);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevice.set(devId, r);
    }
  }

  const bests = Array.from(perDevice.values());
  bests.sort(compareAttempts);

  const rows = bests.map((b, idx) => {
    const devId = b.device_id || b.deviceId;
    const dev = devicesMap instanceof Map ? devicesMap.get(devId) : devicesMap[devId];
    return {
      display_name: resolveDisplayName(dev),
      points: Number(b.points ?? b.score ?? 0),
      total_moves: Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0),
      max_tile: Number(b.max_tile ?? b.maxTile ?? 0),
      rank: idx + 1,
    };
  });

  return rows.slice(0, clampLimit(limit));
}

/**
 * Computes individual device all-time rank lookup.
 */
export function computeMyAlltimeRank(runs, devicesMap, deviceId) {
  const perDevice = new Map();
  for (const r of runs) {
    const devId = r.device_id || r.deviceId;
    const cur = perDevice.get(devId);
    if (!cur || compareAttempts(r, cur) < 0) {
      perDevice.set(devId, r);
    }
  }

  const bests = Array.from(perDevice.values());
  bests.sort(compareAttempts);

  const total_players = bests.length;
  const matchIdx = bests.findIndex(b => (b.device_id || b.deviceId) === deviceId);
  if (matchIdx === -1) return [];

  const b = bests[matchIdx];
  const dev = devicesMap instanceof Map ? devicesMap.get(deviceId) : devicesMap[deviceId];
  return [{
    rank: matchIdx + 1,
    display_name: resolveDisplayName(dev),
    points: Number(b.points ?? b.score ?? 0),
    total_moves: Number(b.total_moves ?? b.totalMoves ?? b.moves ?? 0),
    max_tile: Number(b.max_tile ?? b.maxTile ?? 0),
    total_players,
  }];
}
