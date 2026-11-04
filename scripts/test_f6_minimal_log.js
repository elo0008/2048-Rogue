import assert from 'node:assert/strict';
import { GameController } from '../game/controller.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { CANONICAL_CONFIG, dailySeed } from '../verify/profile.js';
import { verifyRun, extractSubmission } from '../verify/verify_run.js';
import { buildSubmission, enqueueSubmission, STORAGE_KEY_QUEUE } from '../game/leaderboard.js';

class MockStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

function generateLegalRun(moveTarget, seed, dayUTC, rulesVersion, replayVersion) {
  const ctrl = new GameController(seed, CANONICAL_CONFIG, 'anon_test_dev');
  while (!ctrl.isGameOver() && ctrl.state.moveCount < moveTarget) {
    const validMoves = ctrl.getValidMoves();
    if (validMoves.length === 0) break;
    const dir = validMoves[0];
    ctrl.submitMove(dir);
    ctrl.recordInput('swipe', dir);

    if (ctrl.hasPendingDecision()) {
      const d = ctrl.getPendingDecision();
      if (d.type === 'draft') {
        ctrl.resolveDecision(d.offers[0]);
      } else if (d.type === 'mason') {
        ctrl.resolveDecision(d.candidates[0]);
      }
    }
  }

  if (!ctrl.isGameOver()) {
    ctrl.endRun();
  }

  const log = ctrl.getRunLog({ rulesVersion, replayVersion });
  log.activeMs = ctrl.state.moveCount * 350; // realistic active play duration
  return log;
}

console.log('================================================================================');
console.log('F6 MINIMAL LOG TRUTH & MECHANICAL SUFFICIENCY PROOF');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

const rulesVersion = computeRulesVersion('.');
const replayVersion = computeReplayVersion('.');
const dayUTC = '2026-11-04';
const seed = dailySeed(dayUTC);

// Generate 70-move legal run
const run70 = generateLegalRun(72, seed, dayUTC, rulesVersion, replayVersion);
const min70 = buildSubmission(run70);

// (a) Print Object.keys of full run log, minimal run log, and dropped keys
const fullKeys = Object.keys(run70).sort();
const minKeys = Object.keys(min70).sort();
const droppedKeys = fullKeys.filter(k => !minKeys.includes(k));

console.log(`--- [F6.a] Full Run Log Keys (${fullKeys.length} keys) ---`);
console.log(JSON.stringify(fullKeys, null, 2));

console.log(`\n--- [F6.a] Minimal Run Log (buildSubmission) Keys (${minKeys.length} keys) ---`);
console.log(JSON.stringify(minKeys, null, 2));

console.log(`\n--- [F6.a] Dropped Keys (${droppedKeys.length} keys) ---`);
console.log(JSON.stringify(droppedKeys, null, 2));

// (c) Prove sufficiency mechanically with Proxy
console.log('\n--- [F6.c] Mechanical Sufficiency Proof via Proxy ---');
const readProps = new Set();
const proxyLog = new Proxy(run70, {
  get(target, prop) {
    if (typeof prop === 'string') {
      readProps.add(prop);
    }
    return target[prop];
  },
});

const vFull = verifyRun(proxyLog, {
  mode: 'daily',
  dayUTC,
  expectedRulesVersion: rulesVersion,
  expectedReplayVersion: replayVersion,
});
const subFull = await extractSubmission(proxyLog, vFull);

const sortedReadProps = [...readProps].sort();
console.log(`Properties read by verifyRun & extractSubmission (${sortedReadProps.length} properties):`);
console.log(JSON.stringify(sortedReadProps, null, 2));

// Assert minimal log contains every property read
for (const prop of sortedReadProps) {
  assert(prop in min70, `Minimal log must contain read property "${prop}"`);
}
console.log('✔ Assertion PASSED: Minimal log contains 100% of properties accessed during verification.');

const vMin = verifyRun(min70, {
  mode: 'daily',
  dayUTC,
  expectedRulesVersion: rulesVersion,
  expectedReplayVersion: replayVersion,
});
const subMin = await extractSubmission(min70, vMin);

assert.strictEqual(vFull.status, 'OK', `Full run log must be verified as OK, got ${vFull.status} (${vFull.reason})`);
assert.strictEqual(vMin.status, vFull.status, `Verdict must match: expected ${vFull.status}, got ${vMin.status}`);
assert.strictEqual(subMin.eventsHash, subFull.eventsHash, `EventsHash must match: ${subMin.eventsHash} === ${subFull.eventsHash}`);
console.log(`✔ Assertion PASSED: vMin.status (${vMin.status}) === vFull.status (${vFull.status})`);
console.log(`✔ Assertion PASSED: subMin.eventsHash (${subMin.eventsHash}) === subFull.eventsHash (${subFull.eventsHash})`);

// (d) Assert queue stores the MINIMAL log and compare byte sizes
console.log('\n--- [F6.d] Queue Storage & Payload Byte Sizes ---');
const memStorage = new MockStorage();
enqueueSubmission({ runId: 'run_70_test', day: dayUTC, runLog: run70 }, memStorage);
const rawQueue = memStorage.getItem(STORAGE_KEY_QUEUE);
const queueParsed = JSON.parse(rawQueue);
const storedLog = queueParsed[0].runLog;

const storedKeys = Object.keys(storedLog).sort();
assert.deepStrictEqual(storedKeys, minKeys, 'Stored runLog in localStorage must have exact minimal keys');
for (const dk of droppedKeys) {
  assert.strictEqual(dk in storedLog, false, `Dropped telemetry key "${dk}" must NOT be stored in queue`);
}
console.log('✔ Assertion PASSED: Queue in localStorage stores strictly the minimal run log.');

// Byte size measurement for 70-move run
const fullJson70 = JSON.stringify(run70);
const minJson70 = JSON.stringify(min70);
const fullBytes70 = Buffer.byteLength(fullJson70, 'utf8');
const minBytes70 = Buffer.byteLength(minJson70, 'utf8');
const pct70 = ((1 - minBytes70 / fullBytes70) * 100).toFixed(1);

console.log(`\n70-Move Run Payload Byte Sizes:`);
console.log(`  - Full run log size    : ${fullBytes70.toLocaleString()} bytes`);
console.log(`  - Minimal run log size : ${minBytes70.toLocaleString()} bytes`);
console.log(`  - Reduction            : -${pct70}% (-${(fullBytes70 - minBytes70).toLocaleString()} bytes)`);

// Byte size measurement for 2000-move run
console.log('\nGenerating 2,000-move bot marathon run...');
const run2000 = generateLegalRun(2000, 42, dayUTC, rulesVersion, replayVersion);
const min2000 = buildSubmission(run2000);
const fullJson2000 = JSON.stringify(run2000);
const minJson2000 = JSON.stringify(min2000);
const fullBytes2000 = Buffer.byteLength(fullJson2000, 'utf8');
const minBytes2000 = Buffer.byteLength(minJson2000, 'utf8');
const pct2000 = ((1 - minBytes2000 / fullBytes2000) * 100).toFixed(1);

console.log(`2,000-Move Run Payload Byte Sizes (${run2000.totalMoves} moves):`);
console.log(`  - Full run log size    : ${fullBytes2000.toLocaleString()} bytes`);
console.log(`  - Minimal run log size : ${minBytes2000.toLocaleString()} bytes`);
console.log(`  - Reduction            : -${pct2000}% (-${(fullBytes2000 - minBytes2000).toLocaleString()} bytes)`);

console.log('\n================================================================================');
console.log('ALL F6 MINIMAL LOG TRUTH CHECKS AND SUFFICIENCY ASSERTIONS PASSED.');
console.log('================================================================================');
