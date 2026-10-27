/**
 * verify/tests/trust.test.js
 *
 * Automated tests for server trust, tamper rejection under daily mode (Z2),
 * server-trust contract extractSubmission (Z3), and replayVersion invariance/sensitivity (Z4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { verifyRun, extractSubmission } from '../verify_run.js';
import { computeRulesVersion, computeReplayVersion } from '../version.js';
import { generateTrustCases, TRUST_DAY_UTC } from './trust_cases.js';

test('Z2: Trust Tamper Tests - All 10 tampered runs replay legally in mode any, but rejected in mode daily', async () => {
  const rootDir = process.cwd();
  const rulesVer = computeRulesVersion(rootDir);
  const replayVer = computeReplayVersion(rootDir);
  const cases = generateTrustCases(rootDir);

  for (const c of cases) {
    // 1. Legal replay check when config/seed are trusted
    const anyRes = verifyRun(c.run, {
      expectedRulesVersion: rulesVer,
      expectedReplayVersion: replayVer,
      mode: 'any',
    });
    assert.equal(
      anyRes.ok,
      true,
      `Case "${c.name}" should replay legally in mode 'any' but failed: ${anyRes.reason}`
    );

    // 2. Daily mode verification
    const dailyRes = verifyRun(c.run, {
      expectedRulesVersion: rulesVer,
      expectedReplayVersion: replayVer,
      mode: 'daily',
      dayUTC: TRUST_DAY_UTC,
    });

    assert.equal(
      dailyRes.status,
      c.expectedStatus,
      `Case "${c.name}" expected status ${c.expectedStatus}, got ${dailyRes.status} (reason: ${dailyRes.reason})`
    );

    if (c.expectedStatus === 'REJECT') {
      assert.equal(dailyRes.ok, false);
      assert.ok(
        dailyRes.reason && dailyRes.reason.includes(c.expectedReasonPrefix),
        `Case "${c.name}" reason "${dailyRes.reason}" should include prefix "${c.expectedReasonPrefix}"`
      );
    } else {
      assert.equal(dailyRes.ok, true);
      assert.equal(dailyRes.reason, null);
    }
  }
});

test('Z3: Server-Trust Contract - extractSubmission returns null on reject, replayed values on ok, and deterministic eventsHash', async () => {
  const rootDir = process.cwd();
  const rulesVer = computeRulesVersion(rootDir);
  const replayVer = computeReplayVersion(rootDir);
  const cases = generateTrustCases(rootDir);
  const validCase = cases.find(c => c.id === 'untouched_default');
  assert.ok(validCase, 'Must have untouched default case');

  const validVerdict = verifyRun(validCase.run, {
    expectedRulesVersion: rulesVer,
    expectedReplayVersion: replayVer,
    mode: 'daily',
    dayUTC: TRUST_DAY_UTC,
  });
  assert.equal(validVerdict.ok, true);

  // 1. Two submissions of the same run produce identical eventsHash
  const sub1 = await extractSubmission(validCase.run, validVerdict);
  const sub2 = await extractSubmission(validCase.run, validVerdict);
  assert.ok(sub1 && sub2);
  assert.equal(typeof sub1.eventsHash, 'string');
  assert.equal(sub1.eventsHash.length, 64);
  assert.equal(sub1.eventsHash, sub2.eventsHash);

  // 2. Inflated claimed points yield replayed points, never claimed points
  const tamperedClaimed = {
    ...validCase.run,
    points: validCase.run.points + 999999,
    score: validCase.run.score + 999999,
  };
  const subInflated = await extractSubmission(tamperedClaimed, validVerdict);
  assert.equal(subInflated.points, validVerdict.replay.points);
  assert.notEqual(subInflated.points, tamperedClaimed.points);

  // 3. Rejected verdict yields null
  const rejectedVerdict = { ok: false, status: 'REJECT', reason: 'Tampered' };
  const subRejected = await extractSubmission(validCase.run, rejectedVerdict);
  assert.equal(subRejected, null);
});

test('Z4: Replay Version - CRLF invariance, 1-byte sensitivity, and version mismatch checks', () => {
  const rootDir = process.cwd();
  const rulesVer = computeRulesVersion(rootDir);
  const replayVer = computeReplayVersion(rootDir);

  // 1. Temp tree checkout invariance and sensitivity
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-ver-test-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'game'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'sim'), { recursive: true });
    fs.copyFileSync('game/controller.js', path.join(tempDir, 'game/controller.js'));
    fs.copyFileSync('sim/engine.js', path.join(tempDir, 'sim/engine.js'));
    fs.copyFileSync('sim/relics.js', path.join(tempDir, 'sim/relics.js'));

    const baseVer = computeReplayVersion(tempDir);
    assert.equal(baseVer, replayVer);

    // CRLF vs LF gives same value
    for (const f of ['game/controller.js', 'sim/engine.js', 'sim/relics.js']) {
      const p = path.join(tempDir, f);
      const text = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      fs.writeFileSync(p, text, 'utf-8');
    }
    const crlfVer = computeReplayVersion(tempDir);
    assert.equal(crlfVer, baseVer, 'CRLF checkout must produce identical replayVersion');

    // 1-byte edit changes version
    const ctrlPath = path.join(tempDir, 'game/controller.js');
    const orig = fs.readFileSync(ctrlPath, 'utf-8');
    fs.writeFileSync(ctrlPath, orig + ' ', 'utf-8');
    const editedVer = computeReplayVersion(tempDir);
    assert.notEqual(editedVer, baseVer, '1-byte edit must alter replayVersion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // 2. Missing replayVersion returns UNVERIFIABLE_LEGACY
  const cases = generateTrustCases(rootDir);
  const validCase = cases.find(c => c.id === 'untouched_default');
  const legacyLog = { ...validCase.run };
  delete legacyLog.replayVersion;
  const legacyRes = verifyRun(legacyLog, { expectedRulesVersion: rulesVer, expectedReplayVersion: replayVer, mode: 'any' });
  assert.equal(legacyRes.status, 'UNVERIFIABLE_LEGACY');

  // 3. Mismatched replayVersion returns REPLAY_VERSION_MISMATCH
  const wrongReplayLog = { ...validCase.run, replayVersion: '0000000000000000000000000000000000000000000000000000000000000000' };
  const wrongReplayRes = verifyRun(wrongReplayLog, { expectedRulesVersion: rulesVer, expectedReplayVersion: replayVer, mode: 'any' });
  assert.equal(wrongReplayRes.status, 'REJECT');
  assert.equal(wrongReplayRes.reason, 'REPLAY_VERSION_MISMATCH');
});
