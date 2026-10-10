/**
 * Experiment runner for session 10 outstanding tasks:
 *   2. Noisy bot (expectimax, eps=0.1 and 0.25) - 7 solos, N=300
 *   3. shatterMin sweep {8, 16, 32} - greedy N=1000, expectimax N=500
 *   4. Draft cadence: draftEveryMoves {60, 90, 120}, random + rollout policies, greedy N=300
 *
 * Context: 3x stone interval, permanent stones, solos at move 30, same seeds across configs.
 * Results: mean moves with 95% paired-bootstrap CIs vs no-relic baseline.
 */

import { createGame, step, cloneState, mulberry32, STONE } from './engine.js';
import { createBot, createExpectimaxBot, createNoisyBot } from './bots.js';
import { bootstrapCI } from './task_runner.js';

function getPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] * (1 - (rank - lo)) + sorted[hi] * (rank - lo);
}

function buildHazardSchedule(multiplier) {
  return [
    { upToMove: 100, interval: Math.max(3, Math.round(25 * multiplier)) },
    { upToMove: 200, interval: Math.max(3, Math.round(20 * multiplier)) },
    { upToMove: 300, interval: Math.max(3, Math.round(15 * multiplier)) },
    { upToMove: Infinity, interval: Math.max(3, Math.round(10 * multiplier)) },
  ];
}

function runSingleGame({ seed, bot, configOverrides }) {
  const game = createGame(seed, configOverrides);
  while (!game.gameOver && !game.capped) {
    const move = bot.chooseMove(game);
    if (!move) break;
    const res = step(game, move, bot);
    if (!res.valid) break;
  }
  return {
    seed,
    moveCount: game.moveCount,
    score: game.score,
    capped: game.capped,
    activations: { ...game.relicActivations },
    draftHistory: game.draftHistory ? [...game.draftHistory] : [],
    relics: [...game.relics],
  };
}

const POOL_7 = [
  'diagonal_merge',
  'fault_line',
  'mason',
  'foresight',
  'siphon',
  'shatter',
  'last_stand',
];

async function main() {
  const t0 = Date.now();
  const greedyBot = createBot('greedy');
  const expectimaxBot = createExpectimaxBot();

  // Shared seed sets
  const seeds1000 = Array.from({ length: 1000 }, (_, i) => 10000 + i);
  const seeds500  = Array.from({ length: 500 },  (_, i) => 10000 + i);
  const seeds300  = Array.from({ length: 300 },  (_, i) => 10000 + i);

  const base3xCfg = {
    hazardSchedule: buildHazardSchedule(3),
    stoneLifetime: null,
    enableDraft: false,
    forcedRelics: [],
    forceAtMove: 30,
  };

  // ---------------------------------------------------------------
  // Baselines
  // ---------------------------------------------------------------
  console.log('Computing baselines...');

  const greedyBase1000 = seeds1000.map(seed =>
    runSingleGame({ seed, bot: greedyBot, configOverrides: base3xCfg })
  );
  const greedyBase1000Moves = greedyBase1000.map(r => r.moveCount);
  const meanGreedyBase = greedyBase1000Moves.reduce((a,b) => a+b, 0) / 1000;
  console.log(`Greedy Baseline (No Relics, N=1000) Mean Moves: ${meanGreedyBase.toFixed(2)}`);

  const greedyBase300Moves = greedyBase1000Moves.slice(0, 300);

  const exBase500 = seeds500.map(seed =>
    runSingleGame({ seed, bot: expectimaxBot, configOverrides: base3xCfg })
  );
  const exBase500Moves = exBase500.map(r => r.moveCount);
  const meanExBase = exBase500Moves.reduce((a,b) => a+b, 0) / 500;
  console.log(`Expectimax Baseline (No Relics, N=500) Mean Moves: ${meanExBase.toFixed(2)}`);

  const exBase300Moves = exBase500Moves.slice(0, 300);

  // ---------------------------------------------------------------
  // TASK 2: Noisy bot solos (expectimax base, eps=0.1 and 0.25)
  //         N=300, greedy plays 7 relics too for delta reference
  // ---------------------------------------------------------------
  console.log('\n================================================================');
  console.log('TASK 2. Noisy Bot Solos (expectimax base, N=300, forceAtMove=30, 3x)');
  console.log('================================================================\n');

  // Noisy expectimax baselines (no relic)
  const noisyBot010 = createNoisyBot(expectimaxBot, 0.1);
  const noisyBot025 = createNoisyBot(expectimaxBot, 0.25);

  const noisyBase010 = seeds300.map(seed =>
    runSingleGame({ seed, bot: noisyBot010, configOverrides: base3xCfg })
  );
  const noisyBase010Moves = noisyBase010.map(r => r.moveCount);
  const meanNoisyBase010 = noisyBase010Moves.reduce((a,b) => a+b, 0) / 300;

  const noisyBase025 = seeds300.map(seed =>
    runSingleGame({ seed, bot: noisyBot025, configOverrides: base3xCfg })
  );
  const noisyBase025Moves = noisyBase025.map(r => r.moveCount);
  const meanNoisyBase025 = noisyBase025Moves.reduce((a,b) => a+b, 0) / 300;

  console.log(`noisy(expectimax, eps=0.10) Baseline (No Relics, N=300) Mean Moves: ${meanNoisyBase010.toFixed(2)}`);
  console.log(`noisy(expectimax, eps=0.25) Baseline (No Relics, N=300) Mean Moves: ${meanNoisyBase025.toFixed(2)}\n`);

  // Solo runs for both noisy bots
  const noisyResults = [];

  for (const eps of [0.1, 0.25]) {
    const bot = eps === 0.1 ? noisyBot010 : noisyBot025;
    const baselineMoves = eps === 0.1 ? noisyBase010Moves : noisyBase025Moves;

    for (const relic of POOL_7) {
      const runs = seeds300.map(seed =>
        runSingleGame({
          seed,
          bot,
          configOverrides: { ...base3xCfg, forcedRelics: [relic] },
        })
      );
      const moves = runs.map(r => r.moveCount);
      const meanMoves = moves.reduce((a,b) => a+b, 0) / 300;
      const diffs = moves.map((m, i) => m - baselineMoves[i]);
      const meanDelta = diffs.reduce((a,b) => a+b, 0) / 300;
      const ci = bootstrapCI(diffs);
      const acts = runs.map(r => r.activations[relic] || 0);
      const meanAct = acts.reduce((a,b) => a+b, 0) / 300;
      noisyResults.push({ eps, relic, meanMoves, meanDelta, ci, meanAct });
    }
  }

  for (const eps of [0.1, 0.25]) {
    const subset = noisyResults.filter(r => r.eps === eps);
    console.log(`#### Noisy(expectimax, eps=${eps}) Solos (N=300)\n`);
    console.log('| Relic | Mean Moves | Mean Delta vs Noisy Baseline | 95% CI | Fires/run |');
    console.log('|---|---|---|---|---|');
    for (const r of subset) {
      const sign = r.meanDelta >= 0 ? '+' : '';
      console.log(`| ${r.relic} | ${r.meanMoves.toFixed(2)} | ${sign}${r.meanDelta.toFixed(2)} | [${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}] | ${r.meanAct.toFixed(2)} |`);
    }
    console.log('');
  }

  // ---------------------------------------------------------------
  // TASK 3: shatterMin sweeps {8, 16, 32}
  //         Greedy N=1000, Expectimax N=500
  // ---------------------------------------------------------------
  console.log('================================================================');
  console.log('TASK 3. shatterMin Sweeps (greedy N=1000, expectimax N=500)');
  console.log('================================================================\n');

  const shatterSweepResults = [];

  // Greedy
  for (const shMin of [8, 16, 32]) {
    const runs = seeds1000.map(seed =>
      runSingleGame({
        seed, bot: greedyBot,
        configOverrides: { ...base3xCfg, forcedRelics: ['shatter'], shatterMin: shMin },
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a,b) => a+b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBase1000Moves[i]);
    const meanDelta = diffs.reduce((a,b) => a+b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations['shatter'] || 0);
    const meanAct = acts.reduce((a,b) => a+b, 0) / 1000;
    shatterSweepResults.push({ bot: 'greedy', N: 1000, shMin, meanMoves, meanDelta, ci, meanAct });
  }

  // Expectimax
  for (const shMin of [8, 16, 32]) {
    const runs = seeds500.map(seed =>
      runSingleGame({
        seed, bot: expectimaxBot,
        configOverrides: { ...base3xCfg, forcedRelics: ['shatter'], shatterMin: shMin },
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a,b) => a+b, 0) / 500;
    const diffs = moves.map((m, i) => m - exBase500Moves[i]);
    const meanDelta = diffs.reduce((a,b) => a+b, 0) / 500;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations['shatter'] || 0);
    const meanAct = acts.reduce((a,b) => a+b, 0) / 500;
    shatterSweepResults.push({ bot: 'expectimax', N: 500, shMin, meanMoves, meanDelta, ci, meanAct });
  }

  console.log('#### shatterMin Sweep\n');
  console.log('| Bot | N | shatterMin | Mean Moves | Mean Delta | 95% CI | Fires/run |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of shatterSweepResults) {
    const sign = r.meanDelta >= 0 ? '+' : '';
    console.log(`| ${r.bot} | ${r.N} | ${r.shMin} | ${r.meanMoves.toFixed(2)} | ${sign}${r.meanDelta.toFixed(2)} | [${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}] | ${r.meanAct.toFixed(2)} |`);
  }
  console.log('');

  // ---------------------------------------------------------------
  // TASK 4: Draft cadence draftEveryMoves {60, 90, 120}
  //         tile thresholds off, enableDraft true, greedy N=300
  //         policies: random, rollout (40 greedy playouts)
  // ---------------------------------------------------------------
  console.log('================================================================');
  console.log('TASK 4. Draft Cadence Sweep (draftEveryMoves={60,90,120}, greedy N=300)');
  console.log('================================================================\n');

  // Greedy-based rollout bot (40 playouts)
  function createRolloutBot(baseBot, numPlayouts = 40) {
    return {
      name: `rollout_${baseBot.name}`,
      chooseMove(state) { return baseBot.chooseMove(state); },
      chooseStoneCell(state, candidates) {
        return baseBot.chooseStoneCell ? baseBot.chooseStoneCell(state, candidates) : candidates[0];
      },
      chooseDraftRelic(state, offers) {
        if (!offers || offers.length === 0) return null;
        if (offers.length === 1) return offers[0];

        let bestOffer = offers[0];
        let bestScore = -Infinity;

        for (let oIdx = 0; oIdx < offers.length; oIdx++) {
          const offer = offers[oIdx];
          let totalRemaining = 0;
          for (let p = 0; p < numPlayouts; p++) {
            const simState = cloneState(state);
            simState.relics.add(offer);
            if (offer === 'anchor_row' && !simState.anchor) {
              simState.anchor = { type: 'row', index: 3 };
            }
            const rolloutSeed = (state.moveCount * 10007 + oIdx * 257 + p * 67 + 99991) >>> 0;
            simState.rngs = {
              tile: mulberry32(rolloutSeed),
              stone: mulberry32((rolloutSeed + 0x9e3779b9) >>> 0),
              draft: mulberry32((rolloutSeed + 0x3c6ef372) >>> 0),
            };
            simState.spawnQueue = [];

            while (!simState.gameOver && !simState.capped) {
              const m = greedyBot.chooseMove(simState);
              if (!m) break;
              step(simState, m, greedyBot);
            }
            totalRemaining += (simState.moveCount - state.moveCount);
          }
          const meanRem = totalRemaining / numPlayouts;
          if (meanRem > bestScore) {
            bestScore = meanRem;
            bestOffer = offer;
          }
        }
        return bestOffer;
      }
    };
  }

  const rolloutGreedyBot = createRolloutBot(greedyBot, 40);

  // No-draft greedy baseline for comparison (seeds 20000+)
  const draftSeeds300 = Array.from({ length: 300 }, (_, i) => 20000 + i);

  function analyzeDraftRuns(name, runs) {
    const moves = runs.map(r => r.moveCount).sort((a,b) => a-b);
    const med = getPercentile(moves, 50);
    const p10 = getPercentile(moves, 10);
    const p90 = getPercentile(moves, 90);
    const meanDrafts = runs.reduce((sum, r) => sum + r.draftHistory.length, 0) / runs.length;

    const finalSetCounts = {};
    const picksCount = {};
    for (const r of POOL_7) picksCount[r] = 0;

    for (const run of runs) {
      const setKey = [...run.relics].sort().join('+') || 'None';
      finalSetCounts[setKey] = (finalSetCounts[setKey] || 0) + 1;
      for (const d of run.draftHistory) {
        if (d.pick) picksCount[d.pick] = (picksCount[d.pick] || 0) + 1;
      }
    }

    const distinctSets = Object.keys(finalSetCounts).length;
    const meanRelicsPerRun = runs.reduce((sum, r) => sum + r.relics.length, 0) / runs.length;
    const sortedSets = Object.entries(finalSetCounts)
      .map(([set, count]) => ({ set, count, pct: (count / runs.length) * 100 }))
      .sort((a,b) => b.count - a.count);

    return { name, med, p10, p90, meanDrafts, meanRelicsPerRun, distinctSets, sortedSets, picksCount };
  }

  const cadenceResults = [];

  for (const interval of [60, 90, 120]) {
    const draftCfg = {
      hazardSchedule: buildHazardSchedule(3),
      stoneLifetime: null,
      enableDraft: true,
      draftThresholds: [],
      draftEveryMoves: interval,
      draftPool: POOL_7,
      forcedRelics: [],
      forceAtMove: 0,
    };

    console.log(`Running cadence interval=${interval}, random policy (N=300)...`);
    const randomRuns = draftSeeds300.map(seed =>
      runSingleGame({ seed, bot: greedyBot, configOverrides: { ...draftCfg, draftPolicy: 'random' } })
    );

    console.log(`Running cadence interval=${interval}, rollout policy (N=300)...`);
    const rolloutRuns = draftSeeds300.map(seed =>
      runSingleGame({ seed, bot: rolloutGreedyBot, configOverrides: { ...draftCfg, draftPolicy: 'rollout' } })
    );

    cadenceResults.push({ interval, policy: 'random', stats: analyzeDraftRuns(`cadence=${interval}/random`, randomRuns) });
    cadenceResults.push({ interval, policy: 'rollout(40)', stats: analyzeDraftRuns(`cadence=${interval}/rollout`, rolloutRuns) });
  }

  console.log('\n#### Draft Cadence Summary\n');
  console.log('| draftEveryMoves | Policy | Median | P10 | P90 | Mean Drafts/run | Mean Relics/run | Distinct Sets |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const { interval, policy, stats } of cadenceResults) {
    console.log(`| ${interval} | ${policy} | ${stats.med.toFixed(1)} | ${stats.p10.toFixed(1)} | ${stats.p90.toFixed(1)} | ${stats.meanDrafts.toFixed(2)} | ${stats.meanRelicsPerRun.toFixed(2)} | ${stats.distinctSets} |`);
  }
  console.log('');

  // Per-relic pick rates for rollout configs
  for (const { interval, policy, stats } of cadenceResults) {
    if (policy !== 'rollout(40)') continue;
    console.log(`#### Pick Rates: draftEveryMoves=${interval}, rollout(40)\n`);
    console.log('| Relic | Picks |');
    console.log('|---|---|');
    for (const r of POOL_7) {
      console.log(`| ${r} | ${stats.picksCount[r] || 0} |`);
    }
    console.log(`\nDistinct final relic sets: ${stats.distinctSets}`);
    console.log('| Rank | Set | Count | % |');
    console.log('|---|---|---|---|');
    for (let i = 0; i < Math.min(5, stats.sortedSets.length); i++) {
      const s = stats.sortedSets[i];
      console.log(`| ${i+1} | ${s.set} | ${s.count} | ${s.pct.toFixed(1)}% |`);
    }
    console.log('');
  }

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`All experiments completed in ${totalTime}s.\n`);
}

main().catch(err => {
  console.error('Fatal experiment error:', err);
  process.exit(1);
});
