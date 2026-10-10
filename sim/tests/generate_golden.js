import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot, createExpectimaxBot } from '../bots.js';
import { CONFIGS, runSimGame } from './golden_helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const greedyBot = createBot('greedy');
const expectimaxBot = createExpectimaxBot();

const goldenData = {
  meta: {
    createdAt: new Date().toISOString(),
    numSeedsGreedy: 50,
    numSeedsExpectimax: 20,
    configs: CONFIGS.map(c => c.id),
  },
  runs: {},
};

console.log('Generating golden runs for greedy bot (50 seeds x 9 configs)...');
const t0 = Date.now();
for (let s = 1; s <= 50; s++) {
  for (const c of CONFIGS) {
    const key = `greedy:${c.id}:${s}`;
    const result = runSimGame(greedyBot, c.config, s);
    goldenData.runs[key] = {
      hash: result.hash,
      moveCount: result.moveCount,
      relics: result.relics,
    };
  }
}
console.log(`Greedy generated in ${Date.now() - t0}ms`);

console.log('Generating golden runs for expectimax bot (20 seeds x 9 configs)...');
const t1 = Date.now();
for (let s = 1; s <= 20; s++) {
  for (const c of CONFIGS) {
    const key = `expectimax:${c.id}:${s}`;
    const result = runSimGame(expectimaxBot, c.config, s);
    goldenData.runs[key] = {
      hash: result.hash,
      moveCount: result.moveCount,
      relics: result.relics,
    };
  }
}
console.log(`Expectimax generated in ${Date.now() - t1}ms`);

const goldenPath = path.join(__dirname, 'golden.json');
fs.writeFileSync(goldenPath, JSON.stringify(goldenData, null, 2), 'utf-8');
console.log(`Saved golden fixture with ${Object.keys(goldenData.runs).length} runs to ${goldenPath}`);
