/**
 * Section G Experiments Runner
 *
 * G3. EXPERIMENTS (3x stones, relic injected at move 30, seeds 10000+,
 * mean moves with 95% paired-bootstrap CIs vs same-bot no-relic baseline;
 * report uses/run, swipesAtMax, chargesAtDeath)
 *
 * 1. Rewind human-proxy, noisy expectimax eps 0.1 and 0.25, N=300.
 *    New Rewind policies:
 *    - 'oracle' = undo whenever the swipe just played was a noise-chosen move;
 *    - 'evaldrop:T' = undo if the greedy evaluator drops by more than T after the swipe (T in {5, 10, 20}).
 *    After an undo, ban the undone direction at the next swipe.
 *
 * 2. Pairs, expectimax N=200, placement best, Rewind under 'stuck', partner under low:3:
 *    - rewind + eraser
 *    - rewind + diagonal_charge
 *    - rewind + last_stand
 *    - plus diagonal_charge + shatter as reference.
 *
 * 3. Diagonal supply sweep, greedy N=1000, policy stuck, placement best:
 *    diagonalChargeEvery {10, 20, 30} x maxCharges {2, 3}.
 */

import {
  createGame,
  step,
  getValidMoves,
  getLegalTargets,
  useAbility,
  applySlide,
  buildHazardSchedule,
} from './engine.js';
import {
  createBot,
  createExpectimaxBot,
  createNoisyBot,
  evaluateBoard,
} from './bots.js';
import { pickAbilityAction } from './action_bots.js';

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}

function createBootstrapRng(seed = 123456789) {
  let s = seed >>> 0;
  return function () {
    let t = (s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(diffs, resamples = 2000) {
  const n = diffs.length;
  const rng = createBootstrapRng(42);
  const meanReplicates = new Float64Array(resamples);

  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += diffs[idx];
    }
    meanReplicates[b] = sum / n;
  }

  meanReplicates.sort();
  const meanLow = Math.round(getPercentile(meanReplicates, 2.5) * 100) / 100;
  const meanHigh = Math.round(getPercentile(meanReplicates, 97.5) * 100) / 100;

  return { meanLow, meanHigh };
}

/**
 * Runs a single simulation run under specific policies.
 */
function runGGame({
  seed,
  bot,
  configOverrides = {},
  rewindPolicy = null, // 'oracle' | 'evaldrop:T' | 'stuck' | null
  partnerPolicy = null, // 'low:3' | 'stuck' | null
  placement = 'best',
}) {
  const config = {
    hazardSchedule: buildHazardSchedule(3),
    stoneLifetime: null,
    enableDraft: false,
    forceAtMove: 30,
    ...configOverrides,
  };

  const game = createGame(seed, config);
  if (bot.reset) bot.reset(seed);

  let bannedDir = null;
  let lastSwipedDir = null;

  while (!game.gameOver && !game.capped) {
    const validMoves = getValidMoves(game);
    const isStuck = game.stuckNeedsAbility || validMoves.length === 0;

    // Handle stuck state
    if (isStuck) {
      let abilityUsed = false;

      // 1. Check partner active abilities if available
      const partnerAction = pickAbilityAction(game, placement);
      if (partnerAction) {
        useAbility(game, partnerAction.relic, partnerAction.target);
        abilityUsed = true;
      } else if (
        game.relics.has('rewind') &&
        (game.abilities?.rewind?.charges ?? 0) > 0 &&
        game.rewindSnapshot !== null
      ) {
        // Rewind under stuck
        useAbility(game, 'rewind', {});
        bannedDir = lastSwipedDir;
        abilityUsed = true;
      }

      if (abilityUsed) {
        continue;
      }

      // If no ability could be used, resolve stuck (Last Stand or game over)
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

    // Pre-swipe active abilities (e.g. partner under 'low:3')
    if (partnerPolicy && partnerPolicy.startsWith('low:')) {
      const k = parseInt(partnerPolicy.slice(4), 10);
      const emptyCells = game.board.filter(c => c === 0).length;
      if (emptyCells <= k) {
        const partnerAction = pickAbilityAction(game, placement);
        if (partnerAction) {
          useAbility(game, partnerAction.relic, partnerAction.target);
          continue;
        }
      }
    }

    // Direction selection
    let dir = bot.chooseMove(game);
    if (!dir) break;

    // Ban the undone direction at the next swipe
    if (bannedDir && dir === bannedDir) {
      const allowedMoves = validMoves.filter(d => d !== bannedDir);
      if (allowedMoves.length > 0) {
        let bestScore = -Infinity;
        let bestDir = allowedMoves[0];
        for (const d of allowedMoves) {
          const simRes = applySlide(game.board, d, game.relics, game.anchor, game.stoneSpawnMoves);
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

    // Pre-swipe metrics for Rewind policy
    const evalBefore = evaluateBoard(game.board, 0);
    const wasNoise = Boolean(bot.lastMoveWasNoise);

    // Execute swipe
    const res = step(game, dir, bot);
    if (!res.valid) break;

    // Post-swipe Rewind check
    if (rewindPolicy && game.relics.has('rewind')) {
      const canRewind = (game.abilities?.rewind?.charges ?? 0) > 0 && game.rewindSnapshot !== null;
      if (canRewind) {
        let shouldUndo = false;
        if (rewindPolicy === 'oracle') {
          shouldUndo = wasNoise;
        } else if (rewindPolicy.startsWith('evaldrop:')) {
          const T = parseFloat(rewindPolicy.split(':')[1]);
          const evalAfter = evaluateBoard(game.board, 0);
          if (evalBefore - evalAfter > T) {
            shouldUndo = true;
          }
        }

        if (shouldUndo) {
          useAbility(game, 'rewind', {});
          bannedDir = dir;
          continue;
        }
      }
    }
  }

  // Extract metrics
  let totalUses = 0;
  let totalSwipesAtMax = 0;
  let totalChargesAtDeath = 0;

  for (const rid of ['rewind', 'diagonal_charge', 'eraser']) {
    if (game.relics.has(rid)) {
      totalUses += game.relicActivations[rid] || 0;
      const ab = game.abilities?.[rid];
      if (ab) {
        totalSwipesAtMax += ab.swipesAtMax || 0;
        totalChargesAtDeath += ab.charges ?? 0;
      }
    }
  }

  return {
    seed,
    moveCount: game.moveCount,
    points: game.points || 0,
    score: game.score || 0,
    uses: totalUses,
    swipesAtMax: totalSwipesAtMax,
    chargesAtDeath: totalChargesAtDeath,
    game,
  };
}

async function runG1() {
  console.log('====================================================================================================');
  console.log('EXPERIMENT G3.1: Rewind Human-Proxy (Noisy Expectimax, N=300, seeds 10000..10299)');
  console.log('====================================================================================================');

  const N = 300;
  const seeds = Array.from({ length: N }, (_, i) => 10000 + i);
  const epsilons = [0.1, 0.25];
  const policies = ['oracle', 'evaldrop:5', 'evaldrop:10', 'evaldrop:20'];

  for (const eps of epsilons) {
    console.log(`\n--- Running Noisy Expectimax (eps = ${eps}, N = ${N}) ---`);
    const baseExp = createExpectimaxBot();
    const noisyBot = createNoisyBot(baseExp, eps);

    // 1. Baseline: same noisy bot, no relics
    const baselineResults = seeds.map(seed => {
      return runGGame({
        seed,
        bot: noisyBot,
        configOverrides: { forcedRelics: [], forceAtMove: 30 },
      });
    });
    const baseMean = baselineResults.reduce((s, r) => s + r.moveCount, 0) / N;
    console.log(`Baseline (no relics): mean moves = ${baseMean.toFixed(2)}`);

    console.log('\n| Policy | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
    console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

    for (const pol of policies) {
      const expResults = seeds.map(seed => {
        return runGGame({
          seed,
          bot: noisyBot,
          configOverrides: { forcedRelics: ['rewind'], forceAtMove: 30 },
          rewindPolicy: pol,
        });
      });

      const expMean = expResults.reduce((s, r) => s + r.moveCount, 0) / N;
      const diffs = expResults.map((r, i) => r.moveCount - baselineResults[i].moveCount);
      const deltaMean = diffs.reduce((s, d) => s + d, 0) / N;
      const ci = bootstrapCI(diffs);

      const meanUses = expResults.reduce((s, r) => s + r.uses, 0) / N;
      const meanSwipesAtMax = expResults.reduce((s, r) => s + r.swipesAtMax, 0) / N;
      const meanChargesAtDeath = expResults.reduce((s, r) => s + r.chargesAtDeath, 0) / N;

      const ciStr = `[${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}]`;
      console.log(
        `| ${pol.padEnd(11)} | ${expMean.toFixed(2).padStart(10)} | ${deltaMean >= 0 ? '+' : ''}${deltaMean.toFixed(2).padStart(11)} | ${ciStr.padStart(16)} | ${meanUses.toFixed(2).padStart(8)} | ${meanSwipesAtMax.toFixed(2).padStart(11)} | ${meanChargesAtDeath.toFixed(2).padStart(14)} |`
      );
    }
  }
}

async function runG2() {
  console.log('\n====================================================================================================');
  console.log('EXPERIMENT G3.2: Relic Pairs (Expectimax, N=200, seeds 10000..10199, placement best)');
  console.log('====================================================================================================');

  const N = 200;
  const seeds = Array.from({ length: N }, (_, i) => 10000 + i);
  const bot = createExpectimaxBot();

  // Baseline: Expectimax no-relic
  const baselineResults = seeds.map(seed => {
    return runGGame({
      seed,
      bot,
      configOverrides: { forcedRelics: [], forceAtMove: 30 },
    });
  });
  const baseMean = baselineResults.reduce((s, r) => s + r.moveCount, 0) / N;
  console.log(`Baseline Expectimax (no relics): mean moves = ${baseMean.toFixed(2)}`);

  const pairs = [
    { name: 'rewind + eraser', relics: ['rewind', 'eraser'], rewindPol: 'stuck', partnerPol: 'low:3' },
    { name: 'rewind + diagonal_charge', relics: ['rewind', 'diagonal_charge'], rewindPol: 'stuck', partnerPol: 'low:3' },
    { name: 'rewind + last_stand', relics: ['rewind', 'last_stand'], rewindPol: 'stuck', partnerPol: null },
    { name: 'diagonal_charge + shatter (ref)', relics: ['diagonal_charge', 'shatter'], rewindPol: null, partnerPol: 'low:3' },
  ];

  console.log('\n| Relic Pair | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const pair of pairs) {
    const expResults = seeds.map(seed => {
      return runGGame({
        seed,
        bot,
        configOverrides: { forcedRelics: pair.relics, forceAtMove: 30 },
        rewindPolicy: pair.rewindPol,
        partnerPolicy: pair.partnerPol,
        placement: 'best',
      });
    });

    const expMean = expResults.reduce((s, r) => s + r.moveCount, 0) / N;
    const diffs = expResults.map((r, i) => r.moveCount - baselineResults[i].moveCount);
    const deltaMean = diffs.reduce((s, d) => s + d, 0) / N;
    const ci = bootstrapCI(diffs);

    const meanUses = expResults.reduce((s, r) => s + r.uses, 0) / N;
    const meanSwipesAtMax = expResults.reduce((s, r) => s + r.swipesAtMax, 0) / N;
    const meanChargesAtDeath = expResults.reduce((s, r) => s + r.chargesAtDeath, 0) / N;

    const ciStr = `[${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}]`;
    console.log(
      `| ${pair.name.padEnd(30)} | ${expMean.toFixed(2).padStart(10)} | ${deltaMean >= 0 ? '+' : ''}${deltaMean.toFixed(2).padStart(11)} | ${ciStr.padStart(16)} | ${meanUses.toFixed(2).padStart(8)} | ${meanSwipesAtMax.toFixed(2).padStart(11)} | ${meanChargesAtDeath.toFixed(2).padStart(14)} |`
    );
  }
}

async function runG3() {
  console.log('\n====================================================================================================');
  console.log('EXPERIMENT G3.3: Diagonal Supply Sweep (Greedy, N=1000, seeds 10000..10999, policy stuck, placement best)');
  console.log('====================================================================================================');

  const N = 1000;
  const seeds = Array.from({ length: N }, (_, i) => 10000 + i);
  const bot = createBot('greedy');

  // Baseline: Greedy no-relic
  const baselineResults = seeds.map(seed => {
    return runGGame({
      seed,
      bot,
      configOverrides: { forcedRelics: [], forceAtMove: 30 },
    });
  });
  const baseMean = baselineResults.reduce((s, r) => s + r.moveCount, 0) / N;
  console.log(`Baseline Greedy (no relics): mean moves = ${baseMean.toFixed(2)}`);

  const grid = [
    { every: 10, maxCharges: 2 },
    { every: 10, maxCharges: 3 },
    { every: 20, maxCharges: 2 },
    { every: 20, maxCharges: 3 },
    { every: 30, maxCharges: 2 },
    { every: 30, maxCharges: 3 },
  ];

  console.log('\n| diagonalChargeEvery | maxCharges | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const cfg of grid) {
    const expResults = seeds.map(seed => {
      return runGGame({
        seed,
        bot,
        configOverrides: {
          forcedRelics: ['diagonal_charge'],
          forceAtMove: 30,
          diagonalChargeEvery: cfg.every,
          maxCharges: cfg.maxCharges,
        },
        partnerPolicy: 'stuck',
        placement: 'best',
      });
    });

    const expMean = expResults.reduce((s, r) => s + r.moveCount, 0) / N;
    const diffs = expResults.map((r, i) => r.moveCount - baselineResults[i].moveCount);
    const deltaMean = diffs.reduce((s, d) => s + d, 0) / N;
    const ci = bootstrapCI(diffs);

    const meanUses = expResults.reduce((s, r) => s + r.uses, 0) / N;
    const meanSwipesAtMax = expResults.reduce((s, r) => s + r.swipesAtMax, 0) / N;
    const meanChargesAtDeath = expResults.reduce((s, r) => s + r.chargesAtDeath, 0) / N;

    const ciStr = `[${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}]`;
    console.log(
      `| ${cfg.every.toString().padStart(19)} | ${cfg.maxCharges.toString().padStart(10)} | ${expMean.toFixed(2).padStart(10)} | ${deltaMean >= 0 ? '+' : ''}${deltaMean.toFixed(2).padStart(11)} | ${ciStr.padStart(16)} | ${meanUses.toFixed(2).padStart(8)} | ${meanSwipesAtMax.toFixed(2).padStart(11)} | ${meanChargesAtDeath.toFixed(2).padStart(14)} |`
    );
  }
}

async function main() {
  const t0 = Date.now();
  await runG1();
  await runG2();
  await runG3();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nAll Section G experiments completed in ${elapsed}s (cap: 30 min, N was not cut).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
