import test from 'node:test';
import assert from 'node:assert/strict';
import { GameController } from '../../game/controller.js';
import { createBot } from '../bots.js';
import { CONFIGS, runSimGame } from './golden_helper.js';

test('Controller Parity: drive GameController with greedy-bot on 50 seeds x 9 configs', () => {
  const greedyBot = createBot('greedy');
  let totalChecked = 0;

  for (let s = 1; s <= 50; s++) {
    for (const c of CONFIGS) {
      // 1. Sim run
      const simRes = runSimGame(greedyBot, c.config, s);

      // 2. Controller run
      const ctrl = new GameController(s, c.config);
      while (!ctrl.isGameOver()) {
        const move = greedyBot.chooseMove(ctrl.getState());
        if (!move) break;

        const moveRes = ctrl.submitMove(move);
        if (!moveRes.success) break;

        while (ctrl.hasPendingDecision()) {
          const dec = ctrl.getPendingDecision();
          if (dec.type === 'mason') {
            const choice = greedyBot.chooseStoneCell(ctrl.getState(), dec.candidates);
            ctrl.resolveDecision(choice);
          } else if (dec.type === 'draft') {
            let choice = null;
            if (typeof greedyBot.chooseDraftRelic === 'function') {
              choice = greedyBot.chooseDraftRelic(ctrl.getState(), dec.offers);
            }
            if (!choice) {
              // In the sim, unguided drafts pick using draft RNG: offers[Math.floor(rng() * offers.length)]
              const pIdx = Math.floor(ctrl.getState().rngs.draft() * dec.offers.length);
              choice = dec.offers[pIdx];
            }
            ctrl.resolveDecision(choice);
          }
        }
      }

      const ctrlRelics = Array.from(ctrl.getState().relics).sort();
      const ctrlBoard = ctrl.getBoard();
      const ctrlMoves = ctrl.getState().moveCount;

      assert.equal(
        ctrlMoves,
        simRes.moveCount,
        `Move count mismatch for seed ${s}, config ${c.id}: controller got ${ctrlMoves}, sim got ${simRes.moveCount}`
      );

      assert.deepEqual(
        ctrlRelics,
        simRes.relics,
        `Relics mismatch for seed ${s}, config ${c.id}`
      );

      assert.deepEqual(
        ctrlBoard,
        simRes.finalBoard,
        `Final board mismatch for seed ${s}, config ${c.id}`
      );

      totalChecked++;
    }
  }

  assert.equal(totalChecked, 450, 'Must have verified parity for 450 runs (50 seeds x 9 configs)');
});

test('Controller Run-Log: abilityUses context fields and hazardSchedule Infinity serialization', () => {
  // 1. Stuck = false, emptyCellsBefore, chargesBefore, undoneDir, and nextDirAfterUndo resolution
  const ctrl = new GameController(42, { forcedRelics: ['rewind'] });
  assert.equal(ctrl.state.abilities.rewind.charges, 1);

  // Submit a valid move
  const m1 = ctrl.getValidMoves()[0];
  const res1 = ctrl.submitMove(m1);
  assert.ok(res1.success);

  const emptyBeforeUndo = ctrl.state.board.filter(c => c === 0).length;
  const undoRes = ctrl.useAbility('rewind');
  assert.ok(undoRes.success);

  const rewindEntry1 = ctrl.abilityUses[0];
  assert.equal(rewindEntry1.relic, 'rewind');
  assert.equal(rewindEntry1.stuck, false, 'Should not be stuck when valid moves existed');
  assert.equal(rewindEntry1.emptyCellsBefore, emptyBeforeUndo);
  assert.equal(rewindEntry1.chargesBefore, 1);
  assert.equal(rewindEntry1.chargesAfter, 0);
  assert.equal(rewindEntry1.undoneDir, m1);
  assert.equal(rewindEntry1.moveBeforeUndo, 1);
  assert.equal(rewindEntry1.moveAfterUndo, 0);
  assert.equal(rewindEntry1.moveNumber, 0);
  assert.equal(rewindEntry1.nextDirAfterUndo, null, 'nextDirAfterUndo should be null before any valid swipe');

  // Now submit next valid swipe
  const m2 = ctrl.getValidMoves()[0];
  const res2 = ctrl.submitMove(m2);
  assert.ok(res2.success);
  assert.equal(rewindEntry1.nextDirAfterUndo, m2, 'nextDirAfterUndo should be updated to direction of next valid swipe');

  // 2. nextDirAfterUndo = null case when the run ends first
  const ctrl2 = new GameController(99, { forcedRelics: ['rewind'] });
  const moveA = ctrl2.getValidMoves()[0];
  ctrl2.submitMove(moveA);
  const undoRes2 = ctrl2.useAbility('rewind');
  assert.ok(undoRes2.success);
  const rewindEntry2 = ctrl2.abilityUses[0];
  assert.equal(rewindEntry2.undoneDir, moveA);
  assert.equal(rewindEntry2.moveBeforeUndo, 1);
  assert.equal(rewindEntry2.moveAfterUndo, 0);
  assert.equal(rewindEntry2.moveNumber, 0);
  assert.equal(rewindEntry2.nextDirAfterUndo, null);
  // Game ends without any subsequent valid swipe
  ctrl2.state.gameOver = true;
  const log2 = ctrl2.getRunLog();
  assert.equal(log2.abilityUses[0].nextDirAfterUndo, null, 'nextDirAfterUndo must remain null when run ends before another valid swipe');
  assert.equal(log2.abilityUses[0].moveBeforeUndo, 1);
  assert.equal(log2.abilityUses[0].moveAfterUndo, 0);

  // 3. stuck = true case
  const ctrl3 = new GameController(123, { forcedRelics: ['eraser'] });
  // Manually arrange a locked board with no moves
  ctrl3.state.board = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  assert.equal(ctrl3.getValidMoves().length, 0);
  const emptyBeforeEraser = ctrl3.state.board.filter(c => c === 0).length;
  assert.equal(emptyBeforeEraser, 0);

  const eraseRes = ctrl3.useAbility('eraser', 0);
  assert.ok(eraseRes.success);
  const eraserEntry = ctrl3.abilityUses[0];
  assert.equal(eraserEntry.relic, 'eraser');
  assert.equal(eraserEntry.stuck, true, 'Should be stuck when no valid moves existed');
  assert.equal(eraserEntry.emptyCellsBefore, 0);
  assert.equal(eraserEntry.chargesBefore, 1);
  assert.equal(eraserEntry.chargesAfter, 0);

  // 4. hazardSchedule serializes Infinity as string "Infinity", never null
  const log = ctrl.getRunLog();
  assert.ok(Array.isArray(log.config.hazardSchedule));
  const lastTier = log.config.hazardSchedule[log.config.hazardSchedule.length - 1];
  assert.equal(lastTier.upToMove, 'Infinity');

  const serialized = JSON.stringify(log);
  assert.ok(serialized.includes('"upToMove":"Infinity"'), 'Serialized hazardSchedule must contain "upToMove":"Infinity"');
  assert.ok(!serialized.includes('"upToMove":null'), 'Serialized hazardSchedule must never contain "upToMove":null');

  const parsed = JSON.parse(serialized);
  const parsedLastTier = parsed.config.hazardSchedule[parsed.config.hazardSchedule.length - 1];
  assert.equal(parsedLastTier.upToMove, 'Infinity');
});

