import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STONE,
  applySlide,
  applySlidePhase,
  applyFaultLine,
  applyDiagonalMerge,
  slideLineWithStones,
  slideSegment,
  canSlide,
  createGame,
  step,
  peekSpawns,
  spawnOneTile,
  getEffectiveStoneInterval,
  DEFAULT_CONFIG,
} from '../engine.js';
import { chooseStoneCell, countStonesAdjacentToNumberTile, evaluateBoard, createBot, simulateSlideAndPostRelics } from '../bots.js';
import { RELIC_IDS } from '../relics.js';

test('Golden Cases: base 2048 rules sliding left', () => {
  // [2,2,2,2] -> [4,4,0,0]
  const r1 = slideSegment([2, 2, 2, 2], false);
  assert.deepEqual(r1.result, [4, 4, 0, 0]);

  // [2,2,2,0] -> [4,2,0,0]
  const r2 = slideSegment([2, 2, 2, 0], false);
  assert.deepEqual(r2.result, [4, 2, 0, 0]);

  // [4,2,2,0] -> [4,4,0,0]
  const r3 = slideSegment([4, 2, 2, 0], false);
  assert.deepEqual(r3.result, [4, 4, 0, 0]);

  // [2,S,2,0] -> [2,S,2,0] (stone blocks; no merge across it; invalid move)
  const r4 = slideLineWithStones([2, STONE, 2, 0], false);
  assert.deepEqual(r4.line, [2, STONE, 2, 0]);
  const board4 = [
    2, STONE, 2, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  assert.equal(canSlide(board4, 'L', new Set(), null), false, 'Should be an invalid move');

  // [0,2,S,2] -> [2,0,S,2]
  const r5 = slideLineWithStones([0, 2, STONE, 2], false);
  assert.deepEqual(r5.line, [2, 0, STONE, 2]);
  const board5 = [
    0, 2, STONE, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  assert.equal(canSlide(board5, 'L', new Set(), null), true, 'Should be a valid move');
  const slide5 = applySlide(board5, 'L', new Set(), null);
  assert.deepEqual(slide5.board.slice(0, 4), [2, 0, STONE, 2]);
});

test('Relic 1: triple_threat', () => {
  const relics = new Set(['triple_threat']);

  // Golden case 1: [2,2,2,0] left -> [8,0,0,0]
  // Derivation: 3 equal adjacent 2s merge into one tile of 4 * 2 = 8
  const b1 = [
    2, 2, 2, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res1 = applySlide(b1, 'L', relics, null);
  assert.deepEqual(res1.board.slice(0, 4), [8, 0, 0, 0]);

  // Golden case 2: [2,2,2,2] left -> [8,2,0,0]
  // Derivation: First 3 2s merge into 8, 4th tile 2 remains
  const b2 = [
    2, 2, 2, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res2 = applySlide(b2, 'L', relics, null);
  assert.deepEqual(res2.board.slice(0, 4), [8, 2, 0, 0]);

  // Hand-built case 3: [4,2,2,2] left -> [4,8,0,0]
  // Derivation: 4 does not match next 2, next 3 tiles (2,2,2) merge into 8
  const b3 = [
    4, 2, 2, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res3 = applySlide(b3, 'L', relics, null);
  assert.deepEqual(res3.board.slice(0, 4), [4, 8, 0, 0]);
});

test('Relic 2: fault_line', () => {
  const relics = new Set(['fault_line']);

  // Hand-built 1: [0, S, 2, 0] left -> [S, 2, 0, 0]
  // Derivation:
  // Before slide: stone at 1 has empty at 0 and number tile 2 at 2.
  // Stone shifts left to 0 -> [S, 0, 2, 0].
  // Then normal slide left: tile 2 slides up to stone at 0, stopping at 1 -> [S, 2, 0, 0].
  const b1 = [
    0, STONE, 2, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res1 = applySlide(b1, 'L', relics, null);
  assert.deepEqual(res1.board.slice(0, 4), [STONE, 2, 0, 0]);

  // Hand-built 2: [0, S, 2, 2] left -> [S, 4, 0, 0]
  // Derivation:
  // Stone at 1 shifts to 0 -> [S, 0, 2, 2].
  // Normal slide: tiles 2, 2 merge into 4 behind stone at 1 -> [S, 4, 0, 0].
  const b2 = [
    0, STONE, 2, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res2 = applySlide(b2, 'L', relics, null);
  assert.deepEqual(res2.board.slice(0, 4), [STONE, 4, 0, 0]);

  // Hand-built 3: [S, 2, 0, 0] left -> no change (invalid move)
  // Derivation: stone at 0 cannot shift (off board), tile 2 is blocked by stone.
  const b3 = [
    STONE, 2, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res3 = applySlide(b3, 'L', relics, null);
  assert.equal(res3.changed, false);
});

test('Relic 3: pressure_cooker', () => {
  const relics = new Set(['pressure_cooker']);
  const config = { ...DEFAULT_CONFIG };

  // Hand-built 1: Stone interval calculation
  // Base intervals: 25, 20, 15, 10
  // With pressure cooker: max(3, round(interval * 0.7))
  // 25 * 0.7 = 17.5 -> round = 18
  // 20 * 0.7 = 14 -> 14
  // 15 * 0.7 = 10.5 -> round = 11
  // 10 * 0.7 = 7 -> 7
  assert.equal(getEffectiveStoneInterval(50, config, relics), 18);
  assert.equal(getEffectiveStoneInterval(150, config, relics), 14);
  assert.equal(getEffectiveStoneInterval(250, config, relics), 11);
  assert.equal(getEffectiveStoneInterval(350, config, relics), 7);

  // Hand-built 2: Score = moveCount + bonusScore (+2 per merge)
  // Derive: game starts with 0 moves and 0 bonusScore.
  // Set board with 2 merges on move 1: [2,2,4,4] -> [4,8,0,0] (2 merges).
  // bonusScore should be 2 * 2 = 4. moveCount = 1. score = 5.
  const game = createGame(1, { forcedRelics: ['pressure_cooker'], initialTiles: 0 });
  game.board = [
    2, 2, 4, 4,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const stepRes = step(game, 'L');
  assert.equal(stepRes.valid, true);
  assert.equal(game.moveCount, 1);
  assert.equal(game.bonusScore, 4);
  assert.equal(game.score, 5);
});

test('Relic 4: diagonal_merge', () => {
  // Hand-built 1: Cooldown 1. Diagonal merge applies immediately after slide.
  // Derive: (0,0)=4, (1,1)=4. They are diagonally adjacent.
  // Slide Down does not merge them (different columns).
  // Post-slide: (0,0) and (1,1) merge into (0,0)=8 (earlier row-major cell), (1,1)=0.
  const b1 = [
    4, 0, 0, 0,
    0, 4, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  // moveCount is 0, so next move is move #1. Cooldown 1 -> 1 % 1 == 0 triggers.
  const res1 = applyDiagonalMerge(b1, 0, 1);
  assert.equal(res1.merged, true);
  assert.equal(res1.board[0], 8);
  assert.equal(res1.board[5], 0);

  // Hand-built 2: Tie-breaker: highest value first.
  // Pair A: (0,0)=2 and (1,1)=2.
  // Pair B: (0,3)=4 and (1,2)=4.
  // The pair of 4s has higher value -> merges into (0,3)=8 and (1,2)=0. The 2s remain.
  const b2 = [
    2, 0, 0, 4,
    0, 2, 4, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const res2 = applyDiagonalMerge(b2, 0, 1);
  assert.equal(res2.merged, true);
  assert.equal(res2.board[3], 8); // (0,3) became 8
  assert.equal(res2.board[6], 0); // (1,2) became 0
  assert.equal(res2.board[0], 2); // pair A untouched
  assert.equal(res2.board[5], 2);

  // Hand-built 3: Cooldown 3.
  // Move 1 (moveCount 0): (0+1)%3 = 1 -> no
  // Move 2 (moveCount 1): (1+1)%3 = 2 -> no
  // Move 3 (moveCount 2): (2+1)%3 = 0 -> yes!
  assert.equal(applyDiagonalMerge(b1, 0, 3).merged, false);
  assert.equal(applyDiagonalMerge(b1, 1, 3).merged, false);
  assert.equal(applyDiagonalMerge(b1, 2, 3).merged, true);
});

test('Relic 5: mason', () => {
  // Hand-built 1: Stone-cell choice minimizes orthogonal adjacency to numbers.
  // Candidates: cell 0 (0,0) and cell 15 (3,3).
  // Cell 0 has neighbors cell 1 and cell 4: let cell 1=2 and cell 4=4 (2 number neighbors).
  // Cell 15 has neighbors cell 11 and cell 14: both are 0 (0 number neighbors).
  // Mason bot should choose candidate cell 15.
  const state1 = {
    board: [
      0, 2, 0, 0,
      4, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]
  };
  const pick1 = chooseStoneCell(state1, [0, 15]);
  assert.equal(pick1, 15);

  // Hand-built 2: Tie-breaker by row-major order.
  // Both cells have 0 number neighbors: candidate 2 vs candidate 14.
  // Should pick 2 (earlier row-major).
  const state2 = {
    board: new Array(16).fill(0),
  };
  const pick2 = chooseStoneCell(state2, [14, 2]);
  assert.equal(pick2, 2);

  // Hand-built 3: Single empty cell -> automatically used.
  assert.equal(chooseStoneCell(state2, [7]), 7);
});

test('Relic 6: anchor_row', () => {
  const relics = new Set(['anchor_row']);
  const anchor = { type: 'row', index: 3 }; // bottom row (row 3: cells 12, 13, 14, 15)

  // Hand-built 1: Sliding ALONG the anchored line (slide Left).
  // Anchored row 3 has [2, 2, 4, 4] -> does not move or merge!
  // Row 0 has [2, 2, 0, 0] -> slides left to [4, 0, 0, 0].
  const b1 = [
    2, 2, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    2, 2, 4, 4,
  ];
  const res1 = applySlide(b1, 'L', relics, anchor);
  assert.deepEqual(res1.board.slice(0, 4), [4, 0, 0, 0]);
  assert.deepEqual(res1.board.slice(12, 16), [2, 2, 4, 4]);

  // Hand-built 2: Sliding PERPENDICULAR to anchored line (slide Down).
  // Anchored row 3: [4, 0, 2, S]
  // Row 2:          [4, 8, 4, 2]
  // Col 0: arriving 4 merges into anchored 4 -> anchored cell doubles to 8.
  // Col 1: anchored cell was 0, arriving 8 enters empty anchored cell and becomes fixed!
  // Col 2: arriving 4 does not match anchored 2, stops adjacent at row 2 col 2.
  // Col 3: anchored is stone S, arriving 2 stops adjacent at row 2 col 3.
  const b2 = [
    0, 0, 0, 0,
    0, 0, 0, 0,
    4, 8, 4, 2,
    4, 0, 2, STONE,
  ];
  const res2 = applySlide(b2, 'D', relics, anchor);
  assert.deepEqual(res2.board.slice(8, 12), [0, 0, 4, 2]); // Row 2
  assert.deepEqual(res2.board.slice(12, 16), [8, 8, 2, STONE]); // Row 3
});

test('Relic 7: foresight', () => {
  // Hand-built 1: engine exposes peekSpawns(2) with next 2 (value, r) and stoneDue without altering stream.
  const game = createGame(42, { forcedRelics: ['foresight'] });
  const peek1 = peekSpawns(game, 2);
  assert.equal(peek1.spawns.length, 2);
  assert.equal(typeof peek1.stoneDue, 'boolean');

  // Peek again -> must return identical spawns
  const peek2 = peekSpawns(game, 2);
  assert.deepEqual(peek1.spawns, peek2.spawns);

  // Hand-built 2: greedy bot with foresight uses lookahead with peeked spawn
  const bot = createBot('greedy');
  const move = bot.chooseMove(game);
  assert.ok(['L', 'R', 'U', 'D'].includes(move));
});

test('Relic 8: gravity_well', () => {
  // Hand-built 1: Tile spawns favor 8-neighborhood of highest tile.
  // Max tile = 64 at cell 5 (row 1, col 1).
  // Empty cells exist in its 8-neighborhood (e.g. cell 0, 1, 2, 4, 6, 8, 9, 10).
  // Empty cell 15 is outside the 8-neighborhood.
  // All spawns should fall in the 8-neighborhood while it has empty space.
  const game = createGame(100, { forcedRelics: ['gravity_well'], initialTiles: 0 });
  game.board = [
    0, 0, 0, 0,
    0, 64, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const spawned = spawnOneTile(game);
  assert.equal(spawned, true);

  // Check where the new tile spawned
  let spawnedCell = -1;
  for (let i = 0; i < 16; i++) {
    if (i !== 5 && game.board[i] > 0) {
      spawnedCell = i;
      break;
    }
  }
  const r = Math.floor(spawnedCell / 4);
  const c = spawnedCell % 4;
  assert.ok(Math.abs(r - 1) <= 1 && Math.abs(c - 1) <= 1, 'Spawn must be in 8-neighborhood of (1,1)');

  // Hand-built 2: Fall back to uniformly random empty cell when 8-neighborhood is full.
  const game2 = createGame(101, { forcedRelics: ['gravity_well'], initialTiles: 0 });
  // Surround (1,1) completely with stones
  game2.board = [
    STONE, STONE, STONE, 0,
    STONE, 128,   STONE, 0,
    STONE, STONE, STONE, 0,
    0,     0,     0,     0,
  ];
  const spawned2 = spawnOneTile(game2);
  assert.equal(spawned2, true);
  // Verify a tile spawned in one of the remaining empty cells
  const emptyRemaining = game2.board.filter(x => x === 0).length;
  assert.equal(emptyRemaining, 6);
});

test('Determinism: same seed twice produces identical run', () => {
  const seed = 54321;
  const bot1 = createBot('greedy', seed);
  const game1 = createGame(seed);

  const history1 = [];
  for (let m = 0; m < 50; m++) {
    if (game1.gameOver) break;
    const move = bot1.chooseMove(game1);
    if (!move) break;
    step(game1, move, bot1);
    history1.push({
      move,
      board: [...game1.board],
      score: game1.score,
      relics: [...game1.relics],
    });
  }

  const bot2 = createBot('greedy', seed);
  const game2 = createGame(seed);
  const history2 = [];
  for (let m = 0; m < 50; m++) {
    if (game2.gameOver) break;
    const move = bot2.chooseMove(game2);
    if (!move) break;
    step(game2, move, bot2);
    history2.push({
      move,
      board: [...game2.board],
      score: game2.score,
      relics: [...game2.relics],
    });
  }

  assert.deepEqual(history1, history2, 'Runs with same seed must be byte-identical');
});

test('No relics == standard 2048 behavior', () => {
  // Standard 2048: no stones until move 25, no relic effects, standard pair merges.
  const game = createGame(777, { initialTiles: 2 });
  assert.equal(game.relics.size, 0);

  // Verify initial board has exactly 2 tiles, values in {2, 4}
  const nonZero = game.board.filter(v => v > 0);
  assert.equal(nonZero.length, 2);
  assert.ok(nonZero.every(v => v === 2 || v === 4));

  // Verify that an invalid move does not change board or increment moveCount
  const originalBoard = [...game.board];
  const invalidDir = ['L', 'R', 'U', 'D'].find(dir => !canSlide(game.board, dir, game.relics, null));
  if (invalidDir) {
    const res = step(game, invalidDir);
    assert.equal(res.valid, false);
    assert.deepEqual(game.board, originalBoard);
    assert.equal(game.moveCount, 0);
  }

  // Play 10 valid moves and verify standard increments
  const bot = createBot('corner');
  for (let i = 0; i < 10; i++) {
    if (game.gameOver) break;
    const move = bot.chooseMove(game);
    if (!move) break;
    const stepRes = step(game, move, bot);
    assert.equal(stepRes.valid, true);
  }
  assert.equal(game.moveCount, 10);
  // Stones only spawn from move 25 onward in standard schedule
  assert.equal(game.board.includes(STONE), false);
  assert.equal(game.bonusScore, 0);
  assert.equal(game.score, 10);
});

test('Regression: anchor_row initial game-over when all tiles land on anchored row', () => {
  // Derived from seed 228 dump:
  // Board: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,4,2]
  // All tiles on anchored row 3. All 4 directions are no-ops.
  // BEFORE FIX: gameOver stayed false. AFTER FIX: gameOver=true at createGame().
  const game = createGame(228, { forcedRelics: ['anchor_row'], enableDraft: false });
  assert.equal(game.board.slice(0, 12).every(v => v === 0), true, 'Rows 0-2 should be empty');
  const row3HasTiles = game.board.slice(12).some(v => typeof v === 'number' && v > 0);
  assert.equal(row3HasTiles, true, 'Row 3 should have tiles');
  assert.equal(game.gameOver, true, 'Should be immediately over when all tiles are anchored');
  assert.equal(game.moveCount, 0, 'moveCount should be 0');

  // Complementary: a game with tiles NOT all on anchored row must NOT be dead
  const game2 = createGame(42, { forcedRelics: ['anchor_row'], enableDraft: false });
  if (!game2.gameOver) {
    const vm = ['L', 'R', 'U', 'D'].filter(d => canSlide(game2.board, d, game2.relics, game2.anchor));
    assert.ok(vm.length > 0, 'Non-dead game should have valid moves');
  }
});

test('Invariant: gameOver iff all four slides are no-ops (all 8 relic solos, 2000 boards each)', () => {
  // Generate 2000 reachable boards per relic by playing 30 corner-bot moves.
  // Assert game.gameOver === (no valid slide exists).
  const RELIC_LIST = [
    'triple_threat', 'fault_line', 'pressure_cooker', 'diagonal_merge',
    'mason', 'anchor_row', 'foresight', 'gravity_well'
  ];
  const bot = createBot('corner');
  let failures = 0;
  const failureDetails = [];

  for (const relic of RELIC_LIST) {
    for (let i = 0; i < 2000; i++) {
      const seed = (i * 37 + 0xabcd) >>> 0;
      const game = createGame(seed, { forcedRelics: [relic], enableDraft: false });
      for (let m = 0; m < 30; m++) {
        if (game.gameOver || game.capped) break;
        const move = bot.chooseMove(game);
        if (!move) break;
        step(game, move, bot);
      }
      const validMoves = ['L', 'R', 'U', 'D'].filter(d => canSlide(game.board, d, game.relics, game.anchor));
      const shouldBeOver = validMoves.length === 0;
      if (game.gameOver !== shouldBeOver) {
        failures++;
        failureDetails.push({ relic, seed, gameOver: game.gameOver, shouldBeOver });
      }
    }
  }
  if (failures > 0) console.error('Failures (first 3):', JSON.stringify(failureDetails.slice(0, 3)));
  assert.equal(failures, 0, `gameOver invariant violated on ${failures} boards`);
});

test('enableDraft: false produces zero drafts regardless of tile value', () => {
  // 500 greedy games with enableDraft: false -> no relics picked, draftHistory empty.
  const bot = createBot('greedy', 9999);
  for (let i = 0; i < 500; i++) {
    const seed = (42 + i * 17) >>> 0;
    const game = createGame(seed, { enableDraft: false, forcedRelics: [] });
    while (!game.gameOver && !game.capped) {
      const move = bot.chooseMove(game);
      if (!move) break;
      step(game, move, bot);
    }
    assert.equal(game.draftHistory.length, 0,
      `Seed ${seed}: draftHistory should be empty with enableDraft: false`);
    assert.equal(game.relics.size, 0,
      `Seed ${seed}: no relics should be acquired with enableDraft: false`);
  }
});

test('Tile-sum invariant: no-relic slide preserves sum; triple_threat raises by v per triple merge', () => {
  // Part 1: no relics -> applySlide preserves tile sum
  const noRelics = new Set();
  const sumBoard = b => b.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  const boards = [
    [2, 2, 4, 4,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0],
    [2, 0, 2, 0,  4, 0, 4, 0,  8, 0, 8, 0,  0, 0, 0, 0],
    [2, 4, 8, 16, 0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0],
  ];
  for (const board of boards) {
    for (const dir of ['L', 'R', 'U', 'D']) {
      const res = applySlide(board, dir, noRelics, null);
      assert.equal(sumBoard(res.board), sumBoard(board),
        `No-relic slide ${dir} changed tile sum`);
    }
  }

  // Part 2: triple_threat -> 3-tile merge of v: output=4v, net delta=+v vs normal pair (2v)
  const ttRelics = new Set(['triple_threat']);
  {
    const board = [2, 2, 2, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
    const res = applySlide(board, 'L', ttRelics, null);
    assert.equal(res.tripleCount, 1, 'Should be exactly 1 triple merge');
    assert.equal(sumBoard(res.board) - sumBoard(board), 2,
      'Sum delta should equal v=2 for one triple merge of 2s');
  }
  {
    const board = [4, 4, 4, 0,  4, 4, 4, 0,  0, 0, 0, 0,  0, 0, 0, 0];
    const res = applySlide(board, 'L', ttRelics, null);
    assert.equal(res.tripleCount, 2, 'Should be exactly 2 triple merges');
    assert.equal(sumBoard(res.board) - sumBoard(board), 8,
      'Sum delta should equal 2*v=8 for two triple merges of 4s');
  }

  // Part 3: state.tripleMerges counter accumulates correctly
  const game = createGame(1, { forcedRelics: ['triple_threat'], initialTiles: 0, enableDraft: false });
  game.board = [2, 2, 2, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  assert.equal(game.tripleMerges, 0, 'tripleMerges should start at 0');
  step(game, 'L');
  assert.equal(game.tripleMerges, 1, 'tripleMerges should be 1 after one triple merge');
  game.board = [4, 4, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'L');
  assert.equal(game.tripleMerges, 1, 'tripleMerges must not increase on a pair merge');
});

test('Option forceAtMove: relics are injected at exact specified moveCount', () => {
  const game = createGame(42, {
    forcedRelics: ['pressure_cooker', 'anchor_row'],
    forceAtMove: 5,
    enableDraft: false,
    initialTiles: 0,
  });
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];

  assert.equal(game.relics.size, 0, 'Relics should not be active at start');
  assert.equal(game.anchor, null, 'Anchor should not be active at start');

  for (let m = 0; m < 4; m++) {
    // Keep 1 tile moving back and forth
    game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
    step(game, 'R');
    assert.equal(game.relics.size, 0, `Relics should not be active at move ${game.moveCount}`);
  }

  // Next move is moveCount 4 -> 5. At start of step, moveCount is 4.
  // Wait, let's check exact condition:
  // state.moveCount === state.config.forceAtMove
  // If forceAtMove is 5: when moveCount === 5 at turn start, relics are injected!
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'R'); // moveCount becomes 5
  assert.equal(game.moveCount, 5);
  assert.equal(game.relics.size, 0, 'Not injected yet before turn 5 begins');

  // Turn 6: moveCount is 5 entering step() -> matches forceAtMove: 5!
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'R');
  assert.ok(game.relics.has('pressure_cooker'), 'pressure_cooker should be active now');
  assert.ok(game.relics.has('anchor_row'), 'anchor_row should be active now');
  assert.ok(game.anchor !== null, 'anchor object should be initialized');
});

test('Option draftEveryMoves: triggers drafts at fixed move intervals with thresholds off', () => {
  const game = createGame(123, {
    enableDraft: true,
    draftThresholds: [],
    draftEveryMoves: 3,
    initialTiles: 0,
  });

  // Move 1: tile at 0 slides R to 3
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'R');
  assert.equal(game.draftHistory.length, 0);

  // Move 2: tile at 3 slides L to 0
  game.board = [0, 0, 0, 2,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'L');
  assert.equal(game.draftHistory.length, 0);

  // Move 3: tile at 0 slides R to 3 -> triggers draft #1 at move 3
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'R');
  assert.equal(game.draftHistory.length, 1, 'Draft #1 should trigger at move 3');
  assert.equal(game.relics.size, 1);
  assert.equal(game.draftHistory[0].move, 3);

  // Move 4 & 5
  game.board = [0, 0, 0, 2,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'L');
  game.board = [2, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'R');
  assert.equal(game.draftHistory.length, 1);

  // Move 6: tile at 3 slides L to 0 -> triggers draft #2 at move 6
  game.board = [0, 0, 0, 2,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
  step(game, 'L');
  assert.equal(game.draftHistory.length, 2, 'Draft #2 should trigger at move 6');
  assert.equal(game.relics.size, 2);
  assert.equal(game.draftHistory[1].move, 6);
});

test('Option stoneLifetime: decaying stone is removed at step 6 once L moves old', () => {
  const game = createGame(999, {
    stoneLifetime: 2,
    enableDraft: false,
    initialTiles: 0,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }], // don't auto-spawn extra stones
  });

  // Manually place a stone on cell 5 with spawn move = 1
  game.board[5] = STONE;
  game.stoneSpawnMoves[5] = 1;
  game.moveCount = 1;

  // Move 2: age = 2 - 1 = 1 < 2 -> stone remains
  game.board[0] = 2;
  step(game, 'R'); // moveCount becomes 2; at step 6: age = 2 - 1 = 1
  assert.equal(game.board[5], STONE, 'Stone should remain at age 1');

  // Move 3: moveCount becomes 3; at step 6: age = 3 - 1 = 2 >= stoneLifetime(2) -> removed!
  game.board[0] = 2;
  step(game, 'L'); // moveCount becomes 3; at start of step 6: age = 3 - 1 = 2 >= 2
  assert.equal(game.board[5], 0, 'Stone should decay and be removed once L=2 moves old');
  assert.equal(game.stoneSpawnMoves[5], null, 'stoneSpawnMoves should be cleared');
});

test('Relic 9: siphon hand-built tests', () => {
  // Test 1: Merge creates tile >= siphonMin (16).
  // Derivation:
  // Initial board has [8, 8, 0, 0] on top row. All other cells 0.
  // Move 'L': 8 and 8 merge into 16.
  // 16 >= siphonMin (default 16). Siphon triggers: tile spawn is skipped.
  // Result: exactly 1 tile (16) on the board at (0,0), and relicActivations['siphon'] == 1.
  const game1 = createGame(1234, {
    forcedRelics: ['siphon'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    siphonMin: 16,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game1.board = [
    8, 8, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const stepRes1 = step(game1, 'L');
  assert.equal(stepRes1.valid, true);
  assert.equal(game1.relicActivations['siphon'], 1, 'siphon should activate');
  // Tile spawn was skipped, so only the merged 16 should be on the board
  assert.equal(game1.board[0], 16);
  const nonZeroCount1 = game1.board.filter(x => x !== 0).length;
  assert.equal(nonZeroCount1, 1, 'Tile spawn was skipped, only 1 tile remains on board');

  // Test 2: Merge creates tile < siphonMin (8 < 16).
  // Derivation:
  // Initial board has [4, 4, 0, 0] on top row.
  // Move 'L': 4 and 4 merge into 8.
  // 8 < siphonMin (16). Siphon does NOT trigger: tile spawn executes normally.
  // Result: 2 tiles on board (the merged 8 plus 1 spawned tile), and relicActivations['siphon'] == 0.
  const game2 = createGame(1234, {
    forcedRelics: ['siphon'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    siphonMin: 16,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game2.board = [
    4, 4, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const stepRes2 = step(game2, 'L');
  assert.equal(stepRes2.valid, true);
  assert.equal(game2.relicActivations['siphon'], 0, 'siphon should not activate for tile < 16');
  const nonZeroCount2 = game2.board.filter(x => x !== 0).length;
  assert.equal(nonZeroCount2, 2, 'Tile spawn executes normally, exactly 2 tiles on board');
});

test('Relic 10: shatter hand-built tests', () => {
  // Test 1: Merge creates tile >= shatterMin (64).
  // Derivation:
  // Initial board has [STONE, 32, 32, STONE] on row 0, and [0, STONE, 0, 0] on row 1.
  // Cells:
  // (0,0) = STONE, (0,1) = 32, (0,2) = 32, (0,3) = STONE
  // (1,1) = STONE
  // Slide 'L': 32 and 32 merge into 64 at (0,1).
  // 64 >= shatterMin (default 64).
  // Orthogonal neighbors of (0,1) are (0,0), (0,2), (1,1).
  // (0,0) has STONE -> destroyed!
  // (1,1) has STONE -> destroyed!
  // (0,3) is not adjacent to (0,1) -> remains STONE!
  const game1 = createGame(5678, {
    forcedRelics: ['shatter'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    shatterMin: 64,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game1.board = [
    STONE, 32, 32, STONE,
    0,     STONE, 0, 0,
    0,     0,     0, 0,
    0,     0,     0, 0,
  ];
  step(game1, 'L');
  assert.equal(game1.relicActivations['shatter'], 1, 'shatter should activate');
  assert.equal(game1.board[0], 0, 'Stone at (0,0) orthogonally adjacent to 64 should be shattered');
  assert.equal(game1.board[5], 0, 'Stone at (1,1) orthogonally adjacent to 64 should be shattered');
  assert.equal(game1.board[3], STONE, 'Stone at (0,3) not adjacent to 64 should remain intact');

  // Test 2: Merge creates tile < shatterMin (32 < 64).
  // Derivation:
  // Initial board has [STONE, 16, 16, 0] on row 0, and [0, STONE, 0, 0] on row 1.
  // Slide 'L': 16 and 16 merge into 32 at (0,1).
  // 32 < shatterMin (64). Shatter does NOT trigger.
  // Adjacent stones at (0,0) and (1,1) remain STONE.
  const game2 = createGame(5678, {
    forcedRelics: ['shatter'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    shatterMin: 64,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game2.board = [
    STONE, 16, 16, 0,
    0,     STONE, 0, 0,
    0,     0,     0, 0,
    0,     0,     0, 0,
  ];
  step(game2, 'L');
  assert.equal(game2.relicActivations['shatter'], 0, 'shatter should not activate for merge < 64');
  assert.equal(game2.board[0], STONE, 'Stone at (0,0) should remain STONE');
  assert.equal(game2.board[5], STONE, 'Stone at (1,1) should remain STONE');
});

test('Relic 11: last_stand hand-built tests', () => {
  // Test 1: On no valid slide, removes tiles <= lastStandMax (16) and allows game to continue.
  // Derivation:
  // Initial board:
  // Row 0: [ 2,  4,  8, 16]
  // Row 1: [ 4,  8, 16, 32]
  // Row 2: [ 2,  4,  8, 16]
  // Row 3: [ 4,  8, 32, 32]
  // Pre-drawn spawn queue: value 2
  // Action: Slide 'L'.
  // Row 3 merges 32 and 32 into 64 at (3, 2), leaving (3, 3) empty.
  // Tile spawn places 2 at (3, 3).
  // Now board has NO equal adjacent neighbors horizontally or vertically:
  // Col 0: 2, 4, 2, 4 (no match)
  // Col 1: 4, 8, 4, 8 (no match)
  // Col 2: 8, 16, 8, 64 (no match)
  // Col 3: 16, 32, 16, 2 (no match)
  // Normally step 7 triggers gameOver because getValidMoves is empty.
  // With last_stand: all number tiles <= 16 are removed.
  // Only tiles 32 at (1,3) and 64 at (3,2) remain, freeing 14 cells.
  // Valid moves now exist, gameOver is false, and lastStandUsed is true!
  const game1 = createGame(4321, {
    forcedRelics: ['last_stand'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    lastStandMax: 16,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game1.board = [
    2,  4,  8, 16,
    4,  8, 16, 32,
    2,  4,  8, 16,
    4,  8, 32, 32,
  ];
  game1.spawnQueue = [{ value: 2, r: 0.5 }];
  step(game1, 'L');
  assert.equal(game1.lastStandUsed, true, 'lastStandUsed flag should be true');
  assert.equal(game1.relicActivations['last_stand'], 1, 'last_stand should activate');
  assert.equal(game1.gameOver, false, 'game should NOT be over after last_stand clears low tiles');

  // Test 2: On no valid slide, if all tiles are > lastStandMax (e.g. all 32, 64, 128, 256, 512),
  // last_stand removes nothing and game over is triggered.
  // Derivation:
  // Initial board has all tiles >= 32:
  // Row 0: [ 32,  64,  32,  64]
  // Row 1: [ 64, 128,  64, 128]
  // Row 2: [ 32,  64,  32,  64]
  // Row 3: [ 64, 128, 256, 256]
  // Pre-drawn spawn queue: value 32
  // Action: Slide 'L'.
  // Row 3 merges 256 and 256 into 512 at (3, 2), leaving (3, 3) empty.
  // Spawn places 32 at (3, 3).
  // Every tile on the board is now >= 32. No valid slide exists.
  // last_stand triggers, but no tiles are <= 16.
  // 0 tiles are removed. No valid slide still exists.
  // Therefore gameOver is true!
  const game2 = createGame(4321, {
    forcedRelics: ['last_stand'],
    forceAtMove: 0,
    enableDraft: false,
    initialTiles: 0,
    lastStandMax: 16,
    hazardSchedule: [{ upToMove: Infinity, interval: 9999 }],
  });
  game2.board = [
    32,  64,  32,  64,
    64, 128,  64, 128,
    32,  64,  32,  64,
    64, 128, 256, 256,
  ];
  game2.spawnQueue = [{ value: 32, r: 0.5 }];
  step(game2, 'L');
  assert.equal(game2.lastStandUsed, true);
  assert.equal(game2.relicActivations['last_stand'], 1);
  assert.equal(game2.gameOver, true, 'game should be over since no tiles <= 16 could be removed');
});

test('No-relic behavior is completely unchanged by new relics', () => {
  const seed = 777;
  const game1 = createGame(seed, { enableDraft: false });
  const game2 = createGame(seed, { enableDraft: false });

  for (let m = 0; m < 50; m++) {
    const valid1 = canSlide(game1.board, 'L', game1.relics, game1.anchor) ? 'L' : 'D';
    const valid2 = canSlide(game2.board, 'L', game2.relics, game2.anchor) ? 'L' : 'D';
    assert.equal(valid1, valid2);
    step(game1, valid1);
    step(game2, valid2);
    assert.deepEqual(game1.board, game2.board);
    assert.equal(game1.score, game2.score);
    assert.equal(game1.moveCount, game2.moveCount);
  }
});

test('Expectimax simulated slide equals engine slide on 200 random boards for every relic', () => {
  // Test every relic in RELIC_IDS
  for (const relicId of RELIC_IDS) {
    for (let b = 0; b < 200; b++) {
      const seed = 50000 + b;
      const game = createGame(seed, {
        forcedRelics: [relicId],
        forceAtMove: 0,
        enableDraft: false,
      });

      // Populate random tiles and stones on board
      const rng = game.rngs.tile;
      const board = new Array(16).fill(0);
      const tileValues = [2, 4, 8, 16, 32, 64, 128, 256];
      for (let c = 0; c < 16; c++) {
        const r = rng();
        if (r < 0.2) {
          board[c] = STONE;
        } else if (r < 0.8) {
          const valIdx = Math.floor(rng() * tileValues.length);
          board[c] = tileValues[valIdx];
        }
      }

      game.board = board;

      for (const dir of ['L', 'R', 'U', 'D']) {
        const botSim = simulateSlideAndPostRelics(board, dir, game, 0);
        const engineRes = applySlidePhase(
          board,
          dir,
          game.relics,
          game.anchor,
          game.moveCount,
          game.config,
          game.stoneSpawnMoves
        );

        if (!engineRes.changed) {
          assert.equal(botSim, null, `Bot simulation should be null for invalid move ${dir} with relic ${relicId}`);
        } else {
          assert.notEqual(botSim, null, `Bot simulation should not be null for valid move ${dir} with relic ${relicId}`);
          assert.deepEqual(botSim.board, engineRes.board, `Boards must match identically for ${dir} with relic ${relicId}`);
          assert.equal(botSim.mergesCount, engineRes.mergesCount, `Merges count must match identically for ${dir} with relic ${relicId}`);
        }
      }
    }
  }
});


test('Deterministic draft: same seed+config gives identical picks for random and rollout; draftPool restricts offers', () => {
  // Part 1: Same seed + config gives identical picks under 'random' policy across two runs
  const configRandom = {
    hazardSchedule: [{ upToMove: Infinity, interval: 30 }],
    enableDraft: true,
    draftThresholds: [],
    draftEveryMoves: 25,
    draftPolicy: 'random',
    forcedRelics: [],
    forceAtMove: 0,
    stoneLifetime: null,
  };

  const seed = 55555;
  const runGame = (cfg) => {
    const game = createGame(seed, cfg);
    const bot = { chooseMove(s) { return ['L','D','R','U'].find(d => { const r = applySlide(s.board, d, s.relics, s.anchor); return r.changed; }) || null; } };
    for (let i = 0; i < 200 && !game.gameOver && !game.capped; i++) {
      const m = bot.chooseMove(game);
      if (!m) break;
      step(game, m, bot);
    }
    return game;
  };

  const g1 = runGame(configRandom);
  const g2 = runGame(configRandom);
  // Both runs must produce identical draft histories
  assert.equal(g1.draftHistory.length, g2.draftHistory.length, 'Draft history lengths must match for same seed');
  for (let i = 0; i < g1.draftHistory.length; i++) {
    assert.deepEqual(g1.draftHistory[i].offers, g2.draftHistory[i].offers, `Offers at draft ${i} must match`);
    assert.equal(g1.draftHistory[i].pick, g2.draftHistory[i].pick, `Pick at draft ${i} must match`);
  }

  // Part 2: draftPool restricts what can be offered
  const restrictedPool = ['siphon', 'shatter', 'foresight'];
  const configRestricted = {
    ...configRandom,
    draftPool: restrictedPool,
  };
  const g3 = runGame(configRestricted);
  for (const draft of g3.draftHistory) {
    for (const offer of draft.offers) {
      assert.ok(restrictedPool.includes(offer), `Offered relic "${offer}" not in draftPool [${restrictedPool}]`);
    }
    assert.ok(restrictedPool.includes(draft.pick), `Picked relic "${draft.pick}" not in draftPool`);
  }

  // Part 3: draftPool restricts independently of policy — verify picks are subset of pool for rollout too
  // (rollout policy delegates to chooseDraftRelic; if absent, uses random stream — still constrained by pool)
  const configRolloutRestricted = {
    ...configRestricted,
    draftPolicy: 'rollout',
  };
  const g4 = runGame(configRolloutRestricted);
  for (const draft of g4.draftHistory) {
    for (const offer of draft.offers) {
      assert.ok(restrictedPool.includes(offer), `Rollout: offered "${offer}" not in draftPool`);
    }
    assert.ok(restrictedPool.includes(draft.pick), `Rollout: picked "${draft.pick}" not in draftPool`);
  }
});

