import test from 'node:test';
import assert from 'node:assert/strict';
import { getTamperCases } from './tamper_cases.js';
import { verifyRun } from '../verify_run.js';

test('Tamper Tests: all 13 tampered cases must be rejected with stated reason class', async (t) => {
  const { cases, expectedHash, expectedReplayHash, baseFixture } = getTamperCases();

  // Baseline check: untampered fixture passes
  const baseline = verifyRun(baseFixture, {
    expectedRulesVersion: expectedHash,
    expectedReplayVersion: expectedReplayHash,
    mode: 'any',
  });
  assert.equal(baseline.ok, true, `Base fixture must verify as OK: ${baseline.reason}`);
  assert.equal(baseline.status, 'OK');

  for (const tc of cases) {
    await t.test(`Case ${tc.id}: ${tc.name}`, () => {
      const tamperedLog = tc.generate();
      const res = verifyRun(tamperedLog, {
        expectedRulesVersion: expectedHash,
        expectedReplayVersion: expectedReplayHash,
        mode: tc.mode || 'any',
      });

      assert.equal(res.ok, false, `Tampered case '${tc.name}' must not pass (ok must be false)`);
      assert.notEqual(res.status, 'OK', `Tampered case '${tc.name}' must not have status OK`);
      assert.equal(res.status, tc.expectedStatus, `Tampered case '${tc.name}' expected status ${tc.expectedStatus}, got ${res.status}`);
      assert.ok(res.reason && res.reason.length > 0, `Tampered case '${tc.name}' must provide rejection reason`);
      if (tc.expectedReasonSubstring) {
        assert.ok(
          res.reason.includes(tc.expectedReasonSubstring),
          `Tampered case '${tc.name}' expected reason to include '${tc.expectedReasonSubstring}', got '${res.reason}'`
        );
      }
    });
  }
});
