import crypto from 'node:crypto';
import { createGame, step } from '../engine.js';
import { createBot, createExpectimaxBot } from '../bots.js';

export function buildHazardSchedule(multiplier) {
  return [
    { upToMove: 100, interval: Math.max(3, Math.round(25 * multiplier)) },
    { upToMove: 200, interval: Math.max(3, Math.round(20 * multiplier)) },
    { upToMove: 300, interval: Math.max(3, Math.round(15 * multiplier)) },
    { upToMove: Infinity, interval: Math.max(3, Math.round(10 * multiplier)) },
  ];
}

export const POOL_7 = [
  'diagonal_merge',
  'fault_line',
  'mason',
  'foresight',
  'siphon',
  'shatter',
  'last_stand',
];

export const CONFIGS = [
  {
    id: 'no_relics',
    config: {
      hazardSchedule: buildHazardSchedule(3),
      stoneLifetime: null,
      enableDraft: false,
      forcedRelics: [],
      forceAtMove: 30,
    },
  },
  ...POOL_7.map(r => ({
    id: `forced_${r}`,
    config: {
      hazardSchedule: buildHazardSchedule(3),
      stoneLifetime: null,
      enableDraft: false,
      forcedRelics: [r],
      forceAtMove: 30,
    },
  })),
  {
    id: 'draft_60',
    config: {
      hazardSchedule: buildHazardSchedule(3),
      stoneLifetime: null,
      enableDraft: true,
      draftPool: POOL_7,
      draftEveryMoves: 60,
      draftThresholds: [],
      draftPolicy: 'random',
    },
  },
];

export function runSimGame(bot, config, seed) {
  const game = createGame(seed, config);
  const moves = [];
  while (!game.gameOver && !game.capped) {
    const m = bot.chooseMove(game);
    if (!m) break;
    const res = step(game, m, bot);
    if (!res.valid) break;
    moves.push(m);
  }

  const relics = Array.from(game.relics).sort();
  const finalBoard = [...game.board];
  const moveCount = game.moveCount;
  const moveSequence = moves.join('');

  const hashPayload = JSON.stringify({
    moves: moveSequence,
    board: finalBoard,
    relics,
    moveCount,
  });

  const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  return {
    moveCount,
    moves: moveSequence,
    finalBoard,
    relics,
    hash,
  };
}
