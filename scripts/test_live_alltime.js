// scripts/test_live_alltime.js
// Live Integration Verification for Migration 0009: alltime_best and my_alltime_rank.
// Tests against real hosted Supabase project, validates spec comparator, limit clamping,
// tie-breaker precedence, name masking, and cleanup in finally with safety rails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { assertDatabaseSafe } from './live_safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Load .env.test
const envFile = path.join(rootDir, '.env.test');
if (!fs.existsSync(envFile)) {
  throw new Error(`.env.test not found at ${envFile}`);
}

const env = fs.readFileSync(envFile, 'utf8').split('\n').reduce((acc, line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return acc;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    acc[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return acc;
}, {});

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const isSelfCheckFail = process.argv.includes('--self-check-fail');
const TEST_PREFIX = 'test_at_';

function redact(str) {
  if (!str) return '';
  return str
    .replace(/kudxaxewnvqurzukrnsm|csdbgcxbavrtdnazctll/g, (m) => m.slice(0, 4) + '...')
    .replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[REDACTED_IP]');
}

async function cleanupTestData() {
  await serviceClient.from('daily_runs').delete().like('device_id', `${TEST_PREFIX}%`);
  await serviceClient.from('devices').delete().like('device_id', `${TEST_PREFIX}%`);
}

/**
 * Independent reference comparator written strictly from the spec text:
 * "each device's single best run across ALL days (order points DESC, total_moves DESC, received_at ASC, id ASC),
 *  then ranked overall with the same ordering;
 *  display_name = CASE WHEN name_hidden THEN generated_name ELSE display_name END;
 *  limit clamped to 1..100 (null -> 100)"
 */
function independentAlltimeBest(allRuns, allDevices, limit = 100) {
  const devBest = new Map();
  for (const r of allRuns) {
    const cur = devBest.get(r.device_id);
    if (!cur) {
      devBest.set(r.device_id, r);
    } else {
      let rBetter = false;
      if (r.points > cur.points) {
        rBetter = true;
      } else if (r.points === cur.points) {
        if (r.total_moves > cur.total_moves) {
          rBetter = true;
        } else if (r.total_moves === cur.total_moves) {
          const timeR = new Date(r.received_at).getTime();
          const timeCur = new Date(cur.received_at).getTime();
          if (timeR < timeCur) {
            rBetter = true;
          } else if (timeR === timeCur) {
            if (r.id < cur.id) rBetter = true;
          }
        }
      }
      if (rBetter) devBest.set(r.device_id, r);
    }
  }

  const bestList = Array.from(devBest.values());
  bestList.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.total_moves !== a.total_moves) return b.total_moves - a.total_moves;
    const timeA = new Date(a.received_at).getTime();
    const timeB = new Date(b.received_at).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.id - b.id;
  });

  const devMap = new Map(allDevices.map(d => [d.device_id, d]));
  const clampedLimit = limit === null || limit === undefined ? 100 : Math.max(1, Math.min(Number(limit), 100));

  return bestList.slice(0, clampedLimit).map((r, idx) => {
    const d = devMap.get(r.device_id);
    const name = d ? (d.name_hidden ? d.generated_name : d.display_name) : 'Unknown';
    return {
      display_name: name,
      points: r.points,
      total_moves: r.total_moves,
      max_tile: r.max_tile,
      rank: idx + 1,
    };
  });
}

async function main() {
  const simulate = process.argv.includes('--simulate-populated');
  await assertDatabaseSafe(serviceClient, false, simulate);

  console.log('================================================================================');
  console.log('LIVE VERIFICATION SUITE: A1 & A2 (ALL-TIME BOARD & RANK RPCs)');
  console.log(`Endpoint:             ${redact(SUPABASE_URL)}`);
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // 1. Initial State: Empty Database & Unknown Device Lookups
    // -------------------------------------------------------------------------
    console.log('[Phase 1] Testing Empty Database & Unknown Device RPCs...');
    await cleanupTestData();

    // Verify empty database -> []
    const emptyRes = await serviceClient.rpc('alltime_best', { p_limit: 100 });
    assert.strictEqual(emptyRes.error, null, `RPC alltime_best on empty table failed: ${emptyRes.error?.message}`);
    assert.deepStrictEqual(emptyRes.data, [], 'Empty database must return []');

    // Unknown device -> []
    const unknownRes = await serviceClient.rpc('my_alltime_rank', { p_device_id: 'unknown_nonexistent_dev_999' });
    assert.strictEqual(unknownRes.error, null, `RPC my_alltime_rank failed: ${unknownRes.error?.message}`);
    assert.deepStrictEqual(unknownRes.data, [], 'Unknown device must return []');

    // Anon role execution (200 OK)
    const anonEmptyRes = await anonClient.rpc('alltime_best', { p_limit: 10 });
    assert.strictEqual(anonEmptyRes.error, null, `Anon execution on alltime_best failed: ${anonEmptyRes.error?.message}`);
    const anonRankRes = await anonClient.rpc('my_alltime_rank', { p_device_id: 'unknown_dev' });
    assert.strictEqual(anonRankRes.error, null, `Anon execution on my_alltime_rank failed: ${anonRankRes.error?.message}`);
    console.log('✔ Phase 1 PASSED: Empty database returns [], unknown device returns [], anon can call both.\n');

    // -------------------------------------------------------------------------
    // 2. Seeding >= 105 Devices over >= 3 Days with Several Attempts Each
    // -------------------------------------------------------------------------
    console.log('[Phase 2] Seeding 106 Devices over 3 Days with multiple attempts and deliberate tie cases...');
    const TOTAL_DEVICES = 106;
    const days = ['2026-11-01', '2026-11-02', '2026-11-03'];

    const devicesToInsert = [];
    for (let i = 1; i <= TOTAL_DEVICES; i++) {
      const devId = `${TEST_PREFIX}dev_${String(i).padStart(3, '0')}`;
      let dispName = `Player ${i}`;
      let genName = `Generated ${i}`;
      let isHidden = false;

      if (i === 1) {
        // Hidden name device: custom name set, but name_hidden is true
        dispName = 'Secret Master 1';
        genName = 'Hidden Lynx 1';
        isHidden = true;
      } else if (i === 2) {
        // Custom name device: custom name set, name_hidden is false
        dispName = 'Golden Tiger 2';
        genName = 'Generated Tiger 2';
        isHidden = false;
      }

      devicesToInsert.push({
        device_id: devId,
        display_name: dispName,
        generated_name: genName,
        name_hidden: isHidden,
        name_norm: dispName.toLowerCase().replace(/[\s_\-]+/g, ''),
        created_at: new Date('2026-11-01T00:00:00Z').toISOString(),
        last_seen_at: new Date('2026-11-03T12:00:00Z').toISOString(),
      });
    }

    const { error: devInsertErr } = await serviceClient.from('devices').insert(devicesToInsert);
    assert.strictEqual(devInsertErr, null, `Failed to seed devices: ${devInsertErr?.message}`);

    // Build runs for each device across the 3 days
    // Specific tie scenarios:
    // Dev 3 and Dev 4: Tie on points (10,000 pts). Dev 3 has 500 moves, Dev 4 has 450 moves -> Dev 3 wins moves tie.
    // Dev 5 and Dev 6: Tie on points (9,000) AND moves (400).
    //   Dev 5 is inserted first (gets LOWER id in DB) with received_at = 14:00 (LATER).
    //   Dev 6 is inserted second (gets HIGHER id in DB) with received_at = 10:00 (EARLIER).
    //   Expected: Dev 6 ranks AHEAD of Dev 5 because received_at ASC takes precedence over id ASC!
    const runsToInsert = [];

    // First insert Dev 5 attempt (lower id in DB, later received_at)
    const dev5Id = `${TEST_PREFIX}dev_005`;
    const dev6Id = `${TEST_PREFIX}dev_006`;

    runsToInsert.push({
      device_id: dev5Id,
      day_utc: '2026-11-02',
      points: 9000,
      total_moves: 400,
      max_tile: 1024,
      seed: 5001,
      replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
      events_hash: `hash_${dev5Id}_tie`,
      received_at: '2026-11-02T14:00:00Z', // LATER
    });

    runsToInsert.push({
      device_id: dev6Id,
      day_utc: '2026-11-02',
      points: 9000,
      total_moves: 400,
      max_tile: 1024,
      seed: 6001,
      replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
      events_hash: `hash_${dev6Id}_tie`,
      received_at: '2026-11-02T10:00:00Z', // EARLIER
    });

    // Populate all devices with multiple attempts across days
    for (let i = 1; i <= TOTAL_DEVICES; i++) {
      const devId = `${TEST_PREFIX}dev_${String(i).padStart(3, '0')}`;
      if (i === 5 || i === 6) continue; // already seeded their tie bests

      // Score descending by index so device rank roughly follows device index
      // Device 1: 50,000 pts
      // Device 2: 45,000 pts
      // Device 3: 10,000 pts (500 moves)
      // Device 4: 10,000 pts (450 moves) - tie on points
      // Device 7..106: descending from 8,500 down to 100
      let bestPoints = Math.max(10, 8500 - (i - 7) * 80);
      let bestMoves = 300;
      if (i === 1) { bestPoints = 50000; bestMoves = 1500; }
      else if (i === 2) { bestPoints = 45000; bestMoves = 1400; }
      else if (i === 3) { bestPoints = 10000; bestMoves = 500; }
      else if (i === 4) { bestPoints = 10000; bestMoves = 450; }

      // Attempt 1 (Day 1 - mediocre attempt)
      runsToInsert.push({
        device_id: devId,
        day_utc: days[0],
        points: Math.floor(bestPoints * 0.4),
        total_moves: Math.floor(bestMoves * 0.5),
        max_tile: 256,
        seed: i * 100 + 1,
        replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
        events_hash: `hash_${devId}_d1`,
        received_at: `${days[0]}T10:00:00Z`,
      });

      // Attempt 2 (Day 2 - personal best attempt)
      runsToInsert.push({
        device_id: devId,
        day_utc: days[1],
        points: bestPoints,
        total_moves: bestMoves,
        max_tile: 2048,
        seed: i * 100 + 2,
        replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
        events_hash: `hash_${devId}_d2`,
        received_at: `${days[1]}T12:00:00Z`,
      });

      // Attempt 3 (Day 3 - good attempt)
      runsToInsert.push({
        device_id: devId,
        day_utc: days[2],
        points: Math.floor(bestPoints * 0.7),
        total_moves: Math.floor(bestMoves * 0.8),
        max_tile: 1024,
        seed: i * 100 + 3,
        replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
        events_hash: `hash_${devId}_d3`,
        received_at: `${days[2]}T15:00:00Z`,
      });
    }

    // Insert runs in chunks of 50
    for (let c = 0; c < runsToInsert.length; c += 50) {
      const chunk = runsToInsert.slice(c, c + 50);
      const { error: runInsertErr } = await serviceClient.from('daily_runs').insert(chunk);
      assert.strictEqual(runInsertErr, null, `Failed to insert runs chunk: ${runInsertErr?.message}`);
    }

    console.log(`✔ Phase 2 PASSED: Seeded ${TOTAL_DEVICES} devices with ${runsToInsert.length} total runs.\n`);

    // Fetch all seeded rows from database to run independent comparator
    const { data: dbDevices } = await serviceClient.from('devices').select('*').like('device_id', `${TEST_PREFIX}%`);
    const { data: dbRuns } = await serviceClient.from('daily_runs').select('*').like('device_id', `${TEST_PREFIX}%`);

    // -------------------------------------------------------------------------
    // 3. Compare alltime_best with Independent Spec Comparator
    // -------------------------------------------------------------------------
    console.log('[Phase 3] Comparing alltime_best RPC output against independent spec comparator...');
    const specExpectedTop100 = independentAlltimeBest(dbRuns, dbDevices, 100);

    const rpcTop100 = await serviceClient.rpc('alltime_best', { p_limit: 100 });
    assert.strictEqual(rpcTop100.error, null, `RPC alltime_best error: ${rpcTop100.error?.message}`);
    assert.strictEqual(rpcTop100.data.length, 100, `Expected exactly 100 rows, got ${rpcTop100.data.length}`);

    // Verify 100% byte/field parity across all 100 rows
    for (let i = 0; i < 100; i++) {
      const actual = rpcTop100.data[i];
      const expected = specExpectedTop100[i];
      assert.deepStrictEqual(
        actual,
        expected,
        `Mismatch at rank #${i + 1}:\nActual:   ${JSON.stringify(actual)}\nExpected: ${JSON.stringify(expected)}`
      );
    }
    console.log('✔ Phase 3 PASSED: All 100 rows match independent spec comparator exactly.\n');

    // -------------------------------------------------------------------------
    // 4. Verification of Specific Invariants (Name Masking & Ties)
    // -------------------------------------------------------------------------
    console.log('[Phase 4] Verifying Name Masking and Tie-Breaker Precedence...');

    // Invariant A: Hidden name masking (Device 1)
    const rank1 = rpcTop100.data[0];
    assert.strictEqual(rank1.rank, 1);
    assert.strictEqual(rank1.display_name, 'Hidden Lynx 1', 'Device 1 (name_hidden=true) must show generated_name');

    // Invariant B: Custom name display (Device 2)
    const rank2 = rpcTop100.data[1];
    assert.strictEqual(rank2.rank, 2);
    assert.strictEqual(rank2.display_name, 'Golden Tiger 2', 'Device 2 (name_hidden=false) must show custom display_name');

    // Invariant C: Points tie broken by moves (Device 3 vs Device 4)
    const rank3 = rpcTop100.data[2];
    const rank4 = rpcTop100.data[3];
    assert.strictEqual(rank3.points, 10000);
    assert.strictEqual(rank4.points, 10000);
    assert.strictEqual(rank3.total_moves, 500);
    assert.strictEqual(rank4.total_moves, 450);
    assert.strictEqual(rank3.display_name, 'Player 3');
    assert.strictEqual(rank4.display_name, 'Player 4');

    // Invariant D: Points + moves tie broken by received_at ASC over id ASC (Dev 6 vs Dev 5)
    const rank5 = rpcTop100.data[4];
    const rank6 = rpcTop100.data[5];
    assert.strictEqual(rank5.points, 9000);
    assert.strictEqual(rank6.points, 9000);
    assert.strictEqual(rank5.total_moves, 400);
    assert.strictEqual(rank6.total_moves, 400);
    assert.strictEqual(rank5.display_name, 'Player 6', 'Dev 6 had earlier received_at (10:00 vs 14:00) and must win');
    assert.strictEqual(rank6.display_name, 'Player 5', 'Dev 5 had lower id but later received_at and must rank second');

    console.log('✔ Phase 4 PASSED: Name masking and tie-breaker precedence verified.\n');

    // -------------------------------------------------------------------------
    // 5. Clamps for p_limit (0, 1000, null, and no argument)
    // -------------------------------------------------------------------------
    console.log('[Phase 5] Testing p_limit server-side clamping (0, 1000, null, no arg)...');

    // p_limit: 0 -> clamped to 1
    const clamp0 = await serviceClient.rpc('alltime_best', { p_limit: 0 });
    assert.strictEqual(clamp0.data.length, 1, `p_limit=0 must return 1 row, got ${clamp0.data.length}`);

    // p_limit: 1000 -> clamped to 100
    const clamp1000 = await serviceClient.rpc('alltime_best', { p_limit: 1000 });
    assert.strictEqual(clamp1000.data.length, 100, `p_limit=1000 must clamp to 100 rows, got ${clamp1000.data.length}`);

    // p_limit: null -> default 100
    const clampNull = await serviceClient.rpc('alltime_best', { p_limit: null });
    assert.strictEqual(clampNull.data.length, 100, `p_limit=null must return 100 rows, got ${clampNull.data.length}`);

    // no argument -> default 100
    const clampNoArg = await serviceClient.rpc('alltime_best');
    assert.strictEqual(clampNoArg.data.length, 100, `No argument must return 100 rows, got ${clampNoArg.data.length}`);

    console.log('✔ Phase 5 PASSED: Limit clamped to 1..100 (real row counts 1, 100, 100, 100 verified).\n');

    // -------------------------------------------------------------------------
    // 6. my_alltime_rank for Device Outside Top 100
    // -------------------------------------------------------------------------
    console.log('[Phase 6] Testing my_alltime_rank for a device outside the top 100...');
    const outsideDevId = `${TEST_PREFIX}dev_105`;
    const outsideRankRes = await serviceClient.rpc('my_alltime_rank', { p_device_id: outsideDevId });
    assert.strictEqual(outsideRankRes.error, null);
    assert.strictEqual(outsideRankRes.data.length, 1, 'Device outside top 100 must still return 1 row');
    const myRank = outsideRankRes.data[0];
    assert(myRank.rank > 100, `Expected rank > 100, got #${myRank.rank}`);
    assert.strictEqual(myRank.total_players, 106, `Expected total_players = 106, got ${myRank.total_players}`);
    console.log(`✔ Phase 6 PASSED: Device outside top 100 resolved to Rank #${myRank.rank} of ${myRank.total_players}.\n`);

    // -------------------------------------------------------------------------
    // 7. Self-Check Failure Mode
    // -------------------------------------------------------------------------
    if (isSelfCheckFail) {
      console.log('\nDeliberately triggering self-check failure under --self-check-fail...');
      assert.strictEqual(1, 999999999, 'Deliberate self-check failure for test_live_alltime.js');
    }

    console.log('================================================================================');
    console.log('ALL LIVE ALL-TIME BOARD INTEGRATION TESTS PASSED CLEANLY.');
    console.log('================================================================================');
  } finally {
    console.log('\n[CLEANUP] Cleaning up test records in finally block...');
    try {
      await cleanupTestData();
      console.log('✔ [CLEANUP] Test records purged successfully.');
    } catch (cleanupErr) {
      console.error('⚠ [CLEANUP WARNING] Failed to purge test records:', cleanupErr.message);
    }
  }
}

main().catch(err => {
  console.error('\n❌ LIVE INTEGRATION TEST FAILED:', err.message);
  process.exit(1);
});
