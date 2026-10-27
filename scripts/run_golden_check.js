import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createBot, createExpectimaxBot } from '../sim/bots.js';
import { CONFIGS, runSimGame } from '../sim/tests/golden_helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');
const outFile = path.join(outDir, 'golden_check.txt');

async function main() {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const goldenPath = path.join(rootDir, 'sim', 'tests', 'golden.json');
  assert.ok(fs.existsSync(goldenPath), 'golden.json must exist');

  const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();

  let tested = 0;
  let passed = 0;

  // 1. Greedy 50 seeds x 9 configs
  for (let s = 1; s <= 50; s++) {
    for (const c of CONFIGS) {
      const key = `greedy:${c.id}:${s}`;
      const expected = goldenData.runs[key];
      assert.ok(expected, `Missing golden entry for ${key}`);

      const actual = runSimGame(greedyBot, c.config, s);
      assert.equal(actual.hash, expected.hash, `Hash mismatch for ${key}`);
      assert.equal(actual.moveCount, expected.moveCount, `Move count mismatch for ${key}`);
      tested++;
      passed++;
    }
  }

  // 2. Expectimax 20 seeds x 9 configs
  for (let s = 1; s <= 20; s++) {
    for (const c of CONFIGS) {
      const key = `expectimax:${c.id}:${s}`;
      const expected = goldenData.runs[key];
      assert.ok(expected, `Missing golden entry for ${key}`);

      const actual = runSimGame(expectimaxBot, c.config, s);
      assert.equal(actual.hash, expected.hash, `Hash mismatch for ${key}`);
      assert.equal(actual.moveCount, expected.moveCount, `Move count mismatch for ${key}`);
      tested++;
      passed++;
    }
  }

  const resultLine = `Golden Fixture: ${passed}/${tested} runs passed bit-identical (rule off by default: PASS)`;
  fs.writeFileSync(outFile, resultLine + '\n', 'utf-8');
  console.log(resultLine);
  console.log(`Saved result to ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
