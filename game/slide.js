/**
 * UI-side pure slide helper for 2048 Rogue (game/, not sim/).
 * Computes each number tile's from/to cell, which tiles merge, and predicts post-slide board.
 */

export const STONE = 'S';
export const DIRECTIONS = ['L', 'R', 'U', 'D'];

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
 * Pure helper for Fault Line relic stone shifts before the slide.
 * A stone shifts one cell in the slide direction iff the cell beyond it is empty
 * AND the cell immediately behind it holds a number tile.
 */
export function applyFaultLine(board, direction) {
  let changed = false;
  const nextBoard = [...board];
  const shiftedStones = [];

  for (let lineIdx = 0; lineIdx < 4; lineIdx++) {
    const indices = getLineIndices(direction, lineIdx);
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
          shiftedStones.push({ from: indices[k], to: indices[beyondIdx] });
          changed = true;
        }
      }
    }
  }

  return { board: nextBoard, shiftedStones, changed };
}

/**
 * Pure helper: from board before and swipe direction, computes tile movements,
 * merges, and predicted post-slide board (accounting for Fault Line and Siphon).
 *
 * @param {Array} boardBefore - 16-element array of numbers, 0, or 'S'
 * @param {string} direction - 'L' | 'R' | 'U' | 'D'
 * @param {Object} [options] - { hasFaultLine?: boolean, hasSiphon?: boolean, siphonMin?: number }
 * @returns {Object} { predictedBoard, moves, mergedCells, changed, shiftedStones, skippedSpawn, maxCreated }
 */
export function computeSlide(boardBefore, direction, options = {}) {
  let workingBoard = [...boardBefore];
  let shiftedStones = [];
  let faultChanged = false;

  if (options.hasFaultLine) {
    const faultRes = applyFaultLine(workingBoard, direction);
    workingBoard = faultRes.board;
    shiftedStones = faultRes.shiftedStones;
    faultChanged = faultRes.changed;
  }

  const predictedBoard = [...workingBoard];
  const moves = [];
  const mergedCells = new Set();
  let changed = false;
  let maxCreated = 0;

  for (let lineIndex = 0; lineIndex < 4; lineIndex++) {
    const lineIndices = getLineIndices(direction, lineIndex);

    let segStart = 0;
    for (let k = 0; k <= 4; k++) {
      if (k === 4 || workingBoard[lineIndices[k]] === STONE) {
        if (k > segStart) {
          const segCellIndices = lineIndices.slice(segStart, k);
          const tilesInSeg = [];
          for (let s = 0; s < segCellIndices.length; s++) {
            const cellIdx = segCellIndices[s];
            const val = workingBoard[cellIdx];
            if (typeof val === 'number' && val > 0) {
              tilesInSeg.push({ cellIdx, val });
            }
          }

          let destOffset = 0;
          let i = 0;
          while (i < tilesInSeg.length) {
            const destCellIdx = segCellIndices[destOffset];
            if (i + 1 < tilesInSeg.length && tilesInSeg[i].val === tilesInSeg[i + 1].val) {
              const newVal = tilesInSeg[i].val * 2;
              if (newVal > maxCreated) maxCreated = newVal;
              moves.push({
                fromIndex: tilesInSeg[i].cellIdx,
                toIndex: destCellIdx,
                value: tilesInSeg[i].val,
                isMerge: true,
                resultValue: newVal,
                lineIndex,
              });
              moves.push({
                fromIndex: tilesInSeg[i + 1].cellIdx,
                toIndex: destCellIdx,
                value: tilesInSeg[i + 1].val,
                isMerge: true,
                resultValue: newVal,
                lineIndex,
              });
              mergedCells.add(destCellIdx);
              predictedBoard[destCellIdx] = newVal;
              if (tilesInSeg[i].cellIdx !== destCellIdx || tilesInSeg[i + 1].cellIdx !== destCellIdx) {
                changed = true;
              }
              destOffset++;
              i += 2;
            } else {
              moves.push({
                fromIndex: tilesInSeg[i].cellIdx,
                toIndex: destCellIdx,
                value: tilesInSeg[i].val,
                isMerge: false,
                resultValue: tilesInSeg[i].val,
                lineIndex,
              });
              predictedBoard[destCellIdx] = tilesInSeg[i].val;
              if (tilesInSeg[i].cellIdx !== destCellIdx) {
                changed = true;
              }
              destOffset++;
              i += 1;
            }
          }

          while (destOffset < segCellIndices.length) {
            const emptyCellIdx = segCellIndices[destOffset];
            if (predictedBoard[emptyCellIdx] !== 0) {
              changed = true;
            }
            predictedBoard[emptyCellIdx] = 0;
            destOffset++;
          }
        }
        segStart = k + 1;
      }
    }
  }

  const siphonMin = options.siphonMin ?? 16;
  const skippedSpawn = Boolean(options.hasSiphon && maxCreated >= siphonMin && mergedCells.size > 0);

  return {
    predictedBoard,
    moves,
    mergedCells: Array.from(mergedCells),
    changed: changed || faultChanged,
    shiftedStones,
    skippedSpawn,
    maxCreated,
  };
}
