/**
 * Action Bots module for 2048-Rogue.
 * Wraps base directional bots with ability-use policies:
 *   chooseAction(state) -> { type: 'swipe', dir } | { type: 'ability', relic, target } | null
 */

import {
  createGame,
  step,
  getValidMoves,
  getLegalTargets,
  useAbility,
  applySlide,
} from './engine.js';
import { evaluateBoard } from './bots.js';

/**
 * Evaluates candidate targets and picks the best available ability action.
 * Priority: diagonal_charge (if owned and charged), then eraser (if owned and charged).
 */
export function pickAbilityAction(state, placementPolicy = 'upper') {
  if (state.relics.has('diagonal_charge')) {
    const ab = state.abilities?.diagonal_charge;
    if (ab && ab.charges > 0) {
      let targets = getLegalTargets(state, 'diagonal_charge');
      if (targets.length > 0) {
        if (placementPolicy === 'upper') {
          // 'upper' = to is the lower index (old behavior)
          const upperTargets = targets.filter(t => t.to < t.from);
          const pool = upperTargets.length > 0 ? upperTargets : targets;
          pool.sort((t1, t2) => {
            const v1 = state.board[t1.to] * 2;
            const v2 = state.board[t2.to] * 2;
            if (v2 !== v1) return v2 - v1;
            if (t1.to !== t2.to) return t1.to - t2.to;
            return t1.from - t2.from;
          });
          return { type: 'ability', relic: 'diagonal_charge', target: pool[0] };
        } else {
          // 'best' = choose the order using the greedy board evaluator, ties -> upper
          const scored = targets.map(t => {
            const simBoard = [...state.board];
            const mergedVal = state.board[t.from] * 2;
            simBoard[t.to] = mergedVal;
            simBoard[t.from] = 0;
            if (state.relics.has('shatter') && mergedVal >= (state.config?.shatterMin ?? 64)) {
              const r = Math.floor(t.to / 4), c = t.to % 4;
              const ortho = [];
              if (r > 0) ortho.push((r - 1) * 4 + c);
              if (r < 3) ortho.push((r + 1) * 4 + c);
              if (c > 0) ortho.push(r * 4 + (c - 1));
              if (c < 3) ortho.push(r * 4 + (c + 1));
              for (const nc of ortho) {
                if (simBoard[nc] === 'S') simBoard[nc] = 0;
              }
            }
            const score = evaluateBoard(simBoard, 0);
            const isUpper = t.to < t.from ? 1 : 0;
            return { target: t, score, isUpper, mergedVal };
          });
          scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.isUpper !== a.isUpper) return b.isUpper - a.isUpper;
            if (b.mergedVal !== a.mergedVal) return b.mergedVal - a.mergedVal;
            if (a.target.to !== b.target.to) return a.target.to - b.target.to;
            return a.target.from - b.target.from;
          });
          return { type: 'ability', relic: 'diagonal_charge', target: scored[0].target };
        }
      }
    }
  }

  if (state.relics.has('eraser')) {
    const ab = state.abilities?.eraser;
    if (ab && ab.charges > 0) {
      const targets = getLegalTargets(state, 'eraser');
      if (targets.length > 0) {
        // Evaluate candidate cell with greedy bot's board evaluator after removal
        // ties by lowest tile value, then row-major cell index
        const scored = targets.map(t => {
          const cell = t.cell;
          const val = state.board[cell];
          const simBoard = [...state.board];
          simBoard[cell] = 0;
          const score = evaluateBoard(simBoard, 0);
          return { target: t, cell, val, score };
        });
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.val !== b.val) return a.val - b.val;
          return a.cell - b.cell;
        });
        return { type: 'ability', relic: 'eraser', target: scored[0].target };
      }
    }
  }

  return null;
}

/**
 * Wraps a base directional bot with an ability usage policy:
 * Policies:
 * - 'immediate': use as soon as a charge and legal target exist, before swiping
 * - 'low:k' (k in {2,3,4}): use when empty cells <= k
 * - 'stuck': only use when no valid swipe exists
 * Placement policies for diagonal merge:
 * - 'upper': to is lower index (default)
 * - 'best': greedy board evaluator, ties -> upper
 */
export function withAbilities(baseBot, policy, options = {}) {
  const placement = (typeof options === 'string') ? options : (options?.placement || 'upper');
  let bannedDir = null;
  let lastSwipedDir = null;
  let lastActionType = null;

  return {
    baseBot,
    policy,
    placement,
    chooseDraftRelic: baseBot.chooseDraftRelic ? baseBot.chooseDraftRelic.bind(baseBot) : undefined,
    chooseStoneCell: baseBot.chooseStoneCell ? baseBot.chooseStoneCell.bind(baseBot) : undefined,
    chooseAction(state) {
      if (state.gameOver || state.capped) return null;

      const validMoves = getValidMoves(state);
      const isStuck = state.stuckNeedsAbility || validMoves.length === 0;

      if (isStuck) {
        const action = pickAbilityAction(state, placement);
        if (action) {
          lastActionType = 'ability';
          return action;
        }
        if (state.relics.has('rewind') && getLegalTargets(state, 'rewind').length > 0) {
          bannedDir = lastSwipedDir;
          lastActionType = 'ability';
          return { type: 'ability', relic: 'rewind', target: {} };
        }
        return null;
      }

      let shouldCheckAbility = false;
      if (policy === 'immediate') {
        shouldCheckAbility = true;
      } else if (policy.startsWith('low:')) {
        const k = parseInt(policy.slice(4), 10);
        const emptyCells = state.board.filter(c => c === 0).length;
        if (emptyCells <= k) {
          shouldCheckAbility = true;
        }
      }

      if (shouldCheckAbility) {
        const action = pickAbilityAction(state, placement);
        if (action) {
          lastActionType = 'ability';
          return action;
        }
        if (policy.startsWith('low:')) {
          if (lastActionType === 'swipe' && state.relics.has('rewind') && getLegalTargets(state, 'rewind').length > 0) {
            bannedDir = lastSwipedDir;
            lastActionType = 'ability';
            return { type: 'ability', relic: 'rewind', target: {} };
          }
        }
      }

      let dir = baseBot.chooseMove(state);
      if (!dir) return null;

      if (bannedDir && dir === bannedDir) {
        const allowedMoves = validMoves.filter(d => d !== bannedDir);
        if (allowedMoves.length > 0) {
          let bestScore = -Infinity;
          let bestDir = allowedMoves[0];
          for (const d of allowedMoves) {
            const simRes = applySlide(state.board, d, state.relics, state.anchor, state.stoneSpawnMoves);
            if (simRes.changed) {
              const sc = evaluateBoard(simRes.board, 0);
              if (sc > bestScore) {
                bestScore = sc;
                bestDir = d;
              }
            }
          }
          dir = bestDir;
        }
      }

      bannedDir = null;
      lastSwipedDir = dir;
      lastActionType = 'swipe';
      return { type: 'swipe', dir };
    },
  };
}

/**
 * Runs a deterministic simulation using chooseAction loop.
 * Handles stuckNeedsAbility (uses ability; if bot declines, ends the run).
 */
export function runActionGame(actionBot, config, seed) {
  const game = createGame(seed, config);
  const actions = [];

  while (!game.gameOver && !game.capped) {
    if (game.stuckNeedsAbility) {
      const action = actionBot.chooseAction(game);
      if (action && action.type === 'ability') {
        useAbility(game, action.relic, action.target);
        actions.push(action);
        continue;
      } else {
        // Bot declined to use ability when stuck
        // Let Last Stand fire (if available), else game over
        game.stuckNeedsAbility = false;
        if (game.relics.has('last_stand') && !game.lastStandUsed) {
          game.lastStandUsed = true;
          game.relicActivations['last_stand'] = (game.relicActivations['last_stand'] || 0) + 1;
          const lastStandMax = game.config.lastStandMax ?? 16;
          for (let c = 0; c < 16; c++) {
            if (typeof game.board[c] === 'number' && game.board[c] > 0 && game.board[c] <= lastStandMax) {
              game.board[c] = 0;
            }
          }
          if (getValidMoves(game).length === 0) {
            game.gameOver = true;
          }
        } else {
          game.gameOver = true;
        }
        break;
      }
    }

    const action = actionBot.chooseAction(game);
    if (!action) break;

    if (action.type === 'ability') {
      useAbility(game, action.relic, action.target);
      actions.push(action);
    } else if (action.type === 'swipe') {
      const res = step(game, action.dir, actionBot.baseBot || null);
      if (!res.valid) break;
      actions.push(action);
    }
  }

  return {
    game,
    moveCount: game.moveCount,
    score: game.score,
    actions,
  };
}
