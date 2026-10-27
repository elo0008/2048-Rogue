/**
 * scripts/measure_performance.js
 *
 * Measures verification performance over the verified corpus:
 * - 1000-move run verification time (ms) from corpus table
 * - >= 2000-move run verification time (ms) from corpus table
 * - Total verification time over entire corpus (ms)
 *
 * Single timing method: verifyRun(runLog) measured via performance.now().
 * Writes results to scripts/out/performance.txt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../verify/verify_run.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { formatRunRow } from '../verify/cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const corpusDir = path.join(rootDir, 'scripts', 'out', 'corpus');
const perfFile = path.join(rootDir, 'scripts', 'out', 'performance.txt');
const corpusFile = path.join(rootDir, 'scripts', 'out', 'verify_corpus.txt');

export function runPerformanceMeasurement() {
  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);

  const files = fs.readdirSync(corpusDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No corpus files found in ${corpusDir}. Run scripts/make_corpus.js first.`);
  }

  let totalEvents = 0;
  let totalMs = 0;
  let slowest = { filename: '', ms: -1, events: 0 };
  let run1000Info = null;
  let run2000Info = null;
  const rows = [];
  let allPassed = true;

  for (const f of files) {
    const raw = fs.readFileSync(path.join(corpusDir, f), 'utf-8');
    const log = JSON.parse(raw);

    const v = verifyRun(log, { expectedRulesVersion: rulesVersion, expectedReplayVersion: replayVersion, mode: 'any' });
    if (!v.ok) {
      allPassed = false;
      throw new Error(`Corpus file ${f} failed verification: ${v.reason}`);
    }

    totalEvents += log.events.length;
    totalMs += v.ms;

    if (v.ms > slowest.ms) {
      slowest = { filename: f, ms: v.ms, events: log.events.length };
    }

    if (f === 'run_canonical_1000_01.json') {
      run1000Info = { filename: f, seed: log.seed, moves: log.moveNumberAtDeath, ms: v.ms };
    }
    if (f === 'run_long_03.json') {
      run2000Info = { filename: f, seed: log.seed, moves: log.moveNumberAtDeath, ms: v.ms };
    }

    rows.push({
      seed: log.seed,
      eventsCount: log.events.length,
      moves: log.moveNumberAtDeath,
      claimedPoints: log.points,
      replayedPoints: v.replay?.points ?? 0,
      status: v.status,
      ms: v.ms,
      filename: f,
    });
  }

  // 1. Write scripts/out/verify_corpus.txt
  const corpusLines = [
    `=== 2048-ROGUE RUN VERIFICATION CORPUS ===`,
    `Rules Engine SHA-256   : ${rulesVersion}`,
    `Replay Version SHA-256 : ${replayVersion}`,
    `Total Runs Evaluated   : ${files.length}`,
    ``,
    `${'Seed'.padStart(10)} | ${'Events'.padStart(7)} | ${'Moves'.padStart(6)} | ${'Claimed Points'.padStart(14)} | ${'Replayed Points'.padStart(15)} | ${'Status'.padEnd(20)} | ${'Time (ms)'.padStart(8)}`,
    `${'-'.repeat(10)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(14)}-+-${'-'.repeat(15)}-+-${'-'.repeat(20)}-+-${'-'.repeat(8)}`,
  ];

  for (const r of rows) {
    corpusLines.push(formatRunRow(r, r.filename));
  }

  corpusLines.push(
    `${'-'.repeat(10)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(14)}-+-${'-'.repeat(15)}-+-${'-'.repeat(20)}-+-${'-'.repeat(8)}`,
    `Total Events Replayed : ${totalEvents}`,
    `Total Verification Ms : ${totalMs.toFixed(2)} ms`,
    `Slowest Run           : ${slowest.filename} (${slowest.events} events in ${slowest.ms.toFixed(2)} ms)`,
    `Pass Rate             : ${files.length}/${files.length} (ALL PASSED)`
  );

  const corpusOutput = corpusLines.join('\n') + '\n';
  fs.writeFileSync(corpusFile, corpusOutput, 'utf-8');

  // 2. Write scripts/out/performance.txt
  const perfLines = [
    `=== 2048-ROGUE VERIFICATION PERFORMANCE BENCHMARK ===`,
    `Rules Engine SHA-256   : ${rulesVersion}`,
    `Replay Version SHA-256 : ${replayVersion}`,
    `Timing Method          : Pure single-pass re-simulation via verifyRun(runLog) measured with performance.now()`,
    ``,
    `1. 1000-Move Run Verification Time:`,
    `   File           : ${run1000Info.filename}`,
    `   Seed           : ${run1000Info.seed}`,
    `   Moves          : ${run1000Info.moves}`,
    `   Verification ms: ${run1000Info.ms.toFixed(2)} ms`,
    ``,
    `2. >= 2000-Move Run Verification Time:`,
    `   File           : ${run2000Info.filename}`,
    `   Seed           : ${run2000Info.seed}`,
    `   Moves          : ${run2000Info.moves}`,
    `   Verification ms: ${run2000Info.ms.toFixed(2)} ms`,
    ``,
    `3. Total Heap-Independent Timing Over Entire Corpus:`,
    `   Total Runs Evaluated : ${files.length}`,
    `   Total Events Replayed: ${totalEvents}`,
    `   Total Verification ms: ${totalMs.toFixed(2)} ms`,
    `   Average Time per Run : ${(totalMs / files.length).toFixed(2)} ms`,
    `   Average Time per Evt : ${(totalMs / totalEvents * 1000).toFixed(2)} µs`,
  ];

  const perfText = perfLines.join('\n') + '\n';
  fs.writeFileSync(perfFile, perfText, 'utf-8');

  console.log(`✔ Verified ${files.length} runs in ${totalMs.toFixed(2)} ms (all passed)`);
  console.log(`✔ Written ${corpusFile}`);
  console.log(`✔ Written ${perfFile}`);

  return { run1000Info, run2000Info, totalEvents, totalMs, runCount: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPerformanceMeasurement();
}

