import { createGame, step, cloneState, mulberry32, STONE } from './engine.js';
import { createBot, createExpectimaxBot } from './bots.js';
import { RELIC_IDS } from './relics.js';

const SEED = 42;
const CAP = 5000;

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

/**
 * Deterministic PRNG for bootstrap resampling
 */
function createBootstrapRng(seed = 123456789) {
  let s = seed >>> 0;
  return function() {
    let t = (s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 2000-resample bootstrap 95% CI on array of paired values or differences (mean only)
 */
export function bootstrapCI(diffs, resamples = 2000) {
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
 * Runs a single game.
 */
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

  // -----------------------------------------------------------------
  // 4. SOLOS (Greedy N=1000, Expectimax N=500, Param sweeps)
  // -----------------------------------------------------------------
  console.log('================================================================');
  console.log('4. SOLOS: 7 Relics (3x stones, forceAtMove=30, enableDraft=false)');
  console.log('================================================================\n');

  // Baseline Greedy N=1000
  const seeds1000 = Array.from({ length: 1000 }, (_, i) => 10000 + i);
  const greedyBaseRuns = seeds1000.map(seed =>
    runSingleGame({
      seed,
      bot: greedyBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: false,
        forcedRelics: [],
        forceAtMove: 30,
      }
    })
  );
  const greedyBaseMoves = greedyBaseRuns.map(r => r.moveCount);
  const meanGreedyBase = greedyBaseMoves.reduce((a, b) => a + b, 0) / 1000;
  console.log(`Greedy Baseline (No Relics) Mean Moves: ${meanGreedyBase.toFixed(2)}\n`);

  // Greedy Solos
  const greedySoloResults = [];
  for (const relic of POOL_7) {
    const runs = seeds1000.map(seed =>
      runSingleGame({
        seed,
        bot: greedyBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: [relic],
          forceAtMove: 30,
        }
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
    const meanDelta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations[relic] || 0);
    const meanAct = acts.reduce((a, b) => a + b, 0) / 1000;
    greedySoloResults.push({ relic, meanMoves, meanDelta, ci, meanAct });
  }

  console.log('#### Solos: Greedy (N=1000, forceAtMove=30, 3x Stones)\n');
  console.log('| Relic | Mean Moves | Mean Delta vs No-Relic | 95% Bootstrap CI | Mean Activations/run |');
  console.log('|---|---|---|---|---|');
  for (const r of greedySoloResults) {
    const sign = r.meanDelta >= 0 ? '+' : '';
    console.log(`| ${r.relic} | ${r.meanMoves.toFixed(2)} | ${sign}${r.meanDelta.toFixed(2)} | [${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}] | ${r.meanAct.toFixed(2)} |`);
  }
  console.log('');

  // Sweeps: siphonMin {8, 16, 32} and shatterMin {32, 64, 128} (Greedy N=1000)
  const paramSweepResults = [];
  for (const sMin of [8, 16, 32]) {
    const runs = seeds1000.map(seed =>
      runSingleGame({
        seed,
        bot: greedyBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: ['siphon'],
          forceAtMove: 30,
          siphonMin: sMin,
        }
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
    const meanDelta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations['siphon'] || 0);
    const meanAct = acts.reduce((a, b) => a + b, 0) / 1000;
    paramSweepResults.push({ param: `siphon (siphonMin=${sMin})`, meanMoves, meanDelta, ci, meanAct });
  }

  for (const shMin of [32, 64, 128]) {
    const runs = seeds1000.map(seed =>
      runSingleGame({
        seed,
        bot: greedyBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: ['shatter'],
          forceAtMove: 30,
          shatterMin: shMin,
        }
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 1000;
    const diffs = moves.map((m, i) => m - greedyBaseMoves[i]);
    const meanDelta = diffs.reduce((a, b) => a + b, 0) / 1000;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations['shatter'] || 0);
    const meanAct = acts.reduce((a, b) => a + b, 0) / 1000;
    paramSweepResults.push({ param: `shatter (shatterMin=${shMin})`, meanMoves, meanDelta, ci, meanAct });
  }

  console.log('#### Parameter Sweeps: Greedy (N=1000, forceAtMove=30, 3x Stones)\n');
  console.log('| Parameter / Relic | Mean Moves | Mean Delta vs No-Relic | 95% Bootstrap CI | Mean Activations/run |');
  console.log('|---|---|---|---|---|');
  for (const r of paramSweepResults) {
    const sign = r.meanDelta >= 0 ? '+' : '';
    console.log(`| ${r.param} | ${r.meanMoves.toFixed(2)} | ${sign}${r.meanDelta.toFixed(2)} | [${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}] | ${r.meanAct.toFixed(2)} |`);
  }
  console.log('');

  // Expectimax Solos N=500
  const seeds500 = Array.from({ length: 500 }, (_, i) => 10000 + i);
  const exBaseRuns = seeds500.map(seed =>
    runSingleGame({
      seed,
      bot: expectimaxBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: false,
        forcedRelics: [],
        forceAtMove: 30,
      }
    })
  );
  const exBaseMoves = exBaseRuns.map(r => r.moveCount);
  const meanExBase = exBaseMoves.reduce((a, b) => a + b, 0) / 500;
  console.log(`Expectimax Baseline (No Relics) Mean Moves: ${meanExBase.toFixed(2)}\n`);

  const exSoloResults = [];
  for (const relic of POOL_7) {
    const runs = seeds500.map(seed =>
      runSingleGame({
        seed,
        bot: expectimaxBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: [relic],
          forceAtMove: 30,
        }
      })
    );
    const moves = runs.map(r => r.moveCount);
    const meanMoves = moves.reduce((a, b) => a + b, 0) / 500;
    const diffs = moves.map((m, i) => m - exBaseMoves[i]);
    const meanDelta = diffs.reduce((a, b) => a + b, 0) / 500;
    const ci = bootstrapCI(diffs);
    const acts = runs.map(r => r.activations[relic] || 0);
    const meanAct = acts.reduce((a, b) => a + b, 0) / 500;
    exSoloResults.push({ relic, meanMoves, meanDelta, ci, meanAct });
  }

  console.log('#### Solos: Expectimax (N=500, forceAtMove=30, 3x Stones)\n');
  console.log('| Relic | Mean Moves | Mean Delta vs No-Relic | 95% Bootstrap CI | Mean Activations/run |');
  console.log('|---|---|---|---|---|');
  for (const r of exSoloResults) {
    const sign = r.meanDelta >= 0 ? '+' : '';
    console.log(`| ${r.relic} | ${r.meanMoves.toFixed(2)} | ${sign}${r.meanDelta.toFixed(2)} | [${r.ci.meanLow.toFixed(2)}, ${r.ci.meanHigh.toFixed(2)}] | ${r.meanAct.toFixed(2)} |`);
  }
  console.log('');

  // -----------------------------------------------------------------
  // 5. PAIR SYNERGY (Expectimax N=200)
  // -----------------------------------------------------------------
  console.log('================================================================');
  console.log('5. PAIR SYNERGY: 21 Pairs (Expectimax N=200, forceAtMove=30)');
  console.log('================================================================\n');

  const seeds200 = Array.from({ length: 200 }, (_, i) => 10000 + i);
  const exBase200Moves = exBaseMoves.slice(0, 200);
  const meanBase200 = exBase200Moves.reduce((a, b) => a + b, 0) / 200;

  const solo200Moves = {};
  for (const relic of POOL_7) {
    const runs = seeds200.map(seed =>
      runSingleGame({
        seed,
        bot: expectimaxBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: [relic],
          forceAtMove: 30,
        }
      })
    );
    solo200Moves[relic] = runs.map(r => r.moveCount);
  }

  const pairs = [];
  for (let i = 0; i < POOL_7.length; i++) {
    for (let j = i + 1; j < POOL_7.length; j++) {
      pairs.push([POOL_7[i], POOL_7[j]]);
    }
  }

  const pairResults = [];
  for (const [rA, rB] of pairs) {
    const runs = seeds200.map(seed =>
      runSingleGame({
        seed,
        bot: expectimaxBot,
        configOverrides: {
          hazardSchedule: buildHazardSchedule(3),
          stoneLifetime: null,
          enableDraft: false,
          forcedRelics: [rA, rB],
          forceAtMove: 30,
        }
      })
    );
    const pMoves = runs.map(r => r.moveCount);
    const meanPair = pMoves.reduce((a, b) => a + b, 0) / 200;
    const meanA = solo200Moves[rA].reduce((a, b) => a + b, 0) / 200;
    const meanB = solo200Moves[rB].reduce((a, b) => a + b, 0) / 200;
    const expected = meanA + meanB - meanBase200;
    const synergy = meanPair - expected;

    const synPerSeed = pMoves.map((pm, k) => pm - (solo200Moves[rA][k] + solo200Moves[rB][k] - exBase200Moves[k]));
    const ci = bootstrapCI(synPerSeed);
    const pctAboveBase = ((meanPair - meanBase200) / meanBase200) * 100;
    const flagged = pctAboveBase > 60.0;

    pairResults.push({
      pairName: `${rA} + ${rB}`,
      rA,
      rB,
      meanPair,
      meanA,
      meanB,
      expected,
      synergy,
      ci,
      pctAboveBase,
      flagged,
    });
  }

  pairResults.sort((a, b) => b.synergy - a.synergy);

  console.log('#### Top 5 Synergy Pairs (Expectimax N=200)\n');
  console.log('| Rank | Pair | Mean(Pair) | Mean(A) | Mean(B) | Expected Additive | Synergy (Mean) | 95% Bootstrap CI | % Above Baseline | Flagged (>60%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (let i = 0; i < 5; i++) {
    const p = pairResults[i];
    const sign = p.synergy >= 0 ? '+' : '';
    const flagStr = p.flagged ? '**FLAGGED (>60%)**' : 'No';
    console.log(`| ${i + 1} | ${p.pairName} | ${p.meanPair.toFixed(1)} | ${p.meanA.toFixed(1)} | ${p.meanB.toFixed(1)} | ${p.expected.toFixed(1)} | ${sign}${p.synergy.toFixed(1)} | [${p.ci.meanLow.toFixed(1)}, ${p.ci.meanHigh.toFixed(1)}] | +${p.pctAboveBase.toFixed(1)}% | ${flagStr} |`);
  }
  console.log('');

  console.log('#### Bottom 5 Synergy Pairs (Expectimax N=200)\n');
  console.log('| Rank | Pair | Mean(Pair) | Mean(A) | Mean(B) | Expected Additive | Synergy (Mean) | 95% Bootstrap CI | % Above Baseline | Flagged (>60%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (let i = pairResults.length - 5; i < pairResults.length; i++) {
    const p = pairResults[i];
    const sign = p.synergy >= 0 ? '+' : '';
    const pSign = p.pctAboveBase >= 0 ? '+' : '';
    const flagStr = p.flagged ? '**FLAGGED (>60%)**' : 'No';
    console.log(`| ${i + 1} | ${p.pairName} | ${p.meanPair.toFixed(1)} | ${p.meanA.toFixed(1)} | ${p.meanB.toFixed(1)} | ${p.expected.toFixed(1)} | ${sign}${p.synergy.toFixed(1)} | [${p.ci.meanLow.toFixed(1)}, ${p.ci.meanHigh.toFixed(1)}] | ${pSign}${p.pctAboveBase.toFixed(1)}% | ${flagStr} |`);
  }
  console.log('');

  console.log('#### Full Pair Synergy CSV (21 pairs)\n');
  console.log('Pair,Mean_Pair,Mean_A,Mean_B,Expected_Additive,Synergy,CI_Low,CI_High,Pct_Above_Baseline,Flagged_Over_60pct');
  for (const p of pairResults) {
    console.log(`"${p.pairName}",${p.meanPair.toFixed(2)},${p.meanA.toFixed(2)},${p.meanB.toFixed(2)},${p.expected.toFixed(2)},${p.synergy.toFixed(2)},${p.ci.meanLow.toFixed(2)},${p.ci.meanHigh.toFixed(2)},${p.pctAboveBase.toFixed(1)}%,${p.flagged}`);
  }
  console.log('');

  // -----------------------------------------------------------------
  // 6. DRAFTS: RANDOM vs ROLLOUT
  // -----------------------------------------------------------------
  console.log('================================================================');
  console.log('6. DRAFTS: Random vs Rollout (draftEveryMoves=35, pool=7 relics)');
  console.log('================================================================\n');

  function createRolloutBot(baseBot) {
    return {
      name: `rollout_${baseBot.name}`,
      chooseMove(state) { return baseBot.chooseMove(state); },
      chooseStoneCell(state, candidates) { return baseBot.chooseStoneCell ? baseBot.chooseStoneCell(state, candidates) : candidates[0]; },
      chooseDraftRelic(state, offers) {
        if (!offers || offers.length === 0) return null;
        if (offers.length === 1) return offers[0];

        let bestOffer = offers[0];
        let bestScore = -Infinity;

        for (let oIdx = 0; oIdx < offers.length; oIdx++) {
          const offer = offers[oIdx];
          let totalRemaining = 0;
          for (let p = 0; p < 20; p++) {
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
          const meanRem = totalRemaining / 20;
          if (meanRem > bestScore) {
            bestScore = meanRem;
            bestOffer = offer;
          }
        }
        return bestOffer;
      }
    };
  }

  const rolloutGreedyBot = createRolloutBot(greedyBot);
  const rolloutExpectimaxBot = createRolloutBot(expectimaxBot);

  const seeds300 = Array.from({ length: 300 }, (_, i) => 20000 + i);

  console.log('Running Greedy Drafts (N=300) Random & Rollout...');
  const greedyDraftRandomRuns = seeds300.map(seed =>
    runSingleGame({
      seed,
      bot: greedyBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: true,
        draftPool: POOL_7,
        draftEveryMoves: 35,
        draftThresholds: [],
        draftPolicy: 'random',
      }
    })
  );

  const greedyDraftRolloutRuns = seeds300.map(seed =>
    runSingleGame({
      seed,
      bot: rolloutGreedyBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: true,
        draftPool: POOL_7,
        draftEveryMoves: 35,
        draftThresholds: [],
        draftPolicy: 'rollout',
      }
    })
  );

  const seeds100 = Array.from({ length: 100 }, (_, i) => 30000 + i);

  console.log('Running Expectimax Drafts (N=100) Random & Rollout...');
  const exDraftRandomRuns = seeds100.map(seed =>
    runSingleGame({
      seed,
      bot: expectimaxBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: true,
        draftPool: POOL_7,
        draftEveryMoves: 35,
        draftThresholds: [],
        draftPolicy: 'random',
      }
    })
  );

  const exDraftRolloutRuns = seeds100.map(seed =>
    runSingleGame({
      seed,
      bot: rolloutExpectimaxBot,
      configOverrides: {
        hazardSchedule: buildHazardSchedule(3),
        stoneLifetime: null,
        enableDraft: true,
        draftPool: POOL_7,
        draftEveryMoves: 35,
        draftThresholds: [],
        draftPolicy: 'rollout',
      }
    })
  );

  function analyzeDraftRuns(name, runs) {
    const moves = runs.map(r => r.moveCount).sort((a, b) => a - b);
    const med = getPercentile(moves, 50);
    const p10 = getPercentile(moves, 10);
    const p90 = getPercentile(moves, 90);
    const meanDrafts = runs.reduce((sum, r) => sum + r.draftHistory.length, 0) / runs.length;

    const offersCount = {};
    const picksCount = {};
    for (const r of POOL_7) {
      offersCount[r] = 0;
      picksCount[r] = 0;
    }
    const finalSetCounts = {};

    for (const r of runs) {
      for (const d of r.draftHistory) {
        for (const off of d.offers) {
          offersCount[off] = (offersCount[off] || 0) + 1;
        }
        if (d.pick) {
          picksCount[d.pick] = (picksCount[d.pick] || 0) + 1;
        }
      }
      const setKey = [...r.relics].sort().join('+') || 'None';
      finalSetCounts[setKey] = (finalSetCounts[setKey] || 0) + 1;
    }

    const distinctSets = Object.keys(finalSetCounts).length;
    const sortedSets = Object.entries(finalSetCounts)
      .map(([set, count]) => ({ set, count, pct: (count / runs.length) * 100 }))
      .sort((a, b) => b.count - a.count);

    return {
      name,
      med,
      p10,
      p90,
      meanDrafts,
      offersCount,
      picksCount,
      distinctSets,
      sortedSets,
    };
  }

  const gRandomStats = analyzeDraftRuns('Greedy Random (N=300)', greedyDraftRandomRuns);
  const gRolloutStats = analyzeDraftRuns('Greedy Rollout (N=300)', greedyDraftRolloutRuns);
  const exRandomStats = analyzeDraftRuns('Expectimax Random (N=100)', exDraftRandomRuns);
  const exRolloutStats = analyzeDraftRuns('Expectimax Rollout (N=100)', exDraftRolloutRuns);

  console.log('#### Draft Policies Summary\n');
  console.log('| Config / Policy | Bot | N | Median Moves | P10 | P90 | Mean Drafts/run |');
  console.log('|---|---|---|---|---|---|---|');
  console.log(`| Random | Greedy | 300 | ${gRandomStats.med.toFixed(1)} | ${gRandomStats.p10.toFixed(1)} | ${gRandomStats.p90.toFixed(1)} | ${gRandomStats.meanDrafts.toFixed(2)} |`);
  console.log(`| Rollout (20 playouts) | Greedy | 300 | ${gRolloutStats.med.toFixed(1)} | ${gRolloutStats.p10.toFixed(1)} | ${gRolloutStats.p90.toFixed(1)} | ${gRolloutStats.meanDrafts.toFixed(2)} |`);
  console.log(`| Random | Expectimax | 100 | ${exRandomStats.med.toFixed(1)} | ${exRandomStats.p10.toFixed(1)} | ${exRandomStats.p90.toFixed(1)} | ${exRandomStats.meanDrafts.toFixed(2)} |`);
  console.log(`| Rollout (20 playouts) | Expectimax | 100 | ${exRolloutStats.med.toFixed(1)} | ${exRolloutStats.p10.toFixed(1)} | ${exRolloutStats.p90.toFixed(1)} | ${exRolloutStats.meanDrafts.toFixed(2)} |`);
  console.log('');

  function printRolloutDetails(title, stats) {
    console.log(`#### Rollout Details: ${title}\n`);
    console.log('| Relic | Offers | Picks | Pick Rate (Picks/Offers) |');
    console.log('|---|---|---|---|');
    for (const r of POOL_7) {
      const off = stats.offersCount[r] || 0;
      const pick = stats.picksCount[r] || 0;
      const rate = off > 0 ? ((pick / off) * 100).toFixed(1) : '0.0';
      console.log(`| ${r} | ${off} | ${pick} | ${rate}% |`);
    }
    console.log('');
    console.log(`**Number of distinct final relic sets:** ${stats.distinctSets}\n`);
    console.log('| Rank | Final Relic Set | Count | Frequency (%) |');
    console.log('|---|---|---|---|');
    for (let i = 0; i < Math.min(5, stats.sortedSets.length); i++) {
      const s = stats.sortedSets[i];
      console.log(`| ${i + 1} | ${s.set} | ${s.count} | ${s.pct.toFixed(1)}% |`);
    }
    console.log('');
  }

  printRolloutDetails('Greedy Rollout (N=300)', gRolloutStats);
  printRolloutDetails('Expectimax Rollout (N=100)', exRolloutStats);

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`All experiments completed in ${totalTime}s.\n`);
}

main().catch(err => {
  console.error('Fatal experiment error:', err);
  process.exit(1);
});
