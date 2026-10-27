import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  step,
  stepInteractive,
  getValidMoves,
  getLegalTargets,
  useAbility,
  endRun,
  cloneState,
  STONE,
  buildHazardSchedule,
} from '../engine.js';
import { createBot, createExpectimaxBot } from '../bots.js';
import { pickAbilityAction } from '../action_bots.js';
import { runAscensionPropertyTest } from '../../scripts/run_ascension_property.js';

test('T1: Hand-built ascension test at 2048 threshold', () => {
  const hazardSchedule = [{ upToMove: Infinity, interval: 25 }];
  const game = createGame(12345, {
    ascensionAt: 2048,
    hazardSchedule,
    enableDraft: false,
  });

  // Setup board:
  // Row 0: [1024, 1024, 512, 4]
  // Row 1: [STONE, 8, STONE, 16]
  // Row 2: [2, 0, 0, 0]
  // Row 3: [0, 0, 0, 0]
  const b = new Array(16).fill(0);
  b[0] = 1024; b[1] = 1024; b[2] = 512; b[3] = 4;
  b[4] = STONE; b[5] = 8; b[6] = STONE; b[7] = 16;
  b[8] = 2;
  game.board = b;
  game.points = 0;
  game.score = 0;
  game.moveCount = 0;
  game.movesSinceLastStone = 5;

  const nextSpawnItem = game.spawnQueue[0];
  const secondSpawnItem = game.spawnQueue[1];

  const res = step(game, 'L');
  assert.equal(res.valid, true);

  // Exact assertions:
  // 1. MoveCount incremented by 1
  assert.equal(game.moveCount, 1);

  // 2. Points: merge (2048) + payout (512 + 4 + 8 + 16 + 2 = 542) = 2590
  assert.equal(game.points, 2590);
  // Score = moveCount + bonusScore = 1 + 0 = 1 (payout does NOT change score)
  assert.equal(game.score, 1);

  // 3. Only >= 2048 tiles remain (plus the 1 newly spawned tile from turn step)
  // Check board without the new spawn
  let tilesGte2048 = 0;
  let stonesCount = 0;
  for (const c of game.board) {
    if (c === STONE) stonesCount++;
    if (typeof c === 'number' && c >= 2048) tilesGte2048++;
  }
  assert.equal(stonesCount, 0, 'All stones must be destroyed');
  assert.equal(tilesGte2048, 1, 'Tile 2048 must survive in place at cell 0');
  assert.equal(game.board[0], 2048);

  // 4. Ascension record
  assert.equal(game.ascensionLevel, 2048);
  assert.equal(game.ascensions.length, 1);
  assert.deepEqual(game.ascensions[0], {
    move: 0,
    value: 2048,
    payout: 542,
    destroyedTiles: 5,
    destroyedStones: 2,
  });

  // 5. Stone clock reset: movesSinceLastStone was reset to 0, and turn end step 6 incremented it to 1
  // Next stone will spawn when movesSinceLastStone + 1 >= 25, which is at move 25 (exactly 25 moves after ascension)
  assert.equal(game.movesSinceLastStone, 1);

  // 6. Rewind stack cleared
  assert.equal(game.rewindStack.length, 0);

  // 7. Spawn queue consumed by exactly one draw: nextSpawnItem was consumed, new front is secondSpawnItem
  assert.equal(game.spawnQueue[0].value, secondSpawnItem.value);
  assert.equal(game.board.filter(c => typeof c === 'number' && c > 0).length, 2, 'Board has 2048 and the 1 newly spawned tile');
});

test('T2: Shatter + ascension in same swipe at 64 threshold', () => {
  const game = createGame(12345, {
    ascensionAt: 64,
    forcedRelics: ['shatter'],
    forceAtMove: 0,
    enableDraft: false,
    shatterMin: 64,
  });

  // Cell 0: 32, Cell 1: 32. Cell 4 (directly below cell 0): STONE.
  // Cell 15: STONE (far away, not adjacent to cell 0).
  // Cell 2: 8, Cell 3: 4
  const b = new Array(16).fill(0);
  b[0] = 32; b[1] = 32; b[2] = 8; b[3] = 4;
  b[4] = STONE; // adjacent to 0
  b[15] = STONE; // not adjacent
  game.board = b;
  game.points = 0;

  const res = step(game, 'L');
  assert.equal(res.valid, true);

  // Shatter fired on the adjacent stone before ascension wiped remaining stones
  assert.equal(game.relicActivations['shatter'], 1, 'Shatter must fire on merge');
  assert.equal(game.ascensionLevel, 64);
  assert.equal(game.ascensions.length, 1);
  // Both stones were destroyed (1 by shatter, 1 by ascension)
  assert.equal(game.board.includes(STONE), false);
  assert.equal(game.board[0], 64);
  // Payout: 8 + 4 = 12
  assert.equal(game.ascensions[0].payout, 12);
  // Merge points: 64. Total points: 64 + 12 = 76
  assert.equal(game.points, 76);
});

test('T3: Diagonal merge creates threshold and clears stuck state', () => {
  const game = createGame(12345, {
    ascensionAt: 64,
    forcedRelics: ['diagonal_charge'],
    forceAtMove: 0,
    enableDraft: false,
    maxCharges: 3,
  });

  // Completely full board with no legal moves except diagonal merge
  // Alternating numbers so no orthogonal merges or slides exist
  const b = [
    32, 4, 8, 16,
    8, 32, 16, 8,
    16, 8, 4, 16,
    8, 16, 8, 4,
  ];
  game.board = b;
  game.moveCount = 10;
  game.movesSinceLastStone = 5;

  assert.equal(getValidMoves(game).length, 0, 'No legal swipe moves');
  // Diagonal pair at 0 and 5: both are 32, |dr|=1, |dc|=1
  const targets = getLegalTargets(game, 'diagonal_charge');
  assert.ok(targets.some(t => (t.from === 0 && t.to === 5) || (t.from === 5 && t.to === 0)));

  const queueLenBefore = game.spawnQueue.length;
  const movesBefore = game.moveCount;

  // Use diagonal ability
  const res = useAbility(game, 'diagonal_charge', { from: 0, to: 5 });
  assert.equal(res.valid, true);

  // Assertions:
  assert.equal(game.ascensionLevel, 64);
  assert.equal(game.ascensions.length, 1);
  assert.equal(game.board[5], 64, 'Created 64 survives');
  // All other tiles < 64 were destroyed
  for (let i = 0; i < 16; i++) {
    if (i !== 5 && game.board[i] !== 0) {
      assert.fail(`Cell ${i} should be empty but has ${game.board[i]}`);
    }
  }

  // Free action invariants hold:
  assert.equal(game.moveCount, movesBefore, 'moveCount unchanged by free action');
  assert.equal(game.spawnQueue.length, queueLenBefore, 'spawnQueue untouched');
  assert.equal(game.movesSinceLastStone, 0, 'movesSinceLastStone reset by ascension');
  assert.equal(game.stuckNeedsAbility, false, 'Stuck state cleared by ascension');
  assert.equal(game.gameOver, false, 'Game over cleared');
  assert.ok(getValidMoves(game).length > 0, 'Valid swipe moves now exist');
});

test('T4: Retrigger rules - same threshold does not retrigger; higher threshold does', () => {
  const game = createGame(12345, {
    ascensionAt: 64,
    enableDraft: false,
  });

  // 1. First trigger at 64
  game.board = [
    32, 32, 4, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  step(game, 'L');
  assert.equal(game.ascensionLevel, 64);
  assert.equal(game.ascensions.length, 1);

  // 2. Creating 64 again does NOT trigger
  game.board = [
    64, 32, 32, 8,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  step(game, 'L');
  // Second 64 was created, but ascensionLevel is already 64, so no new ascension
  assert.equal(game.ascensionLevel, 64);
  assert.equal(game.ascensions.length, 1, 'Must not retrigger for same value 64');

  // 3. Merging two 64s into 128 triggers ascension at 128
  game.board = [
    64, 64, 16, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  step(game, 'L');
  assert.equal(game.ascensionLevel, 128);
  assert.equal(game.ascensions.length, 2, 'Must trigger for 128 > 64');
  assert.equal(game.ascensions[1].value, 128);
  // Payout excludes >= 64; tiles 16 and 2 were paid out (16 + 2 = 18)
  assert.equal(game.ascensions[1].payout, 18);
});

test('T5: RNG determinism and spawnQueue invariance with and without ascension', () => {
  const seed = 98765;
  const gameNoAsc = createGame(seed, { ascensionAt: null, enableDraft: false });
  const gameAsc = createGame(seed, { ascensionAt: 64, enableDraft: false });

  // Play fixed directions until move 5
  const dirs = ['L', 'U', 'R', 'D', 'L'];
  for (const d of dirs) {
    step(gameNoAsc, d);
    step(gameAsc, d);
  }

  // Compare RNG states before trigger
  assert.deepEqual(gameAsc.rngs.tile.getState(), gameNoAsc.rngs.tile.getState());
  assert.deepEqual(gameAsc.rngs.stone.getState(), gameNoAsc.rngs.stone.getState());
  assert.deepEqual(gameAsc.rngs.draft.getState(), gameNoAsc.rngs.draft.getState());
  assert.equal(gameAsc.spawnQueue.length, gameNoAsc.spawnQueue.length);

  // Determinism: two identical runs with ascension produce identical logs
  const g1 = createGame(seed, { ascensionAt: 64, enableDraft: false });
  const g2 = createGame(seed, { ascensionAt: 64, enableDraft: false });
  for (const d of ['L', 'U', 'R', 'D', 'L', 'R']) {
    step(g1, d);
    step(g2, d);
  }
  assert.deepEqual(g1.board, g2.board);
  assert.equal(g1.points, g2.points);
  assert.deepEqual(g1.ascensions, g2.ascensions);
});

test('T6: Rewind stack cleared on ascension; cannot rewind past ascension', () => {
  const game = createGame(12345, {
    ascensionAt: 64,
    forcedRelics: ['rewind'],
    forceAtMove: 0,
    enableDraft: false,
    maxCharges: 3,
  });

  game.board = [
    32, 32, 4, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];

  step(game, 'L');
  assert.equal(game.ascensionLevel, 64);
  assert.equal(game.rewindStack.length, 0);

  // Rewind should throw because stack is empty
  assert.throws(() => {
    useAbility(game, 'rewind', null);
  }, /no valid rewind snapshot/);
});

test('T7: Parity between step and stepInteractive with ascension across 100 seeds', () => {
  const configs = [
    { name: 'asc_32', ascensionAt: 32, hazardSchedule: buildHazardSchedule(3), enableDraft: false, moveCap: 200, forcedRelics: ['diagonal_charge'], forceAtMove: 0 },
    { name: 'asc_64', ascensionAt: 64, hazardSchedule: buildHazardSchedule(3), enableDraft: false, moveCap: 200, forcedRelics: ['diagonal_charge'], forceAtMove: 0 },
  ];

  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();
  let parityCount = 0;

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const bot = (i === 0) ? greedyBot : expectimaxBot;

    for (let s = 1; s <= 50; s++) {
      const g1 = createGame(s, cfg);
      const g2 = createGame(s, cfg);

      while (!g1.gameOver && !g1.capped) {
        // Check legal ability first
        const ab = pickAbilityAction(g1);
        if (ab && ab.type === 'ability') {
          useAbility(g1, ab.relic, ab.target);
          useAbility(g2, ab.relic, ab.target);
          continue;
        }

        const moves = getValidMoves(g1);
        if (moves.length === 0) break;
        const d = bot.chooseMove(g1) || moves[0];

        const r1 = step(g1, d, bot);
        const r2 = stepInteractive(g2, d);
        if (!r1.valid || !r2.valid) break;
      }

      const c1 = cloneState(g1);
      const c2 = cloneState(g2);
      delete c1.rngs;
      delete c2.rngs;
      assert.deepStrictEqual(c1, c2, `State mismatch for seed ${s} in config ${cfg.name}`);
      parityCount++;
    }
  }
  assert.equal(parityCount, 100, 'All 100 parity seeds verified');
});

test('T8: Property test across 200 seeds with ascensionAt 64', () => {
  const res = runAscensionPropertyTest(200);
  assert.ok(res.totalAscensions > 0, `Total ascensions (${res.totalAscensions}) must be positive`);
});

test('T9: End run action', () => {
  const game = createGame(12345, { enableDraft: false });
  assert.equal(game.gameOver, false);
  assert.equal(game.endedByPlayer, false);

  step(game, 'L');
  step(game, 'U');
  const moveBeforeEnd = game.moveCount;
  const pointsBeforeEnd = game.points;
  const boardBeforeEnd = [...game.board];

  // End run
  endRun(game);
  assert.equal(game.gameOver, true);
  assert.equal(game.endedByPlayer, true);
  assert.equal(game.moveNumberAtDeath, moveBeforeEnd);
  assert.equal(game.points, pointsBeforeEnd, 'Points must not be altered');
  assert.deepEqual(game.board, boardBeforeEnd, 'Board must not be altered');

  // Calling endRun twice throws
  assert.throws(() => {
    endRun(game);
  }, /game is already over/);

  // Subsequent step is a no-op
  const stepRes = step(game, 'R');
  assert.equal(stepRes.valid, false);

  // Subsequent useAbility throws
  assert.throws(() => {
    useAbility(game, 'eraser', 0);
  }, /game is over/);
});
