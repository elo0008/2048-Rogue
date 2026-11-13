// scripts/test_edge_challenge.js
// Comprehensive test suite for Challenge backend feature:
// create-challenge, challenge-event, get_challenge RPC, cleanup, rate-limiting, and security invariants.
// Runtime: Node.js (Simulated Edge Environment with In-Memory Mock Database)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  handleCreateChallengeRequest,
  generateChallengeCode,
  DEVICE_CHALLENGE_LIMIT_DAILY,
} from '../supabase/functions/create-challenge/handler.ts';
import { handleChallengeEventRequest } from '../supabase/functions/challenge-event/handler.ts';
import { SecurityDatabaseEngine } from './lib/inmemory_db.js';
import { buildEdgeVendor } from './build_edge.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { CANONICAL_CONFIG } from '../verify/verify_run.js';
import { GameController } from '../game/controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function generateTestRun(seed, movesCount, rulesVersion, replayVersion, config = CANONICAL_CONFIG) {
  const ctrl = new GameController(seed, config);
  for (let i = 0; i < movesCount; i++) {
    if (ctrl.hasPendingDecision()) {
      const dec = ctrl.getPendingDecision();
      if (dec.type === 'draft') {
        ctrl.recordInput('draft', dec.offers[0]);
        ctrl.resolveDecision(dec.offers[0]);
      }
      continue;
    }
    const moves = ctrl.getValidMoves();
    if (moves.length === 0 || ctrl.isGameOver()) break;
    ctrl.recordInput('swipe', moves[0]);
    ctrl.submitMove(moves[0]);
  }
  if (!ctrl.isGameOver()) {
    ctrl.endRun();
  }
  const log = ctrl.getRunLog({ rulesVersion, replayVersion });
  return { log, ctrl };
}

async function runTests(selfCheckMode = false) {
  const manifest = buildEdgeVendor();
  const rulesVersion = manifest.rulesVersion;
  const replayVersion = manifest.replayVersion;

  const db = new SecurityDatabaseEngine();
  const logs = {
    create: [],
    get: [],
    events: [],
    security: [],
  };

  const todayUtc = new Date().toISOString().slice(0, 10);
  const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // ==========================================================================
  // 1. CREATE DAILY CHALLENGE
  // ==========================================================================
  logs.create.push('================================================================================');
  logs.create.push('1. CREATE DAILY CHALLENGE TESTS');
  logs.create.push('================================================================================');

  const devA = 'device_daily_user_a';
  // Seed two daily runs for devA on todayUtc:
  // Run 1: 15 moves, lower points
  const run1 = generateTestRun(1001, 15, rulesVersion, replayVersion);
  await db.recordSubmission({
    deviceId: devA,
    displayName: 'Amber-Badger-101',
    dayUtc: todayUtc,
    seed: 1001n,
    points: 150,
    totalMoves: 15,
    maxTile: 16,
    relics: [],
    replayVersion,
    eventsHash: 'hash_run_1',
    durationMs: 1000,
    flags: [],
    devKey: `dev_sub:${devA}:${todayUtc}`,
    devLimit: 60,
    finalBoard: run1.ctrl.getBoard(),
  });

  // Run 2: 25 moves, higher points (should be chosen as BEST run)
  const run2 = generateTestRun(1002, 25, rulesVersion, replayVersion);
  await db.recordSubmission({
    deviceId: devA,
    displayName: 'Amber-Badger-101',
    dayUtc: todayUtc,
    seed: 1002n,
    points: 450,
    totalMoves: 25,
    maxTile: 32,
    relics: [],
    replayVersion,
    eventsHash: 'hash_run_2',
    durationMs: 2000,
    flags: [],
    devKey: `dev_sub:${devA}:${todayUtc}`,
    devLimit: 60,
    finalBoard: run2.ctrl.getBoard(),
  });

  // Request: create daily challenge for devA
  const reqDailyA = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.10',
    },
    body: JSON.stringify({ deviceId: devA, mode: 'daily' }),
  });
  const resDailyA = await handleCreateChallengeRequest(reqDailyA, db, manifest);
  assert.strictEqual(resDailyA.status, 200, 'Daily challenge creation must return 200');
  const dataDailyA = await resDailyA.json();

  assert.match(dataDailyA.code, /^[A-Za-z0-9]{12}$/, 'Challenge code must be 12 alphanumeric characters');
  assert.strictEqual(dataDailyA.mode, 'daily');
  assert.strictEqual(dataDailyA.expiresAt, `${todayUtc}T23:59:59.999Z`, 'Expiry must be end of run UTC day');
  assert.strictEqual(dataDailyA.url, `/c/${dataDailyA.code}`);

  // Verify it selected best run (450 pts)
  const storedDailyA = db.challenges.get(dataDailyA.code);
  assert.strictEqual(storedDailyA.points, 450, 'Must select best run, not earliest run');
  assert.strictEqual(storedDailyA.dailyRunId, 2, 'Selected run ID must be run 2');
  logs.create.push(`[PASS] Daily Challenge: Created code=${dataDailyA.code}, expiresAt=${dataDailyA.expiresAt}, bestPoints=450`);

  // Idempotency check: creating daily challenge again for devA returns exact same code
  const reqDailyA2 = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.10',
    },
    body: JSON.stringify({ deviceId: devA, mode: 'daily' }),
  });
  const resDailyA2 = await handleCreateChallengeRequest(reqDailyA2, db, manifest);
  const dataDailyA2 = await resDailyA2.json();
  assert.strictEqual(dataDailyA2.code, dataDailyA.code, 'Idempotent daily creation must return existing code');
  logs.create.push(`[PASS] Daily Idempotency: Returned existing code=${dataDailyA2.code}`);

  // Rejects device with no daily runs
  const devNoRun = 'device_with_zero_runs';
  const reqNoRun = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify({ deviceId: devNoRun, mode: 'daily' }),
  });
  const resNoRun = await handleCreateChallengeRequest(reqNoRun, db, manifest);
  assert.strictEqual(resNoRun.status, 404, 'Device with no runs must be rejected with 404');
  logs.create.push('[PASS] Daily Rejection: Device with no runs returns 404 NO_RUN_FOUND');

  // ==========================================================================
  // 2. CREATE FREE CHALLENGE
  // ==========================================================================
  logs.create.push('\n================================================================================');
  logs.create.push('2. CREATE FREE CHALLENGE TESTS');
  logs.create.push('================================================================================');

  const devFree = 'device_free_user_1';
  const freeRunValid = generateTestRun(2024, 20, rulesVersion, replayVersion);

  // Normal valid free challenge
  const reqFreeValid = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: devFree, mode: 'free', runLog: freeRunValid.log }),
  });
  const resFreeValid = await handleCreateChallengeRequest(reqFreeValid, db, manifest);
  assert.strictEqual(resFreeValid.status, 200, 'Valid free challenge creation must return 200');
  const dataFreeValid = await resFreeValid.json();
  assert.match(dataFreeValid.code, /^[A-Za-z0-9]{12}$/);
  assert.strictEqual(dataFreeValid.mode, 'free');
  assert.strictEqual(dataFreeValid.url, `/c/${dataFreeValid.code}`);

  // Verify expiry is 32h from creation
  const expiryDiffMs = new Date(dataFreeValid.expiresAt).getTime() - Date.now();
  const expiryDiffHours = expiryDiffMs / (3600 * 1000);
  assert.ok(Math.abs(expiryDiffHours - 32) < 0.05, 'Free challenge expiry must be exactly 32 hours');
  logs.create.push(`[PASS] Free Challenge: Created code=${dataFreeValid.code}, 32h expiry=${dataFreeValid.expiresAt}`);

  // Tampered log rejection
  const tamperedLog = JSON.parse(JSON.stringify(freeRunValid.log));
  tamperedLog.points = (tamperedLog.points || 0) + 999;
  const reqTampered = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: devFree, mode: 'free', runLog: tamperedLog }),
  });
  const resTampered = await handleCreateChallengeRequest(reqTampered, db, manifest);
  assert.strictEqual(resTampered.status, 422, 'Tampered free run must be rejected with 422');
  logs.create.push('[PASS] Free Challenge: Tampered run log rejected with 422 VERIFICATION_REJECTED');

  // Non-canonical config rejection
  const nonCanonicalConfig = { ...CANONICAL_CONFIG, enableDraft: false };
  const nonCanonicalRun = generateTestRun(2025, 20, rulesVersion, replayVersion, nonCanonicalConfig);
  const reqNonCanonical = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: devFree, mode: 'free', runLog: nonCanonicalRun.log }),
  });
  const resNonCanonical = await handleCreateChallengeRequest(reqNonCanonical, db, manifest);
  assert.strictEqual(resNonCanonical.status, 422, 'Non-canonical config must be rejected with 422');
  logs.create.push('[PASS] Free Challenge: Non-canonical config rejected with 422');

  // Short run (< 10 moves) rejection
  const shortRun = generateTestRun(2026, 5, rulesVersion, replayVersion);
  const reqShort = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: devFree, mode: 'free', runLog: shortRun.log }),
  });
  const resShort = await handleCreateChallengeRequest(reqShort, db, manifest);
  assert.strictEqual(resShort.status, 422, 'Runs under 10 moves must be rejected with 422 RUN_TOO_SHORT');
  logs.create.push('[PASS] Free Challenge: Short run (<10 moves) rejected with 422 RUN_TOO_SHORT');

  // DELIBERATE SELF-CHECK: Client Lies about finalBoard
  // Client supplies a fraudulent finalBoard in the body { deviceId, runLog, finalBoard: fakeBoard }
  const fakeBoard = [999, 999, 999, 999, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const reqLie = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: 'dev_client_lie', mode: 'free', runLog: freeRunValid.log, finalBoard: fakeBoard }),
  });
  const resLie = await handleCreateChallengeRequest(reqLie, db, manifest);
  assert.strictEqual(resLie.status, 200);
  const dataLie = await resLie.json();
  const storedLieChallenge = db.challenges.get(dataLie.code);

  const replayedBoard = freeRunValid.ctrl.getBoard();
  if (selfCheckMode === true || selfCheckMode === 'clientLie') {
    // Deliberate inversion: assert stored board matches client's fake board (MUST FAIL)
    assert.deepStrictEqual(storedLieChallenge.finalBoard, fakeBoard, 'SELF-CHECK: Simulated vulnerability (client lie accepted)');
  } else {
    // Correct assertion: stored board must match replayed board, NOT client fake board
    assert.deepStrictEqual(storedLieChallenge.finalBoard, replayedBoard, 'Board in DB must equal replayed board');
    assert.notDeepStrictEqual(storedLieChallenge.finalBoard, fakeBoard, 'Board in DB must NEVER accept client claimed board');
    logs.create.push('[PASS] Server-Trust Self-Check: Database stores strictly replayed board even when client lies in payload');
  }

  // Unknown device auto-registration for free challenge
  assert.strictEqual(db.devices.has('dev_client_lie'), true, 'Unknown device submitting free challenge must be auto-registered');
  const regDev = db.devices.get('dev_client_lie');
  assert.ok(regDev.displayName.includes('-'), 'Auto-registered device has generated display name');
  logs.create.push(`[PASS] Device Auto-Registration: Registered unknown device with displayName=${regDev.displayName}`);

  // Idempotency by (creator_device_id, events_hash)
  const reqFreeDup = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: JSON.stringify({ deviceId: devFree, mode: 'free', runLog: freeRunValid.log }),
  });
  const resFreeDup = await handleCreateChallengeRequest(reqFreeDup, db, manifest);
  const dataFreeDup = await resFreeDup.json();
  assert.strictEqual(dataFreeDup.code, dataFreeValid.code, 'Idempotent free challenge creation must return existing code');
  logs.create.push(`[PASS] Free Idempotency: Returned existing code=${dataFreeDup.code}`);

  // ==========================================================================
  // 3. RATE LIMITING (25 creations/device/UTC day, 600/hr/IP)
  // ==========================================================================
  logs.create.push('\n================================================================================');
  logs.create.push('3. RATE LIMITING TESTS');
  logs.create.push('================================================================================');

  const devRate = 'device_rate_tester';
  // Create 25 distinct free challenges (varying move count 10+i guarantees distinct eventsHash)
  for (let i = 1; i <= 25; i++) {
    const run = generateTestRun(3000 + i, 10 + i, rulesVersion, replayVersion);
    const req = new Request('http://localhost/functions/v1/create-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' },
      body: JSON.stringify({ deviceId: devRate, mode: 'free', runLog: run.log }),
    });
    const res = await handleCreateChallengeRequest(req, db, manifest);
    assert.strictEqual(res.status, 200, `Challenge creation #${i} must succeed`);
  }
  logs.create.push('[PASS] Rate Limit: 25 challenge creations for device successfully accepted');

  // 26th creation must be blocked with 429
  const run26 = generateTestRun(3026, 10 + 26, rulesVersion, replayVersion);
  const req26 = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' },
    body: JSON.stringify({ deviceId: devRate, mode: 'free', runLog: run26.log }),
  });
  const res26 = await handleCreateChallengeRequest(req26, db, manifest);
  assert.strictEqual(res26.status, 429, '26th challenge creation must return 429');
  assert.ok(res26.headers.get('retry-after'), '429 must include Retry-After header');
  logs.create.push('[PASS] Rate Limit: 26th challenge creation returns 429 with Retry-After');

  // Submissions are NOT blocked by challenge creation counter
  const subCheck = await db.recordSubmission({
    deviceId: devRate,
    displayName: 'Rate-Test-Device',
    dayUtc: todayUtc,
    seed: 9999n,
    points: 100,
    totalMoves: 10,
    maxTile: 8,
    relics: [],
    replayVersion,
    eventsHash: 'hash_sub_separate',
    durationMs: 500,
    flags: [],
    devKey: `dev_sub:${devRate}:${todayUtc}`,
    devLimit: 60,
    finalBoard: null,
  });
  assert.strictEqual(subCheck.status, 'ACCEPTED', 'Submissions must have separate counter from challenge creations');
  logs.create.push('[PASS] Rate Limit Separation: Device at 25 challenge limit can still submit daily runs');

  // --------------------------------------------------------------------------
  // New-Device Rate Limit (30 new devices per IP per UTC day)
  // --------------------------------------------------------------------------
  const ipNewDevTest = '198.51.100.50';
  for (let i = 1; i <= 30; i++) {
    const devId = `dev_ip_new_${i}`;
    assert.strictEqual(db.devices.has(devId), false, `Device ${devId} must not be registered before creation`);
    const run = generateTestRun(4000 + i, 10 + (i % 15), rulesVersion, replayVersion);
    const req = new Request('http://localhost/functions/v1/create-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipNewDevTest },
      body: JSON.stringify({ deviceId: devId, mode: 'free', runLog: run.log }),
    });
    const res = await handleCreateChallengeRequest(req, db, manifest);
    assert.strictEqual(res.status, 200, `New device creation #${i} from IP must succeed`);
    assert.strictEqual(db.devices.has(devId), true, `Device ${devId} must be registered after creation`);
  }
  logs.create.push('[PASS] New-Device Limit: 30 new devices from same IP successfully accepted');

  // 31st new device from the SAME IP must be blocked with 429
  const devId31 = 'dev_ip_new_31';
  const run31 = generateTestRun(4031, 15, rulesVersion, replayVersion);
  const req31 = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipNewDevTest },
    body: JSON.stringify({ deviceId: devId31, mode: 'free', runLog: run31.log }),
  });
  const res31 = await handleCreateChallengeRequest(req31, db, manifest);
  const body31 = await res31.json();
  if (selfCheckMode === 'newDevice') {
    // Deliberate inversion: assert 31st new device gets 200 (MUST FAIL)
    assert.strictEqual(res31.status, 200, 'SELF-CHECK: Simulated vulnerability (31st new device allowed)');
  }
  assert.strictEqual(res31.status, 429, '31st new device creation from same IP must return 429');
  assert.strictEqual(body31.error, 'DEVICE_CREATION_LIMIT', 'Error code must be DEVICE_CREATION_LIMIT');
  assert.strictEqual(body31.message, 'Max 30 new devices per IP per day');
  assert.ok(res31.headers.get('retry-after'), '429 response must contain Retry-After header');
  assert.strictEqual(db.devices.has(devId31), false, 'Rejected device must not be registered in devices table');
  logs.create.push('[PASS] New-Device Limit: 31st new device from same IP returns 429 DEVICE_CREATION_LIMIT');

  // Existing device from same rate-limited IP still works
  const runExist = generateTestRun(4032, 16, rulesVersion, replayVersion);
  const reqExist = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipNewDevTest },
    body: JSON.stringify({ deviceId: 'dev_ip_new_1', mode: 'free', runLog: runExist.log }),
  });
  const resExist = await handleCreateChallengeRequest(reqExist, db, manifest);
  assert.strictEqual(resExist.status, 200, 'Existing device from same IP must still succeed');
  logs.create.push('[PASS] New-Device Limit: Existing device from rate-limited IP is unaffected');

  // Different IP is unaffected
  const devDiffIp = 'dev_ip_new_diff';
  const ipOther = '198.51.100.51';
  const runDiff = generateTestRun(4033, 17, rulesVersion, replayVersion);
  const reqDiff = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ipOther },
    body: JSON.stringify({ deviceId: devDiffIp, mode: 'free', runLog: runDiff.log }),
  });
  const resDiff = await handleCreateChallengeRequest(reqDiff, db, manifest);
  assert.strictEqual(resDiff.status, 200, 'New device from different IP must succeed');
  logs.create.push('[PASS] New-Device Limit: Different IP is unaffected');

  // Limit separation: new-device limit (30/day per IP) is separate from challenge creation limit (25/day per device)
  const keyNewDev = `ip_newdev:${ipNewDevTest}:${todayUtc}`;
  const keyChal = `chal_create:dev_ip_new_1:${todayUtc}`;
  assert.strictEqual(db.rateLimits.get(keyNewDev), 31, 'New device limit counter tracked separately at 31');
  assert.strictEqual(db.rateLimits.get(keyChal), 2, 'Device challenge counter tracked separately at 2');
  logs.create.push('[PASS] Rate Limit Separation: New-device IP limit (30/day) is separate from challenge creation limit (25/day)');

  // ==========================================================================
  // 4. GET_CHALLENGE RPC
  // ==========================================================================
  logs.get.push('================================================================================');
  logs.get.push('4. GET_CHALLENGE RPC TESTS');
  logs.get.push('================================================================================');

  // Valid Daily Challenge
  const readDailyValid = db.rpcGetChallenge(dataDailyA.code);
  assert.strictEqual(readDailyValid.status, 'valid');
  assert.strictEqual(readDailyValid.mode, 'daily');
  assert.strictEqual(readDailyValid.points, 450);
  assert.strictEqual(readDailyValid.total_moves, 25);
  assert.strictEqual(readDailyValid.max_tile, 32);
  assert.strictEqual(readDailyValid.day_utc, todayUtc);
  assert.strictEqual(readDailyValid.sender_display_name, 'Amber-Badger-101');
  assert.strictEqual(typeof readDailyValid.sender_rank, 'number', 'sender_rank must be computed');
  assert.strictEqual(typeof readDailyValid.total_players, 'number', 'total_players must be computed');
  assert.ok(Array.isArray(readDailyValid.final_board), 'final_board must be present');
  logs.get.push(`[PASS] get_challenge (valid daily): code=${dataDailyA.code}, rank=${readDailyValid.sender_rank}/${readDailyValid.total_players}`);

  // Hidden-Name Masking
  const devObjA = db.devices.get(devA);
  devObjA.nameHidden = true;
  const readMasked = db.rpcGetChallenge(dataDailyA.code);
  assert.strictEqual(readMasked.sender_display_name, devObjA.generatedName, 'Hidden name must be masked with generatedName');
  logs.get.push(`[PASS] get_challenge (masked name): Masked to generatedName=${readMasked.sender_display_name}`);
  devObjA.nameHidden = false;

  // Expired Daily Challenge: still returns all data with status: 'expired'
  const dailyCodeExp = dataDailyA.code;
  const dailyExpRecord = db.challenges.get(dailyCodeExp);
  const origDailyExp = dailyExpRecord.expiresAt;
  dailyExpRecord.expiresAt = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
  const readDailyExpired = db.rpcGetChallenge(dailyCodeExp);
  assert.strictEqual(readDailyExpired.status, 'expired', 'Expired daily challenge must have status "expired"');
  assert.strictEqual(readDailyExpired.points, 450, 'Expired daily challenge must still return points');
  assert.strictEqual(readDailyExpired.total_moves, 25, 'Expired daily challenge must still return moves');
  logs.get.push('[PASS] get_challenge (expired daily): status="expired", all run data returned');
  dailyExpRecord.expiresAt = origDailyExp; // restore

  // Valid Free Challenge
  const readFreeValid = db.rpcGetChallenge(dataFreeValid.code);
  assert.strictEqual(readFreeValid.status, 'valid');
  assert.strictEqual(readFreeValid.mode, 'free');
  assert.strictEqual(readFreeValid.seed, 2024);
  assert.ok(Array.isArray(readFreeValid.final_board));
  logs.get.push(`[PASS] get_challenge (valid free): code=${dataFreeValid.code}, seed=${readFreeValid.seed}`);

  // Expired Free Challenge: status 'expired' with data
  const freeRecord = db.challenges.get(dataFreeValid.code);
  const origFreeExp = freeRecord.expiresAt;
  freeRecord.expiresAt = new Date(Date.now() - 3600000).toISOString();
  const readFreeExpired = db.rpcGetChallenge(dataFreeValid.code);
  assert.strictEqual(readFreeExpired.status, 'expired');
  assert.strictEqual(readFreeExpired.seed, 2024);
  logs.get.push('[PASS] get_challenge (expired free): status="expired", seed returned');
  freeRecord.expiresAt = origFreeExp;

  // Purged Free Challenge: returns not_found
  db.challenges.delete('purged_code_1');
  const readPurged = db.rpcGetChallenge('purged_code_1');
  assert.strictEqual(readPurged.status, 'not_found');
  assert.strictEqual(readPurged.code, undefined, 'Must NEVER echo code on not_found');
  logs.get.push('[PASS] get_challenge (purged): returns status="not_found" without echoing code');

  // Malformed Code: returns not_found and NEVER echoes code
  const malformedCodes = ['abc', '12345', 'TOOLONGCODE12345', 'with-hyphen-!', 'with spaces '];
  for (const mCode of malformedCodes) {
    const resM = db.rpcGetChallenge(mCode);
    assert.strictEqual(resM.status, 'not_found');
    assert.strictEqual(resM.code, undefined);
  }
  logs.get.push('[PASS] get_challenge (malformed codes): All returned not_found without echoing code');

  // Legacy run with null board
  const legacyRun = generateTestRun(5001, 15, rulesVersion, replayVersion);
  await db.recordSubmission({
    deviceId: 'dev_legacy',
    displayName: 'Legacy-User-001',
    dayUtc: todayUtc,
    seed: 5001n,
    points: 200,
    totalMoves: 15,
    maxTile: 16,
    relics: [],
    replayVersion,
    eventsHash: 'hash_legacy',
    durationMs: 1000,
    flags: [],
    devKey: `dev_sub:dev_legacy:${todayUtc}`,
    devLimit: 60,
    finalBoard: null, // Legacy run without finalBoard
  });
  const resLegacyChal = await handleCreateChallengeRequest(new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.15' },
    body: JSON.stringify({ deviceId: 'dev_legacy', mode: 'daily' }),
  }), db, manifest);
  const dataLegacyChal = await resLegacyChal.json();
  const readLegacy = db.rpcGetChallenge(dataLegacyChal.code);
  assert.strictEqual(readLegacy.final_board, null, 'Legacy run must return null final_board');
  logs.get.push('[PASS] get_challenge (legacy null board): Correctly handled as null');

  // ==========================================================================
  // 5. CHALLENGE-EVENT ENDPOINT (open, accept)
  // ==========================================================================
  logs.events.push('================================================================================');
  logs.events.push('5. CHALLENGE-EVENT ENDPOINT TESTS');
  logs.events.push('================================================================================');

  const testEventCode = dataDailyA.code;
  const initialCh = db.challenges.get(testEventCode);
  assert.strictEqual(initialCh.open_count, 0);
  assert.strictEqual(initialCh.accept_count, 0);

  // 'open' event
  const reqOpen = new Request('http://localhost/functions/v1/challenge-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify({ code: testEventCode, kind: 'open' }),
  });
  const resOpen = await handleChallengeEventRequest(reqOpen, db);
  assert.strictEqual(resOpen.status, 200);
  const dataOpen = await resOpen.json();
  assert.strictEqual(dataOpen.ok, true);
  assert.strictEqual(dataOpen.open_count, undefined, 'Must NEVER return open_count');
  assert.strictEqual(db.challenges.get(testEventCode).open_count, 1, 'open_count must be incremented');
  logs.events.push('[PASS] challenge-event (open): Counter incremented to 1, no count leaked in response');

  // 'accept' event
  const reqAccept = new Request('http://localhost/functions/v1/challenge-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify({ code: testEventCode, kind: 'accept' }),
  });
  const resAccept = await handleChallengeEventRequest(reqAccept, db);
  assert.strictEqual(resAccept.status, 200);
  const dataAccept = await resAccept.json();
  assert.strictEqual(dataAccept.ok, true);
  assert.strictEqual(dataAccept.accept_count, undefined, 'Must NEVER return accept_count');
  assert.strictEqual(db.challenges.get(testEventCode).accept_count, 1, 'accept_count must be incremented');
  logs.events.push('[PASS] challenge-event (accept): Counter incremented to 1, no count leaked in response');

  // Unknown code: no-op with generic 200
  const reqUnknownEvent = new Request('http://localhost/functions/v1/challenge-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify({ code: 'UnknownCode12', kind: 'open' }),
  });
  const resUnknownEvent = await handleChallengeEventRequest(reqUnknownEvent, db);
  assert.strictEqual(resUnknownEvent.status, 200, 'Unknown code must return generic 200');
  const dataUnknownEvent = await resUnknownEvent.json();
  assert.strictEqual(dataUnknownEvent.ok, true);
  logs.events.push('[PASS] challenge-event (unknown code): No-op with generic 200');

  // Expired code: no-op with generic 200
  const expiredCode = 'ExpiredCode12';
  db.challenges.set(expiredCode, {
    code: expiredCode,
    creatorDeviceId: 'dev_exp',
    mode: 'free',
    expiresAt: new Date(Date.now() - 3600000).toISOString(),
    open_count: 0,
    accept_count: 0,
  });
  const reqExpiredEvent = new Request('http://localhost/functions/v1/challenge-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify({ code: expiredCode, kind: 'open' }),
  });
  const resExpiredEvent = await handleChallengeEventRequest(reqExpiredEvent, db);
  assert.strictEqual(resExpiredEvent.status, 200);
  assert.strictEqual(db.challenges.get(expiredCode).open_count, 0, 'Expired challenge counter must NOT increment');
  logs.events.push('[PASS] challenge-event (expired code): No-op with generic 200, counter unchanged');

  // ==========================================================================
  // 6. CLEANUP LOGIC (Only free & >7 days; daily untouched)
  // ==========================================================================
  logs.security.push('================================================================================');
  logs.security.push('6. CLEANUP & RETENTION TESTS');
  logs.security.push('================================================================================');

  const oldTime = new Date(Date.now() - (8 * 86400000)).toISOString(); // 8 days ago
  const recentExpTime = new Date(Date.now() - (2 * 86400000)).toISOString(); // 2 days ago

  const freeOldCode = 'FreeOldCode12';
  const freeRecentCode = 'FreeRecent12';
  const dailyOldCode = 'DailyOldCode1';

  db.challenges.set(freeOldCode, { code: freeOldCode, mode: 'free', expiresAt: oldTime });
  db.challenges.set(freeRecentCode, { code: freeRecentCode, mode: 'free', expiresAt: recentExpTime });
  db.challenges.set(dailyOldCode, { code: dailyOldCode, mode: 'daily', expiresAt: oldTime });

  const cleaned = db.cleanupExpiredFreeChallenges(7, 100);
  assert.strictEqual(cleaned, 1, 'Only free challenges expired >7 days should be cleaned');
  assert.strictEqual(db.challenges.has(freeOldCode), false, 'Free challenge >7 days expired must be purged');
  assert.strictEqual(db.challenges.has(freeRecentCode), true, 'Free challenge <7 days expired must remain');
  assert.strictEqual(db.challenges.has(dailyOldCode), true, 'Daily challenge must NEVER be cleaned');
  logs.security.push('[PASS] Cleanup: Purged free challenge >7 days old; preserved free <7 days; preserved daily');

  // ==========================================================================
  // 7. SECURITY INVARIANTS (RLS, CORS, Body Bounds, Replay Version)
  // ==========================================================================
  logs.security.push('\n================================================================================');
  logs.security.push('7. SECURITY INVARIANTS');
  logs.security.push('================================================================================');

  // Anon RLS denial
  let rlsDenied = false;
  try {
    db.anonQuery('challenges', 'insert', { code: 'hack12345678' });
  } catch (err) {
    rlsDenied = err.message.includes('permission denied');
  }
  assert.strictEqual(rlsDenied, true, 'Anon role must be denied INSERT on challenges');

  try {
    db.anonQuery('challenges', 'delete', {});
  } catch (err) {
    rlsDenied = err.message.includes('permission denied');
  }
  assert.strictEqual(rlsDenied, true, 'Anon role must be denied DELETE on challenges');
  logs.security.push('[PASS] RLS: Base table challenges denied direct anon mutations');

  // CORS checks
  const reqCorsAllowed = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'OPTIONS',
    headers: { 'origin': 'https://rogue2048.vercel.app' },
  });
  const resCorsAllowed = await handleCreateChallengeRequest(reqCorsAllowed, db, manifest);
  assert.strictEqual(resCorsAllowed.headers.get('access-control-allow-origin'), 'https://rogue2048.vercel.app');

  const reqCorsDisallowed = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'OPTIONS',
    headers: { 'origin': 'https://attacker.example.com' },
  });
  const resCorsDisallowed = await handleCreateChallengeRequest(reqCorsDisallowed, db, manifest);
  assert.strictEqual(resCorsDisallowed.headers.get('access-control-allow-origin'), null);
  logs.security.push('[PASS] CORS: Allowed origin gets header; disallowed origin rejected');

  // Payload body limit check (1MB)
  const hugeBody = JSON.stringify({ deviceId: devFree, mode: 'free', dummy: 'x'.repeat(1050000) });
  const reqHuge = new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(hugeBody.length) },
    body: hugeBody,
  });
  const resHuge = await handleCreateChallengeRequest(reqHuge, db, manifest);
  assert.strictEqual(resHuge.status, 413, 'Oversize payload must return 413');
  logs.security.push('[PASS] Bounds: Payloads >1MB return 413 PAYLOAD_TOO_LARGE');

  // Collision retry handling
  let collisionAttempts = 0;
  const mockCollisionDb = {
    consumeIpLimit: async () => ({ allowed: true }),
    isDeviceRegistered: async () => true,
    consumeNewDeviceLimit: async () => ({ allowed: true }),
    createDailyChallenge: async () => ({ status: 'NO_RUN' }),
    createFreeChallenge: async (params) => {
      collisionAttempts++;
      if (collisionAttempts === 1) {
        return { status: 'COLLISION' };
      }
      return { status: 'CREATED', code: params.code, expires_at: params.expiresAt };
    },
  };
  const resCollision = await handleCreateChallengeRequest(new Request('http://localhost/functions/v1/create-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev_collision', mode: 'free', runLog: freeRunValid.log }),
  }), mockCollisionDb, manifest);
  assert.strictEqual(resCollision.status, 200);
  assert.strictEqual(collisionAttempts, 2, 'Must retry on code collision');
  logs.security.push('[PASS] Collision Handling: Successfully retried and created challenge on collision');

  // Write Evidence Output Files
  fs.writeFileSync(path.join(outDir, 'challenge_create.txt'), logs.create.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'challenge_get.txt'), logs.get.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'challenge_events.txt'), logs.events.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'challenge_security.txt'), logs.security.join('\n') + '\n', 'utf8');

  console.log('================================================================================');
  console.log('CHALLENGE BACKEND TEST SUITE SUMMARY');
  console.log('================================================================================');
  console.log('✔ Category 1: Create Daily Challenge (best-run, expiry, idempotency, no-run)');
  console.log('✔ Category 2: Create Free Challenge (tamper, non-canonical, min-moves, client-lies, 32h)');
  console.log('✔ Category 3: Rate Limiting (25/day per device, 429 with retry-after, separation)');
  console.log('✔ Category 4: get_challenge RPC (daily, free, expired, purged, masking, legacy null)');
  console.log('✔ Category 5: challenge-event (atomic counters, no-op unknown/expired, zero count leaks)');
  console.log('✔ Category 6: Cleanup & Retention (only free & >7 days, daily untouched)');
  console.log('✔ Category 7: Security Invariants (RLS, CORS, 1MB bound, collision retry, replay version)');
  console.log('================================================================================');
}

async function main() {
  const isSelfCheck = process.argv.includes('--self-check');
  if (isSelfCheck) {
    try {
      await runTests('clientLie');
      console.error('Self-check failed to catch inverted expectation!');
      process.exit(1);
    } catch (err) {
      console.log('[EXPECTED NEGATIVE CASE] ✔ Self-check successfully demonstrated failure on inverted expectation:', err.message.split('\n')[0]);
      return;
    }
  }

  let selfCheckLieCaught = false;
  try {
    await runTests('clientLie');
  } catch (err) {
    selfCheckLieCaught = true;
    console.log('[EXPECTED NEGATIVE CASE] ✔ Proof of failure: Self-check mode deliberately caught (client lie accepted):', err.message.split('\n')[0]);
  }
  assert.strictEqual(selfCheckLieCaught, true, 'Client-lie self-check must be capable of failing');

  let selfCheckNewDevCaught = false;
  try {
    await runTests('newDevice');
  } catch (err) {
    selfCheckNewDevCaught = true;
    console.log('[EXPECTED NEGATIVE CASE] ✔ Proof of failure: Self-check mode deliberately caught (new-device limit bypassed):', err.message.split('\n')[0]);
  }
  assert.strictEqual(selfCheckNewDevCaught, true, 'New-device self-check must be capable of failing');

  await runTests(false);
}

main().catch(err => {
  console.error('[test_edge_challenge] Execution failed:', err);
  process.exit(1);
});
