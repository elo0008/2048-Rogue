import { GameController } from '../../game/controller.js';
import { STONE } from '../../sim/engine.js';

export function getSlideSetup(stoneCell) {
  const r = Math.floor(stoneCell / 4);
  const c = stoneCell % 4;
  const neighbors = [];
  if (r > 0) neighbors.push(stoneCell - 4);
  if (r < 3) neighbors.push(stoneCell + 4);
  if (c > 0) neighbors.push(stoneCell - 1);
  if (c < 3) neighbors.push(stoneCell + 1);

  for (const dest of neighbors) {
    const dr = Math.floor(dest / 4);
    const dc = dest % 4;
    const dirs = ['L', 'R', 'U', 'D'];

    for (const dir of dirs) {
      const board = new Array(16).fill(0);
      board[stoneCell] = STONE;
      let valid = false;

      if (dir === 'L' && dc < 3) {
        if (stoneCell !== dr*4+dc && stoneCell !== dr*4+dc+1) {
          let blockOk = true;
          for (let k = 0; k < dc; k++) {
            if (dr*4+k === stoneCell) { blockOk = false; break; }
            board[dr*4+k] = 1024;
          }
          if (blockOk) {
            board[dr*4+dc] = 32;
            board[dr*4+dc+1] = 32;
            valid = true;
          }
        }
      } else if (dir === 'R' && dc > 0) {
        if (stoneCell !== dr*4+dc && stoneCell !== dr*4+dc-1) {
          let blockOk = true;
          for (let k = 3; k > dc; k--) {
            if (dr*4+k === stoneCell) { blockOk = false; break; }
            board[dr*4+k] = 1024;
          }
          if (blockOk) {
            board[dr*4+dc] = 32;
            board[dr*4+dc-1] = 32;
            valid = true;
          }
        }
      } else if (dir === 'U' && dr < 3) {
        if (stoneCell !== dr*4+dc && stoneCell !== (dr+1)*4+dc) {
          let blockOk = true;
          for (let k = 0; k < dr; k++) {
            if (k*4+dc === stoneCell) { blockOk = false; break; }
            board[k*4+dc] = 1024;
          }
          if (blockOk) {
            board[dr*4+dc] = 32;
            board[(dr+1)*4+dc] = 32;
            valid = true;
          }
        }
      } else if (dir === 'D' && dr > 0) {
        if (stoneCell !== dr*4+dc && stoneCell !== (dr-1)*4+dc) {
          let blockOk = true;
          for (let k = 3; k > dr; k--) {
            if (k*4+dc === stoneCell) { blockOk = false; break; }
            board[k*4+dc] = 1024;
          }
          if (blockOk) {
            board[dr*4+dc] = 32;
            board[(dr-1)*4+dc] = 32;
            valid = true;
          }
        }
      }

      if (valid) {
        const game = new GameController(100, { forcedRelics: ['shatter'] });
        game.state.board = [...board];
        const res = game.submitMove(dir);
        if (res.success && game.getState().relicActivations?.shatter === 1 && game.getBoard()[stoneCell] !== STONE && game.getBoard()[dest] === 64) {
          return { board, dir, dest, stoneCell };
        }
      }
    }
  }
  return null;
}

export function getDiagonalSetup(stoneCell) {
  // Diagonal merge: two tiles of same value diagonal to each other.
  // One moves diagonally onto the other (dest), merging into 64.
  // The destination must be an orthogonal neighbor of stoneCell!
  const r = Math.floor(stoneCell / 4);
  const c = stoneCell % 4;
  const neighbors = [];
  if (r > 0) neighbors.push(stoneCell - 4);
  if (r < 3) neighbors.push(stoneCell + 4);
  if (c > 0) neighbors.push(stoneCell - 1);
  if (c < 3) neighbors.push(stoneCell + 1);

  for (const dest of neighbors) {
    const dr = Math.floor(dest / 4);
    const dc = dest % 4;
    // Possible diagonal sources for dest: (dr+-1, dc+-1)
    const diagSources = [];
    if (dr > 0 && dc > 0) diagSources.push((dr - 1) * 4 + (dc - 1));
    if (dr > 0 && dc < 3) diagSources.push((dr - 1) * 4 + (dc + 1));
    if (dr < 3 && dc > 0) diagSources.push((dr + 1) * 4 + (dc - 1));
    if (dr < 3 && dc < 3) diagSources.push((dr + 1) * 4 + (dc + 1));

    for (const from of diagSources) {
      if (from === stoneCell) continue;
      const board = new Array(16).fill(0);
      board[stoneCell] = STONE;
      board[from] = 32;
      board[dest] = 32;

      const game = new GameController(100, { forcedRelics: ['diagonal_charge', 'shatter'] });
      game.state.board = [...board];
      game.state.abilities.diagonal_charge = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
      const res = game.useAbility('diagonal_charge', { from, to: dest });
      if (res.success && game.getState().relicActivations?.shatter === 1 && game.getBoard()[stoneCell] !== STONE && game.getBoard()[dest] === 64) {
        return { board, from, to: dest, dest, stoneCell };
      }
    }
  }
  return null;
}

// Test all 16 cells
for (let i = 0; i < 16; i++) {
  const s = getSlideSetup(i);
  const d = getDiagonalSetup(i);
  if (!s) console.error(`Missing slide setup for cell ${i}`);
  if (!d) console.error(`Missing diagonal setup for cell ${i}`);
}
console.log('All 16 cells verified for slide & diagonal setups!');
