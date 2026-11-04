// scripts/test_daily_parity.js
// Parity test between game/daily.js and verify/profile.js over 3,650 days and boundaries

import assert from 'node:assert/strict';
import { dailySeed as gameDailySeed, utcDateString, msUntilNextUtcMidnight, formatCountdown } from '../game/daily.js';
import { dailySeed as verifyDailySeed } from '../verify/profile.js';

const selfCheckFail = process.argv.includes('--self-check-fail');

console.log('================================================================================');
console.log('PARITY TEST: game/daily.js vs verify/profile.js');
console.log(`Self-Check Fail Mode: ${selfCheckFail}`);
console.log(`Timestamp:            ${new Date().toISOString()}`);
console.log('================================================================================\n');

if (selfCheckFail) {
  console.log('[SELF-CHECK-FAIL] Testing deliberately wrong seed expectation...');
  try {
    const wrongExpected = 999999999;
    const actual = gameDailySeed('2026-01-01');
    assert.equal(actual, wrongExpected, 'Deliberate mismatch failure');
  } catch (err) {
    console.log(`✔ SELF-CHECK-FAIL PASSED: Deliberate mismatch caught as expected (${err.message})\n`);
    process.exit(0);
  }
  console.error('✖ SELF-CHECK-FAIL FAILED: Deliberate failure did not throw!');
  process.exit(1);
}

// 1. Test 3,650 consecutive days starting 2026-01-01
console.log('[1/3] Testing dailySeed parity over 3,650 days (2026-01-01 to 2035-12-30)...');
const startDate = new Date(Date.UTC(2026, 0, 1));
let checkedDays = 0;

for (let i = 0; i < 3650; i++) {
  const curDate = new Date(startDate.getTime() + i * 86400000);
  const dateStr = curDate.toISOString().slice(0, 10);
  const gameSeed = gameDailySeed(dateStr);
  const verifySeed = verifyDailySeed(dateStr);
  if (gameSeed !== verifySeed) {
    throw new Error(`Daily seed parity mismatch on ${dateStr}: game=${gameSeed}, verify=${verifySeed}`);
  }
  checkedDays++;
}
console.log(`  ✔ Verified 3,650/3,650 days: 100% exact numerical match.\n`);

// 2. Boundary timestamps testing: 23:59:59.999 UTC vs 00:00:00.000 UTC
console.log('[2/3] Testing UTC midnight boundary timestamps...');
const tBefore = new Date('2026-05-15T23:59:59.999Z');
const tAt = new Date('2026-05-16T00:00:00.000Z');
const tAfter = new Date('2026-05-16T00:00:00.001Z');

assert.equal(utcDateString(tBefore), '2026-05-15', 'Boundary before midnight belongs to 2026-05-15');
assert.equal(utcDateString(tAt), '2026-05-16', 'Boundary at midnight belongs to 2026-05-16');
assert.equal(utcDateString(tAfter), '2026-05-16', 'Boundary after midnight belongs to 2026-05-16');

const msBefore = msUntilNextUtcMidnight(tBefore);
assert.equal(msBefore, 1, 'Exactly 1 ms until midnight from 23:59:59.999Z');

const msAt = msUntilNextUtcMidnight(tAt);
assert.equal(msAt, 86400000, 'Exactly 86,400,000 ms (24h) until next midnight from 00:00:00.000Z');

console.log('  ✔ Boundary date strings and countdown milliseconds verified.\n');

// 3. Countdown formatting tests
console.log('[3/3] Testing formatCountdown outputs...');
assert.equal(formatCountdown(86400000), '24h 0m');
assert.equal(formatCountdown(3600000), '1h 0m');
assert.equal(formatCountdown(3660000), '1h 1m');
assert.equal(formatCountdown(59000), '0h 0m');
assert.equal(formatCountdown(125000), '0h 2m');
console.log('  ✔ formatCountdown formatting verified.\n');

console.log('================================================================================');
console.log('ALL DAILY PARITY & BOUNDARY TESTS PASSED CLEANLY.');
console.log('================================================================================');

