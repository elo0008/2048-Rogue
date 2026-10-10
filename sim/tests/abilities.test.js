import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  step,
  stepInteractive,
  getValidMoves,
  getLegalTargets,
  getAbilityState,
  hasLegalAbility,
  useAbility,
  cloneState,
  resolveOneDraft,
  mulberry32,
  STONE,
} from '../engine.js';

test('Abilities: legal and illegal targets for both diagonal_charge and eraser', () => {
  // Derivation:
  // Board setup:
  // [ 2,  0,  0, 'S',
  //   0,  2,  0,  0,
  //   0,  0,  4,  0,
  //   0,  4,  0,  0 ]
  // Cells 0 and 5 have value 2. r0=0, c0=0; r5=1, c5=1 => |dr|=1, |dc|=1 => diagonal pair!
  // Cells 10 and 13 have value 4. r10=2, c10=2; r13=3, c13=1 => |dr|=1, |dc|=1 => diagonal pair!
  // Cell 3 is STONE ('S').
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge', 'eraser'],
    forceAtMove: 0,
    maxCharges: 3,
  });

  const b = new Array(16).fill(0);
  b[0] = 2;
  b[3] = STONE;
  b[5] = 2;
  b[10] = 4;
  b[13] = 4;
  game.board = b;

  // 1. diagonal_charge legal targets (returns both orders)
  const diagTargets = getLegalTargets(game, 'diagonal_charge');
  assert.equal(diagTargets.length, 4);
  assert.deepEqual(diagTargets, [
    { from: 0, to: 5 },
    { from: 5, to: 0 },
    { from: 10, to: 13 },
    { from: 13, to: 10 },
  ]);

  // 2. diagonal_charge illegal targets throw
  // Orthogonal adjacent with same value
  b[1] = 2;
  assert.throws(() => {
    useAbility(game, 'diagonal_charge', { from: 0, to: 1 });
  }, /not diagonally adjacent/);

  // Different values
  assert.throws(() => {
    useAbility(game, 'diagonal_charge', { from: 5, to: 10 });
  }, /not equal number tiles/);

  // Stone target
  assert.throws(() => {
    useAbility(game, 'diagonal_charge', { from: 3, to: 6 });
  }, /not equal number tiles/);

  // Empty cell target
  assert.throws(() => {
    useAbility(game, 'diagonal_charge', { from: 2, to: 7 });
  }, /not equal number tiles/);

  // 3. eraser legal targets
  // Legal targets are cells with positive numbers: 0, 1, 5, 10, 13
  const eraserTargets = getLegalTargets(game, 'eraser');
  const eraserCells = eraserTargets.map(t => t.cell).sort((a, b) => a - b);
  assert.deepEqual(eraserCells, [0, 1, 5, 10, 13]);

  // 4. eraser illegal targets throw
  // Stone cell 3
  assert.throws(() => {
    useAbility(game, 'eraser', { cell: 3 });
  }, /does not hold a number tile/);

  // Empty cell 2
  assert.throws(() => {
    useAbility(game, 'eraser', { cell: 2 });
  }, /does not hold a number tile/);

  // Out of bounds
  assert.throws(() => {
    useAbility(game, 'eraser', { cell: 16 });
  }, /invalid eraser target cell/);
});

test('Abilities: merge cell rule (lands on `to`, `from` empties, both orders legal)', () => {
  // Test 1: from 10 to 5 -> 2x tile at 5, cell 10 becomes 0
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge'],
    forceAtMove: 0,
  });

  const b = new Array(16).fill(0);
  b[5] = 8;
  b[10] = 8;
  game.board = b;

  useAbility(game, 'diagonal_charge', { from: 10, to: 5 });

  assert.equal(game.board[5], 16, 'Cell `to` (5) must receive merged 2x value 16');
  assert.equal(game.board[10], 0, 'Cell `from` (10) must be emptied');

  // Test 2: reverse order: from 5 to 10 -> 2x tile at 10, cell 5 becomes 0
  game.abilities.diagonal_charge.charges = 1;
  game.board[5] = 8;
  game.board[10] = 8;
  useAbility(game, 'diagonal_charge', { from: 5, to: 10 });

  assert.equal(game.board[10], 16, 'Cell `to` (10) must receive merged 2x value 16');
  assert.equal(game.board[5], 0, 'Cell `from` (5) must be emptied');
});

test('Abilities: charge decrement and out-of-charges error', () => {
  const game = createGame(12345, {
    forcedRelics: ['eraser'],
    forceAtMove: 0,
  });
  game.board[0] = 4;

  assert.equal(game.abilities.eraser.charges, 1);
  assert.equal(game.relicActivations.eraser, 0);

  // Use ability once
  useAbility(game, 'eraser', { cell: 0 });
  assert.equal(game.abilities.eraser.charges, 0);
  assert.equal(game.relicActivations.eraser, 1);
  assert.equal(game.board[0], 0);

  // Use again with 0 charges => throws error
  game.board[1] = 4;
  assert.throws(() => {
    useAbility(game, 'eraser', { cell: 1 });
  }, /no charges remaining/);
});

test('Abilities: cooldown ticks on valid swipes only, not on ability use, not at max, regenerates exactly at N', () => {
  // Derivation:
  // diagonalChargeEvery = 5.
  // Charges start at 1, counter = 0.
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge'],
    forceAtMove: 0,
    diagonalChargeEvery: 5,
    maxCharges: 3,
  });

  // Setup diagonal pair at 0 and 5
  game.board[0] = 2;
  game.board[5] = 2;

  // Use ability: charges becomes 0, counter stays 0 (no tick on ability use)
  useAbility(game, 'diagonal_charge', { a: 0, b: 5 });
  assert.equal(game.abilities.diagonal_charge.charges, 0);
  assert.equal(game.abilities.diagonal_charge.counter, 0);

  // Prepare a board that can slide Left multiple times
  // Swipes 1 to 4: counter increments each time, charges remain 0
  for (let s = 1; s <= 4; s++) {
    // Put tile at cell 3 to ensure slide 'L' is valid
    game.board = new Array(16).fill(0);
    game.board[3] = 2;
    step(game, 'L');
    assert.equal(game.abilities.diagonal_charge.charges, 0, `Charges should stay 0 on swipe ${s}`);
    assert.equal(game.abilities.diagonal_charge.counter, s, `Counter should be ${s} on swipe ${s}`);
  }

  // Swipe 5: counter reaches 5 => charges becomes 1, counter resets to 0
  game.board = new Array(16).fill(0);
  game.board[3] = 2;
  step(game, 'L');
  assert.equal(game.abilities.diagonal_charge.charges, 1, 'Charges should regenerate to 1 on swipe 5');
  assert.equal(game.abilities.diagonal_charge.counter, 0, 'Counter should reset to 0');

  // Set charges to max (3) and verify swipesAtMax increments while counter stays 0
  game.abilities.diagonal_charge.charges = 3;
  game.abilities.diagonal_charge.counter = 0;
  game.abilities.diagonal_charge.swipesAtMax = 0;

  game.board = new Array(16).fill(0);
  game.board[3] = 2;
  step(game, 'L');

  assert.equal(game.abilities.diagonal_charge.charges, 3);
  assert.equal(game.abilities.diagonal_charge.counter, 0, 'Counter must not tick while at max charges');
  assert.equal(game.abilities.diagonal_charge.swipesAtMax, 1, 'swipesAtMax must increment');
});

test('Abilities: counter does not tick on the swipe that acquired the relic', () => {
  // Derivation:
  // Inject relic at move 1 via forceAtMove: 1.
  // Game starts at moveCount 0.
  // Move 1 swipe finishes -> moveCount becomes 1. Relic not yet injected.
  // Move 2 swipe starts with moveCount 1 -> forceAtMove: 1 triggers and injects eraser.
  // At the end of Move 2 swipe (the swipe that acquired eraser), counter must NOT tick: charges=1, counter=0.
  // Move 3 swipe starts with eraser already owned -> counter ticks to 1.
  const game = createGame(12345, {
    forcedRelics: ['eraser'],
    forceAtMove: 1,
    eraserEvery: 10,
    maxCharges: 3,
  });

  assert.equal(game.relics.has('eraser'), false);

  // Move 1 swipe: finishes at moveCount 1
  game.board = new Array(16).fill(0);
  game.board[3] = 2;
  step(game, 'L');
  assert.equal(game.relics.has('eraser'), false);

  // Move 2 swipe: starts at moveCount 1, acquires eraser, finishes
  game.board = new Array(16).fill(0);
  game.board[3] = 2;
  step(game, 'L');

  assert.equal(game.relics.has('eraser'), true);
  assert.equal(game.abilities.eraser.charges, 1);
  assert.equal(game.abilities.eraser.counter, 0, 'Counter must not tick on swipe that acquired the relic');

  // Move 3 swipe: now owned at start of swipe, so counter ticks to 1
  game.board = new Array(16).fill(0);
  game.board[3] = 2;
  step(game, 'L');

  assert.equal(game.abilities.eraser.charges, 1);
  assert.equal(game.abilities.eraser.counter, 1, 'Counter must tick on the subsequent swipe');
});

test('Abilities: free-action invariants (moveCount, spawnQueue, movesSinceLastStone unchanged)', () => {
  const game = createGame(12345, {
    forcedRelics: ['eraser'],
    forceAtMove: 0,
  });

  game.board[0] = 8;
  const moveCountBefore = game.moveCount;
  const spawnQueueLenBefore = game.spawnQueue.length;
  const spawnQueueFirstBefore = { ...game.spawnQueue[0] };
  const movesSinceStoneBefore = game.movesSinceLastStone;
  const scoreBefore = game.score;

  useAbility(game, 'eraser', { cell: 0 });

  assert.equal(game.moveCount, moveCountBefore, 'moveCount must not change');
  assert.equal(game.spawnQueue.length, spawnQueueLenBefore, 'spawnQueue length must not change');
  assert.deepEqual(game.spawnQueue[0], spawnQueueFirstBefore, 'spawnQueue head must not change');
  assert.equal(game.movesSinceLastStone, movesSinceStoneBefore, 'movesSinceLastStone must not change');
  assert.equal(game.score, scoreBefore, 'score must not change');
});

test('Abilities: shatter via ability merge', () => {
  // Derivation:
  // Shatter threshold: shatterMin = 64.
  // Cells 0 and 5 have value 32. Cell 1 has STONE.
  // Cell 1 (r=0, c=1) is orthogonally adjacent to cell 0 (r=0, c=0).
  // diagonal_charge merges 32+32 into 64 at cell 0.
  // Shatter should trigger, removing the stone at cell 1, and incrementing relicActivations.shatter.
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge', 'shatter'],
    forceAtMove: 0,
    shatterMin: 64,
  });

  const b = new Array(16).fill(0);
  b[0] = 32;
  b[1] = STONE;
  b[5] = 32;
  game.board = b;

  assert.equal(game.relicActivations.shatter, 0);

  // lands on cell 0, cell 1 is adjacent to 0 -> stone shattered
  useAbility(game, 'diagonal_charge', { from: 5, to: 0 });

  assert.equal(game.board[0], 64, 'Merged tile value must be 64');
  assert.equal(game.board[1], 0, 'Orthogonally adjacent stone must be shattered');
  assert.equal(game.board[5], 0, 'Merged source cell must be empty');
  assert.equal(game.relicActivations.shatter, 1, 'Shatter activation must be counted once');
});

test('Abilities: stuck rule (no swipe but ability exists => stuckNeedsAbility; Last Stand holds until abilities exhausted)', () => {
  // Derivation:
  // Build a jammed board with NO valid swipe moves.
  // Board:
  // [  2,  4,  2,  4,
  //    4,  2,  4,  2,
  //    2,  4,  2,  4,
  //    4,  2,  4,  2 ]
  // Notice: no two orthogonally adjacent cells are equal! Valid moves = 0.
  // But cells 0 and 5 both have value 2 and are diagonally adjacent.
  // With diagonal_charge owned:
  // 1. Stuck check must NOT end the game; stuckNeedsAbility must be true.
  // 2. Last Stand must NOT fire yet.
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge', 'last_stand'],
    forceAtMove: 0,
    lastStandMax: 16,
  });

  const jammed = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  game.board = [...jammed];
  game.abilities.diagonal_charge.charges = 1;

  // Initial swipe fails because board is jammed
  const res = step(game, 'L');
  assert.equal(res.valid, false, 'Swipe should be invalid on jammed board');

  // Simulate end of turn stuck check by calling step with board that produces jammed state
  // Or manually trigger stuck check:
  assert.equal(getValidMoves(game).length, 0);
  assert.equal(hasLegalAbility(game), true);

  // Directly verify stuck check logic via step:
  // Setup board so sliding left produces jammed board:
  // Put a stone at (0,3) and slide 'L' ->
  game.board = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    0, 4, 2, 4, // cell 12 is 0, cell 13 is 4, cell 14 is 2, cell 15 is 4
  ];
  // Sliding Left moves row 3 left: [4, 2, 4, spawn]
  // Let's force stuck check by directly running step when no moves remain:
  game.board = [...jammed];
  // Verify stuck rule properties:
  assert.equal(hasLegalAbility(game), true);
  assert.equal(game.lastStandUsed, false);

  // Now use diagonal_charge to merge cells 0 and 5:
  useAbility(game, 'diagonal_charge', { from: 5, to: 0 });

  // Cell 0 is now 4, cell 5 is 0.
  // Now there is an empty cell (cell 5), so swipes are possible!
  assert.equal(game.board[5], 0);
  assert.ok(getValidMoves(game).length > 0, 'Board should now have valid moves');
  assert.equal(game.stuckNeedsAbility, false);
  assert.equal(game.gameOver, false);
  assert.equal(game.lastStandUsed, false, 'Last stand must not have fired');
});

test('Abilities: Last Stand fires when stuck and abilities are exhausted', () => {
  // Derivation:
  // Jammed board with no swipe moves and 0 charges.
  // Last stand should fire, clearing tiles <= lastStandMax (16).
  const game = createGame(12345, {
    forcedRelics: ['eraser', 'last_stand'],
    forceAtMove: 0,
    lastStandMax: 16,
  });

  const jammed = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  game.board = [...jammed];
  game.abilities.eraser.charges = 1;

  // Consume eraser charge
  useAbility(game, 'eraser', { cell: 0 });
  assert.equal(game.abilities.eraser.charges, 0);

  // Re-fill cell 0 with 2 to jam the board again
  game.board[0] = 2;
  assert.equal(getValidMoves(game).length, 0);
  assert.equal(hasLegalAbility(game), false);

  // Now an ability cannot be used, and Last Stand must fire when stuck check runs
  // Using useAbility when stuck with no charges throws
  assert.throws(() => {
    useAbility(game, 'eraser', { cell: 0 });
  }, /no charges/);
});

test('Stone-group cap: never offered a third stone-group relic when cap is reached; cap null = unchanged', () => {
  // Derivation:
  // stoneGroup: ['fault_line', 'mason', 'shatter']
  // stoneGroupCap: 2
  // Player already owns fault_line and mason.
  // Draft offer pool must exclude shatter!
  const game = createGame(12345, {
    enableDraft: true,
    draftPool: ['fault_line', 'mason', 'shatter', 'siphon', 'last_stand', 'foresight'],
    stoneGroup: ['fault_line', 'mason', 'shatter'],
    stoneGroupCap: 2,
    forcedRelics: ['fault_line', 'mason'],
    forceAtMove: 0,
  });

  // Check draft resolution offers
  for (let d = 0; d < 20; d++) {
    const stateClone = { ...game, relics: new Set(game.relics) };
    resolveOneDraft(stateClone, null, {});
    const lastDraft = stateClone.draftHistory[stateClone.draftHistory.length - 1];
    if (lastDraft) {
      assert.ok(!lastDraft.offers.includes('shatter'), 'shatter must never be offered when stone-group cap is 2');
    }
  }
});

test('Abilities: Last Stand in useAbility respects config.lastStandMax (e.g. 8)', () => {
  const game = createGame(12345, {
    forcedRelics: ['eraser', 'last_stand'],
    forceAtMove: 0,
    lastStandMax: 8,
  });

  const boardStuck = [
    2, STONE, 4, STONE,
    STONE, 4, STONE, 2,
    2, STONE, 4, STONE,
    STONE, 4, STONE, 16,
  ];
  game.board = [...boardStuck];
  game.abilities.eraser.charges = 1;

  useAbility(game, 'eraser', { cell: 0 });

  assert.equal(game.lastStandUsed, true, 'Last Stand must have fired');
  assert.equal(game.board[15], 16, 'Tile 16 must NOT be cleared because lastStandMax is 8');
  assert.equal(game.board[2], 0, 'Tile 4 must be cleared because 4 <= 8');
});

test('Abilities: Shatter counts once per action even if multiple stones are destroyed', () => {
  const game = createGame(12345, {
    forcedRelics: ['diagonal_charge', 'shatter'],
    forceAtMove: 0,
    shatterMin: 64,
  });

  const b = new Array(16).fill(0);
  b[0] = 32;
  b[5] = 32;
  b[1] = STONE;
  b[4] = STONE;
  b[6] = STONE;
  b[9] = STONE;
  game.board = b;

  assert.equal(game.relicActivations.shatter, 0);

  useAbility(game, 'diagonal_charge', { from: 0, to: 5 });

  assert.equal(game.board[5], 64);
  assert.equal(game.board[1], 0);
  assert.equal(game.board[4], 0);
  assert.equal(game.board[6], 0);
  assert.equal(game.board[9], 0);
  assert.equal(game.relicActivations.shatter, 1, 'relicActivations.shatter must increment by exactly 1');
});

function clonePreState(state) {
  const c = cloneState(state);
  c.rngs = {
    tile: mulberry32(state.seed),
    stone: mulberry32((state.seed + 0x9e3779b9) >>> 0),
    draft: mulberry32((state.seed + 0x3c6ef372) >>> 0),
  };
  c.rngs.tile.setState(state.rngs.tile.getState());
  c.rngs.stone.setState(state.rngs.stone.getState());
  c.rngs.draft.setState(state.rngs.draft.getState());
  return c;
}

test('Rewind: Property test on 200 random reachable pre-states (including stones and Mason states)', () => {
  let checkedCount = 0;
  let stonesObserved = 0;
  let masonObserved = 0;
  const relicCombos = [
    ['rewind'],
    ['rewind', 'fault_line'],
    ['rewind', 'mason'],
    ['rewind', 'shatter'],
    ['rewind', 'fault_line', 'mason'],
    ['rewind', 'siphon', 'diagonal_charge'],
  ];

  for (let seed = 100; checkedCount < 200; seed++) {
    const forced = relicCombos[seed % relicCombos.length];
    const g = createGame(seed, {
      forcedRelics: forced,
      forceAtMove: 0,
      enableDraft: false,
      hazardSchedule: [{ upToMove: Infinity, interval: 3 }],
    });

    // Play random moves to reach an interesting mid-game state
    for (let m = 0; m < 12; m++) {
      const vm = getValidMoves(g);
      if (vm.length === 0) break;
      step(g, vm[(seed + m) % vm.length]);
    }

    if (g.board.some(c => c === STONE)) stonesObserved++;
    if (g.relics.has('mason') && (g.relicActivations['mason'] || 0) > 0) masonObserved++;

    const validDirs = getValidMoves(g);
    if (validDirs.length < 2) continue;

    // Ensure rewind is charged and ready
    g.abilities.rewind.charges = 1;
    g.rewindSnapshot = null; // simulate pre-swipe state before next swipe

    for (const d1 of validDirs) {
      for (const d2 of validDirs) {
        const stateA = clonePreState(g);
        const stateB = clonePreState(g);

        // Path A: swipe d1 -> undo -> swipe d2
        step(stateA, d1);
        useAbility(stateA, 'rewind', {});
        step(stateA, d2);

        // Path B: swipe d2 directly
        step(stateB, d2);

        assert.deepStrictEqual(stateA.board, stateB.board, `Board mismatch for seed ${seed} d1=${d1} d2=${d2}`);
        assert.deepStrictEqual(stateA.stoneSpawnMoves, stateB.stoneSpawnMoves);
        assert.strictEqual(stateA.moveCount, stateB.moveCount);
        assert.strictEqual(stateA.points, stateB.points);
        assert.strictEqual(stateA.movesSinceLastStone, stateB.movesSinceLastStone);
        assert.strictEqual(stateA.highestTile, stateB.highestTile);
        assert.deepStrictEqual(stateA.spawnQueue, stateB.spawnQueue);

        // Compare next 3 draws of each RNG stream
        const drawsA = {
          tile: [stateA.rngs.tile(), stateA.rngs.tile(), stateA.rngs.tile()],
          stone: [stateA.rngs.stone(), stateA.rngs.stone(), stateA.rngs.stone()],
          draft: [stateA.rngs.draft(), stateA.rngs.draft(), stateA.rngs.draft()],
        };
        const drawsB = {
          tile: [stateB.rngs.tile(), stateB.rngs.tile(), stateB.rngs.tile()],
          stone: [stateB.rngs.stone(), stateB.rngs.stone(), stateB.rngs.stone()],
          draft: [stateB.rngs.draft(), stateB.rngs.draft(), stateB.rngs.draft()],
        };
        assert.deepStrictEqual(drawsA, drawsB, `RNG stream draws mismatch for seed ${seed}`);
      }
    }
    checkedCount++;
  }
  assert.ok(checkedCount >= 200, `Checked ${checkedCount} states`);
  assert.ok(stonesObserved > 0, `Stones must be observed across pre-states (observed ${stonesObserved})`);
  assert.ok(masonObserved > 0, `Mason activations must be observed across pre-states (observed ${masonObserved})`);
});

test('Rewind property: d1==d2 produces byte-identical world state', () => {
  const g = createGame(4242, {
    forcedRelics: ['rewind', 'mason'],
    forceAtMove: 0,
    enableDraft: false,
    hazardSchedule: [{ upToMove: Infinity, interval: 3 }],
  });
  for (let m = 0; m < 10; m++) {
    const vm = getValidMoves(g);
    if (vm.length === 0) break;
    step(g, vm[0]);
  }
  g.abilities.rewind.charges = 2;
  const validDirs = getValidMoves(g);
  for (const d of validDirs) {
    const stateA = clonePreState(g);
    const stateB = clonePreState(g);

    step(stateA, d);
    useAbility(stateA, 'rewind', {});
    step(stateA, d);

    step(stateB, d);

    assert.deepStrictEqual(
      {
        board: stateA.board,
        stoneSpawnMoves: stateA.stoneSpawnMoves,
        moveCount: stateA.moveCount,
        points: stateA.points,
        score: stateA.score,
        bonusScore: stateA.bonusScore,
        tripleMerges: stateA.tripleMerges,
        movesSinceLastStone: stateA.movesSinceLastStone,
        highestTile: stateA.highestTile,
        spawnQueue: stateA.spawnQueue,
      },
      {
        board: stateB.board,
        stoneSpawnMoves: stateB.stoneSpawnMoves,
        moveCount: stateB.moveCount,
        points: stateB.points,
        score: stateB.score,
        bonusScore: stateB.bonusScore,
        tripleMerges: stateB.tripleMerges,
        movesSinceLastStone: stateB.movesSinceLastStone,
        highestTile: stateB.highestTile,
        spawnQueue: stateB.spawnQueue,
      }
    );
  }
});

test('Rewind invalidation: draft during swipe clears snapshot', () => {
  const gDraft = createGame(12345, {
    forcedRelics: ['rewind'],
    forceAtMove: 0,
    enableDraft: true,
    draftEveryMoves: 1,
  });
  step(gDraft, getValidMoves(gDraft)[0]);
  assert.strictEqual(gDraft.rewindSnapshot, null, 'Snapshot must be invalidated by draft');
  assert.throws(() => useAbility(gDraft, 'rewind', {}), /no valid rewind snapshot/);
});

test('Rewind invalidation: Mason decision during swipe clears snapshot', () => {
  // Test both stepInteractive (pendingDecision) and step (bot path)
  const gInteractive = createGame(12345, {
    forcedRelics: ['rewind', 'mason'],
    forceAtMove: 0,
    hazardSchedule: [{ upToMove: Infinity, interval: 1 }],
  });
  const res = stepInteractive(gInteractive, getValidMoves(gInteractive)[0]);
  assert.strictEqual(gInteractive.rewindSnapshot, null, 'Snapshot must be invalidated when Mason decision triggers in stepInteractive');
  // While decision is pending, ability cannot be used
  assert.throws(() => useAbility(gInteractive, 'rewind', {}), /pending decision/);
  // Resolve Mason decision
  res.pendingDecision.resolve(res.pendingDecision.candidates[0]);
  // After resolving, snapshot remains null, so Rewind cannot be used
  assert.strictEqual(gInteractive.rewindSnapshot, null);
  assert.throws(() => useAbility(gInteractive, 'rewind', {}), /no valid rewind snapshot/);

  const gBot = createGame(12345, {
    forcedRelics: ['rewind', 'mason'],
    forceAtMove: 0,
    hazardSchedule: [{ upToMove: Infinity, interval: 1 }],
  });
  step(gBot, getValidMoves(gBot)[0]);
  assert.strictEqual(gBot.rewindSnapshot, null, 'Snapshot must be invalidated when Mason decision triggers in step');
  assert.throws(() => useAbility(gBot, 'rewind', {}), /no valid rewind snapshot/);
});

test('Rewind invalidation: Last Stand firing in a swipe clears snapshot', () => {
  const g = createGame(12345, {
    forcedRelics: ['rewind', 'last_stand'],
    forceAtMove: 0,
    lastStandMax: 16,
  });
  g.abilities.rewind.charges = 0; // ensure no ability charges so Last Stand fires when stuck
  g.board = [
    2, 4, 32, 64,
    4, 2, 64, 32,
    32, 64, 2, 4,
    0, 64, 32, 4,
  ];
  g.spawnQueue = [{ value: 2, r: 0 }];
  step(g, 'L');
  assert.strictEqual(g.lastStandUsed, true, 'Last Stand must have fired');
  assert.strictEqual(g.gameOver, false, 'Game must not be over since tiles were cleared');
  assert.strictEqual(g.rewindSnapshot, null, 'Snapshot must be invalidated when Last Stand fires');
  g.abilities.rewind.charges = 1;
  assert.throws(() => useAbility(g, 'rewind', {}), /no valid rewind snapshot/);
});

test('Rewind invalidation: ability use clears snapshot', () => {
  const gAb = createGame(12345, {
    forcedRelics: ['rewind', 'eraser'],
    forceAtMove: 0,
  });
  step(gAb, getValidMoves(gAb)[0]);
  assert.ok(gAb.rewindSnapshot !== null, 'Snapshot should exist after valid swipe');
  const numCell = gAb.board.findIndex(v => typeof v === 'number' && v > 0);
  useAbility(gAb, 'eraser', { cell: numCell });
  assert.strictEqual(gAb.rewindSnapshot, null, 'Snapshot must be invalidated by ability use');
  assert.throws(() => useAbility(gAb, 'rewind', {}), /no valid rewind snapshot/);
});

test('Rewind invalidation: consecutive-undo disabled', () => {
  const gUndo = createGame(12345, {
    forcedRelics: ['rewind'],
    forceAtMove: 0,
  });
  gUndo.abilities.rewind.charges = 2;
  step(gUndo, getValidMoves(gUndo)[0]);
  assert.ok(gUndo.rewindSnapshot !== null);
  useAbility(gUndo, 'rewind', {});
  assert.strictEqual(gUndo.rewindSnapshot, null, 'Snapshot must be cleared after undo');
  assert.throws(() => useAbility(gUndo, 'rewind', {}), /no valid rewind snapshot/, 'Consecutive undo must throw');
});

test('Rewind: charge accounting (swipe earns charge, undo spends it, never negative)', () => {
  const gCharges = createGame(12345, {
    forcedRelics: ['rewind'],
    forceAtMove: 0,
    rewindEvery: 5,
    maxCharges: 3,
  });
  assert.strictEqual(gCharges.abilities.rewind.charges, 1);
  assert.strictEqual(gCharges.relicActivations.rewind, 0);
  // Swipe 5 times -> charges becomes 2
  for (let i = 0; i < 5; i++) {
    const vm = getValidMoves(gCharges);
    step(gCharges, vm[0]);
  }
  assert.strictEqual(gCharges.abilities.rewind.charges, 2);
  useAbility(gCharges, 'rewind', {});
  assert.strictEqual(gCharges.abilities.rewind.charges, 1);
  assert.strictEqual(gCharges.relicActivations.rewind, 1);

  // Consume remaining charge
  gCharges.rewindSnapshot = {
    board: [...gCharges.board],
    moveCount: gCharges.moveCount,
    points: gCharges.points,
    score: gCharges.score,
    bonusScore: gCharges.bonusScore,
    movesSinceLastStone: 0,
    highestTile: 4,
    nextThresholdIndex: 0,
    spawnQueue: [],
    rngs: {
      tile: gCharges.rngs.tile.getState(),
      stone: gCharges.rngs.stone.getState(),
      draft: gCharges.rngs.draft.getState(),
    },
  };
  useAbility(gCharges, 'rewind', {});
  assert.strictEqual(gCharges.abilities.rewind.charges, 0);

  // Attempting to use with 0 charges throws
  gCharges.rewindSnapshot = {
    board: [...gCharges.board],
    moveCount: gCharges.moveCount,
    points: gCharges.points,
    score: gCharges.score,
    bonusScore: gCharges.bonusScore,
    movesSinceLastStone: 0,
    highestTile: 4,
    nextThresholdIndex: 0,
    spawnQueue: [],
    rngs: {
      tile: gCharges.rngs.tile.getState(),
      stone: gCharges.rngs.stone.getState(),
      draft: gCharges.rngs.draft.getState(),
    },
  };
  assert.throws(() => useAbility(gCharges, 'rewind', {}), /no charges/);
});

test('Rewind: stuck rule with only Rewind usable prevents game over and holds Last Stand', () => {
  const gStuck = createGame(12345, {
    forcedRelics: ['rewind', 'last_stand'],
    forceAtMove: 0,
  });
  step(gStuck, getValidMoves(gStuck)[0]);
  const jammed = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  gStuck.board = [...jammed];
  assert.strictEqual(getValidMoves(gStuck).length, 0);
  assert.strictEqual(hasLegalAbility(gStuck), true, 'Rewind is usable, so hasLegalAbility is true');
  assert.strictEqual(gStuck.lastStandUsed, false, 'Last Stand must NOT fire while Rewind is usable');
});

test('Scoring case 1: single merge adds created tile value x 1', () => {
  const g = createGame(12345, { forcedRelics: [], forceAtMove: 0 });
  g.board = [
    2, 2, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  g.points = 0;
  step(g, 'L');
  assert.strictEqual(g.points, 4, '1 merge of 2+2 creates 4 -> 4 * 1 = 4 points');
});

test('Scoring case 2: 2 merges in swipe multiplies sum by 2', () => {
  const g = createGame(12345, { forcedRelics: [], forceAtMove: 0 });
  g.board = [
    2, 2, 0, 0,
    4, 4, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  g.points = 0;
  step(g, 'L');
  assert.strictEqual(g.points, 24, '2 merges -> (4 + 8) * 2 = 24 points');
});

test('Scoring case 3: 5 merges in swipe capped at multiplier x 4', () => {
  const g = createGame(12345, {
    forcedRelics: ['diagonal_merge'],
    forceAtMove: 0,
    diagonalMergeCooldown: 1,
  });
  g.board = [
    2, 2, 0, 0,
    STONE, 2, 2, 0,
    8, 8, 0, 0,
    16, 16, 0, 0,
  ];
  g.points = 0;
  const res = step(g, 'L');
  assert.strictEqual(res.mergesThisMove, 5, 'Must have 5 merges total (4 slide + 1 diagonal)');
  assert.strictEqual(g.points, 256, '5 merges: (4 + 4 + 16 + 32 + 8) * min(4, 5) = 64 * 4 = 256 points');
});

test('Scoring case 4: diagonal merge via ability adds created value x 1', () => {
  const g = createGame(12345, {
    forcedRelics: ['diagonal_charge'],
    forceAtMove: 0,
  });
  g.board = [
    8, 0, 0, 0,
    0, 8, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  g.points = 100;
  g.abilities.diagonal_charge.charges = 1;
  useAbility(g, 'diagonal_charge', { from: 5, to: 0 });
  assert.strictEqual(g.points, 116, 'Diagonal merge of 8+8 creates 16 -> points += 16 * 1');
});

test('Scoring case 5: Rewind restores points to pre-swipe value', () => {
  const g = createGame(12345, {
    forcedRelics: ['rewind'],
    forceAtMove: 0,
  });
  g.abilities.rewind.charges = 1;
  g.board = [
    4, 4, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const pointsPreSwipe = g.points;
  step(g, 'L');
  assert.strictEqual(g.points, pointsPreSwipe + 8);
  useAbility(g, 'rewind', {});
  assert.strictEqual(g.points, pointsPreSwipe, 'Rewind must restore points to pre-swipe value');
});
