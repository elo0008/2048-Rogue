/**
 * Pure 2048-Rogue Engine (UI-free, zero dependencies, ES Module)
 */

import { RELIC_IDS } from './relics.js';

export const STONE = 'S';
export const DIRECTIONS = ['L', 'R', 'U', 'D'];

export const DEFAULT_CONFIG = {
  moveCap: 5000,
  draftThresholds: [32, 64, 128, 256, 512, 1024, 2048, 4096],
  hazardSchedule: [
    { upToMove: 100, interval: 25 },
    { upToMove: 200, interval: 20 },
    { upToMove: 300, interval: 15 },
    { upToMove: Infinity, interval: 10 },
  ],
  doubleSpawnFromMove: null, // null = disabled, or number
  diagonalMergeCooldown: 3,
  diagonalMergeMaxValue: null, // null = no limit, or integer max pair value
  diagonalMergeOnlyOnNoMerge: false, // if true, only trigger if slide produced no merge
  stoneLifetime: null, // null = permanent, or integer L (moves)
  anchor: { type: 'row', index: 3 }, // bottom row default
  forcedRelics: [], // relics granted at move 0 (or at forceAtMove)
  forceAtMove: 0,  // inject forcedRelics at this move number (0 = at game start)
  enableDraft: true, // draft trigger enabled
  draftPolicy: 'random', // 'random' or 'fixed:relic1,relic2,...'
  draftEveryMoves: null, // null = disabled; N = trigger a draft every N moves
  initialTiles: 2,
  // siphon relic: skip tile spawn if any merge this move created a tile >= siphonMin
  siphonMin: 16,
  // shatter relic: remove stones adjacent to merge-created tiles with value >= shatterMin
  shatterMin: 64,
  // last_stand relic: on game-over, remove tiles <= lastStandMax once per run and retry
  lastStandMax: 16,
  // Player-triggered ability relic settings
  maxCharges: 3,
  diagonalChargeEvery: 10,
  eraserEvery: 20,
  rewindEvery: 10,
  // Stone-group cap settings:
  stoneGroup: ['fault_line', 'mason', 'shatter'],
  stoneGroupCap: null, // default null = off
};

/**
 * Builds standard hazard schedule scaled by multiplier (default 3x)
 */
export function buildHazardSchedule(multiplier = 3) {
  return [
    { upToMove: 100, interval: Math.max(3, Math.round(25 * multiplier)) },
    { upToMove: 200, interval: Math.max(3, Math.round(20 * multiplier)) },
    { upToMove: 300, interval: Math.max(3, Math.round(15 * multiplier)) },
    { upToMove: Infinity, interval: Math.max(3, Math.round(10 * multiplier)) },
  ];
}

/**
 * 32-bit PRNG: mulberry32
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  let count = 0;
  const fn = function () {
    count++;
    fn.drawCount = count;
    let t = (s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.drawCount = 0;
  fn.seed = seed >>> 0;
  fn.getState = function () {
    return { s, count };
  };
  fn.setState = function (state) {
    s = state.s >>> 0;
    count = state.count;
    fn.drawCount = count;
  };
  return fn;
}

/**
 * Returns line indices in [leading, ..., trailing] order.
 */
export function getLineIndices(direction, lineIndex) {
  const indices = [];
  if (direction === 'L') {
    for (let c = 0; c < 4; c++) indices.push(lineIndex * 4 + c);
  } else if (direction === 'R') {
    for (let c = 3; c >= 0; c--) indices.push(lineIndex * 4 + c);
  } else if (direction === 'U') {
    for (let r = 0; r < 4; r++) indices.push(r * 4 + lineIndex);
  } else if (direction === 'D') {
    for (let r = 3; r >= 0; r--) indices.push(r * 4 + lineIndex);
  }
  return indices;
}

/**
 * Returns base hazard interval for a given moveCount.
 */
export function getBaseStoneInterval(moveCount, hazardSchedule) {
  for (const tier of hazardSchedule) {
    if (moveCount <= tier.upToMove) {
      return tier.interval;
    }
  }
  return hazardSchedule[hazardSchedule.length - 1].interval;
}

/**
 * Returns effective hazard interval considering pressure_cooker relic.
 */
export function getEffectiveStoneInterval(moveCount, config, relics) {
  const baseInterval = getBaseStoneInterval(moveCount, config.hazardSchedule);
  if (relics.has('pressure_cooker')) {
    return Math.max(3, Math.round(baseInterval * 0.7));
  }
  return baseInterval;
}

/**
 * Checks if a stone spawn is due on the upcoming/current move.
 */
export function isStoneDue(state) {
  const upcomingMove = state.moveCount + 1;
  const interval = getEffectiveStoneInterval(upcomingMove, state.config, state.relics);
  return (state.movesSinceLastStone + 1) >= interval;
}

/**
 * Applies fault_line stone shifts before the slide.
 * "for each line in the slide direction, process stones from the leading end backward:
 * a stone shifts one cell in the slide direction iff the cell beyond it is empty
 * AND the cell immediately behind it holds a number tile."
 */
export function applyFaultLine(board, direction, stoneSpawnMoves = null) {
  let changed = false;
  const nextBoard = [...board];
  const nextSpawnMoves = stoneSpawnMoves ? [...stoneSpawnMoves] : null;

  for (let lineIdx = 0; lineIdx < 4; lineIdx++) {
    const indices = getLineIndices(direction, lineIdx);
    // Process from leading end (0) backward to trailing end (3)
    for (let k = 0; k < 4; k++) {
      if (nextBoard[indices[k]] === STONE) {
        const beyondIdx = k - 1;
        const behindIdx = k + 1;
        if (
          beyondIdx >= 0 &&
          nextBoard[indices[beyondIdx]] === 0 &&
          behindIdx < 4 &&
          typeof nextBoard[indices[behindIdx]] === 'number' &&
          nextBoard[indices[behindIdx]] > 0
        ) {
          nextBoard[indices[beyondIdx]] = STONE;
          nextBoard[indices[k]] = 0;
          if (nextSpawnMoves) {
            nextSpawnMoves[indices[beyondIdx]] = nextSpawnMoves[indices[k]];
            nextSpawnMoves[indices[k]] = null;
          }
          changed = true;
        }
      }
    }
  }

  return { board: nextBoard, stoneSpawnMoves: nextSpawnMoves, changed };
}

/**
 * Slides and merges a single segment of tiles (between stones or line bounds).
 */
export function slideSegment(segment, hasTripleThreat) {
  const tiles = segment.filter(v => typeof v === 'number' && v > 0);
  const result = [];
  const mergedIndices = [];
  let mergesCount = 0;
  let tripleCount = 0; // actual 3-tile merges
  let maxCreated = 0;
  let i = 0;

  if (hasTripleThreat) {
    while (i < tiles.length) {
      if (
        i + 2 < tiles.length &&
        tiles[i] === tiles[i + 1] &&
        tiles[i] === tiles[i + 2]
      ) {
        const newVal = tiles[i] * 4;
        result.push(newVal);
        mergedIndices.push(result.length - 1);
        mergesCount += 1;
        tripleCount += 1;
        if (newVal > maxCreated) maxCreated = newVal;
        i += 3;
      } else if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        const newVal = tiles[i] * 2;
        result.push(newVal);
        mergedIndices.push(result.length - 1);
        mergesCount += 1;
        if (newVal > maxCreated) maxCreated = newVal;
        i += 2;
      } else {
        result.push(tiles[i]);
        i += 1;
      }
    }
  } else {
    while (i < tiles.length) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        const newVal = tiles[i] * 2;
        result.push(newVal);
        mergedIndices.push(result.length - 1);
        mergesCount += 1;
        if (newVal > maxCreated) maxCreated = newVal;
        i += 2;
      } else {
        result.push(tiles[i]);
        i += 1;
      }
    }
  }

  while (result.length < segment.length) {
    result.push(0);
  }

  return { result, mergesCount, tripleCount, maxCreated, mergedIndices };
}

/**
 * Slides a line with stones as immovable blockers.
 */
export function slideLineWithStones(lineValues, hasTripleThreat) {
  const resultLine = [...lineValues];
  const mergedPositions = [];
  let mergesCount = 0;
  let tripleCount = 0;
  let maxCreated = 0;

  let segStart = 0;
  for (let k = 0; k <= 4; k++) {
    if (k === 4 || lineValues[k] === STONE) {
      if (k > segStart) {
        const seg = lineValues.slice(segStart, k);
        const { result, mergesCount: mCount, tripleCount: tCount, maxCreated: mMax, mergedIndices } = slideSegment(seg, hasTripleThreat);
        for (let s = 0; s < result.length; s++) {
          resultLine[segStart + s] = result[s];
        }
        for (const mIdx of (mergedIndices || [])) {
          mergedPositions.push({ idx: segStart + mIdx, value: result[mIdx] });
        }
        mergesCount += mCount;
        tripleCount += tCount;
        if (mMax > maxCreated) maxCreated = mMax;
      }
      segStart = k + 1;
    }
  }

  return { line: resultLine, mergesCount, tripleCount, maxCreated, mergedPositions };
}

/**
 * Slides a line perpendicular to an anchored line.
 * Anchored cell is fixed at ancIdx in line.
 */
export function slidePerpendicularWithAnchor(lineValues, ancIdx, hasTripleThreat) {
  const resultLine = [...lineValues];
  const mergedPositions = [];
  let mergesCount = 0;
  let maxCreated = 0;

  // 1. Cells ahead of ancIdx: [0, ..., ancIdx - 1] slide normally towards leading edge
  if (ancIdx > 0) {
    const aheadSeg = lineValues.slice(0, ancIdx);
    const { line: aheadRes, mergesCount: mAhead, maxCreated: maxAhead, mergedPositions: mAheadPositions } = slideLineWithStones(aheadSeg, hasTripleThreat);
    for (let s = 0; s < aheadRes.length; s++) {
      resultLine[s] = aheadRes[s];
    }
    for (const mp of (mAheadPositions || [])) mergedPositions.push(mp);
    mergesCount += mAhead;
    if (maxAhead > maxCreated) maxCreated = maxAhead;
  }

  // 2. Anchored cell is fixed at ancIdx
  // 3. Cells behind ancIdx: [ancIdx + 1, ..., 3] move towards ancIdx
  if (ancIdx < 3) {
    const trailingValues = lineValues.slice(ancIdx + 1);
    // Find first stone if any behind ancIdx
    const firstStoneIdx = trailingValues.indexOf(STONE);
    const subSegEnd = firstStoneIdx === -1 ? trailingValues.length : firstStoneIdx;
    const subSeg = trailingValues.slice(0, subSegEnd);
    const trailingTiles = subSeg.filter(v => typeof v === 'number' && v > 0);

    let anchorVal = resultLine[ancIdx];
    let anchorMerged = false;

    if (trailingTiles.length > 0) {
      const firstArriving = trailingTiles[0];
      if (anchorVal === 0) {
        // Enters empty anchored cell and becomes fixed
        anchorVal = firstArriving;
        resultLine[ancIdx] = anchorVal;
        trailingTiles.shift();
      } else if (typeof anchorVal === 'number' && anchorVal === firstArriving) {
        // Merges into anchored tile, doubles, stays in place
        anchorVal = anchorVal * 2;
        resultLine[ancIdx] = anchorVal;
        anchorMerged = true;
        mergedPositions.push({ idx: ancIdx, value: anchorVal });
        mergesCount += 1;
        if (anchorVal > maxCreated) maxCreated = anchorVal;
        trailingTiles.shift();
      }
      // If neither, first arriving stops adjacent (kept in trailingTiles)
    }

    // Now compact and slide the remaining trailing tiles in subSeg
    const remainingResult = [];
    let i = 0;
    if (hasTripleThreat) {
      while (i < trailingTiles.length) {
        if (
          i + 2 < trailingTiles.length &&
          trailingTiles[i] === trailingTiles[i + 1] &&
          trailingTiles[i] === trailingTiles[i + 2]
        ) {
          const newVal = trailingTiles[i] * 4;
          remainingResult.push(newVal);
          mergesCount += 1;
          if (newVal > maxCreated) maxCreated = newVal;
          i += 3;
        } else if (i + 1 < trailingTiles.length && trailingTiles[i] === trailingTiles[i + 1]) {
          const newVal = trailingTiles[i] * 2;
          remainingResult.push(newVal);
          mergesCount += 1;
          if (newVal > maxCreated) maxCreated = newVal;
          i += 2;
        } else {
          remainingResult.push(trailingTiles[i]);
          i += 1;
        }
      }
    } else {
      while (i < trailingTiles.length) {
        if (i + 1 < trailingTiles.length && trailingTiles[i] === trailingTiles[i + 1]) {
          const newVal = trailingTiles[i] * 2;
          remainingResult.push(newVal);
          mergesCount += 1;
          if (newVal > maxCreated) maxCreated = newVal;
          i += 2;
        } else {
          remainingResult.push(trailingTiles[i]);
          i += 1;
        }
      }
    }

    while (remainingResult.length < subSegEnd) {
      remainingResult.push(0);
    }

    for (let s = 0; s < subSegEnd; s++) {
      resultLine[ancIdx + 1 + s] = remainingResult[s];
    }

    // If there were stones behind firstStoneIdx, slide remaining segments normally
    if (firstStoneIdx !== -1) {
      const rest = trailingValues.slice(firstStoneIdx);
      const { line: restRes, mergesCount: mRest, maxCreated: maxRest, mergedPositions: mRestPositions } = slideLineWithStones(rest, hasTripleThreat);
      for (let s = 0; s < restRes.length; s++) {
        resultLine[ancIdx + 1 + firstStoneIdx + s] = restRes[s];
      }
      for (const mp of (mRestPositions || [])) mergedPositions.push({ idx: ancIdx + 1 + firstStoneIdx + mp.idx, value: mp.value });
      mergesCount += mRest;
      if (maxRest > maxCreated) maxCreated = maxRest;
    }
  }

  return { line: resultLine, mergesCount, maxCreated, mergedPositions };
}

/**
 * Applies slide step across all lines.
 */
export function applySlide(board, direction, relics, anchor, stoneSpawnMoves = null) {
  let workingBoard = [...board];
  let workingSpawnMoves = stoneSpawnMoves ? [...stoneSpawnMoves] : null;

  // Relic: fault_line
  if (relics.has('fault_line')) {
    const faultRes = applyFaultLine(workingBoard, direction, workingSpawnMoves);
    workingBoard = faultRes.board;
    workingSpawnMoves = faultRes.stoneSpawnMoves;
  }

  const nextBoard = [...workingBoard];
  let totalMerges = 0;
  let totalTriples = 0;
  let maxCreatedTile = 0;
  const mergeCreatedCells = [];
  const hasTripleThreat = relics.has('triple_threat');
  const hasAnchor = relics.has('anchor_row') && anchor;

  const isParallelToAnchor = hasAnchor && (
    (anchor.type === 'row' && (direction === 'L' || direction === 'R')) ||
    (anchor.type === 'col' && (direction === 'U' || direction === 'D'))
  );

  for (let lineIdx = 0; lineIdx < 4; lineIdx++) {
    const lineIndices = getLineIndices(direction, lineIdx);
    const lineValues = lineIndices.map(idx => workingBoard[idx]);

    if (isParallelToAnchor && lineIdx === anchor.index) {
      // Anchored line: tiles do not move or merge
      continue;
    }

    if (hasAnchor && !isParallelToAnchor) {
      // Perpendicular line: find ancIdx in this line
      let ancIdx = -1;
      for (let k = 0; k < 4; k++) {
        const boardIdx = lineIndices[k];
        const r = Math.floor(boardIdx / 4);
        const c = boardIdx % 4;
        if (anchor.type === 'row' && r === anchor.index) {
          ancIdx = k;
          break;
        } else if (anchor.type === 'col' && c === anchor.index) {
          ancIdx = k;
          break;
        }
      }

      const { line: newLine, mergesCount, maxCreated, mergedPositions } = slidePerpendicularWithAnchor(
        lineValues, ancIdx, hasTripleThreat
      );
      totalMerges += mergesCount;
      if (maxCreated > maxCreatedTile) maxCreatedTile = maxCreated;
      for (let k = 0; k < 4; k++) nextBoard[lineIndices[k]] = newLine[k];
      for (const mp of (mergedPositions || [])) mergeCreatedCells.push({ cell: lineIndices[mp.idx], value: mp.value });
    } else {
      // Standard slide
      const { line: newLine, mergesCount, tripleCount, maxCreated, mergedPositions } = slideLineWithStones(lineValues, hasTripleThreat);
      totalMerges += mergesCount;
      totalTriples += tripleCount;
      if (maxCreated > maxCreatedTile) maxCreatedTile = maxCreated;
      for (let k = 0; k < 4; k++) nextBoard[lineIndices[k]] = newLine[k];
      for (const mp of (mergedPositions || [])) mergeCreatedCells.push({ cell: lineIndices[mp.idx], value: mp.value });
    }
  }

  let changed = false;
  for (let i = 0; i < 16; i++) {
    if (board[i] !== nextBoard[i]) { changed = true; break; }
  }

  return {
    board: nextBoard,
    stoneSpawnMoves: workingSpawnMoves,
    changed,
    mergesCount: totalMerges,
    tripleCount: totalTriples,
    maxCreatedTile,
    mergeCreatedCells,
  };
}

/**
 * Post-slide relic: diagonal_merge
 * Usable on every Nth move ((moveCount + 1) % cooldown === 0).
 */
export function applyDiagonalMerge(board, moveCount, cooldown, options = {}) {
  const currentMoveNum = moveCount + 1;
  if (options.onlyOnNoMerge && options.mergesThisMove > 0) {
    return { board: [...board], merged: false, mergedValue: 0 };
  }
  if (currentMoveNum % cooldown !== 0) {
    return { board: [...board], merged: false, mergedValue: 0 };
  }

  const pairs = [];
  for (let c1 = 0; c1 < 16; c1++) {
    const val1 = board[c1];
    if (typeof val1 !== 'number' || val1 <= 0) continue;
    if (options.maxValue && val1 > options.maxValue) continue;
    const r1 = Math.floor(c1 / 4);
    const col1 = c1 % 4;

    for (let c2 = c1 + 1; c2 < 16; c2++) {
      const val2 = board[c2];
      if (typeof val2 !== 'number' || val2 <= 0) continue;
      if (options.maxValue && val2 > options.maxValue) continue;
      const r2 = Math.floor(c2 / 4);
      const col2 = c2 % 4;

      if (Math.abs(r1 - r2) === 1 && Math.abs(col1 - col2) === 1) {
        if (val1 === val2) {
          pairs.push({ c1, c2, val: val1 });
        }
      }
    }
  }

  if (pairs.length === 0) {
    return { board: [...board], merged: false, mergedValue: 0 };
  }

  // Sort pairs:
  // 1. highest value first
  // 2. row-major of first cell (c1 ascending)
  // 3. row-major of second cell (c2 ascending)
  pairs.sort((a, b) => {
    if (b.val !== a.val) return b.val - a.val;
    if (a.c1 !== b.c1) return a.c1 - b.c1;
    return a.c2 - b.c2;
  });

  const bestPair = pairs[0];
  const nextBoard = [...board];
  const mergedValue = bestPair.val * 2;
  nextBoard[bestPair.c1] = mergedValue;
  nextBoard[bestPair.c2] = 0;

  return { board: nextBoard, merged: true, mergedValue, mergedCell: bestPair.c1 };
}

/**
 * Full slide phase including post-slide relics (diagonal_merge, shatter).
 * Used by both engine step() and expectimax lookahead.
 */
export function applySlidePhase(board, direction, relics, anchor, moveCount = 0, config = {}, stoneSpawnMoves = null) {
  const slideRes = applySlide(board, direction, relics, anchor, stoneSpawnMoves);
  if (!slideRes.changed) {
    return { changed: false, board, mergesCount: 0, tripleCount: 0, maxCreatedTile: 0, mergeCreatedCells: [], stoneSpawnMoves, shatterFired: false, diagonalMerged: false };
  }

  let nextBoard = slideRes.board;
  let nextSpawnMoves = slideRes.stoneSpawnMoves;
  let mergesCount = slideRes.mergesCount;
  let maxCreatedTile = slideRes.maxCreatedTile;
  let mergeCreatedCells = [...(slideRes.mergeCreatedCells || [])];
  let diagonalMerged = false;

  // Diagonal merge
  if (relics && relics.has('diagonal_merge')) {
    const diagRes = applyDiagonalMerge(
      nextBoard,
      moveCount,
      config.diagonalMergeCooldown ?? 3,
      {
        maxValue: config.diagonalMergeMaxValue ?? null,
        onlyOnNoMerge: config.diagonalMergeOnlyOnNoMerge ?? false,
        mergesThisMove: mergesCount,
      }
    );
    if (diagRes.merged) {
      nextBoard = diagRes.board;
      mergesCount += 1;
      diagonalMerged = true;
      if (diagRes.mergedValue > maxCreatedTile) maxCreatedTile = diagRes.mergedValue;
      mergeCreatedCells.push({ cell: diagRes.mergedCell, value: diagRes.mergedValue });
    }
  }

  // Shatter
  let shatterFired = false;
  if (relics && relics.has('shatter') && mergesCount > 0) {
    const shatterMin = config.shatterMin ?? 64;
    for (const { cell, value } of mergeCreatedCells) {
      if (value >= shatterMin) {
        const r = Math.floor(cell / 4), c = cell % 4;
        const ortho = [];
        if (r > 0) ortho.push((r - 1) * 4 + c);
        if (r < 3) ortho.push((r + 1) * 4 + c);
        if (c > 0) ortho.push(r * 4 + (c - 1));
        if (c < 3) ortho.push(r * 4 + (c + 1));
        for (const nc of ortho) {
          if (nextBoard[nc] === STONE) {
            nextBoard[nc] = 0;
            if (nextSpawnMoves) nextSpawnMoves[nc] = null;
            shatterFired = true;
          }
        }
      }
    }
  }

  return {
    changed: true,
    board: nextBoard,
    stoneSpawnMoves: nextSpawnMoves,
    mergesCount,
    tripleCount: slideRes.tripleCount,
    maxCreatedTile,
    mergeCreatedCells,
    shatterFired,
    diagonalMerged,
  };
}

/**
 * Checks if a move in a given direction is valid (changes the board).
 */
export function canSlide(board, direction, relics, anchor) {
  const res = applySlide(board, direction, relics, anchor);
  return res.changed;
}

/**
 * Returns list of valid slide directions.
 */
export function getValidMoves(state) {
  const valid = [];
  for (const dir of DIRECTIONS) {
    if (canSlide(state.board, dir, state.relics, state.anchor)) {
      valid.push(dir);
    }
  }
  return valid;
}

/**
 * Refills the pre-drawn spawn queue.
 */
function replenishSpawnQueue(state, minCount = 5) {
  while (state.spawnQueue.length < minCount) {
    const valRand = state.rngs.tile();
    const value = valRand < 0.9 ? 2 : 4;
    const r = state.rngs.tile();
    state.spawnQueue.push({ value, r });
  }
}

/**
 * Exposes next count pre-drawn tile spawns and whether stone is due.
 */
export function peekSpawns(state, count = 2) {
  replenishSpawnQueue(state, count);
  return {
    spawns: state.spawnQueue.slice(0, count),
    stoneDue: isStoneDue(state),
  };
}

/**
 * Finds all empty cells in row-major order.
 */
export function getEmptyCells(board) {
  const empty = [];
  for (let i = 0; i < 16; i++) {
    if (board[i] === 0) empty.push(i);
  }
  return empty;
}

/**
 * Spawns one tile according to step 5.
 */
export function spawnOneTile(state) {
  replenishSpawnQueue(state, 1);
  const spawn = state.spawnQueue.shift();
  const allEmpty = getEmptyCells(state.board);
  if (allEmpty.length === 0) return false;

  let candidates = allEmpty;
  if (state.relics.has('gravity_well')) {
    // Find highest-value tile on board (ties: first in row-major order)
    let maxVal = -1;
    let maxCell = -1;
    for (let i = 0; i < 16; i++) {
      if (typeof state.board[i] === 'number' && state.board[i] > maxVal) {
        maxVal = state.board[i];
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
            if (state.board[nIdx] === 0) {
              neighborEmpty.push(nIdx);
            }
          }
        }
      }
      // Sort in row-major order
      neighborEmpty.sort((a, b) => a - b);
      if (neighborEmpty.length > 0) {
        candidates = neighborEmpty;
      }
    }
  }

  const chosenIdx = Math.floor(spawn.r * candidates.length);
  const targetCell = candidates[chosenIdx];
  state.board[targetCell] = spawn.value;
  replenishSpawnQueue(state, 5);
  return true;
}

/**
 * Spawns a stone if due according to step 6.
 */
export function spawnStoneIfDue(state, bot) {
  state.movesSinceLastStone += 1;
  const interval = getEffectiveStoneInterval(state.moveCount, state.config, state.relics);

  if (state.movesSinceLastStone >= interval) {
    const emptyCells = getEmptyCells(state.board);
    if (emptyCells.length === 0) {
      // Skip and retry next move (counter NOT reset)
      return false;
    }

    let chosenCell;
    if (state.relics.has('mason')) {
      if (emptyCells.length === 1) {
        chosenCell = emptyCells[0];
      } else {
        const i1 = Math.floor(state.rngs.stone() * emptyCells.length);
        const c1 = emptyCells[i1];
        const remaining = emptyCells.filter(c => c !== c1);
        const i2 = Math.floor(state.rngs.stone() * remaining.length);
        const c2 = remaining[i2];
        const candidates = [c1, c2];

        if (bot && typeof bot.chooseStoneCell === 'function') {
          chosenCell = bot.chooseStoneCell(state, candidates);
        } else {
          chosenCell = candidates[0];
        }
      }
    } else {
      const idx = Math.floor(state.rngs.stone() * emptyCells.length);
      chosenCell = emptyCells[idx];
    }

    state.board[chosenCell] = STONE;
    if (state.stoneSpawnMoves) {
      state.stoneSpawnMoves[chosenCell] = state.moveCount;
    }
    state.movesSinceLastStone = 0;
    return true;
  }

  return false;
}

export const ABILITY_RELIC_IDS = ['diagonal_charge', 'eraser', 'rewind'];

export function isAbilityRelic(relicId) {
  return ABILITY_RELIC_IDS.includes(relicId);
}

export function initAbility(state, relicId) {
  if (!state.abilities) state.abilities = {};
  if (!state.abilities[relicId]) {
    state.abilities[relicId] = {
      charges: 1,
      counter: 0,
      swipesAtMax: 0,
    };
  }
}

export function getLegalTargets(state, relicId) {
  const targets = [];
  if (relicId === 'diagonal_charge') {
    for (let c1 = 0; c1 < 16; c1++) {
      const v1 = state.board[c1];
      if (typeof v1 !== 'number' || v1 <= 0) continue;
      const r1 = Math.floor(c1 / 4), col1 = c1 % 4;
      for (let c2 = c1 + 1; c2 < 16; c2++) {
        const v2 = state.board[c2];
        if (typeof v2 !== 'number' || v2 <= 0) continue;
        const r2 = Math.floor(c2 / 4), col2 = c2 % 4;
        if (Math.abs(r1 - r2) === 1 && Math.abs(col1 - col2) === 1) {
          if (v1 === v2) {
            targets.push({ from: c1, to: c2 });
            targets.push({ from: c2, to: c1 });
          }
        }
      }
    }
  } else if (relicId === 'eraser') {
    for (let c = 0; c < 16; c++) {
      const v = state.board[c];
      if (typeof v === 'number' && v > 0) {
        targets.push({ cell: c });
      }
    }
  } else if (relicId === 'rewind') {
    const ab = state.abilities?.rewind;
    if (ab && ab.charges > 0 && state.rewindStack && state.rewindStack.length > 0) {
      targets.push({});
    }
  }
  return targets;
}

export function hasLegalAbility(state) {
  if (state.gameOver || state.capped) return false;
  for (const rid of ABILITY_RELIC_IDS) {
    if (state.relics && state.relics.has(rid)) {
      const info = state.abilities ? state.abilities[rid] : null;
      if (info && info.charges > 0) {
        if (getLegalTargets(state, rid).length > 0) {
          return true;
        }
      }
    }
  }
  return false;
}

export function getAbilityState(state) {
  const res = {};
  const maxCharges = state.config?.maxCharges ?? 3;
  for (const rid of ABILITY_RELIC_IDS) {
    if (state.relics && state.relics.has(rid)) {
      const info = state.abilities?.[rid] || { charges: 1, counter: 0, swipesAtMax: 0 };
      const every = (rid === 'diagonal_charge')
        ? (state.config?.diagonalChargeEvery ?? 10)
        : (rid === 'eraser')
        ? (state.config?.eraserEvery ?? 20)
        : (state.config?.rewindEvery ?? 10);
      const swipesUntilNext = info.charges >= maxCharges ? 0 : Math.max(0, every - info.counter);
      const legalTargets = getLegalTargets(state, rid);
      const abObj = {
        relic: rid,
        charges: info.charges,
        maxCharges,
        counter: info.counter,
        swipesUntilNext,
        legalTargets,
      };
      if (rid === 'rewind') {
        abObj.undoLevels = Math.min(info.charges, state.rewindStack ? state.rewindStack.length : 0);
      }
      res[rid] = abObj;
    }
  }
  res[Symbol.iterator] = function* () {
    for (const k of Object.keys(this)) {
      yield this[k];
    }
  };
  return res;
}

export function useAbility(state, relicId, target) {
  if (state.gameOver || state.capped) {
    throw new Error('Cannot use ability: game is over');
  }
  if (state.pendingDecision) {
    throw new Error('Cannot use ability: pending decision');
  }
  if (!state.relics || !state.relics.has(relicId)) {
    throw new Error(`Cannot use ability: relic ${relicId} not owned`);
  }
  if (!isAbilityRelic(relicId)) {
    throw new Error(`Cannot use ability: ${relicId} is not an ability relic`);
  }
  const ab = state.abilities?.[relicId];
  if (!ab || ab.charges <= 0) {
    throw new Error(`Cannot use ability: no charges remaining for ${relicId}`);
  }

  if (relicId === 'diagonal_charge') {
    if (!target || typeof target !== 'object') {
      throw new Error('Cannot use ability: diagonal_charge requires target { from, to }');
    }
    let from = target.from;
    let to = target.to;
    if (from === undefined && to === undefined && target.a !== undefined && target.b !== undefined) {
      from = target.a;
      to = target.b;
    }
    if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || from > 15 || to < 0 || to > 15 || from === to) {
      throw new Error(`Cannot use ability: invalid diagonal target cells (${from}, ${to})`);
    }
    const vFrom = state.board[from], vTo = state.board[to];
    if (typeof vFrom !== 'number' || vFrom <= 0 || typeof vTo !== 'number' || vTo <= 0 || vFrom !== vTo) {
      throw new Error(`Cannot use ability: tiles at (${from}, ${to}) are not equal number tiles`);
    }
    const rFrom = Math.floor(from / 4), cFrom = from % 4;
    const rTo = Math.floor(to / 4), cTo = to % 4;
    if (Math.abs(rFrom - rTo) !== 1 || Math.abs(cFrom - cTo) !== 1) {
      throw new Error(`Cannot use ability: cells (${from}, ${to}) are not diagonally adjacent`);
    }

    ab.charges -= 1;
    state.relicActivations[relicId] = (state.relicActivations[relicId] || 0) + 1;

    const mergedVal = vFrom * 2;
    state.board[to] = mergedVal;
    state.board[from] = 0;
    if (mergedVal > state.highestTile) {
      state.highestTile = mergedVal;
    }
    state.points = (state.points || 0) + mergedVal;

    // Shatter check (uses to cell)
    if (state.relics.has('shatter')) {
      const shatterMin = state.config?.shatterMin ?? 64;
      if (mergedVal >= shatterMin) {
        let shatterFired = false;
        const r = Math.floor(to / 4), c = to % 4;
        const ortho = [];
        if (r > 0) ortho.push((r - 1) * 4 + c);
        if (r < 3) ortho.push((r + 1) * 4 + c);
        if (c > 0) ortho.push(r * 4 + (c - 1));
        if (c < 3) ortho.push(r * 4 + (c + 1));
        for (const nc of ortho) {
          if (state.board[nc] === STONE) {
            state.board[nc] = 0;
            if (state.stoneSpawnMoves) state.stoneSpawnMoves[nc] = null;
            shatterFired = true;
          }
        }
        if (shatterFired) {
          state.relicActivations['shatter'] = (state.relicActivations['shatter'] || 0) + 1;
        }
      }
    }
    state.rewindStack = [];
  } else if (relicId === 'eraser') {
    const cell = (typeof target === 'number') ? target : target?.cell;
    if (typeof cell !== 'number' || cell < 0 || cell > 15) {
      throw new Error(`Cannot use ability: invalid eraser target cell ${cell}`);
    }
    const v = state.board[cell];
    if (typeof v !== 'number' || v <= 0) {
      throw new Error(`Cannot use ability: cell ${cell} does not hold a number tile`);
    }

    ab.charges -= 1;
    state.relicActivations[relicId] = (state.relicActivations[relicId] || 0) + 1;
    state.board[cell] = 0;
    state.rewindStack = [];
  } else if (relicId === 'rewind') {
    if (!state.rewindStack || state.rewindStack.length === 0) {
      throw new Error('Cannot use ability: no valid rewind snapshot');
    }
    const snap = state.rewindStack.pop();
    state.board = [...snap.board];
    state.stoneSpawnMoves = snap.stoneSpawnMoves ? [...snap.stoneSpawnMoves] : new Array(16).fill(null);
    state.moveCount = snap.moveCount;
    state.bonusScore = snap.bonusScore;
    state.score = snap.score;
    state.points = snap.points;
    state.tripleMerges = snap.tripleMerges ?? state.tripleMerges;
    state.movesSinceLastStone = snap.movesSinceLastStone;
    state.highestTile = snap.highestTile;
    state.nextThresholdIndex = snap.nextThresholdIndex;
    state.spawnQueue = snap.spawnQueue.map(s => ({ ...s }));
    state.rngs.tile.setState(snap.rngs.tile);
    state.rngs.stone.setState(snap.rngs.stone);
    state.rngs.draft.setState(snap.rngs.draft);

    ab.charges -= 1;
    state.relicActivations['rewind'] = (state.relicActivations['rewind'] || 0) + 1;
  }

  // Stuck & Last Stand check
  const validMoves = getValidMoves(state);
  if (validMoves.length > 0) {
    state.stuckNeedsAbility = false;
    state.gameOver = false;
  } else {
    if (hasLegalAbility(state)) {
      state.stuckNeedsAbility = true;
      state.gameOver = false;
    } else {
      state.stuckNeedsAbility = false;
      if (state.relics.has('last_stand') && !state.lastStandUsed) {
        state.lastStandUsed = true;
        state.relicActivations['last_stand'] = (state.relicActivations['last_stand'] || 0) + 1;
        const lastStandMax = state.config?.lastStandMax ?? 16;
        for (let c = 0; c < 16; c++) {
          if (typeof state.board[c] === 'number' && state.board[c] > 0 && state.board[c] <= lastStandMax) {
            state.board[c] = 0;
          }
        }
        if (getValidMoves(state).length === 0) {
          if (hasLegalAbility(state)) {
            state.stuckNeedsAbility = true;
            state.gameOver = false;
          } else {
            state.gameOver = true;
          }
        } else {
          state.stuckNeedsAbility = false;
          state.gameOver = false;
        }
      } else {
        state.gameOver = true;
      }
    }
  }

  return { valid: true, state };
}

/**
 * Resolves a single draft event: offers up to 3 unowned relics, bot picks 1 according to policy.
 */
export function resolveOneDraft(state, bot, info = {}) {
  const relicPool = state.config.draftPool || RELIC_IDS;
  let unowned = relicPool.filter(id => !state.relics.has(id));

  // Stone-group cap: filter out remaining stone group relics if cap reached
  if (state.config.stoneGroupCap !== null && state.config.stoneGroupCap !== undefined) {
    const stoneGroup = state.config.stoneGroup || ['fault_line', 'mason', 'shatter'];
    const ownedCount = stoneGroup.filter(id => state.relics.has(id)).length;
    if (ownedCount >= state.config.stoneGroupCap) {
      unowned = unowned.filter(id => !stoneGroup.includes(id));
    }
  }

  if (unowned.length === 0) return;

  const pool = [...unowned];
  const offers = [];
  const count = Math.min(3, pool.length);
  for (let o = 0; o < count; o++) {
    const idx = Math.floor(state.rngs.draft() * pool.length);
    offers.push(pool[idx]);
    pool.splice(idx, 1);
  }

  // Record offers
  for (const off of offers) {
    state.relicOffers[off] = (state.relicOffers[off] || 0) + 1;
  }

  // Bot picks 1 via policy or custom bot method
  let pick;
  if (bot && typeof bot.chooseDraftRelic === 'function') {
    pick = bot.chooseDraftRelic(state, offers);
  }
  if (!pick) {
    const policy = state.config.draftPolicy || 'random';
    if (policy.startsWith('fixed:')) {
      const list = policy.slice(6).split(',').map(s => s.trim());
      for (const pref of list) {
        if (offers.includes(pref)) {
          pick = pref;
          break;
        }
      }
      if (!pick) {
        const pIdx = Math.floor(state.rngs.draft() * offers.length);
        pick = offers[pIdx];
      }
    } else {
      // Uniform random pick using draft RNG stream
      const pIdx = Math.floor(state.rngs.draft() * offers.length);
      pick = offers[pIdx];
    }
  }

  state.relics.add(pick);
  state.relicPicks[pick] = (state.relicPicks[pick] || 0) + 1;
  state.draftHistory.push({ ...info, offers, pick, move: state.moveCount });

  if (pick === 'anchor_row') {
    state.anchor = { ...(state.config.anchor || { type: 'row', index: 3 }) };
  }
  if (isAbilityRelic(pick)) {
    initAbility(state, pick);
  }
}

/**
 * Draft trigger and resolution according to step 4.
 */
export function checkAndResolveDraft(state, bot) {
  if (state.config.enableDraft === false) return;
  const thresholds = state.config.draftThresholds;
  if (!thresholds || thresholds.length === 0) return;

  while (
    state.nextThresholdIndex < thresholds.length &&
    state.highestTile >= thresholds[state.nextThresholdIndex]
  ) {
    const threshold = thresholds[state.nextThresholdIndex];
    state.nextThresholdIndex += 1;
    resolveOneDraft(state, bot, { threshold });
  }
}

/**
 * Clones game state for bot simulation / lookahead.
 */
export function cloneState(state) {
  const clonedAbilities = {};
  if (state.abilities) {
    for (const [k, v] of Object.entries(state.abilities)) {
      clonedAbilities[k] = { ...v };
    }
  }
  const clonedStack = state.rewindStack
    ? state.rewindStack.map(snap => ({
        board: [...snap.board],
        stoneSpawnMoves: snap.stoneSpawnMoves ? [...snap.stoneSpawnMoves] : new Array(16).fill(null),
        moveCount: snap.moveCount,
        bonusScore: snap.bonusScore,
        score: snap.score,
        points: snap.points,
        tripleMerges: snap.tripleMerges,
        movesSinceLastStone: snap.movesSinceLastStone,
        highestTile: snap.highestTile,
        nextThresholdIndex: snap.nextThresholdIndex,
        spawnQueue: snap.spawnQueue.map(s => ({ ...s })),
        rngs: {
          tile: { ...snap.rngs.tile },
          stone: { ...snap.rngs.stone },
          draft: { ...snap.rngs.draft },
        },
      }))
    : [];
  return {
    board: [...state.board],
    stoneSpawnMoves: state.stoneSpawnMoves ? [...state.stoneSpawnMoves] : new Array(16).fill(null),
    moveCount: state.moveCount,
    bonusScore: state.bonusScore,
    score: state.score,
    points: state.points || 0,
    highestTile: state.highestTile,
    movesSinceLastStone: state.movesSinceLastStone,
    gameOver: state.gameOver,
    capped: state.capped,
    nextThresholdIndex: state.nextThresholdIndex,
    relics: new Set(state.relics),
    anchor: state.anchor ? { ...state.anchor } : null,
    spawnQueue: state.spawnQueue.map(s => ({ ...s })),
    config: state.config,
    rngs: state.rngs, // shared RNG references
    lastStandUsed: state.lastStandUsed || false,
    relicActivations: state.relicActivations ? { ...state.relicActivations } : {},
    draftHistory: state.draftHistory ? [...state.draftHistory] : [],
    relicOffers: state.relicOffers ? { ...state.relicOffers } : {},
    relicPicks: state.relicPicks ? { ...state.relicPicks } : {},
    tripleMerges: state.tripleMerges || 0,
    relicsInjected: state.relicsInjected || false,
    seed: state.seed,
    abilities: clonedAbilities,
    stuckNeedsAbility: state.stuckNeedsAbility || false,
    pendingDecision: state.pendingDecision ? { ...state.pendingDecision } : null,
    rewindStack: clonedStack,
    get rewindSnapshot() {
      return this.rewindStack && this.rewindStack.length > 0 ? this.rewindStack[this.rewindStack.length - 1] : null;
    },
    set rewindSnapshot(val) {
      if (!this.rewindStack) this.rewindStack = [];
      if (!val) {
        this.rewindStack = [];
      } else {
        this.rewindStack.push(val);
      }
    },
  };
}

/**
 * Initializes a new game state.
 */
export function createGame(seed = 12345, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  const tileRng = mulberry32(seed >>> 0);
  const stoneRng = mulberry32((seed + 0x9e3779b9) >>> 0);
  const draftRng = mulberry32((seed + 0x3c6ef372) >>> 0);

  const state = {
    seed,
    board: new Array(16).fill(0),
    stoneSpawnMoves: new Array(16).fill(null),
    moveCount: 0,
    bonusScore: 0,
    score: 0,
    points: 0,
    highestTile: 0,
    movesSinceLastStone: 0,
    gameOver: false,
    capped: false,
    nextThresholdIndex: 0,
    rewindStack: [],
    get rewindSnapshot() {
      return this.rewindStack && this.rewindStack.length > 0 ? this.rewindStack[this.rewindStack.length - 1] : null;
    },
    set rewindSnapshot(val) {
      if (!this.rewindStack) this.rewindStack = [];
      if (!val) {
        this.rewindStack = [];
      } else {
        this.rewindStack.push(val);
      }
    },
    // Inject forcedRelics immediately only when forceAtMove === 0
    relics: (config.forceAtMove === 0)
      ? new Set(config.forcedRelics || [])
      : new Set(),
    anchor: (config.forceAtMove === 0 && config.forcedRelics && config.forcedRelics.includes('anchor_row'))
      ? { ...(config.anchor || { type: 'row', index: 3 }) }
      : null,
    draftHistory: [],
    relicOffers: {},
    relicPicks: {},
    spawnQueue: [],
    config,
    rngs: {
      tile: tileRng,
      stone: stoneRng,
      draft: draftRng,
    },
    abilities: {},
    stuckNeedsAbility: false,
    pendingDecision: null,
  };

  const relicActivations = {};
  for (const rid of RELIC_IDS) {
    state.relicOffers[rid] = 0;
    state.relicPicks[rid] = 0;
    relicActivations[rid] = 0;
  }
  state.relicActivations = relicActivations;
  state.tripleMerges = 0; // total actual 3-tile merges this run
  state.relicsInjected = false; // tracks whether forceAtMove relics have been injected
  state.lastStandUsed = false; // last_stand fires at most once per run

  for (const rid of state.relics) {
    if (isAbilityRelic(rid)) {
      initAbility(state, rid);
    }
  }

  replenishSpawnQueue(state, 5);

  // Initial tile spawns
  const initialCount = config.initialTiles ?? 2;
  for (let i = 0; i < initialCount; i++) {
    spawnOneTile(state);
  }

  // Update highestTile
  for (const cell of state.board) {
    if (typeof cell === 'number' && cell > state.highestTile) {
      state.highestTile = cell;
    }
  }

  // Initial game-over check: possible if anchor_row traps all tiles on start.
  // Only check if there are tiles on the board (avoids flagging empty-board test setups).
  const hasTiles = state.board.some(v => typeof v === 'number' && v > 0);
  if (hasTiles && getValidMoves(state).length === 0) {
    if (hasLegalAbility(state)) {
      state.stuckNeedsAbility = true;
    } else {
      state.gameOver = true;
    }
  }

  return state;
}

/**
 * Executes a single turn in exact order.
 * Turn Order:
 * 1. Apply slide (with owned relic modifications).
 * 2. Apply post-slide relic effects (Diagonal Merge).
 * 3. moveCount += 1.
 * 4. If a new highest tile value was created in steps 1-2, check draft trigger and resolve immediately.
 * 5. Spawn one tile (or 2 if doubleSpawnFromMove).
 * 6. Stone spawn if due.
 * 7. Game over if no valid slide exists, or capped at moveCap.
 */
/**
 * Helper to get moves remaining until next stone spawn and stone interval.
 */
export function getNextStoneInfo(state) {
  const interval = getEffectiveStoneInterval(state.moveCount, state.config, state.relics);
  const movesUntilNextStone = Math.max(0, interval - state.movesSinceLastStone);
  return {
    interval,
    movesUntilNextStone,
    movesSinceLastStone: state.movesSinceLastStone,
    isDue: state.movesSinceLastStone + 1 >= interval,
  };
}

/**
 * Helper to get relics info: owned list and per-relic activation counters.
 */
export function getRelicsInfo(state) {
  return {
    owned: Array.from(state.relics),
    activations: { ...(state.relicActivations || {}) },
  };
}

/**
 * Helper for Foresight: previews the values of the next 2 tile spawns
 * and indicates if a stone is due on the next move (no positions).
 */
export function getForesightPreview(state) {
  if (!state.relics.has('foresight')) return null;
  const peek = peekSpawns(state, 2);
  const stoneInfo = getNextStoneInfo(state);
  return {
    values: peek.spawns.map(s => s.value),
    stoneDue: stoneInfo.movesUntilNextStone <= 1,
  };
}

/**
 * Interactive step function supporting human player decisions (drafts, mason stone placement).
 * Pauses by returning a pendingDecision object with a resolve continuation function.
 */
export function stepInteractive(state, direction, options = {}) {
  const boardBefore = [...state.board];

  if (state.gameOver || state.capped) {
    return { valid: false, state, boardBefore, boardAfter: boardBefore };
  }

  const ownedAbilitiesAtStart = state.relics ? Array.from(state.relics).filter(isAbilityRelic) : [];

  if (!state.relicActivations) state.relicActivations = {};
  const act = state.relicActivations;

  // forceAtMove: inject forced relics exactly when moveCount reaches the target
  if (
    !state.relicsInjected &&
    state.config.forceAtMove > 0 &&
    state.moveCount === state.config.forceAtMove
  ) {
    state.relicsInjected = true;
    for (const rid of (state.config.forcedRelics || [])) {
      state.relics.add(rid);
      if (isAbilityRelic(rid)) {
        initAbility(state, rid);
      }
    }
    if (state.relics.has('anchor_row') && !state.anchor) {
      state.anchor = { ...(state.config.anchor || { type: 'row', index: 3 }) };
    }
  }

  // 1. Apply slide
  if (state.relics.has('fault_line')) {
    const faultCheck = applyFaultLine(state.board, direction);
    if (faultCheck.changed) act['fault_line'] = (act['fault_line'] || 0) + 1;
  }

  const slideRes = applySlide(state.board, direction, state.relics, state.anchor, state.stoneSpawnMoves);
  if (!slideRes.changed) {
    return { valid: false, state, boardBefore, boardAfter: boardBefore };
  }

  // Snapshot WORLD before valid swipe for Rewind
  if (!state.rewindStack) state.rewindStack = [];
  const maxCharges = state.config?.maxCharges ?? 3;
  state.rewindStack.push({
    board: [...boardBefore],
    stoneSpawnMoves: state.stoneSpawnMoves ? [...state.stoneSpawnMoves] : new Array(16).fill(null),
    moveCount: state.moveCount,
    bonusScore: state.bonusScore,
    score: state.score,
    points: state.points || 0,
    tripleMerges: state.tripleMerges || 0,
    movesSinceLastStone: state.movesSinceLastStone,
    highestTile: state.highestTile,
    nextThresholdIndex: state.nextThresholdIndex,
    spawnQueue: state.spawnQueue.map(s => ({ ...s })),
    rngs: {
      tile: state.rngs.tile.getState(),
      stone: state.rngs.stone.getState(),
      draft: state.rngs.draft.getState(),
    },
  });
  while (state.rewindStack.length > maxCharges) {
    state.rewindStack.shift();
  }

  if (state.relics.has('triple_threat') && slideRes.tripleCount > 0) {
    act['triple_threat'] = (act['triple_threat'] || 0) + 1;
    state.tripleMerges = (state.tripleMerges || 0) + slideRes.tripleCount;
  }

  if (state.relics.has('anchor_row') && state.anchor) {
    const isParallel = (
      (state.anchor.type === 'row' && (direction === 'L' || direction === 'R')) ||
      (state.anchor.type === 'col' && (direction === 'U' || direction === 'D'))
    );
    if (!isParallel) act['anchor_row'] = (act['anchor_row'] || 0) + 1;
  }

  state.board = slideRes.board;
  if (slideRes.stoneSpawnMoves) {
    state.stoneSpawnMoves = slideRes.stoneSpawnMoves;
  }
  let mergesThisMove = slideRes.mergesCount;
  let maxCreatedThisMove = slideRes.maxCreatedTile;
  let mergeCreatedCells = slideRes.mergeCreatedCells || [];

  // 2. Apply post-slide relic effects (Diagonal Merge)
  if (state.relics.has('diagonal_merge')) {
    const diagRes = applyDiagonalMerge(
      state.board,
      state.moveCount,
      state.config.diagonalMergeCooldown ?? 3,
      {
        maxValue: state.config.diagonalMergeMaxValue ?? null,
        onlyOnNoMerge: state.config.diagonalMergeOnlyOnNoMerge ?? false,
        mergesThisMove: mergesThisMove,
      }
    );
    if (diagRes.merged) {
      state.board = diagRes.board;
      mergesThisMove += 1;
      if (diagRes.mergedValue > maxCreatedThisMove) maxCreatedThisMove = diagRes.mergedValue;
      mergeCreatedCells = [...mergeCreatedCells, { cell: diagRes.mergedCell, value: diagRes.mergedValue }];
      act['diagonal_merge'] = (act['diagonal_merge'] || 0) + 1;
    }
  }

  // 2b. Shatter: remove stones adjacent to merge-created tiles >= shatterMin
  if (state.relics.has('shatter') && mergesThisMove > 0) {
    const shatterMin = state.config.shatterMin ?? 64;
    let shatterFired = false;
    for (const { cell, value } of mergeCreatedCells) {
      if (value >= shatterMin) {
        const r = Math.floor(cell / 4), c = cell % 4;
        const ortho = [];
        if (r > 0) ortho.push((r - 1) * 4 + c);
        if (r < 3) ortho.push((r + 1) * 4 + c);
        if (c > 0) ortho.push(r * 4 + (c - 1));
        if (c < 3) ortho.push(r * 4 + (c + 1));
        for (const nc of ortho) {
          if (state.board[nc] === STONE) {
            state.board[nc] = 0;
            if (state.stoneSpawnMoves) state.stoneSpawnMoves[nc] = null;
            shatterFired = true;
          }
        }
      }
    }
    if (shatterFired) act['shatter'] = (act['shatter'] || 0) + 1;
  }

  // Pressure cooker bonusScore: +2 per merge
  if (state.relics.has('pressure_cooker') && mergesThisMove > 0) {
    state.bonusScore += mergesThisMove * 2;
    act['pressure_cooker'] = (act['pressure_cooker'] || 0) + 1;
  }

  // Track foresight: once per move it is owned
  if (state.relics.has('foresight')) {
    act['foresight'] = (act['foresight'] || 0) + 1;
  }

  // D. Scoring
  const sumCreatedValues = mergeCreatedCells.reduce((sum, item) => sum + item.value, 0);
  const mergeMultiplier = Math.min(4, mergesThisMove);
  state.points = (state.points || 0) + sumCreatedValues * mergeMultiplier;

  // 3. moveCount += 1
  state.moveCount += 1;
  state.score = state.moveCount + state.bonusScore;

  // 4. Drafts queue
  if (maxCreatedThisMove > state.highestTile) {
    state.highestTile = maxCreatedThisMove;
  }

  const pendingDraftInfos = [];
  if (state.config.enableDraft !== false) {
    const thresholds = state.config.draftThresholds;
    if (thresholds && thresholds.length > 0) {
      while (
        state.nextThresholdIndex < thresholds.length &&
        state.highestTile >= thresholds[state.nextThresholdIndex]
      ) {
        const threshold = thresholds[state.nextThresholdIndex];
        state.nextThresholdIndex += 1;
        pendingDraftInfos.push({ threshold });
      }
    }

    let triggerPeriodicDraft = false;
    let draftTriggerInfo = {};
    if (state.config.draftFirstAt != null) {
      const firstAt = state.config.draftFirstAt;
      const every = state.config.draftEveryMoves;
      if (state.moveCount === firstAt) {
        triggerPeriodicDraft = true;
        draftTriggerInfo = { draftFirstAt: firstAt };
      } else if (state.moveCount > firstAt && every && every > 0 && (state.moveCount - firstAt) % every === 0) {
        triggerPeriodicDraft = true;
        draftTriggerInfo = { draftEveryMoves: every };
      }
    } else {
      const isEveryMoves = (
        state.config.draftEveryMoves &&
        state.config.draftEveryMoves > 0 &&
        state.moveCount % state.config.draftEveryMoves === 0
      );
      if (isEveryMoves) {
        triggerPeriodicDraft = true;
        draftTriggerInfo = { draftEveryMoves: state.config.draftEveryMoves };
      }
    }
    if (triggerPeriodicDraft) {
      pendingDraftInfos.push(draftTriggerInfo);
    }
  }

  if (pendingDraftInfos.length > 0) {
    state.rewindStack = [];
  }

  function runSpawnsAndFinish() {
    // 5. Spawn tile(s)
    const siphonMin = state.config.siphonMin ?? 16;
    const siphonBlocked = state.relics.has('siphon') && maxCreatedThisMove >= siphonMin && mergesThisMove > 0;
    if (siphonBlocked) {
      act['siphon'] = (act['siphon'] || 0) + 1;
    }

    const spawnCount = (
      state.config.doubleSpawnFromMove !== null &&
      state.moveCount >= state.config.doubleSpawnFromMove
    ) ? 2 : 1;

    for (let s = 0; s < spawnCount; s++) {
      if (siphonBlocked && s === 0) {
        replenishSpawnQueue(state, 1);
        state.spawnQueue.shift();
        continue;
      }
      if (state.relics.has('gravity_well')) {
        let maxVal = -1, maxCell = -1;
        for (let i = 0; i < 16; i++) {
          if (typeof state.board[i] === 'number' && state.board[i] > maxVal) {
            maxVal = state.board[i]; maxCell = i;
          }
        }
        if (maxCell !== -1) {
          const mr = Math.floor(maxCell / 4), mc = maxCell % 4;
          let neighborHasEmpty = false;
          loop: for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = mr + dr, nc = mc + dc;
              if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4 && state.board[nr * 4 + nc] === 0) {
                neighborHasEmpty = true; break loop;
              }
            }
          }
          if (neighborHasEmpty) act['gravity_well'] = (act['gravity_well'] || 0) + 1;
        }
      }
      spawnOneTile(state);
    }

    // 6. Stone spawn if due
    if (state.config.stoneLifetime !== null && state.config.stoneLifetime > 0) {
      const L = state.config.stoneLifetime;
      for (let c = 0; c < 16; c++) {
        if (state.board[c] === STONE && state.stoneSpawnMoves && state.stoneSpawnMoves[c] !== null) {
          if (state.moveCount - state.stoneSpawnMoves[c] >= L) {
            state.board[c] = 0;
            state.stoneSpawnMoves[c] = null;
          }
        }
      }
    }

    state.movesSinceLastStone += 1;
    const interval = getEffectiveStoneInterval(state.moveCount, state.config, state.relics);

    if (state.movesSinceLastStone >= interval) {
      const emptyCells = getEmptyCells(state.board);
      if (emptyCells.length > 0) {
        if (state.relics.has('mason')) {
          state.rewindStack = [];
          if (emptyCells.length === 1) {
            const chosenCell = emptyCells[0];
            state.board[chosenCell] = STONE;
            if (state.stoneSpawnMoves) state.stoneSpawnMoves[chosenCell] = state.moveCount;
            state.movesSinceLastStone = 0;
            act['mason'] = (act['mason'] || 0) + 1;
            return finalizeTurn();
          } else {
            const i1 = Math.floor(state.rngs.stone() * emptyCells.length);
            const c1 = emptyCells[i1];
            const remaining = emptyCells.filter(c => c !== c1);
            const i2 = Math.floor(state.rngs.stone() * remaining.length);
            const c2 = remaining[i2];
            const candidates = [c1, c2];

            const pendingDecision = {
              type: 'mason',
              candidates,
              resolve(chosenCell) {
                if (!candidates.includes(chosenCell)) {
                  throw new Error(`Invalid mason candidate cell: ${chosenCell}. Must be one of [${candidates.join(', ')}]`);
                }
                state.pendingDecision = null;
                state.board[chosenCell] = STONE;
                if (state.stoneSpawnMoves) {
                  state.stoneSpawnMoves[chosenCell] = state.moveCount;
                }
                state.movesSinceLastStone = 0;
                act['mason'] = (act['mason'] || 0) + 1;
                return finalizeTurn();
              },
            };
            state.pendingDecision = pendingDecision;

            return {
              valid: true,
              pendingDecision,
              mergesThisMove,
              maxCreatedThisMove,
              state,
              boardBefore,
            };
          }
        } else {
          const idx = Math.floor(state.rngs.stone() * emptyCells.length);
          const chosenCell = emptyCells[idx];
          state.board[chosenCell] = STONE;
          if (state.stoneSpawnMoves) {
            state.stoneSpawnMoves[chosenCell] = state.moveCount;
          }
          state.movesSinceLastStone = 0;
        }
      }
    }

    return finalizeTurn();
  }

  function finalizeTurn() {
    state.pendingDecision = null;
    for (const cell of state.board) {
      if (typeof cell === 'number' && cell > state.highestTile) state.highestTile = cell;
    }

    // Tick ability cooldowns for abilities owned at START of swipe
    const maxCharges = state.config.maxCharges ?? 3;
    for (const rid of ownedAbilitiesAtStart) {
      const ab = state.abilities?.[rid];
      if (!ab) continue;
      const every = (rid === 'diagonal_charge')
        ? (state.config.diagonalChargeEvery ?? 10)
        : (rid === 'eraser')
        ? (state.config.eraserEvery ?? 20)
        : (state.config.rewindEvery ?? 10);
      if (ab.charges >= maxCharges) {
        ab.swipesAtMax = (ab.swipesAtMax || 0) + 1;
      } else {
        ab.counter = (ab.counter || 0) + 1;
        if (ab.counter >= every) {
          ab.charges += 1;
          ab.counter = 0;
        }
      }
    }

    let lastStandFired = false;
    if (state.moveCount >= state.config.moveCap) {
      state.capped = true;
      state.gameOver = true;
      state.stuckNeedsAbility = false;
    } else {
      if (getValidMoves(state).length === 0) {
        if (hasLegalAbility(state)) {
          state.stuckNeedsAbility = true;
        } else {
          state.stuckNeedsAbility = false;
          if (state.relics.has('last_stand') && !state.lastStandUsed) {
            state.lastStandUsed = true;
            lastStandFired = true;
            state.rewindStack = [];
            const lastStandMax = state.config.lastStandMax ?? 16;
            for (let c = 0; c < 16; c++) {
              if (typeof state.board[c] === 'number' && state.board[c] > 0 && state.board[c] <= lastStandMax) {
                state.board[c] = 0;
              }
            }
            act['last_stand'] = (act['last_stand'] || 0) + 1;
            if (getValidMoves(state).length === 0) {
              if (hasLegalAbility(state)) {
                state.stuckNeedsAbility = true;
              } else {
                state.gameOver = true;
              }
            }
          } else {
            state.gameOver = true;
          }
        }
      } else {
        state.stuckNeedsAbility = false;
      }
    }

    return {
      valid: true,
      pendingDecision: null,
      mergesThisMove,
      maxCreatedThisMove,
      lastStandFired,
      state,
      boardBefore,
      boardAfter: [...state.board],
    };
  }

  function processNextDraft() {
    while (pendingDraftInfos.length > 0) {
      const info = pendingDraftInfos.shift();
      const relicPool = state.config.draftPool || RELIC_IDS;
      let unowned = relicPool.filter(id => !state.relics.has(id));

      if (state.config.stoneGroupCap !== null && state.config.stoneGroupCap !== undefined) {
        const stoneGroup = state.config.stoneGroup || ['fault_line', 'mason', 'shatter'];
        const ownedCount = stoneGroup.filter(id => state.relics.has(id)).length;
        if (ownedCount >= state.config.stoneGroupCap) {
          unowned = unowned.filter(id => !stoneGroup.includes(id));
        }
      }
      if (unowned.length === 0) continue;

      const pool = [...unowned];
      const offers = [];
      const count = Math.min(3, pool.length);
      for (let o = 0; o < count; o++) {
        const idx = Math.floor(state.rngs.draft() * pool.length);
        offers.push(pool[idx]);
        pool.splice(idx, 1);
      }
      for (const off of offers) {
        state.relicOffers[off] = (state.relicOffers[off] || 0) + 1;
      }

      const pendingDecision = {
        type: 'draft',
        offers,
        info,
        resolve(pick) {
          if (!offers.includes(pick)) {
            throw new Error(`Invalid draft pick: ${pick}. Must be one of [${offers.join(', ')}]`);
          }
          state.pendingDecision = null;
          state.relics.add(pick);
          state.relicPicks[pick] = (state.relicPicks[pick] || 0) + 1;
          state.draftHistory.push({ ...info, offers, pick, move: state.moveCount });
          if (pick === 'anchor_row') {
            state.anchor = { ...(state.config.anchor || { type: 'row', index: 3 }) };
          }
          if (isAbilityRelic(pick)) {
            initAbility(state, pick);
          }
          return processNextDraft();
        },
      };
      state.pendingDecision = pendingDecision;

      return {
        valid: true,
        pendingDecision,
        mergesThisMove,
        maxCreatedThisMove,
        state,
        boardBefore,
      };
    }

    return runSpawnsAndFinish();
  }

  return processNextDraft();
}

/**
 * Executes a single turn in exact order.
 * Turn Order:
 * 1. Apply slide (with owned relic modifications).
 * 2. Apply post-slide relic effects (Diagonal Merge).
 * 3. moveCount += 1.
 * 4. If a new highest tile value was created in steps 1-2, check draft trigger and resolve immediately.
 * 5. Spawn one tile (or 2 if doubleSpawnFromMove).
 * 6. Stone spawn if due.
 * 7. Game over if no valid slide exists, or capped at moveCap.
 */
export function step(state, direction, bot = null, options = {}) {
  if (options && options.interactive) {
    return stepInteractive(state, direction, options);
  }

  const boardBefore = [...state.board];

  if (state.gameOver || state.capped) {
    return { valid: false, state, boardBefore, boardAfter: boardBefore };
  }

  const ownedAbilitiesAtStart = state.relics ? Array.from(state.relics).filter(isAbilityRelic) : [];

  if (!state.relicActivations) state.relicActivations = {};
  const act = state.relicActivations;

  // forceAtMove: inject forced relics exactly when moveCount reaches the target
  if (
    !state.relicsInjected &&
    state.config.forceAtMove > 0 &&
    state.moveCount === state.config.forceAtMove
  ) {
    state.relicsInjected = true;
    for (const rid of (state.config.forcedRelics || [])) {
      state.relics.add(rid);
      if (isAbilityRelic(rid)) {
        initAbility(state, rid);
      }
    }
    if (state.relics.has('anchor_row') && !state.anchor) {
      state.anchor = { ...(state.config.anchor || { type: 'row', index: 3 }) };
    }
  }

  // 1. Apply slide
  // Track fault_line: pre-check whether any stone shifts before this move
  if (state.relics.has('fault_line')) {
    const faultCheck = applyFaultLine(state.board, direction);
    if (faultCheck.changed) act['fault_line'] = (act['fault_line'] || 0) + 1;
  }

  const slideRes = applySlide(state.board, direction, state.relics, state.anchor, state.stoneSpawnMoves);
  if (!slideRes.changed) {
    return { valid: false, state, boardBefore, boardAfter: boardBefore };
  }

  // Snapshot WORLD before valid swipe for Rewind
  if (!state.rewindStack) state.rewindStack = [];
  const maxCharges = state.config?.maxCharges ?? 3;
  state.rewindStack.push({
    board: [...boardBefore],
    stoneSpawnMoves: state.stoneSpawnMoves ? [...state.stoneSpawnMoves] : new Array(16).fill(null),
    moveCount: state.moveCount,
    bonusScore: state.bonusScore,
    score: state.score,
    points: state.points || 0,
    tripleMerges: state.tripleMerges || 0,
    movesSinceLastStone: state.movesSinceLastStone,
    highestTile: state.highestTile,
    nextThresholdIndex: state.nextThresholdIndex,
    spawnQueue: state.spawnQueue.map(s => ({ ...s })),
    rngs: {
      tile: state.rngs.tile.getState(),
      stone: state.rngs.stone.getState(),
      draft: state.rngs.draft.getState(),
    },
  });
  while (state.rewindStack.length > maxCharges) {
    state.rewindStack.shift();
  }

  // Track triple_threat: use slideRes.tripleCount (exact count from slideSegment)
  if (state.relics.has('triple_threat') && slideRes.tripleCount > 0) {
    act['triple_threat'] = (act['triple_threat'] || 0) + 1;
    state.tripleMerges = (state.tripleMerges || 0) + slideRes.tripleCount;
  }

  // Track anchor_row: counts perpendicular-slide moves (tiles can interact with anchor)
  if (state.relics.has('anchor_row') && state.anchor) {
    const isParallel = (
      (state.anchor.type === 'row' && (direction === 'L' || direction === 'R')) ||
      (state.anchor.type === 'col' && (direction === 'U' || direction === 'D'))
    );
    if (!isParallel) act['anchor_row'] = (act['anchor_row'] || 0) + 1;
  }

  state.board = slideRes.board;
  if (slideRes.stoneSpawnMoves) {
    state.stoneSpawnMoves = slideRes.stoneSpawnMoves;
  }
  let mergesThisMove = slideRes.mergesCount;
  let maxCreatedThisMove = slideRes.maxCreatedTile;
  // tilesCreatedThisMove: list of {cell, value} for tiles created by merges (for shatter)
  let mergeCreatedCells = slideRes.mergeCreatedCells || [];

  // 2. Apply post-slide relic effects (Diagonal Merge)
  if (state.relics.has('diagonal_merge')) {
    const diagRes = applyDiagonalMerge(
      state.board,
      state.moveCount,
      state.config.diagonalMergeCooldown ?? 3,
      {
        maxValue: state.config.diagonalMergeMaxValue ?? null,
        onlyOnNoMerge: state.config.diagonalMergeOnlyOnNoMerge ?? false,
        mergesThisMove: mergesThisMove,
      }
    );
    if (diagRes.merged) {
      state.board = diagRes.board;
      mergesThisMove += 1;
      if (diagRes.mergedValue > maxCreatedThisMove) maxCreatedThisMove = diagRes.mergedValue;
      // record cell created by diagonal merge for shatter
      mergeCreatedCells = [...mergeCreatedCells, { cell: diagRes.mergedCell, value: diagRes.mergedValue }];
      act['diagonal_merge'] = (act['diagonal_merge'] || 0) + 1;
    }
  }

  // 2b. Shatter: remove stones adjacent to merge-created tiles >= shatterMin
  if (state.relics.has('shatter') && mergesThisMove > 0) {
    const shatterMin = state.config.shatterMin ?? 64;
    let shatterFired = false;
    for (const { cell, value } of mergeCreatedCells) {
      if (value >= shatterMin) {
        const r = Math.floor(cell / 4), c = cell % 4;
        const ortho = [];
        if (r > 0) ortho.push((r - 1) * 4 + c);
        if (r < 3) ortho.push((r + 1) * 4 + c);
        if (c > 0) ortho.push(r * 4 + (c - 1));
        if (c < 3) ortho.push(r * 4 + (c + 1));
        for (const nc of ortho) {
          if (state.board[nc] === STONE) {
            state.board[nc] = 0;
            if (state.stoneSpawnMoves) state.stoneSpawnMoves[nc] = null;
            shatterFired = true;
          }
        }
      }
    }
    if (shatterFired) act['shatter'] = (act['shatter'] || 0) + 1;
  }

  // Pressure cooker bonusScore: +2 per merge; track activation (fired when a merge happened)
  if (state.relics.has('pressure_cooker') && mergesThisMove > 0) {
    state.bonusScore += mergesThisMove * 2;
    act['pressure_cooker'] = (act['pressure_cooker'] || 0) + 1;
  }

  // Track foresight: once per move it is owned (pure information relic)
  if (state.relics.has('foresight')) {
    act['foresight'] = (act['foresight'] || 0) + 1;
  }

  // D. Scoring
  const sumCreatedValues = mergeCreatedCells.reduce((sum, item) => sum + item.value, 0);
  const mergeMultiplier = Math.min(4, mergesThisMove);
  state.points = (state.points || 0) + sumCreatedValues * mergeMultiplier;

  // 3. moveCount += 1
  state.moveCount += 1;
  state.score = state.moveCount + state.bonusScore;

  // 4a. Check draft trigger if new highest tile was created in steps 1-2
  let highestChanged = false;
  if (maxCreatedThisMove > state.highestTile) {
    state.highestTile = maxCreatedThisMove;
    highestChanged = true;
  }
  let draftTriggered = false;
  if (state.config.enableDraft !== false) {
    const draftsBefore = state.draftHistory ? state.draftHistory.length : 0;
    checkAndResolveDraft(state, bot);
    if (state.draftHistory && state.draftHistory.length > draftsBefore) draftTriggered = true;
  }

  // 4b. draftEveryMoves or draftFirstAt: fire a draft on a fixed interval regardless of tile value
  let triggerPeriodicDraft = false;
  let periodicDraftInfo = {};
  if (state.config.draftFirstAt != null) {
    const firstAt = state.config.draftFirstAt;
    const every = state.config.draftEveryMoves;
    if (state.moveCount === firstAt) {
      triggerPeriodicDraft = true;
      periodicDraftInfo = { draftFirstAt: firstAt };
    } else if (state.moveCount > firstAt && every && every > 0 && (state.moveCount - firstAt) % every === 0) {
      triggerPeriodicDraft = true;
      periodicDraftInfo = { draftEveryMoves: every };
    }
  } else {
    const isDraftEveryMoves = (
      state.config.draftEveryMoves &&
      state.config.draftEveryMoves > 0 &&
      state.moveCount % state.config.draftEveryMoves === 0
    );
    if (isDraftEveryMoves) {
      triggerPeriodicDraft = true;
      periodicDraftInfo = { draftEveryMoves: state.config.draftEveryMoves };
    }
  }
  if (state.config.enableDraft !== false && triggerPeriodicDraft) {
    resolveOneDraft(state, bot, periodicDraftInfo);
    draftTriggered = true;
  }
  if (draftTriggered) {
    state.rewindStack = [];
  }

  // 5. Spawn tile(s)
  // Siphon: skip tile spawn if any merge created >= siphonMin
  const siphonMin = state.config.siphonMin ?? 16;
  const siphonBlocked = state.relics.has('siphon') && maxCreatedThisMove >= siphonMin && mergesThisMove > 0;
  if (siphonBlocked) {
    act['siphon'] = (act['siphon'] || 0) + 1;
  }

  const spawnCount = (
    state.config.doubleSpawnFromMove !== null &&
    state.moveCount >= state.config.doubleSpawnFromMove
  ) ? 2 : 1;

  for (let s = 0; s < spawnCount; s++) {
    if (siphonBlocked && s === 0) {
      // Consume the spawn queue entry without placing a tile (keeps determinism)
      replenishSpawnQueue(state, 1);
      state.spawnQueue.shift();
      continue;
    }
    // Track gravity_well: fires when the 8-neighborhood of the max tile has empty cells
    if (state.relics.has('gravity_well')) {
      let maxVal = -1, maxCell = -1;
      for (let i = 0; i < 16; i++) {
        if (typeof state.board[i] === 'number' && state.board[i] > maxVal) {
          maxVal = state.board[i]; maxCell = i;
        }
      }
      if (maxCell !== -1) {
        const mr = Math.floor(maxCell / 4), mc = maxCell % 4;
        let neighborHasEmpty = false;
        loop: for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = mr + dr, nc = mc + dc;
            if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4 && state.board[nr * 4 + nc] === 0) {
              neighborHasEmpty = true; break loop;
            }
          }
        }
        if (neighborHasEmpty) act['gravity_well'] = (act['gravity_well'] || 0) + 1;
      }
    }
    spawnOneTile(state);
  }

  // 6. Stone spawn if due (with stoneLifetime decay at start of step 6)
  if (state.config.stoneLifetime !== null && state.config.stoneLifetime > 0) {
    const L = state.config.stoneLifetime;
    for (let c = 0; c < 16; c++) {
      if (state.board[c] === STONE && state.stoneSpawnMoves && state.stoneSpawnMoves[c] !== null) {
        if (state.moveCount - state.stoneSpawnMoves[c] >= L) {
          state.board[c] = 0;
          state.stoneSpawnMoves[c] = null;
        }
      }
    }
  }

  const stoneSpawned = spawnStoneIfDue(state, bot);
  if (stoneSpawned && state.relics.has('mason')) {
    act['mason'] = (act['mason'] || 0) + 1;
    state.rewindStack = [];
  }

  // Update highestTile on board
  for (const cell of state.board) {
    if (typeof cell === 'number' && cell > state.highestTile) state.highestTile = cell;
  }

  // Tick ability cooldowns for abilities owned at START of swipe
  for (const rid of ownedAbilitiesAtStart) {
    const ab = state.abilities?.[rid];
    if (!ab) continue;
    const every = (rid === 'diagonal_charge')
      ? (state.config.diagonalChargeEvery ?? 10)
      : (rid === 'eraser')
      ? (state.config.eraserEvery ?? 20)
      : (state.config.rewindEvery ?? 10);
    if (ab.charges >= maxCharges) {
      ab.swipesAtMax = (ab.swipesAtMax || 0) + 1;
    } else {
      ab.counter = (ab.counter || 0) + 1;
      if (ab.counter >= every) {
        ab.charges += 1;
        ab.counter = 0;
      }
    }
  }

  let lastStandFired = false;
  // 7. Game over check & moveCap
  if (state.moveCount >= state.config.moveCap) {
    state.capped = true;
    state.gameOver = true;
    state.stuckNeedsAbility = false;
  } else {
    if (getValidMoves(state).length === 0) {
      if (hasLegalAbility(state)) {
        state.stuckNeedsAbility = true;
      } else {
        state.stuckNeedsAbility = false;
        // last_stand: once per run, remove tiles <= lastStandMax and retry
        if (state.relics.has('last_stand') && !state.lastStandUsed) {
          state.lastStandUsed = true;
          lastStandFired = true;
          state.rewindStack = [];
          const lastStandMax = state.config.lastStandMax ?? 16;
          for (let c = 0; c < 16; c++) {
            if (typeof state.board[c] === 'number' && state.board[c] > 0 && state.board[c] <= lastStandMax) {
              state.board[c] = 0;
            }
          }
          act['last_stand'] = (act['last_stand'] || 0) + 1;
          // Check again
          if (getValidMoves(state).length === 0) {
            if (hasLegalAbility(state)) {
              state.stuckNeedsAbility = true;
            } else {
              state.gameOver = true;
            }
          }
        } else {
          state.gameOver = true;
        }
      }
    } else {
      state.stuckNeedsAbility = false;
    }
  }

  return {
    valid: true,
    mergesThisMove,
    maxCreatedThisMove,
    lastStandFired,
    state,
    boardBefore,
    boardAfter: [...state.board],
  };
}

