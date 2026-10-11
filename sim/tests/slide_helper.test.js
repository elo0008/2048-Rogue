import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSlide, DIRECTIONS } from '../../game/slide.js';
import { applySlide, STONE } from '../engine.js';

test('Slide Helper Parity: on 500 random no-relic boards (with stones) predictedBoard equals engine applySlide for all 4 directions', () => {
  // Simple LCG PRNG for reproducible test data
  let seed = 42;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  const tileValues = [0, 0, 2, 4, 8, 16, 32, 64, 128, 256, 512, STONE];
  const emptyRelics = new Set();

  for (let b = 0; b < 500; b++) {
    const board = [];
    for (let i = 0; i < 16; i++) {
      const idx = Math.floor(rnd() * tileValues.length);
      board.push(tileValues[idx]);
    }

    for (const dir of DIRECTIONS) {
      const helperRes = computeSlide(board, dir);
      const engineRes = applySlide(board, dir, emptyRelics, null);

      assert.deepStrictEqual(
        helperRes.predictedBoard,
        engineRes.board,
        `Mismatch at board #${b}, direction ${dir}: predicted ${JSON.stringify(helperRes.predictedBoard)} vs engine ${JSON.stringify(engineRes.board)}`
      );
      assert.strictEqual(
        helperRes.changed,
        engineRes.changed,
        `Changed flag mismatch at board #${b}, direction ${dir}`
      );
    }
  }
});
