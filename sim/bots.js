/**
 * Bot implementations for 2048-Rogue.
 * - random: uniformly random valid move.
 * - greedy: 1-ply lookahead with specified evaluation function, tie-break L, D, R, U.
 * - corner: fixed priority D, L, R, then U.
 * Mason stone-cell choice: minimize number-tile orthogonal adjacency, tie-break row-major.
 */

import {
  STONE,
  getValidMoves,
  canSlide,
  applySlide,
  applySlidePhase,
  applyDiagonalMerge,
  peekSpawns,
  getEmptyCells,
  mulberry32,
  cloneState,
  step,
} from './engine.js';

const CORNERS = new Set([0, 3, 12, 15]);

/**
 * Returns orthogonal neighbor cell indices for cell c in 4x4 grid.
 */
export function getOrthogonalNeighbors(cell) {
  const r = Math.floor(cell / 4);
  const col = cell % 4;
  const neighbors = [];
  if (r > 0) neighbors.push((r - 1) * 4 + col);
  if (r < 3) neighbors.push((r + 1) * 4 + col);
  if (col > 0) neighbors.push(r * 4 + (col - 1));
  if (col < 3) neighbors.push(r * 4 + (col + 1));
  return neighbors;
}

/**
 * Stone-cell choice for Mason:
 * "pick the candidate that minimizes adjacency to number tiles; ties by row-major."
 */
export function chooseStoneCell(state, candidates) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestCell = null;
  let minAdj = Infinity;

  for (const cell of candidates) {
    const neighbors = getOrthogonalNeighbors(cell);
    let adjCount = 0;
    for (const n of neighbors) {
      const val = state.board[n];
      if (typeof val === 'number' && val > 0) {
        adjCount += 1;
      }
    }

    if (adjCount < minAdj) {
      minAdj = adjCount;
      bestCell = cell;
    } else if (adjCount === minAdj) {
      if (bestCell === null || cell < bestCell) {
        bestCell = cell;
      }
    }
  }

  return bestCell;
}

/**
 * Counts stones adjacent to at least one number tile.
 */
export function countStonesAdjacentToNumberTile(board) {
  let count = 0;
  for (let c = 0; c < 16; c++) {
    if (board[c] === STONE) {
      const neighbors = getOrthogonalNeighbors(cellOrIndex(c));
      const hasAdjNumber = neighbors.some(n => typeof board[n] === 'number' && board[n] > 0);
      if (hasAdjNumber) {
        count += 1;
      }
    }
  }
  return count;
}

function cellOrIndex(c) {
  return c;
}

/**
 * Greedy board evaluation:
 * Evaluation = 10*emptyCells + merges_this_move + 5*(1 if max tile is in a corner) - 3*(number of stones adjacent to a number tile).
 */
export function evaluateBoard(board, mergesThisMove) {
  let emptyCells = 0;
  let maxTile = -1;
  const maxTileCells = [];

  for (let c = 0; c < 16; c++) {
    const val = board[c];
    if (val === 0) {
      emptyCells += 1;
    } else if (typeof val === 'number' && val > 0) {
      if (val > maxTile) {
        maxTile = val;
        maxTileCells.length = 0;
        maxTileCells.push(c);
      } else if (val === maxTile) {
        maxTileCells.push(c);
      }
    }
  }

  // 1 if any max tile is in a corner
  const cornerBonus = maxTileCells.some(c => CORNERS.has(c)) ? 5 : 0;

  // Number of stones adjacent to a number tile
  const stonePenalty = 3 * countStonesAdjacentToNumberTile(board);

  return 10 * emptyCells + mergesThisMove + cornerBonus - stonePenalty;
}

/**
 * Creates a bot instance.
 */
export function createBot(name = 'greedy', botSeed = 99999) {
  const rng = mulberry32(botSeed >>> 0);

  if (name === 'random') {
    return {
      name: 'random',
      chooseMove(state) {
        const valid = getValidMoves(state);
        if (valid.length === 0) return null;
        const idx = Math.floor(rng() * valid.length);
        return valid[idx];
      },
      chooseStoneCell(state, candidates) {
        return chooseStoneCell(state, candidates);
      }
    };
  }

  if (name === 'corner') {
    return {
      name: 'corner',
      chooseMove(state) {
        const priority = ['D', 'L', 'R', 'U'];
        for (const dir of priority) {
          if (canSlide(state.board, dir, state.relics, state.anchor)) {
            return dir;
          }
        }
        return null;
      },
      chooseStoneCell(state, candidates) {
        return chooseStoneCell(state, candidates);
      }
    };
  }

  if (name === 'expectimax') {
    return createExpectimaxBot();
  }

  // Default: greedy bot
  return {
    name: 'greedy',
    chooseMove(state) {
      const moveOrder = ['L', 'D', 'R', 'U'];
      let bestMove = null;
      let bestScore = -Infinity;

      const hasForesight = state.relics.has('foresight');
      let peekedSpawn = null;
      if (hasForesight) {
        const peekRes = peekSpawns(state, 1);
        if (peekRes.spawns.length > 0) {
          peekedSpawn = peekRes.spawns[0];
        }
      }

      for (const dir of moveOrder) {
        // Check validity
        const slideRes = applySlide(state.board, dir, state.relics, state.anchor);
        if (!slideRes.changed) continue;

        let simBoard = slideRes.board;
        let mergesThisMove = slideRes.mergesCount;

        // Diagonal merge simulation
        if (state.relics.has('diagonal_merge')) {
          const diagRes = applyDiagonalMerge(
            simBoard,
            state.moveCount,
            state.config.diagonalMergeCooldown ?? 3,
            {
              maxValue: state.config.diagonalMergeMaxValue ?? null,
              onlyOnNoMerge: state.config.diagonalMergeOnlyOnNoMerge ?? false,
              mergesThisMove: mergesThisMove,
            }
          );
          if (diagRes.merged) {
            simBoard = diagRes.board;
            mergesThisMove += 1;
          }
        }

        // If foresight is owned, simulate exact peeked spawn
        if (hasForesight && peekedSpawn) {
          simBoard = [...simBoard];
          const emptyCells = getEmptyCells(simBoard);
          if (emptyCells.length > 0) {
            let candidates = emptyCells;
            if (state.relics.has('gravity_well')) {
              let maxVal = -1;
              let maxCell = -1;
              for (let i = 0; i < 16; i++) {
                if (typeof simBoard[i] === 'number' && simBoard[i] > maxVal) {
                  maxVal = simBoard[i];
                  maxCell = i;
                }
              }
              if (maxCell !== -1) {
                const maxR = Math.floor(maxCell / 4);
                const maxC = maxCell % 4;
                const neighborEmpty = [];
                for (let dr = -1; dr <= 1; dr++) {
                  for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = maxR + dr;
                    const nc = maxC + dc;
                    if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4) {
                      const nIdx = nr * 4 + nc;
                      if (simBoard[nIdx] === 0) neighborEmpty.push(nIdx);
                    }
                  }
                }
                neighborEmpty.sort((a, b) => a - b);
                if (neighborEmpty.length > 0) {
                  candidates = neighborEmpty;
                }
              }
            }

            const chosenIdx = Math.floor(peekedSpawn.r * candidates.length);
            simBoard[candidates[chosenIdx]] = peekedSpawn.value;
          }
        }

        const score = evaluateBoard(simBoard, mergesThisMove);
        if (score > bestScore) {
          bestScore = score;
          bestMove = dir;
        }
      }

      return bestMove;
    },
    chooseStoneCell(state, candidates) {
      return chooseStoneCell(state, candidates);
    }
  };
}

/**
 * Extended evaluation for expectimax.
 * = 10*empty + merges + 2*equalNeighborPairs + 5*cornerBonus + monoScore - 3*stonePenalty
 * Monotonicity score: for each row/col sum the log2-delta loss; take best direction.
 */
export function evaluateBoardExtended(board, mergesThisMove) {
  let emptyCells = 0;
  let maxTile = -1;
  const maxTileCells = [];

  for (let c = 0; c < 16; c++) {
    const val = board[c];
    if (val === 0) {
      emptyCells += 1;
    } else if (typeof val === 'number' && val > 0) {
      if (val > maxTile) { maxTile = val; maxTileCells.length = 0; maxTileCells.push(c); }
      else if (val === maxTile) { maxTileCells.push(c); }
    }
  }

  const cornerBonus = maxTileCells.some(c => CORNERS.has(c)) ? 5 : 0;
  const stonePenalty = 3 * countStonesAdjacentToNumberTile(board);

  // Equal orthogonal neighbor pairs
  let equalPairs = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = board[r * 4 + c];
      if (typeof v !== 'number' || v <= 0) continue;
      if (c < 3 && board[r * 4 + c + 1] === v) equalPairs++;
      if (r < 3 && board[(r + 1) * 4 + c] === v) equalPairs++;
    }
  }

  // Monotonicity: penalize non-monotone sequences in each row and col
  const logVal = v => (typeof v === 'number' && v > 0) ? Math.log2(v) : 0;
  let monoScore = 0;
  for (let r = 0; r < 4; r++) {
    let decr = 0, incr = 0;
    for (let c = 0; c < 3; c++) {
      const a = logVal(board[r * 4 + c]), b = logVal(board[r * 4 + c + 1]);
      if (a > b) decr += b - a;
      if (a < b) incr += a - b;
    }
    monoScore += Math.max(decr, incr);
  }
  for (let c = 0; c < 4; c++) {
    let decr = 0, incr = 0;
    for (let r = 0; r < 3; r++) {
      const a = logVal(board[r * 4 + c]), b = logVal(board[(r + 1) * 4 + c]);
      if (a > b) decr += b - a;
      if (a < b) incr += a - b;
    }
    monoScore += Math.max(decr, incr);
  }

  return 10 * emptyCells + mergesThisMove + 2 * equalPairs + cornerBonus + monoScore - stonePenalty;
}

/** Simulates slide and post-slide relic effects using the engine's slide phase */
export function simulateSlideAndPostRelics(board, dir, state, moveOffset = 0) {
  const res = applySlidePhase(
    board,
    dir,
    state.relics,
    state.anchor,
    state.moveCount + moveOffset,
    state.config || {},
    state.stoneSpawnMoves || null
  );
  if (!res.changed) return null;
  return { board: res.board, mergesCount: res.mergesCount };
}

function getGravityCandidates(board) {
  let maxVal = -1, maxCell = -1;
  for (let i = 0; i < 16; i++) {
    if (typeof board[i] === 'number' && board[i] > maxVal) {
      maxVal = board[i]; maxCell = i;
    }
  }
  if (maxCell !== -1) {
    const maxR = Math.floor(maxCell / 4), maxC = maxCell % 4;
    const neighborEmpty = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = maxR + dr, nc = maxC + dc;
        if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4) {
          const nIdx = nr * 4 + nc;
          if (board[nIdx] === 0) neighborEmpty.push(nIdx);
        }
      }
    }
    neighborEmpty.sort((a, b) => a - b);
    if (neighborEmpty.length > 0) return neighborEmpty;
  }
  const empty = [];
  for (let i = 0; i < 16; i++) if (board[i] === 0) empty.push(i);
  return empty;
}

/** Expectimax max-node: try all valid directions, return best score. */
function exMaxNode(board, state, moveOffset = 1, peekedSpawn2 = null) {
  let best = -Infinity;
  for (const dir of ['L', 'D', 'R', 'U']) {
    const sim = simulateSlideAndPostRelics(board, dir, state, moveOffset);
    if (!sim) continue;
    let s;
    if (peekedSpawn2) {
      const candidates = state.relics.has('gravity_well') ? getGravityCandidates(sim.board) : getEmptyCells(sim.board);
      if (candidates.length === 0) {
        s = evaluateBoardExtended(sim.board, sim.mergesCount);
      } else {
        const chosenIdx = Math.floor(peekedSpawn2.r * candidates.length);
        const nextBoard = [...sim.board];
        nextBoard[candidates[chosenIdx]] = peekedSpawn2.value;
        s = evaluateBoardExtended(nextBoard, sim.mergesCount);
      }
    } else {
      s = evaluateBoardExtended(sim.board, sim.mergesCount);
    }
    if (s > best) best = s;
  }
  return best === -Infinity ? evaluateBoardExtended(board, 0) : best;
}

/** Expectimax chance-node: handles foresight (using both peeked spawns), gravity_well, and tile sampling */
function exChanceNode(board, state, peekedSpawns = null) {
  if (state.relics.has('foresight') && peekedSpawns && peekedSpawns.length >= 1) {
    const s0 = peekedSpawns[0];
    const s1 = peekedSpawns.length >= 2 ? peekedSpawns[1] : null;
    const candidates = state.relics.has('gravity_well') ? getGravityCandidates(board) : getEmptyCells(board);
    if (candidates.length === 0) return evaluateBoardExtended(board, 0);
    const chosenIdx = Math.floor(s0.r * candidates.length);
    const nextBoard = [...board];
    nextBoard[candidates[chosenIdx]] = s0.value;
    return exMaxNode(nextBoard, state, 1, s1);
  }

  const empty = state.relics.has('gravity_well') ? getGravityCandidates(board) : getEmptyCells(board);
  if (empty.length === 0) return evaluateBoardExtended(board, 0);
  const sample = empty.length <= 4 ? empty : empty.slice(0, 4); // first 4 in row-major
  let total = 0;
  const w = 1 / sample.length;
  for (const cell of sample) {
    const next2 = [...board]; next2[cell] = 2;
    const next4 = [...board]; next4[cell] = 4;
    total += w * (0.9 * exMaxNode(next2, state, 1, null) + 0.1 * exMaxNode(next4, state, 1, null));
  }
  return total;
}

/**
 * Creates an expectimax bot (depth 2: max -> chance -> max -> leaf eval).
 */
export function createExpectimaxBot() {
  return {
    name: 'expectimax',
    chooseMove(state) {
      let bestMove = null;
      let bestScore = -Infinity;

      let peekedSpawns = null;
      if (state.relics.has('foresight')) {
        const peekRes = peekSpawns(state, 2);
        if (peekRes.spawns.length >= 2) {
          peekedSpawns = peekRes.spawns;
        } else if (peekRes.spawns.length === 1) {
          peekedSpawns = [peekRes.spawns[0]];
        }
      }

      for (const dir of ['L', 'D', 'R', 'U']) {
        const sim = simulateSlideAndPostRelics(state.board, dir, state, 0);
        if (!sim) continue;
        const score = exChanceNode(sim.board, state, peekedSpawns);
        if (score > bestScore) { bestScore = score; bestMove = dir; }
      }
      return bestMove;
    },
    chooseStoneCell(state, candidates) {
      return chooseStoneCell(state, candidates);
    }
  };
}

/**
 * Creates a noisy wrapper bot: with probability eps, plays a uniformly random
 * valid move; otherwise defers to base bot's chooseMove. Stone-cell choice
 * always delegates to base bot (or the canonical chooseStoneCell).
 *
 * @param {object} base   - A bot object with a chooseMove(state) method.
 * @param {number} eps    - Noise probability in [0, 1]. Default 0.1.
 * @param {number} botSeed - Seed for the noise RNG. Default 77777.
 */
export function createNoisyBot(base, eps = 0.1, botSeedOffset = 0x77777777) {
  let currentSeed = null;
  let lastMove = -1;
  let rng = null;

  function getRng(state) {
    const seed = state.seed ?? 12345;
    if (currentSeed !== seed || state.moveCount === 0 || state.moveCount <= lastMove) {
      currentSeed = seed;
      rng = mulberry32((seed + botSeedOffset) >>> 0);
    }
    lastMove = state.moveCount;
    return rng;
  }

  let lastMoveWasNoise = false;

  return {
    name: `noisy_${base.name}_eps${eps}`,
    get lastMoveWasNoise() {
      return lastMoveWasNoise;
    },
    reset(seed = null) {
      currentSeed = null;
      lastMove = -1;
      rng = null;
      lastMoveWasNoise = false;
    },
    chooseMove(state) {
      const valid = getValidMoves(state);
      if (valid.length === 0) {
        lastMoveWasNoise = false;
        return null;
      }
      const r = getRng(state);
      if (r() < eps) {
        // Uniform random valid move
        lastMoveWasNoise = true;
        const idx = Math.floor(r() * valid.length);
        return valid[idx];
      }
      lastMoveWasNoise = false;
      return base.chooseMove(state);
    },
    chooseStoneCell(state, candidates) {
      if (base.chooseStoneCell) return base.chooseStoneCell(state, candidates);
      return chooseStoneCell(state, candidates);
    },
    chooseDraftRelic(state, offers) {
      if (base.chooseDraftRelic) return base.chooseDraftRelic(state, offers);
      return null;
    },
  };
}

/**
 * Creates a rollout bot that evaluates draft offers using playouts.
 */
export function createRolloutBot(baseBot, playouts = 20) {
  return {
    name: `rollout_${baseBot.name}`,
    chooseMove(state) { return baseBot.chooseMove(state); },
    chooseStoneCell(state, candidates) {
      if (baseBot.chooseStoneCell) return baseBot.chooseStoneCell(state, candidates);
      return chooseStoneCell(state, candidates);
    },
    chooseDraftRelic(state, offers) {
      if (!offers || offers.length === 0) return null;
      if (offers.length === 1) return offers[0];

      let bestOffer = offers[0];
      let bestScore = -Infinity;

      for (let oIdx = 0; oIdx < offers.length; oIdx++) {
        const offer = offers[oIdx];
        let totalRemaining = 0;
        for (let p = 0; p < playouts; p++) {
          const simState = cloneState(state);
          simState.relics.add(offer);
          if (offer === 'anchor_row' && !simState.anchor) {
            simState.anchor = { type: 'row', index: 3 };
          }
          const rolloutSeed = (state.moveCount * 10007 + p * 67 + 99991) >>> 0;
          simState.rngs = {
            tile: mulberry32(rolloutSeed),
            stone: mulberry32((rolloutSeed + 0x9e3779b9) >>> 0),
            draft: mulberry32((rolloutSeed + 0x3c6ef372) >>> 0),
          };
          simState.spawnQueue = [];

          while (!simState.gameOver && !simState.capped) {
            const m = baseBot.chooseMove(simState);
            if (!m) break;
            step(simState, m, baseBot);
          }
          totalRemaining += (simState.moveCount - state.moveCount);
        }
        const meanRem = totalRemaining / playouts;
        if (meanRem > bestScore) {
          bestScore = meanRem;
          bestOffer = offer;
        }
      }
      return bestOffer;
    },
  };
}

