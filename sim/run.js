#!/usr/bin/env node

/**
 * Experiment CLI for 2048-Rogue Simulator.
 * Arguments:
 *   --experiment, -e   E1 | E2 | E3 | E4 | all (default: E1)
 *   --runs, -n         Number of runs per configuration (default: 2000, E4: 5000)
 *   --bot, -b          random | greedy | corner | all (default: all)
 *   --seed, -s         Master PRNG seed (default: 42)
 *   --cap, -c          Move cap (default: 5000)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, step } from './engine.js';
import { createBot } from './bots.js';
import { RELIC_IDS } from './relics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    experiment: 'E1',
    runs: null,
    bot: 'all',
    seed: 42,
    cap: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--experiment' || arg === '-e') {
      params.experiment = args[++i].toUpperCase();
    } else if (arg === '--runs' || arg === '-n') {
      params.runs = parseInt(args[++i], 10);
    } else if (arg === '--bot' || arg === '-b') {
      params.bot = args[++i].toLowerCase();
    } else if (arg === '--seed' || arg === '-s') {
      params.seed = parseInt(args[++i], 10);
    } else if (arg === '--cap' || arg === '-c') {
      params.cap = parseInt(args[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
2048-Rogue Headless Simulator CLI
Usage: node run.js [options]

Options:
  --experiment, -e   E1 | E2 | E3 | E4 | all (default: E1)
  --runs, -n         Number of runs per config (default: 2000, E4: 5000)
  --bot, -b          random | greedy | corner | all (default: all)
  --seed, -s         Master PRNG seed (default: 42)
  --cap, -c          Move cap (default: 5000)
  --help, -h         Show this help message
`);
      process.exit(0);
    }
  }

  return params;
}

/**
 * Runs a single simulation to completion.
 */
export function runSingleGame({ seed, botName, configOverrides }) {
  const botSeed = (seed + 0x7f4a7c15) >>> 0;
  const bot = createBot(botName, botSeed);
  const game = createGame(seed, configOverrides);

  while (!game.gameOver && !game.capped) {
    const move = bot.chooseMove(game);
    if (!move) break;
    const res = step(game, move, bot);
    if (!res.valid) break;
  }

  return {
    moveCount: game.moveCount,
    score: game.score,
    bonusScore: game.bonusScore,
    highestTile: game.highestTile,
    capped: game.capped,
    relicOffers: game.relicOffers,
    relicPicks: game.relicPicks,
    relicActivations: game.relicActivations,
    tripleMerges: game.tripleMerges,
    relics: [...game.relics],
  };
}

/**
 * Calculates percentile using linear interpolation.
 */
function getPercentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Aggregates statistics for a batch of simulation runs.
 */
export function aggregateStats(runs, e1BaselineMedian = null) {
  const n = runs.length;
  if (n === 0) return null;

  const moveCounts = runs.map(r => r.moveCount).sort((a, b) => a - b);
  const scores = runs.map(r => r.score);
  const maxTiles = runs.map(r => r.highestTile);
  const cappedCount = runs.filter(r => r.capped).length;

  const medianMoves = getPercentile(moveCounts, 50);
  const p10 = getPercentile(moveCounts, 10);
  const p90 = getPercentile(moveCounts, 90);
  const meanScore = scores.reduce((sum, v) => sum + v, 0) / n;
  const meanMaxTile = maxTiles.reduce((sum, v) => sum + v, 0) / n;
  const endlessRate = (cappedCount / n) * 100;

  // Flag condition: endless rate > 1% OR median > 2x E1 median of same bot
  const flags = [];
  if (endlessRate > 1.0) {
    flags.push(`Endless > 1% (${endlessRate.toFixed(1)}%)`);
  }
  if (e1BaselineMedian !== null && medianMoves > 2 * e1BaselineMedian) {
    flags.push(`Median > 2x E1 (${medianMoves.toFixed(0)} vs ${e1BaselineMedian.toFixed(0)})`);
  }

  // Aggregate relic offers, picks, and activations
  const totalOffers = {};
  const totalPicks = {};
  const totalActivations = {};
  for (const rid of RELIC_IDS) {
    totalOffers[rid] = 0;
    totalPicks[rid] = 0;
    totalActivations[rid] = 0;
  }
  for (const r of runs) {
    for (const rid of RELIC_IDS) {
      totalOffers[rid] += (r.relicOffers[rid] || 0);
      totalPicks[rid] += (r.relicPicks[rid] || 0);
      totalActivations[rid] += (r.relicActivations ? (r.relicActivations[rid] || 0) : 0);
    }
  }

  const pickRates = {};
  const meanActivations = {};
  for (const rid of RELIC_IDS) {
    pickRates[rid] = totalOffers[rid] > 0 ? (totalPicks[rid] / totalOffers[rid]) : 0;
    meanActivations[rid] = Math.round((totalActivations[rid] / n) * 10) / 10;
  }

  return {
    n,
    medianMoves: Math.round(medianMoves * 10) / 10,
    p10: Math.round(p10 * 10) / 10,
    p90: Math.round(p90 * 10) / 10,
    meanScore: Math.round(meanScore * 10) / 10,
    meanMaxTile: Math.round(meanMaxTile * 10) / 10,
    endlessRate: Math.round(endlessRate * 100) / 100,
    flags: flags.join('; '),
    pickRates,
    totalOffers,
    totalPicks,
    meanActivations,
  };
}

/**
 * Formats results into markdown table and writes CSV.
 */
function reportResults(expName, rows, csvPath, isE4 = false) {
  // Format Markdown
  console.log(`\n### Experiment ${expName} Summary\n`);

  if (!isE4) {
    console.log('| Config / Relic | Bot | N | Median Moves | P10 | P90 | Mean Score | Mean Max Tile | Endless % | Activations/run | Flags |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      // For E2 solo, show the activation count of the forced relic
      // For E1 or E3 pairs, show the sum of all activated relics in the config
      let actStr = '-';
      if (r.stats.meanActivations) {
        const forcedRelics = r.forcedRelics || [];
        if (forcedRelics.length === 1) {
          actStr = String(r.stats.meanActivations[forcedRelics[0]] ?? 0);
        } else if (forcedRelics.length > 1) {
          actStr = forcedRelics.map(rid => `${rid.replace('_', ' ')}:${r.stats.meanActivations[rid] ?? 0}`).join(', ');
        }
      }
      console.log(
        `| ${r.configName} | ${r.bot} | ${r.stats.n} | ${r.stats.medianMoves} | ${r.stats.p10} | ${r.stats.p90} | ${r.stats.meanScore} | ${r.stats.meanMaxTile} | ${r.stats.endlessRate}% | ${actStr} | ${r.stats.flags || '-'} |`
      );
    }
  } else {
    console.log('| Bot | N | Median Moves | P10 | P90 | Mean Score | Mean Max Tile | Endless % | Flags |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(
        `| ${r.bot} | ${r.stats.n} | ${r.stats.medianMoves} | ${r.stats.p10} | ${r.stats.p90} | ${r.stats.meanScore} | ${r.stats.meanMaxTile} | ${r.stats.endlessRate}% | ${r.stats.flags || '-'} |`
      );
    }

    console.log(`\n#### Experiment ${expName} Relic Pick Rates (picks / offers)\n`);
    const header = ['Bot', ...RELIC_IDS];
    console.log(`| ${header.join(' | ')} |`);
    console.log(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rows) {
      const line = [r.bot];
      for (const rid of RELIC_IDS) {
        const rate = (r.stats.pickRates[rid] * 100).toFixed(1) + '%';
        const off = r.stats.totalOffers[rid];
        const pck = r.stats.totalPicks[rid];
        line.push(`${pck}/${off} (${rate})`);
      }
      console.log(`| ${line.join(' | ')} |`);
    }
  }

  // Write CSV
  const csvLines = [];
  if (!isE4) {
    csvLines.push('config,bot,n,median_moves,p10,p90,mean_score,mean_max_tile,endless_pct,flags');
    for (const r of rows) {
      csvLines.push(
        `"${r.configName}","${r.bot}",${r.stats.n},${r.stats.medianMoves},${r.stats.p10},${r.stats.p90},${r.stats.meanScore},${r.stats.meanMaxTile},${r.stats.endlessRate},"${r.stats.flags}"`
      );
    }
  } else {
    const csvHeader = ['bot', 'n', 'median_moves', 'p10', 'p90', 'mean_score', 'mean_max_tile', 'endless_pct', 'flags', ...RELIC_IDS.map(rid => `${rid}_pick_rate`)];
    csvLines.push(csvHeader.join(','));
    for (const r of rows) {
      const line = [
        `"${r.bot}"`,
        r.stats.n,
        r.stats.medianMoves,
        r.stats.p10,
        r.stats.p90,
        r.stats.meanScore,
        r.stats.meanMaxTile,
        r.stats.endlessRate,
        `"${r.stats.flags}"`,
        ...RELIC_IDS.map(rid => r.stats.pickRates[rid].toFixed(4))
      ];
      csvLines.push(line.join(','));
    }
  }

  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
  console.log(`\nSaved CSV to ${csvPath}\n`);
}

/**
 * Main Experiment Runner
 */
async function main() {
  const args = parseArgs();
  const botsToRun = args.bot === 'all' ? ['random', 'greedy', 'corner'] : [args.bot];

  // We cache E1 baselines to evaluate 2x median flags for E2/E3/E4
  const e1Baselines = {};

  // Run E1 Baseline
  if (args.experiment === 'E1' || args.experiment === 'ALL') {
    const runsCount = args.runs ?? 2000;
    console.log(`\n======================================================`);
    console.log(`Running Experiment E1: Baseline (No Relics, ${runsCount} runs per bot)`);
    console.log(`======================================================`);

    const rows = [];
    for (const bName of botsToRun) {
      process.stdout.write(`Simulating E1 for bot: ${bName}... `);
      const runs = [];
      for (let i = 0; i < runsCount; i++) {
        const seed = (args.seed + i * 31) >>> 0;
        runs.push(runSingleGame({
          seed,
          botName: bName,
          configOverrides: { moveCap: args.cap, forcedRelics: [], enableDraft: false }
        }));
      }
      const stats = aggregateStats(runs, null);
      e1Baselines[bName] = stats.medianMoves;
      rows.push({ configName: 'baseline', bot: bName, stats });
      console.log(`Done (Median: ${stats.medianMoves})`);
    }

    reportResults('E1', rows, path.join(OUT_DIR, 'e1.csv'), false);
  }

  // Run E2 Solo
  if (args.experiment === 'E2' || args.experiment === 'ALL') {
    const runsCount = args.runs ?? 2000;
    console.log(`\n======================================================`);
    console.log(`Running Experiment E2: Solo Relics (${runsCount} runs per relic per bot)`);
    console.log(`======================================================`);

    const rows = [];
    for (const rid of RELIC_IDS) {
      for (const bName of botsToRun) {
        process.stdout.write(`Simulating E2: ${rid} | ${bName}... `);
        const runs = [];
        for (let i = 0; i < runsCount; i++) {
          const seed = (args.seed + i * 31) >>> 0;
          runs.push(runSingleGame({
            seed,
            botName: bName,
            configOverrides: { moveCap: args.cap, forcedRelics: [rid], enableDraft: false }
          }));
        }
        const stats = aggregateStats(runs, e1Baselines[bName] ?? null);
        rows.push({ configName: rid, bot: bName, stats, forcedRelics: [rid] });
        console.log(`Done (Median: ${stats.medianMoves})`);
      }
    }

    reportResults('E2', rows, path.join(OUT_DIR, 'e2.csv'), false);
  }

  // Run E3 Pairs
  if (args.experiment === 'E3' || args.experiment === 'ALL') {
    const runsCount = args.runs ?? 2000;
    console.log(`\n======================================================`);
    console.log(`Running Experiment E3: Relic Pairs (${runsCount} runs per pair, greedy bot)`);
    console.log(`======================================================`);

    const pairs = [];
    for (let i = 0; i < RELIC_IDS.length; i++) {
      for (let j = i + 1; j < RELIC_IDS.length; j++) {
        pairs.push([RELIC_IDS[i], RELIC_IDS[j]]);
      }
    }

    const targetBot = (args.bot === 'all' || args.bot === 'greedy') ? 'greedy' : args.bot;
    const rows = [];
    for (const [r1, r2] of pairs) {
      const pairName = `${r1} + ${r2}`;
      process.stdout.write(`Simulating E3: ${pairName}... `);
      const runs = [];
      for (let i = 0; i < runsCount; i++) {
        const seed = (args.seed + i * 31) >>> 0;
        runs.push(runSingleGame({
          seed,
          botName: targetBot,
          configOverrides: { moveCap: args.cap, forcedRelics: [r1, r2], enableDraft: false }
        }));
      }
      const stats = aggregateStats(runs, e1Baselines[targetBot] ?? null);
      rows.push({ configName: pairName, bot: targetBot, stats, forcedRelics: [r1, r2] });

      console.log(`Done (Median: ${stats.medianMoves})`);
    }

    reportResults('E3', rows, path.join(OUT_DIR, 'e3.csv'), false);
  }

  // Run E4 Random Draft
  if (args.experiment === 'E4' || args.experiment === 'ALL') {
    const runsCount = args.runs ?? 5000;
    console.log(`\n======================================================`);
    console.log(`Running Experiment E4: Random Draft Flow (${runsCount} runs per bot)`);
    console.log(`======================================================`);

    const rows = [];
    for (const bName of botsToRun) {
      process.stdout.write(`Simulating E4 for bot: ${bName}... `);
      const runs = [];
      for (let i = 0; i < runsCount; i++) {
        const seed = (args.seed + i * 31) >>> 0;
        runs.push(runSingleGame({
          seed,
          botName: bName,
          configOverrides: { moveCap: args.cap, draftPolicy: 'random', enableDraft: true }
        }));
      }
      const stats = aggregateStats(runs, e1Baselines[bName] ?? null);
      rows.push({ bot: bName, stats });
      console.log(`Done (Median: ${stats.medianMoves})`);
    }

    reportResults('E4', rows, path.join(OUT_DIR, 'e4.csv'), true);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Error running experiments:', err);
    process.exit(1);
  });
}
