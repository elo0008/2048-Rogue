import { buildHazardSchedule } from '../sim/engine.js';
import { createBot } from '../sim/bots.js';
import { withAbilities, runActionGame } from '../sim/action_bots.js';

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

function runExperimentSeries(bot, policy, configOverrides, seeds, options = {}) {
  const actionBot = withAbilities(bot, policy, options);
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
      points: g.points || 0,
      score: g.score || 0,
      activations: { ...g.relicActivations },
      abilities: {
        rewind: g.abilities?.rewind ? { ...g.abilities.rewind } : null,
      },
    };
  });
}

async function runJ3() {
  const N = 1000;
  const seeds = Array.from({ length: N }, (_, i) => 10000 + i);
  const greedyBot = createBot('greedy');

  console.log('Running Greedy Baseline (N=1000, 3x stones, seeds 10000+)...');
  const baseRuns = runExperimentSeries(greedyBot, 'stuck', { forcedRelics: [] }, seeds);
  const baseMoves = baseRuns.map(r => r.moveCount);
  const baseMean = baseMoves.reduce((a, b) => a + b, 0) / N;

  const previousResults = {
    'stuck': { prevDelta: '+23.25', prevCI: '[20.21, 26.35]' },
    'low:2': { prevDelta: '-5.35', prevCI: '[-8.38, -2.31]' },
    'low:3': { prevDelta: '-8.16', prevCI: '[-11.23, -5.09]' },
  };

  const policies = ['stuck', 'low:2', 'low:3'];
  const results = [];

  for (const pol of policies) {
    console.log(`Running Rewind policy ${pol} (N=1000)...`);
    const runs = runExperimentSeries(greedyBot, pol, { forcedRelics: ['rewind'] }, seeds);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / N;
    const diffs = moves.map((m, i) => m - baseMoves[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / N;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['rewind'] || 0).reduce((a, b) => a + b, 0) / N;
    const swipesAtMax = runs.map(r => r.abilities['rewind']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / N;
    const chargesAtDeath = runs.map(r => r.abilities['rewind']?.charges || 0).reduce((a, b) => a + b, 0) / N;

    results.push({
      policy: pol,
      meanMoves,
      delta,
      ci,
      uses,
      swipesAtMax,
      chargesAtDeath,
    });
  }

  console.log('\n====================================================================================================');
  console.log(`J3 REGRESSION CHECK RESULTS (N=1000, Baseline: ${baseMean.toFixed(2)})`);
  console.log('====================================================================================================');
  console.log('| Policy | Old Delta | New Delta | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath | Match? |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const r of results) {
    const prev = previousResults[r.policy];
    const sign = r.delta >= 0 ? '+' : '';
    const newDeltaStr = `${sign}${r.delta.toFixed(2)}`;
    const ciStr = `[${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}]`;
    const matches = (newDeltaStr === prev.prevDelta) ? 'EXACT' : 'DIFF';
    console.log(`| ${r.policy.padEnd(6)} | ${prev.prevDelta.padStart(9)} | ${newDeltaStr.padStart(9)} | ${ciStr.padStart(16)} | ${r.uses.toFixed(2).padStart(8)} | ${r.swipesAtMax.toFixed(2).padStart(11)} | ${r.chargesAtDeath.toFixed(2).padStart(14)} | ${matches.padStart(6)} |`);
  }
}

runJ3().catch(err => {
  console.error(err);
  process.exit(1);
});
