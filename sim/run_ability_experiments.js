/**
 * Ability Relic Experiments Runner
 *
 * Experiments:
 * 1. Solos diagonal_charge and eraser x policies {immediate, low:3, low:4, stuck}:
 *    Greedy N=1000 and Expectimax N=300.
 *    Reports delta, 95% bootstrap CI, uses/run, mean swipesAtMax, mean charges held at death.
 * 2. N sweeps under low:3 (Greedy N=1000):
 *    diagonalChargeEvery {6, 10, 15}; eraserEvery {15, 20, 30}.
 * 3. Pairs under low:3 (Expectimax N=200):
 *    diagonal_charge+shatter, eraser+shatter, diagonal_charge+eraser, eraser+last_stand: synergy with CI.
 */

import { buildHazardSchedule } from './engine.js';
import { createBot, createExpectimaxBot } from './bots.js';
import { withAbilities, runActionGame } from './action_bots.js';

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

function runExperimentSeries(bot, policy, configOverrides, seeds) {
  const actionBot = withAbilities(bot, policy);
  return seeds.map(seed => {
    const config = {
      hazardSchedule: buildHazardSchedule(3),
      stoneLifetime: null,
      enableDraft: false,
      forceAtMove: 30,
      ...configOverrides,
    };
    const res = runActionGame(actionBot, config, seed);
    const g = res.game;
    return {
      seed,
      moveCount: g.moveCount,
      activations: { ...g.relicActivations },
      abilities: {
        diagonal_charge: g.abilities?.diagonal_charge ? { ...g.abilities.diagonal_charge } : null,
        eraser: g.abilities?.eraser ? { ...g.abilities.eraser } : null,
      },
    };
  });
}

async function main() {
  console.log('================================================================');
  console.log('ABILITY RELIC EXPERIMENTS: 3x Stones, injected at move 30');
  console.log('================================================================\n');

  const seeds1000 = Array.from({ length: 1000 }, (_, i) => 10000 + i);
  const seeds300 = Array.from({ length: 300 }, (_, i) => 10000 + i);
  const seeds200 = Array.from({ length: 200 }, (_, i) => 10000 + i);

  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();

  // -------------------------------------------------------------
  // Baselines
  // -------------------------------------------------------------
  console.log('Running Baselines...');
  const greedyBaseRuns = runExperimentSeries(greedyBot, 'stuck', { forcedRelics: [] }, seeds1000);
  const greedyBaseMoves = greedyBaseRuns.map(r => r.moveCount);
  const meanGreedyBase = greedyBaseMoves.reduce((a, b) => a + b, 0) / 1000;
  console.log(`Greedy Baseline (N=1000): ${meanGreedyBase.toFixed(2)} moves (Expected: 150.63)`);

  const exBaseRuns300 = runExperimentSeries(expectimaxBot, 'stuck', { forcedRelics: [] }, seeds300);
  const exBaseMoves300 = exBaseRuns300.map(r => r.moveCount);
  const meanExBase300 = exBaseMoves300.reduce((a, b) => a + b, 0) / 300;
  console.log(`Expectimax Baseline (N=300): ${meanExBase300.toFixed(2)} moves`);

  const exBaseRuns200 = exBaseRuns300.slice(0, 200);
  const exBaseMoves200 = exBaseRuns200.map(r => r.moveCount);
  const meanExBase200 = exBaseMoves200.reduce((a, b) => a + b, 0) / 200;
  console.log(`Expectimax Baseline (N=200): ${meanExBase200.toFixed(2)} moves\n`);

  // -------------------------------------------------------------
  // Experiment 1: Solos x Policies
  // -------------------------------------------------------------
  console.log('### Experiment 1: Solos diagonal_charge and eraser x Policies\n');
  const policies = ['immediate', 'low:3', 'low:4', 'stuck'];
  const abilityRelics = ['diagonal_charge', 'eraser'];

  console.log('#### 1A. Greedy Bot (N=1000, Baseline = ' + meanGreedyBase.toFixed(2) + ')');
  console.log('| Relic | Policy | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|---|');

  for (const relic of abilityRelics) {
    for (const pol of policies) {
      const runs = runExperimentSeries(greedyBot, pol, { forcedRelics: [relic] }, seeds1000);
      const moves = runs.map(r => r.moveCount);
      const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
      const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
      const delta = diffs.reduce((a, b) => a + b, 0) / 1000;
      const ci = bootstrapCI(diffs);
      const uses = runs.map(r => r.activations[relic] || 0).reduce((a, b) => a + b, 0) / 1000;
      const swipesAtMax = runs.map(r => r.abilities[relic]?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 1000;
      const chargesAtDeath = runs.map(r => r.abilities[relic]?.charges || 0).reduce((a, b) => a + b, 0) / 1000;

      const sign = delta >= 0 ? '+' : '';
      console.log(`| ${relic} | ${pol} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
    }
  }
  console.log('');

  console.log('#### 1B. Expectimax Bot (N=300, Baseline = ' + meanExBase300.toFixed(2) + ')');
  console.log('| Relic | Policy | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|---|');

  for (const relic of abilityRelics) {
    for (const pol of policies) {
      const runs = runExperimentSeries(expectimaxBot, pol, { forcedRelics: [relic] }, seeds300);
      const moves = runs.map(r => r.moveCount);
      const meanMoves = moves.reduce((a, b) => a + b, 0) / 300;
      const diffs = moves.map((m, i) => m - exBaseMoves300[i]);
      const delta = diffs.reduce((a, b) => a + b, 0) / 300;
      const ci = bootstrapCI(diffs);
      const uses = runs.map(r => r.activations[relic] || 0).reduce((a, b) => a + b, 0) / 300;
      const swipesAtMax = runs.map(r => r.abilities[relic]?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 300;
      const chargesAtDeath = runs.map(r => r.abilities[relic]?.charges || 0).reduce((a, b) => a + b, 0) / 300;

      const sign = delta >= 0 ? '+' : '';
      console.log(`| ${relic} | ${pol} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
    }
  }
  console.log('');

  // -------------------------------------------------------------
  // Experiment 2: N sweeps under low:3 (Greedy N=1000)
  // -------------------------------------------------------------
  console.log('### Experiment 2: N Sweeps under policy low:3 (Greedy N=1000)\n');
  console.log('| Ability Relic | Cadence N | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|---|');

  const diagSweeps = [6, 10, 15];
  for (const n of diagSweeps) {
    const runs = runExperimentSeries(greedyBot, 'low:3', { forcedRelics: ['diagonal_charge'], diagonalChargeEvery: n }, seeds1000);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['diagonal_charge'] || 0).reduce((a, b) => a + b, 0) / 1000;
    const swipesAtMax = runs.map(r => r.abilities['diagonal_charge']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 1000;
    const chargesAtDeath = runs.map(r => r.abilities['diagonal_charge']?.charges || 0).reduce((a, b) => a + b, 0) / 1000;

    const sign = delta >= 0 ? '+' : '';
    console.log(`| diagonal_charge | every ${n} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
  }

  const eraserSweeps = [15, 20, 30];
  for (const n of eraserSweeps) {
    const runs = runExperimentSeries(greedyBot, 'low:3', { forcedRelics: ['eraser'], eraserEvery: n }, seeds1000);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['eraser'] || 0).reduce((a, b) => a + b, 0) / 1000;
    const swipesAtMax = runs.map(r => r.abilities['eraser']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 1000;
    const chargesAtDeath = runs.map(r => r.abilities['eraser']?.charges || 0).reduce((a, b) => a + b, 0) / 1000;

    const sign = delta >= 0 ? '+' : '';
    console.log(`| eraser | every ${n} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
  }
  console.log('');

  // -------------------------------------------------------------
  // Experiment 3: Pairs under low:3 (Expectimax N=200)
  // -------------------------------------------------------------
  console.log('### Experiment 3: Pairs under policy low:3 (Expectimax N=200, Baseline = ' + meanExBase200.toFixed(2) + ')\n');

  // First get solo runs for expectimax N=200 under low:3
  const soloRelicsNeeded = ['diagonal_charge', 'eraser', 'shatter', 'last_stand'];
  const soloDiffs = {};
  const soloDeltas = {};

  for (const relic of soloRelicsNeeded) {
    const runs = runExperimentSeries(expectimaxBot, 'low:3', { forcedRelics: [relic] }, seeds200);
    const moves = runs.map(r => r.moveCount);
    const diffs = moves.map((m, i) => m - exBaseMoves200[i]);
    soloDiffs[relic] = diffs;
    soloDeltas[relic] = diffs.reduce((a, b) => a + b, 0) / 200;
  }

  const pairs = [
    { name: 'diagonal_charge + shatter', r1: 'diagonal_charge', r2: 'shatter' },
    { name: 'eraser + shatter', r1: 'eraser', r2: 'shatter' },
    { name: 'diagonal_charge + eraser', r1: 'diagonal_charge', r2: 'eraser' },
    { name: 'eraser + last_stand', r1: 'eraser', r2: 'last_stand' },
  ];

  console.log('| Pair | Pair Moves | Pair Delta | Solo1 Delta | Solo2 Delta | Synergy | 95% Bootstrap Synergy CI |');
  console.log('|---|---|---|---|---|---|---|');

  for (const p of pairs) {
    const runs = runExperimentSeries(expectimaxBot, 'low:3', { forcedRelics: [p.r1, p.r2] }, seeds200);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 200;
    const pairDiffs = moves.map((m, i) => m - exBaseMoves200[i]);
    const pairDelta = pairDiffs.reduce((a, b) => a + b, 0) / 200;

    const d1 = soloDeltas[p.r1];
    const d2 = soloDeltas[p.r2];
    const diff1 = soloDiffs[p.r1];
    const diff2 = soloDiffs[p.r2];

    const synergyDiffs = pairDiffs.map((dPair, i) => dPair - (diff1[i] + diff2[i]));
    const synergy = synergyDiffs.reduce((a, b) => a + b, 0) / 200;
    const synCI = bootstrapCI(synergyDiffs);

    const signPair = pairDelta >= 0 ? '+' : '';
    const sign1 = d1 >= 0 ? '+' : '';
    const sign2 = d2 >= 0 ? '+' : '';
    const signSyn = synergy >= 0 ? '+' : '';

    console.log(`| ${p.name} | ${meanMoves.toFixed(2)} | ${signPair}${pairDelta.toFixed(2)} | ${sign1}${d1.toFixed(2)} | ${sign2}${d2.toFixed(2)} | ${signSyn}${synergy.toFixed(2)} | [${synCI.meanLow.toFixed(2)}, ${synCI.meanHigh.toFixed(2)}] |`);
  }
  console.log('');
}

main().catch(console.error);
