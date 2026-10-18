/**
 * scripts/measure_performance.js
 *
 * Measures verification performance:
 * - 1000-move run verification time (ms)
 * - >= 2000-move run verification time (ms)
 * - Total verification time over entire corpus (ms)
 *
 * Writes results to scripts/out/performance.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../verify/verify_run.js';
import { computeEngineHash } from '../verify/cli.js';
import { GameController } from '../game/controller.js';
import { createBot, chooseStoneCell } from '../sim/bots.js';
import { RELIC_IDS } from '../sim/relics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const corpusDir = path.join(rootDir, 'scripts', 'out', 'corpus');
const outFile = path.join(rootDir, 'scripts', 'out', 'performance.txt');

function generateNaturalRun(seed) {
  const bot = createBot('corner');
  const ctrl = new GameController(seed, {
    forcedRelics: RELIC_IDS.filter(r => r !== 'anchor_row'),
    shatterMin: 32,
    siphonMin: 16,
    stoneLifetime: 15,
    hazardSchedule: [{ upToMove: Infinity, interval: 35 }],
    moveCap: 5000,
  });

  let loopCount = 0;
  while (!ctrl.isGameOver() && ctrl.state.moveCount < 3000 && loopCount < 15000) {
    loopCount++;
    if (ctrl.hasPendingDecision()) {
      const dec = ctrl.getPendingDecision();
      if (dec.type === 'draft') ctrl.resolveDecision(dec.offers[0]);
      else if (dec.type === 'mason') ctrl.resolveDecision(chooseStoneCell(ctrl.state, dec.candidates));
      continue;
    }
    const dir = bot.chooseMove(ctrl.state);
    if (!dir) {
      const diag = ctrl.getLegalTargets('diagonal_charge');
      if (diag.length > 0 && (ctrl.state.abilities?.diagonal_charge?.charges || 0) > 0) {
        ctrl.useAbility('diagonal_charge', diag[0]);
        continue;
      }
      const erase = ctrl.getLegalTargets('eraser');
      if (erase.length > 0 && (ctrl.state.abilities?.eraser?.charges || 0) > 0) {
        ctrl.useAbility('eraser', erase[0]);
        continue;
      }
      if (ctrl.getRewindUndoLevels() > 0) {
        ctrl.useAbility('rewind', null);
        continue;
      }
      break;
    }
    ctrl.recordInput('swipe', dir);
    ctrl.submitMove(dir);
  }

  return ctrl.getRunLog();
}

function measureVerification(log, hash, warmup = 3, runs = 10) {
  for (let i = 0; i < warmup; i++) {
    verifyRun(log, hash);
  }
  let totalMs = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    verifyRun(log, hash);
    const t1 = performance.now();
    totalMs += (t1 - t0);
  }
  return totalMs / runs;
}

export function runPerformanceMeasurement() {
  const expectedHash = computeEngineHash();

  // 1. 1000-move run (Seed 707 produces 1108 moves in Y3b)
  const run1000Path = path.join(corpusDir, 'run_long_1000.json');
  let run1000;
  run1000 = generateNaturalRun(707);
  fs.writeFileSync(run1000Path, JSON.stringify(run1000, null, 2), 'utf-8');

  // 2. >= 2000-move run (run_long_03.json is Seed 407 with 2301 moves)
  const run2000Path = path.join(corpusDir, 'run_long_03.json');
  const run2000 = JSON.parse(fs.readFileSync(run2000Path, 'utf-8'));

  const ms1000 = measureVerification(run1000, expectedHash);
  const ms2000 = measureVerification(run2000, expectedHash);

  // 3. Total timing over entire corpus
  const corpusFiles = fs.readdirSync(corpusDir).filter(f => f.endsWith('.json') && !f.includes('1000'));
  let totalCorpusMs = 0;
  let totalCorpusEvents = 0;
  let corpusRunsCount = 0;

  for (const f of corpusFiles) {
    const log = JSON.parse(fs.readFileSync(path.join(corpusDir, f), 'utf-8'));
    const t0 = performance.now();
    const res = verifyRun(log, expectedHash);
    const t1 = performance.now();
    totalCorpusMs += (t1 - t0);
    totalCorpusEvents += (log.events ? log.events.length : 0);
    corpusRunsCount++;
  }

  const lines = [
    `=== 2048-ROGUE VERIFIER PERFORMANCE BENCHMARKS ===`,
    `Rules Engine SHA-256 : ${expectedHash}`,
    ``,
    `1000-Move Run Verification:`,
    `  - Moves                  : ${run1000.moveNumberAtDeath ?? run1000.totalMoves}`,
    `  - Events                 : ${run1000.events ? run1000.events.length : 0}`,
    `  - Verification Time      : ${ms1000.toFixed(2)} ms`,
    ``,
    `>= 2000-Move Run Verification (Seed ${run2000.seed}):`,
    `  - Moves                  : ${run2000.moveNumberAtDeath ?? run2000.totalMoves}`,
    `  - Events                 : ${run2000.events ? run2000.events.length : 0}`,
    `  - Verification Time      : ${ms2000.toFixed(2)} ms`,
    ``,
    `Total Timing Over Entire Corpus:`,
    `  - Corpus Runs Evaluated  : ${corpusRunsCount}`,
    `  - Total Events Replayed  : ${totalCorpusEvents}`,
    `  - Total Verification Time: ${totalCorpusMs.toFixed(2)} ms`,
    `  - Average Per-Run Time   : ${(totalCorpusMs / corpusRunsCount).toFixed(2)} ms`,
    `  - Average Per-Event Time : ${(totalCorpusMs / totalCorpusEvents * 1000).toFixed(3)} µs/event`,
  ];

  const output = lines.join('\n') + '\n';
  fs.writeFileSync(outFile, output, 'utf-8');
  return { output, ms1000, ms2000, totalCorpusMs, corpusRunsCount, totalCorpusEvents };
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMain) {
  const { output } = runPerformanceMeasurement();
  console.log(output);
}
