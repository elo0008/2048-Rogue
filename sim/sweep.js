/**
 * Sweep: E1 baseline and E4 draft over:
 *   stoneIntervalMultiplier in {1, 1.5, 2, 3}
 *   draftThresholds in {current, [8,16,32,...,4096]}
 * Greedy bot only, N=300 each.
 *
 * Reports: median moves, p10, p90, and for E4 also mean drafts per run.
 */

import { createGame, step, DEFAULT_CONFIG } from './engine.js';
import { createBot } from './bots.js';

const N = 300;
const SEED = 42;
const CAP = 5000;
const BOT_NAME = 'greedy';

const STONE_MULTIPLIERS = [1, 1.5, 2, 3];
const THRESHOLD_SETS = {
  current: DEFAULT_CONFIG.draftThresholds,
  extended: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096],
};

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}

function runGame(seed, configOverrides) {
  const botSeed = (seed + 0x7f4a7c15) >>> 0;
  const bot = createBot(BOT_NAME, botSeed);
  const game = createGame(seed, configOverrides);
  while (!game.gameOver && !game.capped) {
    const move = bot.chooseMove(game);
    if (!move) break;
    const res = step(game, move, bot);
    if (!res.valid) break;
  }
  return { moveCount: game.moveCount, draftHistory: game.draftHistory };
}

function buildHazardSchedule(multiplier) {
  return [
    { upToMove: 100, interval: Math.max(3, Math.round(25 * multiplier)) },
    { upToMove: 200, interval: Math.max(3, Math.round(20 * multiplier)) },
    { upToMove: 300, interval: Math.max(3, Math.round(15 * multiplier)) },
    { upToMove: Infinity, interval: Math.max(3, Math.round(10 * multiplier)) },
  ];
}

console.log('=== Sweep: E1 Baseline (greedy, N=' + N + ') ===');
console.log('Stone-interval multiplier only (no draft, current thresholds ignored)\n');
console.log('| Multiplier | Median | P10 | P90 |');
console.log('|---|---|---|---|');

for (const mult of STONE_MULTIPLIERS) {
  const moveCounts = [];
  for (let i = 0; i < N; i++) {
    const seed = (SEED + i * 31) >>> 0;
    const { moveCount } = runGame(seed, {
      moveCap: CAP,
      forcedRelics: [],
      enableDraft: false,
      hazardSchedule: buildHazardSchedule(mult),
    });
    moveCounts.push(moveCount);
  }
  moveCounts.sort((a, b) => a - b);
  const med = Math.round(getPercentile(moveCounts, 50) * 10) / 10;
  const p10 = Math.round(getPercentile(moveCounts, 10) * 10) / 10;
  const p90 = Math.round(getPercentile(moveCounts, 90) * 10) / 10;
  console.log(`| ${mult}x | ${med} | ${p10} | ${p90} |`);
}

console.log('\n=== Sweep: E4 Random Draft (greedy, N=' + N + ') ===');
console.log('Both axes: stone multiplier x threshold set\n');
console.log('| Mult | Thresholds | Median | P10 | P90 | Mean Drafts/run |');
console.log('|---|---|---|---|---|---|');

for (const mult of STONE_MULTIPLIERS) {
  for (const [tLabel, thresholds] of Object.entries(THRESHOLD_SETS)) {
    const moveCounts = [];
    const draftCounts = [];
    for (let i = 0; i < N; i++) {
      const seed = (SEED + i * 31) >>> 0;
      const { moveCount, draftHistory } = runGame(seed, {
        moveCap: CAP,
        draftPolicy: 'random',
        enableDraft: true,
        draftThresholds: thresholds,
        hazardSchedule: buildHazardSchedule(mult),
      });
      moveCounts.push(moveCount);
      draftCounts.push(draftHistory.length);
    }
    moveCounts.sort((a, b) => a - b);
    const med = Math.round(getPercentile(moveCounts, 50) * 10) / 10;
    const p10 = Math.round(getPercentile(moveCounts, 10) * 10) / 10;
    const p90 = Math.round(getPercentile(moveCounts, 90) * 10) / 10;
    const meanDrafts = Math.round((draftCounts.reduce((a, b) => a + b, 0) / N) * 100) / 100;
    console.log(`| ${mult}x | ${tLabel} | ${med} | ${p10} | ${p90} | ${meanDrafts} |`);
  }
}
