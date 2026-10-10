import { createGame, step } from './engine.js';
import { createBot } from './bots.js';

const N = 200;
const SEED = 42;
const MULTIPLIERS = [1, 2, 3, 4];

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}

function buildHazardSchedule(multiplier) {
  return [
    { upToMove: 100, interval: Math.max(3, Math.round(25 * multiplier)) },
    { upToMove: 200, interval: Math.max(3, Math.round(20 * multiplier)) },
    { upToMove: 300, interval: Math.max(3, Math.round(15 * multiplier)) },
    { upToMove: Infinity, interval: Math.max(3, Math.round(10 * multiplier)) },
  ];
}

function runExperiment(botName, mult) {
  const moveCounts = [];
  const schedule = buildHazardSchedule(mult);
  for (let i = 0; i < N; i++) {
    const seed = (SEED + i * 31) >>> 0;
    const botSeed = (seed + 0x7f4a7c15) >>> 0;
    const bot = createBot(botName, botSeed);
    const game = createGame(seed, {
      forcedRelics: [],
      enableDraft: false,
      moveCap: 5000,
      hazardSchedule: schedule,
    });
    while (!game.gameOver && !game.capped) {
      const move = bot.chooseMove(game);
      if (!move) break;
      const res = step(game, move, bot);
      if (!res.valid) break;
    }
    moveCounts.push(game.moveCount);
  }
  moveCounts.sort((a, b) => a - b);
  return {
    med: Math.round(getPercentile(moveCounts, 50) * 10) / 10,
    p10: Math.round(getPercentile(moveCounts, 10) * 10) / 10,
    p90: Math.round(getPercentile(moveCounts, 90) * 10) / 10,
  };
}

console.log(`=== E1 Baseline: Expectimax vs Greedy (N=${N}) ===\n`);
console.log('| Multiplier | Greedy Med | Greedy P10 | Greedy P90 | Expectimax Med | Expectimax P10 | Expectimax P90 | Δ Med (Exp - Grd) |');
console.log('|---|---|---|---|---|---|---|---|');

for (const mult of MULTIPLIERS) {
  const grd = runExperiment('greedy', mult);
  const exp = runExperiment('expectimax', mult);
  const delta = Math.round((exp.med - grd.med) * 10) / 10;
  const sign = delta >= 0 ? '+' : '';
  console.log(`| ${mult}x | ${grd.med} | ${grd.p10} | ${grd.p90} | ${exp.med} | ${exp.p10} | ${exp.p90} | ${sign}${delta} |`);
}
