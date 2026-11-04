// scripts/test_leaderboard_boards.js
// Unit and integration test suite for game/leaderboard.js data-layer functions,
// scripts/lib/ranking.js shared ranking comparator, and mock server RPC endpoints.

import assert from 'node:assert/strict';
import {
  formatPoints,
  rankSummary,
  avatarInitials,
  getMondayUtc,
  fetchBoard,
  fetchMyRank,
  setDisplayName,
} from '../game/leaderboard.js';
import {
  compareAttempts,
  computeDailyBest,
  computeMyDailyRank,
  computeWeeklyBest,
  computeMyWeeklyRank,
  computeAlltimeBest,
  computeMyAlltimeRank,
  clampLimit,
} from './lib/ranking.js';

const isSelfCheckFail = process.argv.includes('--self-check-fail');

async function main() {
  console.log('================================================================================');
  console.log('TEST SUITE: LEADERBOARD DATA LAYER & BOARDS (scripts/test_leaderboard_boards.js)');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  let passed = 0;
  let total = 0;

  function runSync(name, fn) {
    total++;
    try {
      fn();
      passed++;
      console.log(`✔ [PASS] ${name}`);
    } catch (e) {
      console.error(`✖ [FAIL] ${name}:`, e);
      throw e;
    }
  }

  async function runAsync(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`✔ [PASS] ${name}`);
    } catch (e) {
      console.error(`✖ [FAIL] ${name}:`, e);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. formatPoints
  // ---------------------------------------------------------------------------
  runSync('1. formatPoints en-US thousands separators', () => {
    assert.strictEqual(formatPoints(18420), '18,420');
    assert.strictEqual(formatPoints(0), '0');
    assert.strictEqual(formatPoints(999), '999');
    assert.strictEqual(formatPoints(1000), '1,000');
    assert.strictEqual(formatPoints(1000000), '1,000,000');
    assert.strictEqual(formatPoints('1234567'), '1,234,567');
    assert.strictEqual(formatPoints(null), '0');
  });

  // ---------------------------------------------------------------------------
  // 2. rankSummary
  // ---------------------------------------------------------------------------
  runSync('2. rankSummary topLabel and ofLabel calculations', () => {
    // 247 of 18420 -> 'Top 2%'
    const s1 = rankSummary(247, 18420);
    assert.strictEqual(s1.topLabel, 'Top 2%');
    assert.strictEqual(s1.ofLabel, 'of 18,420 players');

    // Total 49 (< 50) -> topLabel must be null
    const s2 = rankSummary(1, 49);
    assert.strictEqual(s2.topLabel, null);
    assert.strictEqual(s2.ofLabel, 'of 49 players');

    // Total 50 (>= 50) -> rank 1 of 50 -> 'Top 2%'
    const s3 = rankSummary(1, 50);
    assert.strictEqual(s3.topLabel, 'Top 2%');
    assert.strictEqual(s3.ofLabel, 'of 50 players');

    // Rank 1 of 10000 -> Top 1% (min 1%)
    const s4 = rankSummary(1, 10000);
    assert.strictEqual(s4.topLabel, 'Top 1%');
    assert.strictEqual(s4.ofLabel, 'of 10,000 players');

    // Rank 100 of 100 -> Top 100%
    const s5 = rankSummary(100, 100);
    assert.strictEqual(s5.topLabel, 'Top 100%');
    assert.strictEqual(s5.ofLabel, 'of 100 players');

    // 0 players -> no error
    const s6 = rankSummary(0, 0);
    assert.strictEqual(s6.topLabel, null);
    assert.strictEqual(s6.ofLabel, 'of 0 players');
  });

  // ---------------------------------------------------------------------------
  // 3. avatarInitials (>= 20 cases)
  // ---------------------------------------------------------------------------
  runSync('3. avatarInitials (>=20 test cases matching spec rules)', () => {
    const cases = [
      { input: 'Silent-Wolf-123', expected: 'SW' },
      { input: 'Madhav', expected: 'MA' },
      { input: 'xX_Sniper_Xx', expected: 'XX' },
      { input: '', expected: '?' },
      { input: '   ', expected: '?' },
      { input: '12345', expected: '?' },
      { input: 'SuperLongNameHere', expected: 'SL' },
      { input: 'alpha_beta', expected: 'AB' },
      { input: 'cool-player', expected: 'CP' },
      { input: 'IronMan', expected: 'IM' },
      { input: 'John Doe', expected: 'JD' },
      { input: 'One', expected: 'ON' },
      { input: 'A', expected: 'A' },
      { input: 'A-B', expected: 'AB' },
      { input: 'Player99', expected: 'PL' },
      { input: 'p99', expected: 'P' },
      { input: 'fast_and_furious', expected: 'FA' },
      { input: 'Super_Nova_2026', expected: 'SN' },
      { input: 'camelCaseToken', expected: 'CC' },
      { input: 'A1B2C3', expected: 'AB' },
      { input: '---', expected: '?' },
      { input: null, expected: '?' },
      { input: undefined, expected: '?' },
      { input: '123_456_789', expected: '?' },
      { input: 'SixteenCharsLong', expected: 'SC' },
      { input: 'Rogue-2048-Player', expected: 'RP' },
    ];

    assert(cases.length >= 20, `Expected at least 20 test cases, got ${cases.length}`);
    for (const c of cases) {
      const res = avatarInitials(c.input);
      assert.strictEqual(
        res,
        c.expected,
        `avatarInitials(${JSON.stringify(c.input)}) expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(res)}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 4. getMondayUtc
  // ---------------------------------------------------------------------------
  runSync('4. getMondayUtc ISO Monday calculation', () => {
    // 2026-11-04 is a Wednesday -> Monday is 2026-11-02
    assert.strictEqual(getMondayUtc('2026-11-04'), '2026-11-02');
    // 2026-11-02 is Monday -> Monday is 2026-11-02
    assert.strictEqual(getMondayUtc('2026-11-02'), '2026-11-02');
    // 2026-11-08 is Sunday -> Monday is 2026-11-02
    assert.strictEqual(getMondayUtc('2026-11-08'), '2026-11-02');
    // 2026-11-09 is next Monday -> Monday is 2026-11-09
    assert.strictEqual(getMondayUtc('2026-11-09'), '2026-11-09');
  });

  // ---------------------------------------------------------------------------
  // 5. Shared ranking comparator (scripts/lib/ranking.js) against expectations
  // ---------------------------------------------------------------------------
  runSync('5. Shared ranking comparator & tie-breaker assertions', () => {
    // Case 1: points DESC
    const r1 = { id: 1, points: 100, total_moves: 50, received_at: '2026-11-04T10:00:00Z' };
    const r2 = { id: 2, points: 200, total_moves: 40, received_at: '2026-11-04T09:00:00Z' };
    assert(compareAttempts(r1, r2) > 0, 'r2 (200 pts) ranks ahead of r1 (100 pts)');

    // Case 2: total_moves DESC (more moves survived wins tie)
    const r3 = { id: 3, points: 200, total_moves: 45, received_at: '2026-11-04T11:00:00Z' };
    assert(compareAttempts(r2, r3) > 0, 'r3 (45 moves) ranks ahead of r2 (40 moves)');

    // Case 3: received_at ASC (earliest submission wins tie)
    const r4 = { id: 4, points: 200, total_moves: 45, received_at: '2026-11-04T08:00:00Z' };
    assert(compareAttempts(r3, r4) > 0, 'r4 (08:00) ranks ahead of r3 (11:00)');

    // Case 4: id ASC (lower id wins tie)
    const r5 = { id: 1, points: 200, total_moves: 45, received_at: '2026-11-04T08:00:00Z' };
    assert(compareAttempts(r4, r5) > 0, 'r5 (id 1) ranks ahead of r4 (id 4)');

    // Clamping limits
    assert.strictEqual(clampLimit(null), 100);
    assert.strictEqual(clampLimit(undefined), 100);
    assert.strictEqual(clampLimit(0), 1);
    assert.strictEqual(clampLimit(-5), 1);
    assert.strictEqual(clampLimit(1000), 100);
    assert.strictEqual(clampLimit(25), 25);
  });

  // ---------------------------------------------------------------------------
  // 6. fetchBoard (today, week, all) with injected fetch
  // ---------------------------------------------------------------------------
  await runAsync('6. fetchBoard tabs, injected fetch, and apikey-only headers', async () => {
    const mockAnonKey = 'anon_public_key_abc123';
    const mockUrl = 'https://mock.supabase.co';

    const capturedCalls = [];
    const mockFetch = async (url, opts) => {
      capturedCalls.push({ url, opts });
      if (url.includes('/daily_best')) {
        return new Response(JSON.stringify([
          { rank: 1, display_name: 'Player 1', points: 500, total_moves: 50, max_tile: 256 },
          { rank: 2, display_name: 'Player 2', points: 400, total_moves: 40, max_tile: 128 },
        ]), { status: 200 });
      }
      if (url.includes('/weekly_best')) {
        return new Response(JSON.stringify([
          { rank: 1, display_name: 'Weekly King', points: 2500, total_moves: 300, max_tile: 2048 },
        ]), { status: 200 });
      }
      if (url.includes('/alltime_best')) {
        return new Response(JSON.stringify([
          { rank: 1, display_name: 'GOAT', points: 99999, total_moves: 5000, max_tile: 4096 },
        ]), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    // Tab 'today'
    const resToday = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'today',
      day: '2026-11-04',
      fetchFn: mockFetch,
    });
    assert.strictEqual(resToday.ok, true);
    assert.strictEqual(resToday.rows.length, 2);
    assert.strictEqual(resToday.rows[0].name, 'Player 1');
    assert.strictEqual(resToday.rows[0].points, 500);

    // Tab 'week'
    const resWeek = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'week',
      day: '2026-11-04',
      fetchFn: mockFetch,
    });
    assert.strictEqual(resWeek.ok, true);
    assert.strictEqual(resWeek.rows.length, 1);
    assert.strictEqual(resWeek.rows[0].name, 'Weekly King');

    // Tab 'all'
    const resAll = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'all',
      fetchFn: mockFetch,
    });
    assert.strictEqual(resAll.ok, true);
    assert.strictEqual(resAll.rows.length, 1);
    assert.strictEqual(resAll.rows[0].name, 'GOAT');

    // Verify all requests used apikey ONLY
    assert.strictEqual(capturedCalls.length, 3);
    for (const call of capturedCalls) {
      assert.strictEqual(call.opts.headers.apikey, mockAnonKey);
      assert.strictEqual(call.opts.headers.Authorization, undefined, 'Must not send Authorization header');
    }
  });

  // ---------------------------------------------------------------------------
  // 7. fetchBoard error classifications (http, network, timeout)
  // ---------------------------------------------------------------------------
  await runAsync('7. fetchBoard error classifications (http, network, timeout)', async () => {
    const mockAnonKey = 'anon_key';
    const mockUrl = 'https://mock.supabase.co';

    // 1. HTTP error (500)
    const httpFailFetch = async () => new Response('Internal error', { status: 500 });
    const resHttp = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      fetchFn: httpFailFetch,
    });
    assert.strictEqual(resHttp.ok, false);
    assert.strictEqual(resHttp.error, 'http');

    // 2. Network error (fetch rejects)
    const netFailFetch = async () => { throw new TypeError('Failed to fetch'); };
    const resNet = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      fetchFn: netFailFetch,
    });
    assert.strictEqual(resNet.ok, false);
    assert.strictEqual(resNet.error, 'network');

    // 3. Timeout error
    const timeoutFetch = async (url, opts) => {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const resTimeout = await fetchBoard({
      url: mockUrl,
      anonKey: mockAnonKey,
      fetchFn: timeoutFetch,
      timeoutMs: 10,
    });
    assert.strictEqual(resTimeout.ok, false);
    assert.strictEqual(resTimeout.error, 'timeout');
  });

  // ---------------------------------------------------------------------------
  // 8. fetchMyRank (today, week, all, empty, errors)
  // ---------------------------------------------------------------------------
  await runAsync('8. fetchMyRank lookups, apikey-only headers, and empty cases', async () => {
    const mockAnonKey = 'anon_key';
    const mockUrl = 'https://mock.supabase.co';

    const capturedCalls = [];
    const mockFetch = async (url, opts) => {
      capturedCalls.push({ url, opts });
      if (url.includes('/my_daily_rank')) {
        return new Response(JSON.stringify([{
          rank: 5,
          display_name: 'Me',
          points: 1200,
          total_moves: 110,
          max_tile: 512,
          total_players: 50,
        }]), { status: 200 });
      }
      if (url.includes('/my_weekly_rank')) {
        return new Response(JSON.stringify([]), { status: 200 }); // not ranked
      }
      if (url.includes('/my_alltime_rank')) {
        return new Response(JSON.stringify([{
          rank: 1,
          display_name: 'Me',
          points: 9000,
          total_moves: 800,
          max_tile: 2048,
          total_players: 500,
        }]), { status: 200 });
      }
      return new Response('Error', { status: 500 });
    };

    // Daily rank
    const myDaily = await fetchMyRank({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'today',
      deviceId: 'dev_123',
      day: '2026-11-04',
      fetchFn: mockFetch,
    });
    assert.strictEqual(myDaily.ok, true);
    assert.strictEqual(myDaily.row.rank, 5);
    assert.strictEqual(myDaily.row.name, 'Me');
    assert.strictEqual(myDaily.totalPlayers, 50);

    // Weekly rank (empty)
    const myWeekly = await fetchMyRank({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'week',
      deviceId: 'dev_123',
      day: '2026-11-04',
      fetchFn: mockFetch,
    });
    assert.strictEqual(myWeekly.ok, true);
    assert.strictEqual(myWeekly.row, null);
    assert.strictEqual(myWeekly.totalPlayers, null);

    // All-time rank
    const myAlltime = await fetchMyRank({
      url: mockUrl,
      anonKey: mockAnonKey,
      tab: 'all',
      deviceId: 'dev_123',
      fetchFn: mockFetch,
    });
    assert.strictEqual(myAlltime.ok, true);
    assert.strictEqual(myAlltime.row.rank, 1);
    assert.strictEqual(myAlltime.totalPlayers, 500);

    // Verify apikey-only headers
    for (const call of capturedCalls) {
      assert.strictEqual(call.opts.headers.apikey, mockAnonKey);
      assert.strictEqual(call.opts.headers.Authorization, undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. setDisplayName mappings & never expose server text
  // ---------------------------------------------------------------------------
  await runAsync('9. setDisplayName status mappings and zero server message leakage', async () => {
    const mockAnonKey = 'anon_key';
    const mockUrl = 'https://mock.supabase.co';

    // 200 Success
    const fetch200 = async () => new Response(JSON.stringify({ ok: true, displayName: 'CoolPlayer' }), { status: 200 });
    const res200 = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'CoolPlayer',
      fetchFn: fetch200,
    });
    assert.strictEqual(res200.ok, true);
    assert.strictEqual(res200.displayName, 'CoolPlayer');

    // 400 NAME_NOT_ALLOWED
    const fetch400NotAllowed = async () => new Response(JSON.stringify({ error: 'NAME_NOT_ALLOWED', message: 'Secret internal rule 12 fired' }), { status: 400 });
    const res400A = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'bad_word',
      fetchFn: fetch400NotAllowed,
    });
    assert.strictEqual(res400A.ok, false);
    assert.strictEqual(res400A.code, 'NAME_NOT_ALLOWED');
    assert.strictEqual('message' in res400A, false, 'Never expose server text');

    // 400 INVALID_NAME_FIELD
    const fetch400Field = async () => new Response(JSON.stringify({ error: 'INVALID_NAME_FIELD', message: 'Field name is required' }), { status: 400 });
    const res400B = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: undefined,
      fetchFn: fetch400Field,
    });
    assert.strictEqual(res400B.ok, false);
    assert.strictEqual(res400B.code, 'INVALID_NAME_FIELD');
    assert.strictEqual('message' in res400B, false, 'Never expose server text');

    // 404 DEVICE_NOT_FOUND
    const fetch404 = async () => new Response(JSON.stringify({ error: 'DEVICE_NOT_FOUND', message: 'Device not found' }), { status: 404 });
    const res404 = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'ValidName',
      fetchFn: fetch404,
    });
    assert.strictEqual(res404.ok, false);
    assert.strictEqual(res404.code, 'DEVICE_NOT_FOUND');
    assert.strictEqual('message' in res404, false, 'Never expose server text');

    // 409 NAME_TAKEN
    const fetch409 = async () => new Response(JSON.stringify({ error: 'NAME_TAKEN', message: 'Taken' }), { status: 409 });
    const res409 = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'TakenName',
      fetchFn: fetch409,
    });
    assert.strictEqual(res409.ok, false);
    assert.strictEqual(res409.code, 'NAME_TAKEN');
    assert.strictEqual('message' in res409, false, 'Never expose server text');

    // 429 RATE_LIMITED
    const fetch429 = async () => new Response(JSON.stringify({ error: 'DEVICE_DAILY_LIMIT_EXCEEDED', message: 'Max 2' }), { status: 429 });
    const res429 = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'NewName',
      fetchFn: fetch429,
    });
    assert.strictEqual(res429.ok, false);
    assert.strictEqual(res429.code, 'RATE_LIMITED');
    assert.strictEqual('message' in res429, false, 'Never expose server text');

    // Network error
    const fetchThrow = async () => { throw new Error('Network crash'); };
    const resThrow = await setDisplayName({
      url: mockUrl,
      anonKey: mockAnonKey,
      deviceId: 'dev_1',
      name: 'NewName',
      fetchFn: fetchThrow,
    });
    assert.strictEqual(resThrow.ok, false);
    assert.strictEqual(resThrow.code, 'NETWORK');
    assert.strictEqual('message' in resThrow, false, 'Never expose server text');
  });

  // ---------------------------------------------------------------------------
  // 10. Self-check fail mode
  // ---------------------------------------------------------------------------
  if (isSelfCheckFail) {
    console.log('\nDeliberately triggering self-check failure under --self-check-fail...');
    assert.strictEqual(1, 999999999, 'Deliberate self-check failure for test_leaderboard_boards.js');
  }

  console.log('\n================================================================================');
  console.log(`ALL ${passed}/${total} LEADERBOARD BOARDS TESTS PASSED CLEANLY.`);
  console.log('================================================================================');
}

main().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err.message);
  process.exit(1);
});

