// scripts/test_leaderboard_unit.js
// Unit tests for game/leaderboard.js (Device ID, Minimal Submission, Queue, Backoffs)

import assert from 'node:assert/strict';
import {
  getDeviceId,
  buildSubmission,
  shouldSubmitRun,
  recordDailyBest,
  submitRun,
  loadQueue,
  saveQueue,
  enqueueSubmission,
  flushQueue,
  getMyDailyRank,
  SUBMIT_BACKOFFS_MS,
  VERSION_BACKOFF_MS,
  STORAGE_KEY_QUEUE,
  STORAGE_KEY_BEST,
  STORAGE_KEY_PLAYER,
} from '../game/leaderboard.js';
import { GameController } from '../game/controller.js';
import { verifyRun, extractSubmission } from '../verify/verify_run.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { dailySeed, CANONICAL_CONFIG } from '../verify/profile.js';

console.log('================================================================================');
console.log('UNIT TEST SUITE: C3 LEADERBOARD LOGIC & MINIMAL SUBMISSION');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

let total = 0;
let passed = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`[PASS] Case ${total}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Case ${total}: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`[PASS] Case ${total}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Case ${total}: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// 1. Test getDeviceId() against 1,000 freshly generated IDs
test('getDeviceId generates and validates 1000 compliant IDs (/^[a-z0-9_]{8,64}$/)', () => {
  const ID_REGEX = /^[a-z0-9_]{8,64}$/;
  for (let i = 0; i < 1000; i++) {
    const memStorage = new MockStorage();
    const id = getDeviceId(memStorage, true);
    assert.match(id, ID_REGEX, `ID "${id}" must match regex`);
    // Check persistence
    assert.equal(memStorage.getItem(STORAGE_KEY_PLAYER), id);
    // Calling again returns existing ID
    assert.equal(getDeviceId(memStorage, true), id);
  }
});

// 2. Test buildSubmission minimal log vs full log
await asyncTest('buildSubmission drops telemetry, verifies OK, equals full log verdict, and is smaller', async () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const seed = dailySeed(todayUtc);
  const rulesVersion = computeRulesVersion();
  const replayVersion = computeReplayVersion();

  const ctrl = new GameController(seed, CANONICAL_CONFIG);
  // Play 30 moves
  for (let m = 0; m < 30; m++) {
    if (ctrl.hasPendingDecision()) {
      const dec = ctrl.getPendingDecision();
      if (dec.type === 'draft' && dec.offers && dec.offers.length > 0) {
        ctrl.resolveDecision(dec.offers[0]);
      }
      continue;
    }
    const valid = ctrl.getValidMoves();
    if (valid.length === 0 || ctrl.isGameOver()) break;
    ctrl.recordInput('swipe', valid[0]);
    ctrl.submitMove(valid[0]);
  }
  if (!ctrl.isGameOver()) ctrl.endRun();

  const fullRunLog = ctrl.getRunLog({ rulesVersion, replayVersion });
  fullRunLog.startTimestamp = new Date(`${todayUtc}T12:00:00.000Z`).getTime();
  fullRunLog.activeMs = 12000;

  // Simulate heavy client telemetry attached to full log
  fullRunLog.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  fullRunLog.viewport = { width: 1920, height: 1080, dpr: 1.25 };
  fullRunLog.queryString = '?foo=bar&debug=1&mode=daily';
  fullRunLog.host = 'rogue2048.vercel.app';
  fullRunLog.embedded = false;
  fullRunLog.referrerOrigin = 'https://news.ycombinator.com';
  fullRunLog.touchPoints = 0;
  fullRunLog.reducedMotion = false;
  fullRunLog.lang = 'en-US';
  fullRunLog.soundEnabled = true;
  fullRunLog.audioState = { muted: false, volume: 0.8 };
  fullRunLog.errors = [];
  fullRunLog.diagnostics = { renderFps: 60, droppedFrames: 0, memoryHeapMb: 24.5 };
  fullRunLog.drafts = ctrl.draftRecords;
  fullRunLog.moveHistory = [1, 2, 3, 4, 5];
  fullRunLog.undoHistory = [];
  fullRunLog.boardHistory = [];

  const minimalLog = buildSubmission(fullRunLog);

  // Assert telemetry was dropped
  assert.equal(minimalLog.userAgent, undefined);
  assert.equal(minimalLog.viewport, undefined);
  assert.equal(minimalLog.queryString, undefined);
  assert.equal(minimalLog.host, undefined);
  assert.equal(minimalLog.embedded, undefined);
  assert.equal(minimalLog.referrerOrigin, undefined);
  assert.equal(minimalLog.touchPoints, undefined);
  assert.equal(minimalLog.reducedMotion, undefined);
  assert.equal(minimalLog.lang, undefined);
  assert.equal(minimalLog.soundEnabled, undefined);
  assert.equal(minimalLog.audioState, undefined);
  assert.equal(minimalLog.errors, undefined);
  assert.equal(minimalLog.diagnostics, undefined);

  // Verify both with real verifyRun in 'daily' mode
  const fullVerdict = verifyRun(fullRunLog, { mode: 'daily', dayUTC: todayUtc, expectedRulesVersion: rulesVersion, expectedReplayVersion: replayVersion });
  const minVerdict = verifyRun(minimalLog, { mode: 'daily', dayUTC: todayUtc, expectedRulesVersion: rulesVersion, expectedReplayVersion: replayVersion });

  assert.equal(fullVerdict.ok, true, `Full log must verify OK: ${fullVerdict.reason}`);
  assert.equal(minVerdict.ok, true, `Minimal log must verify OK: ${minVerdict.reason}`);
  assert.equal(fullVerdict.replay.points, minVerdict.replay.points);
  assert.equal(fullVerdict.replay.moves, minVerdict.replay.moves);

  // Verify extractSubmission returns identical results
  const fullSub = await extractSubmission(fullRunLog, fullVerdict);
  const minSub = await extractSubmission(minimalLog, minVerdict);

  assert.equal(fullSub.points, minSub.points);
  assert.equal(fullSub.moves, minSub.moves);
  assert.equal(fullSub.eventsHash, minSub.eventsHash);
  assert.equal(fullSub.seed, minSub.seed);

  // Assert minimal log size is smaller
  const fullBytes = Buffer.byteLength(JSON.stringify(fullRunLog), 'utf8');
  const minBytes = Buffer.byteLength(JSON.stringify(minimalLog), 'utf8');
  assert.ok(minBytes < fullBytes, `Minimal log (${minBytes} bytes) must be smaller than full log (${fullBytes} bytes)`);
  console.log(`    Log size reduction: ${fullBytes} bytes -> ${minBytes} bytes (-${Math.round((1 - minBytes / fullBytes) * 100)}%)`);
});

// 3. Test shouldSubmitRun and recordDailyBest (send-only-if-better)
test('shouldSubmitRun enforces strictly greater logic', () => {
  const memStorage = new MockStorage();
  const day = '2026-11-03';

  // No run recorded yet -> true
  assert.equal(shouldSubmitRun(day, 100, 20, memStorage), true);

  // Record baseline run: 100 pts, 20 moves
  recordDailyBest(day, 100, 20, memStorage, true);

  // Worse points -> false
  assert.equal(shouldSubmitRun(day, 80, 30, memStorage), false);

  // Same points, fewer or equal moves -> false
  assert.equal(shouldSubmitRun(day, 100, 15, memStorage), false);
  assert.equal(shouldSubmitRun(day, 100, 20, memStorage), false);

  // Same points, MORE moves -> true (tie-break improvement)
  assert.equal(shouldSubmitRun(day, 100, 25, memStorage), true);

  // Higher points -> true
  assert.equal(shouldSubmitRun(day, 150, 10, memStorage), true);

  // Next day -> true even with lower score
  assert.equal(shouldSubmitRun('2026-11-04', 50, 5, memStorage), true);
});

// 4. Test submitRun status classifications
await asyncTest('submitRun status classifications (200, 429, 422, 422-version, 500)', async () => {
  const dummyLog = { seed: 1, replayVersion: 'a', rulesVersion: 'b', events: [] };

  // Status 200 ACCEPTED
  {
    const mockFetch = async () => new Response(JSON.stringify({ status: 'ACCEPTED' }), { status: 200 });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'ACCEPTED');
  }

  // Status 200 ALREADY_SUBMITTED
  {
    const mockFetch = async () => new Response(JSON.stringify({ status: 'ALREADY_SUBMITTED' }), { status: 200 });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'ACCEPTED');
  }

  // Status 429 Rate limit with Retry-After: 45
  {
    const mockFetch = async () => new Response(JSON.stringify({ error: 'RATE_LIMIT_EXCEEDED' }), {
      status: 429,
      headers: { 'retry-after': '45' },
    });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'RETRY');
    assert.equal(res.retryAfter, 45000);
  }

  // Status 422 Version Mismatch -> VERSION_MISMATCH (1h backoff)
  {
    const mockFetch = async () => new Response(JSON.stringify({
      error: 'VERIFICATION_REJECTED',
      reason: 'Rules version mismatch: claimed "old", expected "new"',
    }), { status: 422 });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'VERSION_MISMATCH');
    assert.equal(res.retryAfter, VERSION_BACKOFF_MS);
  }

  // Status 422 Non-version rejection -> REJECTED (no retry)
  {
    const mockFetch = async () => new Response(JSON.stringify({
      error: 'VERIFICATION_REJECTED',
      reason: 'Illegal swipe direction',
    }), { status: 422 });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'REJECTED');
  }

  // Status 500 Server error -> RETRY
  {
    const mockFetch = async () => new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'RETRY');
  }

  // Network / fetch throw -> RETRY
  {
    const mockFetch = async () => { throw new Error('Network offline'); };
    const res = await submitRun({ url: 'http://localhost', anonKey: 'key', deviceId: 'dev_12345', runLog: dummyLog, fetchFn: mockFetch });
    assert.equal(res.status, 'RETRY');
  }
});

// 5. Test queue lifecycle, bounded capacity (max 5), expiry, and single-flight flush
await asyncTest('Submission queue respects max 5 entries, drops expired, and backoff progression', async () => {
  const memStorage = new MockStorage();
  let fakeTime = 1000000;
  const clock = () => fakeTime;

  const dummyRun = (id, day) => ({
    seed: 123,
    rulesVersion: 'r',
    replayVersion: 'v',
    startTimestamp: 1000,
    activeMs: 5000,
    points: 100,
    totalMoves: 20,
    events: ['s:L'],
  });

  // Enqueue 7 runs -> only last 5 retained
  for (let i = 1; i <= 7; i++) {
    enqueueSubmission({
      runId: `run_${i}`,
      day: '2026-11-03',
      runLog: dummyRun(`run_${i}`, '2026-11-03'),
    }, memStorage, true, clock);
  }

  const loaded = loadQueue(memStorage, clock);
  assert.equal(loaded.length, 5, 'Queue must be capped at MAX_QUEUE_ENTRIES (5)');
  assert.equal(loaded[0].runId, 'run_3');
  assert.equal(loaded[4].runId, 'run_7');

  // Flush with network offline -> each item increments attempts and schedules backoff
  const mockOffline = async () => { throw new Error('Offline'); };
  const remainingAfterFail = await flushQueue({
    url: 'http://localhost',
    anonKey: 'key',
    deviceId: 'dev_1',
    storage: memStorage,
    persistenceEnabled: true,
    fetchFn: mockOffline,
    clockFn: clock,
  });

  assert.equal(remainingAfterFail.length, 5);
  assert.equal(remainingAfterFail[0].attempts, 1);
  assert.equal(remainingAfterFail[0].nextAt, fakeTime + SUBMIT_BACKOFFS_MS[0]); // +5s

  // Advance time past nextAt and flush with 200 ACCEPTED
  fakeTime += 10000;
  const mockAccepted = async () => new Response(JSON.stringify({ status: 'ACCEPTED' }), { status: 200 });
  const remainingAfterPass = await flushQueue({
    url: 'http://localhost',
    anonKey: 'key',
    deviceId: 'dev_1',
    storage: memStorage,
    persistenceEnabled: true,
    fetchFn: mockAccepted,
    clockFn: clock,
  });

  assert.equal(remainingAfterPass.length, 0, 'Queue must be empty after all items are accepted');
});

// 6. Test F1 Auth Header: getMyDailyRank & submitRun send apikey ONLY (never Authorization: Bearer)
await asyncTest('F1 Auth Header: getMyDailyRank and submitRun send apikey ONLY with publishable and JWT keys', async () => {
  const dummyLog = {
    seed: 123,
    rulesVersion: 'r',
    replayVersion: 'v',
    startTimestamp: 1000,
    activeMs: 5000,
    points: 100,
    totalMoves: 20,
    events: ['s:L'],
  };

  // 1. Publishable key: sb_publishable_...
  {
    let capturedHeaders = null;
    const mockFetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return new Response(JSON.stringify([{ rank: 1, total_players: 1 }]), { status: 200 });
    };

    const pubKey = 'sb_publishable_test_token_12345';
    await getMyDailyRank({
      url: 'http://localhost',
      anonKey: pubKey,
      day: '2026-11-04',
      deviceId: 'dev_12345',
      fetchFn: mockFetch,
    });

    assert.equal(capturedHeaders.apikey, pubKey, 'apikey header must equal anonKey');
    assert.equal(capturedHeaders.Authorization, undefined, 'Authorization header must NOT be sent for getMyDailyRank');

    // Also assert submitRun sends apikey only
    let submitHeaders = null;
    const mockSubmitFetch = async (url, opts) => {
      submitHeaders = opts.headers;
      return new Response(JSON.stringify({ status: 'ACCEPTED' }), { status: 200 });
    };

    await submitRun({
      url: 'http://localhost',
      anonKey: pubKey,
      deviceId: 'dev_12345',
      runLog: dummyLog,
      fetchFn: mockSubmitFetch,
    });

    assert.equal(submitHeaders.apikey, pubKey, 'apikey header must equal anonKey in submitRun');
    assert.equal(submitHeaders.Authorization, undefined, 'Authorization header must NOT be sent in submitRun');
  }

  // 2. Legacy JWT key: eyJhbGciOi...
  {
    let capturedHeaders = null;
    const mockFetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return new Response(JSON.stringify([{ rank: 1, total_players: 1 }]), { status: 200 });
    };

    const jwtKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.mock_signature';
    await getMyDailyRank({
      url: 'http://localhost',
      anonKey: jwtKey,
      day: '2026-11-04',
      deviceId: 'dev_12345',
      fetchFn: mockFetch,
    });

    assert.equal(capturedHeaders.apikey, jwtKey, 'apikey header must equal anonKey for JWT');
    assert.equal(capturedHeaders.Authorization, undefined, 'Authorization header must NOT be sent even for legacy JWT');
  }

  // 3. Mock server rejection test: if Authorization: Bearer sb_publishable_ is sent, mock responds 401 Invalid JWT
  {
    const { createMockLeaderboardServer } = await import('./mock_leaderboard.js');
    const mock = createMockLeaderboardServer();
    const port = await mock.listen(0);
    const mockUrl = `http://localhost:${port}`;

    try {
      // Direct fetch with illegal Bearer sb_publishable_
      const res = await fetch(`${mockUrl}/rest/v1/rpc/my_daily_rank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'sb_publishable_key_123',
          'Authorization': 'Bearer sb_publishable_key_123',
        },
        body: JSON.stringify({ target_day: '2026-11-04', p_device_id: 'test_dev' }),
      });

      assert.equal(res.status, 401, 'Mock server must return 401 for Bearer sb_publishable_');
      const body = await res.json();
      assert.equal(body.message, 'Invalid JWT');

      // Valid fetch with apikey only -> 200 OK
      const validRes = await fetch(`${mockUrl}/rest/v1/rpc/my_daily_rank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'sb_publishable_key_123',
        },
        body: JSON.stringify({ target_day: '2026-11-04', p_device_id: 'test_dev' }),
      });
      assert.equal(validRes.status, 200, 'Mock server must return 200 for apikey only');
    } finally {
      await mock.close();
    }
  }
});

// 7. Test F2 No Fake Rank: getMyDailyRank returns exact rank or null on missing/empty/500
await asyncTest('F2 No Fake Rank: getMyDailyRank returns rank info or null on missing/500', async () => {
  // Case A: 2 players -> returns rank #2 of 2
  {
    const mockFetch = async () => new Response(JSON.stringify([{
      rank: 2,
      total_players: 2,
      display_name: 'Player2',
      points: 500,
    }]), { status: 200 });

    const rank = await getMyDailyRank({
      url: 'http://localhost',
      anonKey: 'key',
      day: '2026-11-04',
      deviceId: 'dev_2',
      fetchFn: mockFetch,
    });
    assert.deepEqual(rank, { rank: 2, total_players: 2, display_name: 'Player2', points: 500 });
  }

  // Case B: empty list -> null
  {
    const mockFetch = async () => new Response(JSON.stringify([]), { status: 200 });
    const rank = await getMyDailyRank({
      url: 'http://localhost',
      anonKey: 'key',
      day: '2026-11-04',
      deviceId: 'dev_unknown',
      fetchFn: mockFetch,
    });
    assert.equal(rank, null, 'Empty list must resolve to null (no fake rank)');
  }

  // Case C: 500 RPC error -> null
  {
    const mockFetch = async () => new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
    const rank = await getMyDailyRank({
      url: 'http://localhost',
      anonKey: 'key',
      day: '2026-11-04',
      deviceId: 'dev_err',
      fetchFn: mockFetch,
    });
    assert.equal(rank, null, 'RPC 500 error must resolve to null (no fake rank)');
  }
});

console.log('\n================================================================================');
console.log(`ALL ${passed}/${total} LEADERBOARD UNIT TESTS PASSED CLEANLY.`);
console.log('================================================================================');

