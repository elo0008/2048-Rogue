/**
 * Section F Experiments Runner
 *
 * Experiments:
 * F.1: diagonal_charge solo, greedy N=1000, policies {stuck, low:3} x placement {upper, best}.
 * F.2: rewind solo: greedy N=1000 and expectimax N=300 under {stuck, low:2, low:3}: delta, CI, uses/run, charges held at death, swipes at max.
 * F.3: Pairs, expectimax N=200, policy low:3, placement best: diagonal_charge+shatter, rewind+eraser, rewind+diagonal_charge, rewind+last_stand: synergy with CI.
 * F.4: Scoring stats from D: Pearson r(points, moveCount), mean/p10/p50/p90 of points for no-relic greedy (N=500), expectimax (N=500), random draft (greedy N=300).
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

function pearsonR(x, y) {
  const n = x.length;
  if (n === 0) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
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
        diagonal_charge: g.abilities?.diagonal_charge ? { ...g.abilities.diagonal_charge } : null,
        eraser: g.abilities?.eraser ? { ...g.abilities.eraser } : null,
        rewind: g.abilities?.rewind ? { ...g.abilities.rewind } : null,
      },
    };
  });
}

async function main() {
  console.log('================================================================');
  console.log('EXPERIMENTS F: 3x stones, relic injected at move 30, seeds 10000+');
  console.log('================================================================\n');

  const seeds1000 = Array.from({ length: 1000 }, (_, i) => 10000 + i);
  const seeds500 = Array.from({ length: 500 }, (_, i) => 10000 + i);
  const seeds300 = Array.from({ length: 300 }, (_, i) => 10000 + i);
  const seeds200 = Array.from({ length: 200 }, (_, i) => 10000 + i);

  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();

  // -------------------------------------------------------------
  // Baselines
  // -------------------------------------------------------------
  console.log('Computing Baselines...');
  const t0 = Date.now();
  const greedyBaseRuns1000 = runExperimentSeries(greedyBot, 'stuck', { forcedRelics: [] }, seeds1000);
  const greedyBaseMoves1000 = greedyBaseRuns1000.map(r => r.moveCount);
  const meanGreedyBase1000 = greedyBaseMoves1000.reduce((a, b) => a + b, 0) / 1000;
  console.log(`Greedy Baseline (N=1000): ${meanGreedyBase1000.toFixed(2)} moves (Expected: 150.63)`);

  const exBaseRuns300 = runExperimentSeries(expectimaxBot, 'stuck', { forcedRelics: [] }, seeds300);
  const exBaseMoves300 = exBaseRuns300.map(r => r.moveCount);
  const meanExBase300 = exBaseMoves300.reduce((a, b) => a + b, 0) / 300;
  console.log(`Expectimax Baseline (N=300): ${meanExBase300.toFixed(2)} moves`);

  const exBaseRuns200 = exBaseRuns300.slice(0, 200);
  const exBaseMoves200 = exBaseRuns200.map(r => r.moveCount);
  const meanExBase200 = exBaseMoves200.reduce((a, b) => a + b, 0) / 200;
  console.log(`Expectimax Baseline (N=200): ${meanExBase200.toFixed(2)} moves [${((Date.now() - t0)/1000).toFixed(1)}s]\n`);

  // -------------------------------------------------------------
  // F.1: diagonal_charge solo, greedy N=1000, policies {stuck, low:3} x placement {upper, best}
  // -------------------------------------------------------------
  console.log('### F.1 diagonal_charge solo (Greedy N=1000)\n');
  console.log('| Policy | Placement | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|---|');

  const f1Configs = [
    { policy: 'stuck', placement: 'upper' },
    { policy: 'stuck', placement: 'best' },
    { policy: 'low:3', placement: 'upper' },
    { policy: 'low:3', placement: 'best' },
  ];

  for (const cfg of f1Configs) {
    const runs = runExperimentSeries(
      greedyBot,
      cfg.policy,
      { forcedRelics: ['diagonal_charge'] },
      seeds1000,
      { placement: cfg.placement }
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves1000[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['diagonal_charge'] || 0).reduce((a, b) => a + b, 0) / 1000;
    const swipesAtMax = runs.map(r => r.abilities['diagonal_charge']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 1000;
    const chargesAtDeath = runs.map(r => r.abilities['diagonal_charge']?.charges || 0).reduce((a, b) => a + b, 0) / 1000;

    const sign = delta >= 0 ? '+' : '';
    console.log(`| ${cfg.policy} | ${cfg.placement} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
  }
  console.log('');

  // -------------------------------------------------------------
  // F.2: rewind solo: greedy N=1000 and expectimax N=300 under {stuck, low:2, low:3}
  // -------------------------------------------------------------
  console.log('### F.2 rewind solo\n');
  const rewindPolicies = ['stuck', 'low:2', 'low:3'];

  console.log('#### F.2A Greedy Bot (N=1000, Baseline = ' + meanGreedyBase1000.toFixed(2) + ')');
  console.log('| Policy | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|');

  for (const pol of rewindPolicies) {
    const runs = runExperimentSeries(greedyBot, pol, { forcedRelics: ['rewind'] }, seeds1000);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves1000[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['rewind'] || 0).reduce((a, b) => a + b, 0) / 1000;
    const swipesAtMax = runs.map(r => r.abilities['rewind']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 1000;
    const chargesAtDeath = runs.map(r => r.abilities['rewind']?.charges || 0).reduce((a, b) => a + b, 0) / 1000;

    const sign = delta >= 0 ? '+' : '';
    console.log(`| ${pol} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
  }
  console.log('');

  console.log('#### F.2B Expectimax Bot (N=300, Baseline = ' + meanExBase300.toFixed(2) + ')');
  console.log('| Policy | Mean Moves | Delta vs Base | 95% Bootstrap CI | Uses/Run | SwipesAtMax | ChargesAtDeath |');
  console.log('|---|---|---|---|---|---|---|');

  for (const pol of rewindPolicies) {
    const runs = runExperimentSeries(expectimaxBot, pol, { forcedRelics: ['rewind'] }, seeds300);
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 300;
    const diffs = moves.map((m, i) => m - exBaseMoves300[i]);
    const delta = diffs.reduce((a, b) => a + b, 0) / 300;
    const ci = bootstrapCI(diffs);
    const uses = runs.map(r => r.activations['rewind'] || 0).reduce((a, b) => a + b, 0) / 300;
    const swipesAtMax = runs.map(r => r.abilities['rewind']?.swipesAtMax || 0).reduce((a, b) => a + b, 0) / 300;
    const chargesAtDeath = runs.map(r => r.abilities['rewind']?.charges || 0).reduce((a, b) => a + b, 0) / 300;

    const sign = delta >= 0 ? '+' : '';
    console.log(`| ${pol} | ${meanMoves.toFixed(2)} | ${sign}${delta.toFixed(2)} | [${ci.meanLow.toFixed(2)}, ${ci.meanHigh.toFixed(2)}] | ${uses.toFixed(2)} | ${swipesAtMax.toFixed(2)} | ${chargesAtDeath.toFixed(2)} |`);
  }
  console.log('');

  // -------------------------------------------------------------
  // F.3: Pairs, expectimax N=200, policy low:3, placement best
  // diagonal_charge+shatter, rewind+eraser, rewind+diagonal_charge, rewind+last_stand
  // -------------------------------------------------------------
  console.log('### F.3 Pairs (Expectimax N=200, Policy low:3, Placement best, Baseline = ' + meanExBase200.toFixed(2) + ')\n');

  const pairSoloRelics = ['diagonal_charge', 'shatter', 'rewind', 'eraser', 'last_stand'];
  const soloDiffs = {};
  const soloDeltas = {};

  for (const relic of pairSoloRelics) {
    const runs = runExperimentSeries(
      expectimaxBot,
      'low:3',
      { forcedRelics: [relic] },
      seeds200,
      { placement: 'best' }
    );
    const moves = runs.map(r => r.moveCount);
    const diffs = moves.map((m, i) => m - exBaseMoves200[i]);
    soloDiffs[relic] = diffs;
    soloDeltas[relic] = diffs.reduce((a, b) => a + b, 0) / 200;
  }

  const pairsToTest = [
    { name: 'diagonal_charge + shatter', r1: 'diagonal_charge', r2: 'shatter' },
    { name: 'rewind + eraser', r1: 'rewind', r2: 'eraser' },
    { name: 'rewind + diagonal_charge', r1: 'rewind', r2: 'diagonal_charge' },
    { name: 'rewind + last_stand', r1: 'rewind', r2: 'last_stand' },
  ];

  console.log('| Pair | Pair Moves | Pair Delta | Solo1 Delta | Solo2 Delta | Synergy | 95% Bootstrap Synergy CI |');
  console.log('|---|---|---|---|---|---|---|');

  for (const p of pairsToTest) {
    const runs = runExperimentSeries(
      expectimaxBot,
      'low:3',
      { forcedRelics: [p.r1, p.r2] },
      seeds200,
      { placement: 'best' }
    );
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

  // -------------------------------------------------------------
  // F.4 / D: Scoring stats
  // Pearson r(points, moveCount), mean/p10/p50/p90 for:
  // - No-relic greedy (N=500)
  // - No-relic expectimax (N=500)
  // - Random draft (greedy N=300)
  // -------------------------------------------------------------
  console.log('### F.4 Scoring Stats (Points vs Moves)\n');
  console.log('| Regime | N | Pearson r | Mean Points | P10 | P50 | P90 | Mean Moves |');
  console.log('|---|---|---|---|---|---|---|---|');

  // Regime 1: No-relic greedy (N=500)
  const greedyNoRelicRuns500 = runExperimentSeries(greedyBot, 'stuck', { forcedRelics: [] }, seeds500);
  const gPts = greedyNoRelicRuns500.map(r => r.points);
  const gMvs = greedyNoRelicRuns500.map(r => r.moveCount);
  const gSortedPts = [...gPts].sort((a, b) => a - b);
  const rGreedy = pearsonR(gPts, gMvs);
  const meanGPts = gPts.reduce((a, b) => a + b, 0) / 500;
  const meanGMvs = gMvs.reduce((a, b) => a + b, 0) / 500;

  console.log(`| No-relic Greedy | 500 | ${rGreedy.toFixed(4)} | ${meanGPts.toFixed(1)} | ${getPercentile(gSortedPts, 10).toFixed(1)} | ${getPercentile(gSortedPts, 50).toFixed(1)} | ${getPercentile(gSortedPts, 90).toFixed(1)} | ${meanGMvs.toFixed(2)} |`);

  // Regime 2: No-relic expectimax (N=500)
  const exNoRelicRuns500 = runExperimentSeries(expectimaxBot, 'stuck', { forcedRelics: [] }, seeds500);
  const exPts = exNoRelicRuns500.map(r => r.points);
  const exMvs = exNoRelicRuns500.map(r => r.moveCount);
  const exSortedPts = [...exPts].sort((a, b) => a - b);
  const rExpectimax = pearsonR(exPts, exMvs);
  const meanExPts = exPts.reduce((a, b) => a + b, 0) / 500;
  const meanExMvs = exMvs.reduce((a, b) => a + b, 0) / 500;

  console.log(`| No-relic Expectimax | 500 | ${rExpectimax.toFixed(4)} | ${meanExPts.toFixed(1)} | ${getPercentile(exSortedPts, 10).toFixed(1)} | ${getPercentile(exSortedPts, 50).toFixed(1)} | ${getPercentile(exSortedPts, 90).toFixed(1)} | ${meanExMvs.toFixed(2)} |`);

  // Regime 3: Random draft (greedy N=300)
  const draftRuns300 = runExperimentSeries(greedyBot, 'stuck', {
    enableDraft: true,
    draftPolicy: 'random',
    forcedRelics: [],
    forceAtMove: 0,
  }, seeds300);
  const dPts = draftRuns300.map(r => r.points);
  const dMvs = draftRuns300.map(r => r.moveCount);
  const dSortedPts = [...dPts].sort((a, b) => a - b);
  const rDraft = pearsonR(dPts, dMvs);
  const meanDPts = dPts.reduce((a, b) => a + b, 0) / 300;
  const meanDMvs = dMvs.reduce((a, b) => a + b, 0) / 300;

  console.log(`| Random Draft (Greedy) | 300 | ${rDraft.toFixed(4)} | ${meanDPts.toFixed(1)} | ${getPercentile(dSortedPts, 10).toFixed(1)} | ${getPercentile(dSortedPts, 50).toFixed(1)} | ${getPercentile(dSortedPts, 90).toFixed(1)} | ${meanDMvs.toFixed(2)} |`);
  console.log('');
}

main().catch(console.error);
