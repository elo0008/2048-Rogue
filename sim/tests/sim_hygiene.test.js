import test from 'node:test';
import assert from 'node:assert';
import {
  createGame,
  step,
  cloneState,
  getValidMoves,
  buildHazardSchedule,
  mulberry32,
} from '../engine.js';
import { createBot, createNoisyBot, createRolloutBot } from '../bots.js';

test('Sim hygiene (a): 200 random mid-game states have every key except rngs deep-equal in cloneState', () => {
  const configs = [
    { enableDraft: true, draftEveryMoves: 10, draftPool: ['diagonal_merge', 'mason', 'siphon', 'shatter'] },
    { forcedRelics: ['triple_threat', 'fault_line'], forceAtMove: 0 },
    { forcedRelics: ['anchor_row'], forceAtMove: 10, draftEveryMoves: 15 },
    { forcedRelics: ['last_stand', 'pressure_cooker'], forceAtMove: 0, hazardSchedule: buildHazardSchedule(0.5) },
  ];

  for (let i = 1; i <= 200; i++) {
    const seed = i * 17 + 101;
    const cfg = configs[i % configs.length];
    const state = createGame(seed, cfg);

    const stepRng = mulberry32(seed >>> 0);
    const targetSteps = 15 + Math.floor(stepRng() * 50);

    for (let stepCount = 0; stepCount < targetSteps; stepCount++) {
      if (state.gameOver || state.capped) break;
      const valid = getValidMoves(state);
      if (valid.length === 0) break;
      const dir = valid[Math.floor(stepRng() * valid.length)];
      step(state, dir);
    }

    const cloned = cloneState(state);

    // Verify all keys of state except rngs exist in cloned and are deep-equal
    const stateKeys = Object.keys(state);
    for (const key of stateKeys) {
      if (key === 'rngs') continue;
      assert.ok(
        key in cloned,
        `Key "${key}" missing in cloneState for state at move ${state.moveCount}`
      );

      if (state[key] instanceof Set) {
        assert.deepStrictEqual(
          Array.from(cloned[key]).sort(),
          Array.from(state[key]).sort(),
          `Set mismatch on key "${key}"`
        );
      } else {
        assert.deepStrictEqual(
          cloned[key],
          state[key],
          `Value mismatch on key "${key}"`
        );
      }
    }
  }
});

test('Sim hygiene (b): noisy(base, eps) seeds randomness from game seed and reproduces same run twice', () => {
  const baseBot = createBot('greedy');
  const noisyBot = createNoisyBot(baseBot, 0.2);

  const seed = 88888;
  const cfg = {
    hazardSchedule: buildHazardSchedule(3),
    enableDraft: false,
    moveCap: 200,
  };

  // Run 1
  const state1 = createGame(seed, cfg);
  const moves1 = [];
  while (!state1.gameOver && !state1.capped && state1.moveCount < 200) {
    const m = noisyBot.chooseMove(state1);
    if (!m) break;
    moves1.push(m);
    step(state1, m, noisyBot);
  }

  // Run 2 with same bot instance and same seed
  const state2 = createGame(seed, cfg);
  const moves2 = [];
  while (!state2.gameOver && !state2.capped && state2.moveCount < 200) {
    const m = noisyBot.chooseMove(state2);
    if (!m) break;
    moves2.push(m);
    step(state2, m, noisyBot);
  }

  assert.strictEqual(moves1.length, moves2.length);
  assert.deepStrictEqual(moves1, moves2, 'Noisy bot must produce identical moves for same game seed');
  assert.strictEqual(state1.moveCount, state2.moveCount);
  assert.deepStrictEqual(state1.board, state2.board);
});

test('Sim hygiene (c): same seed and config give identical offers AND picks under draftPolicy rollout', () => {
  const greedy = createBot('greedy');
  const rolloutBot1 = createRolloutBot(greedy, 10);
  const rolloutBot2 = createRolloutBot(greedy, 10);

  const seed = 99999;
  const cfg = {
    enableDraft: true,
    draftEveryMoves: 15,
    draftThresholds: [],
    draftPool: ['diagonal_merge', 'fault_line', 'mason', 'siphon', 'shatter', 'last_stand'],
    draftPolicy: 'rollout',
    moveCap: 80,
  };

  // Run 1
  const state1 = createGame(seed, cfg);
  while (!state1.gameOver && !state1.capped && state1.moveCount < 80) {
    const m = rolloutBot1.chooseMove(state1);
    if (!m) break;
    step(state1, m, rolloutBot1);
  }

  // Run 2
  const state2 = createGame(seed, cfg);
  while (!state2.gameOver && !state2.capped && state2.moveCount < 80) {
    const m = rolloutBot2.chooseMove(state2);
    if (!m) break;
    step(state2, m, rolloutBot2);
  }

  assert.ok(state1.draftHistory.length >= 2, 'Should have triggered at least 2 drafts');
  assert.strictEqual(state1.draftHistory.length, state2.draftHistory.length);

  for (let d = 0; d < state1.draftHistory.length; d++) {
    const h1 = state1.draftHistory[d];
    const h2 = state2.draftHistory[d];
    assert.deepStrictEqual(h1.offers, h2.offers, `Offers mismatch at draft ${d}`);
    assert.strictEqual(h1.pick, h2.pick, `Pick mismatch at draft ${d}`);
  }

  assert.deepStrictEqual(state1.board, state2.board);
  assert.strictEqual(state1.moveCount, state2.moveCount);
});
