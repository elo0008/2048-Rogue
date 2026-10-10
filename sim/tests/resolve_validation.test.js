import test from 'node:test';
import assert from 'node:assert';
import { createGame, stepInteractive } from '../engine.js';
import { GameController } from '../../game/controller.js';

test('resolve() validation: draft resolve throws if choice not in offers', () => {
  // Test direct engine stepInteractive
  const state = createGame(42, {
    enableDraft: true,
    draftEveryMoves: 1,
    draftPool: ['diagonal_merge', 'fault_line', 'mason', 'siphon', 'shatter', 'last_stand'],
  });

  const res = stepInteractive(state, 'L');
  assert.ok(res.valid);
  assert.ok(res.pendingDecision);
  assert.strictEqual(res.pendingDecision.type, 'draft');

  const offers = res.pendingDecision.offers;
  assert.ok(offers.length > 0);

  // Pick an invalid relic ID that is definitely not in offers
  const invalidPick = 'non_existent_relic_xyz';
  assert.throws(
    () => {
      res.pendingDecision.resolve(invalidPick);
    },
    {
      name: 'Error',
      message: /Invalid draft pick/,
    }
  );

  // Also test through GameController
  const controller = new GameController(42, {
    enableDraft: true,
    draftEveryMoves: 1,
    draftPool: ['diagonal_merge', 'fault_line', 'mason', 'siphon', 'shatter', 'last_stand'],
  });

  const cRes = controller.submitMove('L');
  assert.ok(cRes.success);
  assert.ok(controller.hasPendingDecision());
  assert.strictEqual(controller.getPendingDecision().type, 'draft');

  assert.throws(
    () => {
      controller.resolveDecision(invalidPick);
    },
    {
      name: 'Error',
      message: /Invalid draft pick/,
    }
  );

  // Valid pick should succeed
  const validPick = controller.getPendingDecision().offers[0];
  const validRes = controller.resolveDecision(validPick);
  assert.ok(validRes.success);
  assert.ok(controller.getState().relics.has(validPick));
});

test('resolve() validation: mason resolve throws if chosenCell not in candidates', () => {
  // Test direct engine stepInteractive
  const state = createGame(101, {
    forcedRelics: ['mason'],
    forceAtMove: 0,
    enableDraft: false,
    hazardSchedule: [{ upToMove: Infinity, interval: 1 }], // stone every move
  });

  const res = stepInteractive(state, 'L');
  assert.ok(res.valid);
  assert.ok(res.pendingDecision);
  assert.strictEqual(res.pendingDecision.type, 'mason');

  const candidates = res.pendingDecision.candidates;
  assert.strictEqual(candidates.length, 2);

  // Pick a cell that is not in candidates
  let invalidCell = 0;
  while (candidates.includes(invalidCell)) {
    invalidCell++;
  }

  assert.throws(
    () => {
      res.pendingDecision.resolve(invalidCell);
    },
    {
      name: 'Error',
      message: /Invalid mason candidate cell/,
    }
  );

  // Also test through GameController
  const controller = new GameController(101, {
    forcedRelics: ['mason'],
    forceAtMove: 0,
    enableDraft: false,
    hazardSchedule: [{ upToMove: Infinity, interval: 1 }],
  });

  const cRes = controller.submitMove('L');
  assert.ok(cRes.success);
  assert.ok(controller.hasPendingDecision());
  assert.strictEqual(controller.getPendingDecision().type, 'mason');

  assert.throws(
    () => {
      controller.resolveDecision(invalidCell);
    },
    {
      name: 'Error',
      message: /Invalid mason candidate cell/,
    }
  );

  // Valid cell should succeed
  const validCell = controller.getPendingDecision().candidates[0];
  const validRes = controller.resolveDecision(validCell);
  assert.ok(validRes.success);
  assert.strictEqual(controller.getState().board[validCell], 'S');
});
