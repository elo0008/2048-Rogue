/**
 * E2 forceAtMove=30: run each relic solo, greedy, N=500, injected at move 30.
 * Compare median/p10/p90 with forceAtMove=0 (normal E2).
 */

import { createGame, step, DEFAULT_CONFIG, DIRECTIONS } from './engine.js';
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

function runBatch(forceAtMove) {
  const rows = [];
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
    rows.push({
      rid,
      med: Math.round(getPercentile(moveCounts, 50) * 10) / 10,
      p10: Math.round(getPercentile(moveCounts, 10) * 10) / 10,
      p90: Math.round(getPercentile(moveCounts, 90) * 10) / 10,
    });
  }
  return rows;
}

const at0 = runBatch(0);
const at30 = runBatch(30);

console.log('E2 greedy N=' + N + ': forceAtMove=0 vs forceAtMove=30\n');
console.log('| Relic | Med@0 | P10@0 | P90@0 | Med@30 | P10@30 | P90@30 | Δmed |');
console.log('|---|---|---|---|---|---|---|---|');
for (let i = 0; i < RELIC_IDS.length; i++) {
  const r0 = at0[i], r30 = at30[i];
  const delta = Math.round((r30.med - r0.med) * 10) / 10;
  const sign = delta >= 0 ? '+' : '';
  console.log(`| ${r0.rid} | ${r0.med} | ${r0.p10} | ${r0.p90} | ${r30.med} | ${r30.p10} | ${r30.p90} | ${sign}${delta} |`);
}
