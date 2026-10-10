import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot, createExpectimaxBot } from '../bots.js';
import { CONFIGS, runSimGame } from './golden_helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Golden Fixture: verify all 630 runs remain bit-identical', () => {
  const goldenPath = path.join(__dirname, 'golden.json');
  assert.ok(fs.existsSync(goldenPath), 'golden.json must exist');

  const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();

  let tested = 0;

  // 1. Greedy 50 seeds x 9 configs
  for (let s = 1; s <= 50; s++) {
    for (const c of CONFIGS) {
      const key = `greedy:${c.id}:${s}`;
      const expected = goldenData.runs[key];
      assert.ok(expected, `Missing golden entry for ${key}`);

      const actual = runSimGame(greedyBot, c.config, s);
      assert.equal(
        actual.hash,
        expected.hash,
        `Hash mismatch for ${key} (moves: ${actual.moveCount} vs ${expected.moveCount})`
      );
      assert.equal(
        actual.moveCount,
        expected.moveCount,
        `Move count mismatch for ${key}`
      );
      tested++;
    }
  }

  // 2. Expectimax 20 seeds x 9 configs
  for (let s = 1; s <= 20; s++) {
    for (const c of CONFIGS) {
      const key = `expectimax:${c.id}:${s}`;
      const expected = goldenData.runs[key];
      assert.ok(expected, `Missing golden entry for ${key}`);

      const actual = runSimGame(expectimaxBot, c.config, s);
      assert.equal(
        actual.hash,
        expected.hash,
        `Hash mismatch for ${key} (moves: ${actual.moveCount} vs ${expected.moveCount})`
      );
      assert.equal(
        actual.moveCount,
        expected.moveCount,
        `Move count mismatch for ${key}`
      );
      tested++;
    }
  }

  assert.equal(tested, 630, 'Must have recomputed and verified exactly 630 runs');
});
