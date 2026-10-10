import { createGame, step } from './engine.js';
import { createBot } from './bots.js';
import { RELIC_IDS } from './relics.js';

const N = 500;
const SEED = 42;
const BOT_NAME = 'greedy';

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}

function runE1() {
  const moveCounts = [];
  for (let i = 0; i < N; i++) {
    const seed = (SEED + i * 31) >>> 0;
    const botSeed = (seed + 0x7f4a7c15) >>> 0;
    const bot = createBot(BOT_NAME, botSeed);
    const game = createGame(seed, { forcedRelics: [], enableDraft: false, moveCap: 5000 });
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

function runE2(forceAtMove) {
  const results = {};
  for (const rid of RELIC_IDS) {
    const moveCounts = [];
    for (let i = 0; i < N; i++) {
      const seed = (SEED + i * 31) >>> 0;
      const botSeed = (seed + 0x7f4a7c15) >>> 0;
      const bot = createBot(BOT_NAME, botSeed);
      const game = createGame(seed, {
        forcedRelics: [rid],
        forceAtMove,
        enableDraft: false,
        moveCap: 5000,
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
    results[rid] = {
      med: Math.round(getPercentile(moveCounts, 50) * 10) / 10,
      p10: Math.round(getPercentile(moveCounts, 10) * 10) / 10,
      p90: Math.round(getPercentile(moveCounts, 90) * 10) / 10,
    };
  }
  return results;
}

const e1 = runE1();
console.log(`E1 Baseline (greedy, N=${N}): Median=${e1.med}, P10=${e1.p10}, P90=${e1.p90}\n`);

const e2_at0 = runE2(0);
const e2_at30 = runE2(30);

console.log('| Relic | E1 Med | E1 P10 | E1 P90 | Med@30 | P10@30 | P90@30 | Δ vs E1 (Med) | Med@0 | Δ vs Med@0 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const rid of RELIC_IDS) {
  const r30 = e2_at30[rid];
  const r0 = e2_at0[rid];
  const deltaE1 = Math.round((r30.med - e1.med) * 10) / 10;
  const delta0 = Math.round((r30.med - r0.med) * 10) / 10;
  console.log(`| ${rid} | ${e1.med} | ${e1.p10} | ${e1.p90} | ${r30.med} | ${r30.p10} | ${r30.p90} | ${deltaE1 >= 0 ? '+' : ''}${deltaE1} | ${r0.med} | ${delta0 >= 0 ? '+' : ''}${delta0} |`);
}
