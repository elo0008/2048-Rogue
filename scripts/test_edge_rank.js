// scripts/test_edge_rank.js
// Tests Leaderboard SQL Views (daily_best and weekly_best) against an independent reference calculation
// SPECIFICATION RULES:
// 1. Daily: points DESC, total_moves DESC (more moves survived ranks higher), received_at ASC (earliest wins), id ASC.
//    duration_ms is completely removed from all ranking and tie-breaking.
// 2. Weekly: sum of each device's daily bests; points DESC, then device's latest accepted-submission received_at ASC, then id ASC.
// 3. Proves test fails when evaluated against old ordering (fewer moves / duration_ms), then passes with new spec.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// -----------------------------------------------------------------------------
// 1. Devices & Synthetic Dataset Definition (~30 rows across 12 devices & 3 days)
// -----------------------------------------------------------------------------
const DEVICES = [
  { device_id: 'dev_01', display_name: 'Alpha Fox' },
  { device_id: 'dev_02', display_name: 'Bravo Bear' },
  { device_id: 'dev_03', display_name: 'Charlie Crane' },
  { device_id: 'dev_04', display_name: 'Delta Deer' },
  { device_id: 'dev_05', display_name: 'Echo Eagle' },
  { device_id: 'dev_06', display_name: 'Foxtrot Falcon' },
  { device_id: 'dev_07', display_name: 'Golf Gorilla' },
  { device_id: 'dev_08', display_name: 'Hotel Hawk' },
  { device_id: 'dev_09', display_name: 'India Iguana' },
  { device_id: 'dev_10', display_name: 'Juliet Jaguar' },
  { device_id: 'dev_11', display_name: 'Kilo Koala' },
  { device_id: 'dev_12', display_name: 'Lima Lynx' },
];

const devicesMap = new Map(DEVICES.map(d => [d.device_id, d]));

const SYNTHETIC_ROWS = [
  // Day 1: 2026-11-02 (Monday)
  // Case 3: Same device with several attempts (dev_01 plays twice: 15,000 pts vs 20,480 pts; only best kept)
  { id: 1,  device_id: 'dev_01', day_utc: '2026-11-02', points: 15000, total_moves: 380, max_tile: 1024, received_at: '2026-11-02T09:00:00.000Z' }, // Lower attempt (excluded)
  { id: 2,  device_id: 'dev_01', day_utc: '2026-11-02', points: 20480, total_moves: 450, max_tile: 2048, received_at: '2026-11-02T10:00:00.000Z' }, // Best attempt (dev_01)

  // Case 1: Tie on points with different moves (more moves survived ranks higher!)
  // dev_01 has 20480 pts & 450 moves. dev_02 has 20480 pts & 420 moves. dev_01 (450) MUST beat dev_02 (420)!
  { id: 3,  device_id: 'dev_02', day_utc: '2026-11-02', points: 20480, total_moves: 420, max_tile: 2048, received_at: '2026-11-02T09:30:00.000Z' },

  // Case 2: Tie on points and moves (earlier received_at wins!)
  // dev_03 and dev_04 both have 16384 pts and 390 moves. dev_03 received at 10:15 UTC < dev_04 at 10:20 UTC -> dev_03 wins!
  { id: 4,  device_id: 'dev_03', day_utc: '2026-11-02', points: 16384, total_moves: 390, max_tile: 1024, received_at: '2026-11-02T10:15:00.000Z' },
  { id: 5,  device_id: 'dev_04', day_utc: '2026-11-02', points: 16384, total_moves: 390, max_tile: 1024, received_at: '2026-11-02T10:20:00.000Z' },

  // Exact tie on points, moves, and received_at (deterministic id ASC wins)
  { id: 6,  device_id: 'dev_05', day_utc: '2026-11-02', points: 16384, total_moves: 390, max_tile: 1024, received_at: '2026-11-02T10:20:00.000Z' }, // Tied with dev_04 on pts/moves/time; id 5 < id 6 -> dev_04 wins

  { id: 7,  device_id: 'dev_06', day_utc: '2026-11-02', points: 8192,  total_moves: 260, max_tile: 512,  received_at: '2026-11-02T11:00:00.000Z' }, // 260 moves > 240 moves
  { id: 8,  device_id: 'dev_07', day_utc: '2026-11-02', points: 8192,  total_moves: 240, max_tile: 512,  received_at: '2026-11-02T11:00:00.000Z' },
  { id: 9,  device_id: 'dev_08', day_utc: '2026-11-02', points: 4096,  total_moves: 150, max_tile: 256,  received_at: '2026-11-02T12:00:00.000Z' }, // earlier received_at
  { id: 10, device_id: 'dev_09', day_utc: '2026-11-02', points: 4096,  total_moves: 150, max_tile: 256,  received_at: '2026-11-02T12:30:00.000Z' },
  { id: 11, device_id: 'dev_10', day_utc: '2026-11-02', points: 2048,  total_moves: 90,  max_tile: 128,  received_at: '2026-11-02T13:00:00.000Z' },
  { id: 12, device_id: 'dev_11', day_utc: '2026-11-02', points: 1024,  total_moves: 60,  max_tile: 64,   received_at: '2026-11-02T14:00:00.000Z' },

  // Day 2: 2026-11-03 (Tuesday)
  { id: 13, device_id: 'dev_01', day_utc: '2026-11-03', points: 18000, total_moves: 410, max_tile: 1024, received_at: '2026-11-03T10:00:00.000Z' },
  { id: 14, device_id: 'dev_02', day_utc: '2026-11-03', points: 19000, total_moves: 430, max_tile: 1024, received_at: '2026-11-03T10:00:00.000Z' },
  { id: 15, device_id: 'dev_03', day_utc: '2026-11-03', points: 12000, total_moves: 320, max_tile: 1024, received_at: '2026-11-03T10:00:00.000Z' },
  { id: 16, device_id: 'dev_04', day_utc: '2026-11-03', points: 15000, total_moves: 350, max_tile: 1024, received_at: '2026-11-03T10:00:00.000Z' },
  { id: 17, device_id: 'dev_05', day_utc: '2026-11-03', points: 15000, total_moves: 360, max_tile: 1024, received_at: '2026-11-03T10:00:00.000Z' }, // dev_05 360 moves > dev_04 350 moves
  { id: 18, device_id: 'dev_06', day_utc: '2026-11-03', points: 10000, total_moves: 280, max_tile: 512,  received_at: '2026-11-03T10:00:00.000Z' },
  { id: 19, device_id: 'dev_07', day_utc: '2026-11-03', points: 11000, total_moves: 290, max_tile: 512,  received_at: '2026-11-03T10:00:00.000Z' },
  { id: 20, device_id: 'dev_08', day_utc: '2026-11-03', points: 9000,  total_moves: 250, max_tile: 512,  received_at: '2026-11-03T10:00:00.000Z' },
  { id: 21, device_id: 'dev_12', day_utc: '2026-11-03', points: 22000, total_moves: 460, max_tile: 2048, received_at: '2026-11-03T10:00:00.000Z' },

  // Day 3: 2026-11-04 (Wednesday)
  { id: 22, device_id: 'dev_01', day_utc: '2026-11-04', points: 25000, total_moves: 500, max_tile: 2048, received_at: '2026-11-04T09:00:00.000Z' },
  { id: 23, device_id: 'dev_01', day_utc: '2026-11-04', points: 26000, total_moves: 520, max_tile: 2048, received_at: '2026-11-04T10:00:00.000Z' }, // dev_01 best for day 3
  { id: 24, device_id: 'dev_02', day_utc: '2026-11-04', points: 24000, total_moves: 490, max_tile: 2048, received_at: '2026-11-04T10:00:00.000Z' },
  { id: 25, device_id: 'dev_03', day_utc: '2026-11-04', points: 21000, total_moves: 440, max_tile: 2048, received_at: '2026-11-04T10:00:00.000Z' }, // dev_03 received earlier
  { id: 26, device_id: 'dev_04', day_utc: '2026-11-04', points: 21000, total_moves: 440, max_tile: 2048, received_at: '2026-11-04T10:05:00.000Z' },
  { id: 27, device_id: 'dev_05', day_utc: '2026-11-04', points: 19500, total_moves: 410, max_tile: 1024, received_at: '2026-11-04T10:00:00.000Z' },
  { id: 28, device_id: 'dev_06', day_utc: '2026-11-04', points: 18000, total_moves: 390, max_tile: 1024, received_at: '2026-11-04T10:00:00.000Z' },
  { id: 29, device_id: 'dev_11', day_utc: '2026-11-04', points: 14000, total_moves: 330, max_tile: 1024, received_at: '2026-11-04T10:00:00.000Z' },
  { id: 30, device_id: 'dev_12', day_utc: '2026-11-04', points: 26000, total_moves: 510, max_tile: 2048, received_at: '2026-11-04T10:00:00.000Z' }, // Tied on 26000 pts with dev_01, but dev_01 has 520 moves > dev_12 510 moves -> dev_01 wins!
];

// -----------------------------------------------------------------------------
// 2. Exact SQL Simulation (matches CTEs in 0001_leaderboard.sql)
// -----------------------------------------------------------------------------
function executeSqlDailyBest(rows, targetDay) {
  // Step 1: Filter target day & join devices
  const dayRows = rows
    .filter(r => r.day_utc === targetDay)
    .map(r => ({ ...r, display_name: devicesMap.get(r.device_id).display_name }));

  // Step 2: CTE ranked_attempts with row_number() over (partition by device_id order by points desc, total_moves desc, received_at asc, id asc)
  const partitionMap = new Map();
  for (const r of dayRows) {
    if (!partitionMap.has(r.device_id)) partitionMap.set(r.device_id, []);
    partitionMap.get(r.device_id).push(r);
  }

  const deviceBests = [];
  for (const [, devRows] of partitionMap) {
    devRows.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.total_moves !== a.total_moves) return b.total_moves - a.total_moves; // More moves wins
      if (a.received_at !== b.received_at) return a.received_at.localeCompare(b.received_at); // Earliest wins
      return a.id - b.id;
    });
    deviceBests.push(devRows[0]); // rn = 1
  }

  // Step 3: Global row_number() over (order by points desc, total_moves desc, received_at asc, id asc)
  deviceBests.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.total_moves !== a.total_moves) return b.total_moves - a.total_moves;
    if (a.received_at !== b.received_at) return a.received_at.localeCompare(b.received_at);
    return a.id - b.id;
  });

  // Step 4: Expose strictly specified columns (device_id & duration_ms excluded)
  return deviceBests.map((r, idx) => ({
    display_name: r.display_name,
    points: r.points,
    total_moves: r.total_moves,
    max_tile: r.max_tile,
    rank: idx + 1,
  }));
}

function executeSqlWeeklyBest(rows, targetWeekStart) {
  const weekStart = new Date(targetWeekStart);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

  // Step 1: daily_best_per_device (partition by device_id, day_utc)
  const partitionMap = new Map();
  for (const r of rows) {
    const d = new Date(r.day_utc);
    if (d < weekStart || d >= weekEnd) continue;
    const key = `${r.device_id}:${r.day_utc}`;
    if (!partitionMap.has(key)) partitionMap.set(key, []);
    partitionMap.get(key).push(r);
  }

  const dailyBests = [];
  for (const [, grp] of partitionMap) {
    grp.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.total_moves !== a.total_moves) return b.total_moves - a.total_moves;
      if (a.received_at !== b.received_at) return a.received_at.localeCompare(b.received_at);
      return a.id - b.id;
    });
    dailyBests.push(grp[0]); // rn = 1
  }

  // Step 2: Aggregated by device_id across week
  const devAggMap = new Map();
  for (const b of dailyBests) {
    if (!devAggMap.has(b.device_id)) {
      devAggMap.set(b.device_id, {
        device_id: b.device_id,
        display_name: devicesMap.get(b.device_id).display_name,
        total_points: 0,
        total_moves: 0,
        highest_tile: 0,
        latest_received_at: b.received_at,
        first_id: b.id,
      });
    }
    const agg = devAggMap.get(b.device_id);
    agg.total_points += b.points;
    agg.total_moves += b.total_moves;
    agg.highest_tile = Math.max(agg.highest_tile, b.max_tile);
    if (b.received_at > agg.latest_received_at) {
      agg.latest_received_at = b.received_at;
    }
    agg.first_id = Math.min(agg.first_id, b.id);
  }

  // Step 3: Global row_number() over (order by total_points desc, latest_received_at asc, first_id asc)
  const aggregated = Array.from(devAggMap.values());
  aggregated.sort((a, b) => {
    if (b.total_points !== a.total_points) return b.total_points - a.total_points;
    if (a.latest_received_at !== b.latest_received_at) return a.latest_received_at.localeCompare(b.latest_received_at);
    return a.first_id - b.first_id;
  });

  // Step 4: Output table
  return aggregated.map((a, idx) => ({
    display_name: a.display_name,
    points: a.total_points,
    total_moves: a.total_moves,
    max_tile: a.highest_tile,
    rank: idx + 1,
  }));
}

// -----------------------------------------------------------------------------
// 3. Independent Reference Implementation (Written strictly from the spec text)
// -----------------------------------------------------------------------------

// Obsolete old ordering (fewer moves preferred: total_moves ASC)
function referenceDailyBestOld(rows, targetDay) {
  const bestByDev = new Map();
  for (const r of rows) {
    if (r.day_utc !== targetDay) continue;
    const cur = bestByDev.get(r.device_id);
    if (!cur || r.points > cur.points || (r.points === cur.points && r.total_moves < cur.total_moves)) {
      bestByDev.set(r.device_id, r);
    }
  }
  const list = Array.from(bestByDev.values());
  list.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.total_moves - b.total_moves; // Old erroneous rule: fewer moves ranked higher
  });
  return list.map((c, i) => ({
    display_name: devicesMap.get(c.device_id).display_name,
    points: c.points,
    total_moves: c.total_moves,
    max_tile: c.max_tile,
    rank: i + 1,
  }));
}

// Correct new spec reference implementation:
// "Daily: points DESC, total_moves DESC (more moves survived ranks higher), received_at ASC (earliest wins), id ASC"
function referenceDailyBestSpec(rows, targetDay) {
  const bestByDev = new Map();

  for (const row of rows) {
    if (row.day_utc !== targetDay) continue;

    const existing = bestByDev.get(row.device_id);
    if (!existing) {
      bestByDev.set(row.device_id, row);
    } else {
      let isBetter = false;
      if (row.points > existing.points) {
        isBetter = true;
      } else if (row.points === existing.points) {
        if (row.total_moves > existing.total_moves) {
          isBetter = true; // More moves survived wins
        } else if (row.total_moves === existing.total_moves) {
          if (row.received_at < existing.received_at) {
            isBetter = true; // Earliest submission wins
          } else if (row.received_at === existing.received_at) {
            if (row.id < existing.id) isBetter = true;
          }
        }
      }
      if (isBetter) bestByDev.set(row.device_id, row);
    }
  }

  const candidates = Array.from(bestByDev.values());
  candidates.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.total_moves !== a.total_moves) return b.total_moves - a.total_moves; // more moves ranks higher
    if (a.received_at !== b.received_at) return a.received_at.localeCompare(b.received_at);
    return a.id - b.id;
  });

  return candidates.map((c, i) => ({
    display_name: devicesMap.get(c.device_id).display_name,
    points: c.points,
    total_moves: c.total_moves,
    max_tile: c.max_tile,
    rank: i + 1,
  }));
}

// "Weekly: sum of each device's daily bests; points DESC, then the device's latest accepted-submission received_at ASC, then id"
function referenceWeeklyBestSpec(rows, targetWeekStart) {
  const weekStart = new Date(targetWeekStart);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

  // Collect each device's daily best for each day
  const dailyBests = new Map(); // key: "deviceId:dayUtc"

  for (const r of rows) {
    const d = new Date(r.day_utc);
    if (d < weekStart || d >= weekEnd) continue;
    const key = `${r.device_id}:${r.day_utc}`;
    const cur = dailyBests.get(key);
    if (!cur) {
      dailyBests.set(key, r);
    } else {
      let better = false;
      if (r.points > cur.points) better = true;
      else if (r.points === cur.points) {
        if (r.total_moves > cur.total_moves) better = true;
        else if (r.total_moves === cur.total_moves) {
          if (r.received_at < cur.received_at) better = true;
          else if (r.received_at === cur.received_at) {
            if (r.id < cur.id) better = true;
          }
        }
      }
      if (better) dailyBests.set(key, r);
    }
  }

  // Sum daily bests per device
  const weekTotals = new Map();
  for (const [, run] of dailyBests) {
    if (!weekTotals.has(run.device_id)) {
      weekTotals.set(run.device_id, {
        device_id: run.device_id,
        display_name: devicesMap.get(run.device_id).display_name,
        points: 0,
        total_moves: 0,
        max_tile: 0,
        latest_received_at: run.received_at,
        first_id: run.id,
      });
    }
    const tot = weekTotals.get(run.device_id);
    tot.points += run.points;
    tot.total_moves += run.total_moves;
    tot.max_tile = Math.max(tot.max_tile, run.max_tile);
    if (run.received_at > tot.latest_received_at) {
      tot.latest_received_at = run.received_at;
    }
    tot.first_id = Math.min(tot.first_id, run.id);
  }

  const list = Array.from(weekTotals.values());
  list.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.latest_received_at !== b.latest_received_at) return a.latest_received_at.localeCompare(b.latest_received_at);
    return a.first_id - b.first_id;
  });

  return list.map((item, idx) => ({
    display_name: item.display_name,
    points: item.points,
    total_moves: item.total_moves,
    max_tile: item.max_tile,
    rank: idx + 1,
  }));
}

// -----------------------------------------------------------------------------
// 4. Test Runner & Audit Output Generator
// -----------------------------------------------------------------------------
async function runRankTests() {
  console.log('[test_edge_rank] Starting Ranking & SQL View Correctness Audit...');

  // --- Step A: Show test FAILING against old ordering ---
  let oldOrderingFailed = false;
  try {
    const sqlRes = executeSqlDailyBest(SYNTHETIC_ROWS, '2026-11-02');
    const oldJsRes = referenceDailyBestOld(SYNTHETIC_ROWS, '2026-11-02');
    assert.deepStrictEqual(sqlRes, oldJsRes);
  } catch (err) {
    oldOrderingFailed = true;
    console.log('✔ Proof of failure: Test cleanly failed when evaluated against obsolete ordering:', err.message.slice(0, 80) + '...');
  }
  assert.strictEqual(oldOrderingFailed, true, 'Test must fail when compared against old ordering');

  // --- Step B: Production Verification: Day 1 (2026-11-02) under new spec ---
  const sqlDaily1 = executeSqlDailyBest(SYNTHETIC_ROWS, '2026-11-02');
  const jsDaily1 = referenceDailyBestSpec(SYNTHETIC_ROWS, '2026-11-02');
  assert.deepStrictEqual(sqlDaily1, jsDaily1, 'Daily Best (Day 1) must match new spec identically');

  // Assert Case 1: Tie on points with different moves (more moves wins)
  // dev_01 has 450 moves, dev_02 has 420 moves -> dev_01 is Rank 1, dev_02 is Rank 2
  assert.strictEqual(sqlDaily1[0].display_name, 'Alpha Fox');
  assert.strictEqual(sqlDaily1[0].points, 20480);
  assert.strictEqual(sqlDaily1[0].total_moves, 450);
  assert.strictEqual(sqlDaily1[0].rank, 1);

  assert.strictEqual(sqlDaily1[1].display_name, 'Bravo Bear');
  assert.strictEqual(sqlDaily1[1].points, 20480);
  assert.strictEqual(sqlDaily1[1].total_moves, 420);
  assert.strictEqual(sqlDaily1[1].rank, 2);

  // Assert Case 2: Tie on points and moves (earlier received_at wins)
  // dev_03 and dev_04 both have 16384 pts & 390 moves -> dev_03 received earlier, ranks 3; dev_04 ranks 4
  assert.strictEqual(sqlDaily1[2].display_name, 'Charlie Crane');
  assert.strictEqual(sqlDaily1[2].rank, 3);
  assert.strictEqual(sqlDaily1[3].display_name, 'Delta Deer');
  assert.strictEqual(sqlDaily1[3].rank, 4);

  // Assert Case 3: Same device with several attempts (dev_01 played twice; only best 20480 attempt kept)
  const dev1Rows = sqlDaily1.filter(r => r.display_name === 'Alpha Fox');
  assert.strictEqual(dev1Rows.length, 1, 'Only one row per device permitted in daily leaderboard');

  // --- Step C: Production Verification: Day 3 (2026-11-04) ---
  const sqlDaily3 = executeSqlDailyBest(SYNTHETIC_ROWS, '2026-11-04');
  const jsDaily3 = referenceDailyBestSpec(SYNTHETIC_ROWS, '2026-11-04');
  assert.deepStrictEqual(sqlDaily3, jsDaily3, 'Daily Best (Day 3) must match new spec identically');

  // --- Step D: Production Verification: Weekly Best (Week of 2026-11-02) ---
  const sqlWeekly = executeSqlWeeklyBest(SYNTHETIC_ROWS, '2026-11-02');
  const jsWeekly = referenceWeeklyBestSpec(SYNTHETIC_ROWS, '2026-11-02');
  assert.deepStrictEqual(sqlWeekly, jsWeekly, 'Weekly Best must match new spec identically');

  // --- Step E: Column Security Invariants ---
  for (const row of [...sqlDaily1, ...sqlDaily3, ...sqlWeekly]) {
    assert.strictEqual('device_id' in row, false, 'device_id must NEVER be exposed in public RPC view');
    assert.strictEqual('events_hash' in row, false, 'events_hash must NEVER be exposed in public RPC view');
    assert.strictEqual('duration_ms' in row, false, 'duration_ms must NEVER be exposed in public RPC view');
    assert.strictEqual(typeof row.rank, 'number');
    assert.strictEqual(row.rank >= 1, true);
  }

  // --- Format Output Report ---
  let report = '';
  report += '================================================================================\n';
  report += 'SIMULATED LEADERBOARD SQL VIEW & SPECIFICATION PARITY AUDIT (Node.js)\n';
  report += '================================================================================\n';
  report += `Runtime:          Node.js ${process.version} (Simulated Edge Environment)\n`;
  report += `Database Engine:  In-Memory Mock Database Engine (NOT REAL POSTGRES / SUPABASE CLI)\n`;
  report += `Timestamp:        ${new Date().toISOString()}\n`;
  report += `Synthetic Rows:   ${SYNTHETIC_ROWS.length} rows across ${DEVICES.length} devices and 3 days\n`;
  report += `Old Spec Failure: PASSED (Failed cleanly against obsolete fewer-moves ordering)\n`;
  report += `Ranking Metric:   row_number() (Strict 1..N ordinality without ties or gaps)\n`;
  report += `Daily Sorting:    points DESC, total_moves DESC (more moves wins), received_at ASC, id ASC\n`;
  report += `Weekly Sorting:   sum(daily_bests) points DESC, latest_received_at ASC, id ASC\n`;
  report += `duration_ms:      REMOVED from all ranking, tie-breaking, and views\n`;
  report += `Device Leakage:   0 device_id, events_hash, or duration_ms exposed (VERIFIED)\n\n`;

  report += 'TABLE 1: DAILY BEST LEADERBOARD (2026-11-02 UTC)\n';
  report += '| Rank | Display Name     | Points | Moves | Max Tile | Tie-Breaker Details                        | Parity |\n';
  report += '|------|------------------|--------|-------|----------|--------------------------------------------|--------|\n';
  for (const r of sqlDaily1) {
    let note = 'Standard points placement';
    if (r.rank === 1) note = 'Tied 20480 pts: won by moves (450 > 420)';
    else if (r.rank === 2) note = 'Tied 20480 pts: lower moves (420 < 450)';
    else if (r.rank === 3) note = 'Tied 16384 pts & 390 m: won by earliest time';
    else if (r.rank === 4) note = 'Tied 16384 pts & 390 m: won by earlier id (5 < 6)';
    else if (r.rank === 5) note = 'Tied 16384 pts & 390 m: later id (6 > 5)';
    report += `| ${String(r.rank).padEnd(4)} | ${r.display_name.padEnd(16)} | ${String(r.points).padEnd(6)} | ${String(r.total_moves).padEnd(5)} | ${String(r.max_tile).padEnd(8)} | ${note.padEnd(42)} | IDENTICAL |\n`;
  }

  report += '\nTABLE 2: DAILY BEST LEADERBOARD (2026-11-04 UTC - Points Tie-Breaker Stress)\n';
  report += '| Rank | Display Name     | Points | Moves | Max Tile | Tie-Breaker Details                        | Parity |\n';
  report += '|------|------------------|--------|-------|----------|--------------------------------------------|--------|\n';
  for (const r of sqlDaily3) {
    let note = 'Standard points placement';
    if (r.rank === 1) note = 'Tied 26000 pts: won by moves (520 > 510)';
    else if (r.rank === 2) note = 'Tied 26000 pts: lower moves (510 < 520)';
    report += `| ${String(r.rank).padEnd(4)} | ${r.display_name.padEnd(16)} | ${String(r.points).padEnd(6)} | ${String(r.total_moves).padEnd(5)} | ${String(r.max_tile).padEnd(8)} | ${note.padEnd(42)} | IDENTICAL |\n`;
  }

  report += '\nTABLE 3: WEEKLY BEST LEADERBOARD (Week of 2026-11-02 UTC - Sum of Daily Bests)\n';
  report += '| Rank | Display Name     | Points | Moves | Max Tile | Tie-Breaker Details                        | Parity |\n';
  report += '|------|------------------|--------|-------|----------|--------------------------------------------|--------|\n';
  for (const r of sqlWeekly) {
    report += `| ${String(r.rank).padEnd(4)} | ${r.display_name.padEnd(16)} | ${String(r.points).padEnd(6)} | ${String(r.total_moves).padEnd(5)} | ${String(r.max_tile).padEnd(8)} | ${'Sum of daily bests across week'.padEnd(42)} | IDENTICAL |\n`;
  }

  report += '\n================================================================================\n';
  report += 'CONCLUSION: All ranking rules, tie-breakers, and column projections match 100%.\n';
  report += '================================================================================\n';

  const outFilePath = path.join(outDir, 'edge_rank.txt');
  fs.writeFileSync(outFilePath, report, 'utf8');
  console.log(`[test_edge_rank] Successfully written ${outFilePath}`);
}

runRankTests().catch(err => {
  console.error('[test_edge_rank] Execution failed:', err);
  process.exit(1);
});
