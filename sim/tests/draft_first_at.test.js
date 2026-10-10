import test from 'node:test';
import assert from 'node:assert';
import { createGame, step, stepInteractive } from '../engine.js';
import { createBot } from '../bots.js';

test('draftFirstAt semantics: first draft at firstAt, then every draftEveryMoves after it (e.g. 30, 90, 150)', () => {
  const bot = createBot('corner');

  // Test with draftFirstAt=30, draftEveryMoves=60
  const state = createGame(42, {
    enableDraft: true,
    draftFirstAt: 30,
    draftEveryMoves: 60,
    draftThresholds: [], // disable threshold drafts
    hazardSchedule: [{ upToMove: Infinity, interval: 10000 }],
    moveCap: 200,
  });

  const draftMoves = [];
  while (!state.gameOver && !state.capped && state.moveCount < 200) {
    const move = bot.chooseMove(state);
    if (!move) break;
    const preCount = state.draftHistory.length;
    step(state, move, bot);
    if (state.draftHistory.length > preCount) {
      draftMoves.push(state.moveCount);
    }
  }

  // Expect drafts exactly at moves 30, 90, 150
  assert.deepStrictEqual(draftMoves.slice(0, 3), [30, 90, 150]);
  assert.ok(!draftMoves.includes(60), 'Should not draft at move 60 when first=30, every=60');
  assert.ok(!draftMoves.includes(120), 'Should not draft at move 120 when first=30, every=60');
});

test('draftFirstAt unset: triggers at draftEveryMoves multiples (60, 120, 180)', () => {
  const bot = createBot('corner');

  const state = createGame(42, {
    enableDraft: true,
    draftFirstAt: null, // unset
    draftEveryMoves: 60,
    draftThresholds: [],
    hazardSchedule: [{ upToMove: Infinity, interval: 10000 }],
    moveCap: 250,
  });

  const draftMoves = [];
  while (!state.gameOver && !state.capped && state.moveCount < 250) {
    const move = bot.chooseMove(state);
    if (!move) break;
    const preCount = state.draftHistory.length;
    step(state, move, bot);
    if (state.draftHistory.length > preCount) {
      draftMoves.push(state.moveCount);
    }
  }

  // Expect drafts at 60, 120, 180
  assert.deepStrictEqual(draftMoves.slice(0, 3), [60, 120, 180]);
  assert.ok(!draftMoves.includes(30), 'Should not draft at move 30 when firstAt is unset');
  assert.ok(!draftMoves.includes(90), 'Should not draft at move 90 when firstAt is unset');
});

test('draftFirstAt parity between synchronous step and stepInteractive', () => {
  const bot = createBot('corner');

  // Run with stepInteractive
  const stateInter = createGame(42, {
    enableDraft: true,
    draftFirstAt: 15,
    draftEveryMoves: 20, // should trigger at 15, 35, 55, 75
    draftThresholds: [],
    hazardSchedule: [{ upToMove: Infinity, interval: 10000 }],
    moveCap: 80,
  });

  const interDraftMoves = [];
  while (!stateInter.gameOver && !stateInter.capped && stateInter.moveCount < 80) {
    const move = bot.chooseMove(stateInter);
    if (!move) break;
    let res = stepInteractive(stateInter, move);
    while (res.pendingDecision) {
      if (res.pendingDecision.type === 'draft') {
        interDraftMoves.push(stateInter.moveCount);
        res = res.pendingDecision.resolve(res.pendingDecision.offers[0]);
      } else if (res.pendingDecision.type === 'mason') {
        res = res.pendingDecision.resolve(res.pendingDecision.candidates[0]);
      }
    }
  }

  assert.deepStrictEqual(interDraftMoves.slice(0, 4), [15, 35, 55, 75]);
});
