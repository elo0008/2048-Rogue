/**
 * scripts/run_tamper_table.js
 *
 * Runs all 13 tamper test cases against a real fixture and outputs
 * the formatted verdict table to scripts/out/tamper.txt.
 * Imports cases directly from verify/tests/tamper_cases.js so they cannot drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../verify/verify_run.js';
import { getTamperCases } from '../verify/tests/tamper_cases.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');
const outFile = path.join(outDir, 'tamper.txt');

export function runTamperSuite() {
  const { cases, expectedHash, expectedReplayHash, baseFixture } = getTamperCases();

  // Baseline verification
  const baseline = verifyRun(baseFixture, {
    expectedRulesVersion: expectedHash,
    expectedReplayVersion: expectedReplayHash,
    mode: 'any',
  });
  if (!baseline.ok) {
    throw new Error(`Base fixture failed verification: ${baseline.reason}`);
  }

  const results = [];

  for (const tc of cases) {
    const tamperedLog = tc.generate();
    const verdict = verifyRun(tamperedLog, {
      expectedRulesVersion: expectedHash,
      expectedReplayVersion: expectedReplayHash,
      mode: tc.mode || 'any',
    });

    const matchesExpected =
      verdict.status === tc.expectedStatus &&
      verdict.ok === false &&
      (!tc.expectedReasonSubstring || (verdict.reason && verdict.reason.includes(tc.expectedReasonSubstring)));

    results.push({
      id: tc.id,
      name: tc.name,
      expectedStatus: tc.expectedStatus,
      status: verdict.status,
      ok: verdict.ok,
      reason: verdict.reason || '(none)',
      matchesExpected,
      ms: verdict.ms,
    });
  }

  return { baseline, results, expectedHash, expectedReplayHash };
}

function main() {
  console.log('=== Rogue 2048: Running Tamper Verification Suite ===\n');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const { baseline, results, expectedHash, expectedReplayHash } = runTamperSuite();
  console.log(`Rules SHA-256 : ${expectedHash}`);
  console.log(`Replay SHA-256: ${expectedReplayHash}`);
  console.log(`Baseline Check: OK (${baseline.ms} ms, ${baseline.replay.moves} moves, ${baseline.replay.points} points)\n`);

  const lines = [];
  lines.push('=== TAMPER TEST VERDICT TABLE ===');
  lines.push(`Rules Engine SHA-256 : ${expectedHash}`);
  lines.push(`Replay Version SHA-256: ${expectedReplayHash}`);
  lines.push(`Baseline Run          : OK (points=${baseline.replay.points}, moves=${baseline.replay.moves})\n`);

  const colId = 4;
  const colName = 42;
  const colExp = 22;
  const colStatus = 22;
  const colVerdict = 8;
  const colReason = 60;

  const header =
    'ID'.padEnd(colId) + ' | ' +
    'Tamper Scenario'.padEnd(colName) + ' | ' +
    'Expected Status'.padEnd(colExp) + ' | ' +
    'Actual Status'.padEnd(colStatus) + ' | ' +
    'Verdict'.padEnd(colVerdict) + ' | ' +
    'Reason';

  const separator = '-'.repeat(colId + colName + colExp + colStatus + colVerdict + colReason + 15);

  lines.push(header);
  lines.push(separator);

  let allPassed = true;

  for (const r of results) {
    const verdictStr = r.matchesExpected ? 'PASS' : 'FAIL';
    if (!r.matchesExpected) allPassed = false;

    const row =
      String(r.id).padEnd(colId) + ' | ' +
      r.name.padEnd(colName) + ' | ' +
      r.expectedStatus.padEnd(colExp) + ' | ' +
      r.status.padEnd(colStatus) + ' | ' +
      verdictStr.padEnd(colVerdict) + ' | ' +
      r.reason;

    lines.push(row);
  }

  lines.push(separator);
  lines.push(`\nSummary: ${results.filter(r => r.matchesExpected).length}/${results.length} tamper test cases passed as expected.`);

  const outputText = lines.join('\n') + '\n';
  fs.writeFileSync(outFile, outputText, 'utf-8');

  console.log(outputText);
  console.log(`Saved tamper verdicts to ${outFile}`);

  if (!allPassed) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
