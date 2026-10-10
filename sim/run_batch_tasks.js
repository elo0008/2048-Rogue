import { createGame, step } from './engine.js';
import { createBot } from './bots.js';
import { RELIC_IDS } from './relics.js';

const N = 300;
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

const hazardSchedule3x = buildHazardSchedule(3);

function runBatch(configOverrides, botName = 'greedy') {
  const moveCounts = [];
  const scores = [];
  let totalActivations = {};
  for (const rid of RELIC_IDS) totalActivations[rid] = 0;
  let totalDrafts = 0;

  for (let i = 0; i < N; i++) {
    const seed = (SEED + i * 31) >>> 0;
    const botSeed = (seed + 0x7f4a7c15) >>> 0;
    const bot = createBot(botName, botSeed);
    const game = createGame(seed, {
      moveCap: CAP,
      hazardSchedule: hazardSchedule3x,
      forceAtMove: 30,
      enableDraft: false,
      ...configOverrides,
    });

    while (!game.gameOver && !game.capped) {
      const move = bot.chooseMove(game);
      if (!move) break;
      const res = step(game, move, bot);
      if (!res.valid) break;
    }

    moveCounts.push(game.moveCount);
    scores.push(game.score);
    totalDrafts += game.draftHistory.length;
    for (const rid of RELIC_IDS) {
      totalActivations[rid] += (game.relicActivations ? (game.relicActivations[rid] || 0) : 0);
    }
  }

  moveCounts.sort((a, b) => a - b);
  const meanMoves = moveCounts.reduce((a, b) => a + b, 0) / N;
  const meanScore = scores.reduce((a, b) => a + b, 0) / N;
  const meanActivations = {};
  for (const rid of RELIC_IDS) {
    meanActivations[rid] = Math.round((totalActivations[rid] / N) * 10) / 10;
  }

  return {
    med: Math.round(getPercentile(moveCounts, 50) * 10) / 10,
    p10: Math.round(getPercentile(moveCounts, 10) * 10) / 10,
    p90: Math.round(getPercentile(moveCounts, 90) * 10) / 10,
    meanMoves: Math.round(meanMoves * 10) / 10,
    meanScore: Math.round(meanScore * 10) / 10,
    meanDrafts: Math.round((totalDrafts / N) * 100) / 100,
    meanActivations,
  };
}

// ==========================================
// 1. Diagonal Merge cooldown sweep {3,4,5,6,8}
// ==========================================
console.log('=== 1. DIAGONAL MERGE COOLDOWN SWEEP ===\n');
console.log('| Cooldown | Median | P10 | P90 | Mean Activations/run |');
console.log('|---|---|---|---|---|');
const cds = [3, 4, 5, 6, 8];
for (const cd of cds) {
  const res = runBatch({
    forcedRelics: ['diagonal_merge'],
    diagonalMergeCooldown: cd,
  });
  console.log(`| ${cd} | ${res.med} | ${res.p10} | ${res.p90} | ${res.meanActivations['diagonal_merge']} |`);
}

// ==========================================
// 2. Pair synergy, all 28 pairs
// ==========================================
console.log('\n=== 2. PAIR SYNERGY ===\n');

// Baseline: no relic
const noRelicRes = runBatch({ forcedRelics: [] });
const medNoRelic = noRelicRes.med;
console.log(`No Relic Baseline Median: ${medNoRelic}\n`);

// 8 Solos
const soloMeds = {};
for (const rid of RELIC_IDS) {
  const soloRes = runBatch({ forcedRelics: [rid] });
  soloMeds[rid] = soloRes.med;
}

console.log('Solo Medians:');
for (const rid of RELIC_IDS) {
  console.log(`  ${rid}: ${soloMeds[rid]}`);
}
console.log('');

// 28 Pairs
const pairResults = [];
for (let i = 0; i < RELIC_IDS.length; i++) {
  for (let j = i + 1; j < RELIC_IDS.length; j++) {
    const rA = RELIC_IDS[i];
    const rB = RELIC_IDS[j];
    const pairRes = runBatch({ forcedRelics: [rA, rB] });
    const medPair = pairRes.med;
    // synergy = med(pair) - (med(A) + med(B) - med(no relic))
    const expectedAdditive = soloMeds[rA] + soloMeds[rB] - medNoRelic;
    const synergy = Math.round((medPair - expectedAdditive) * 10) / 10;
    pairResults.push({
      pair: `${rA} + ${rB}`,
      rA,
      rB,
      medA: soloMeds[rA],
      medB: soloMeds[rB],
      medPair,
      expected: Math.round(expectedAdditive * 10) / 10,
      synergy,
    });
  }
}

// Sort by synergy descending
const sortedPairs = [...pairResults].sort((a, b) => b.synergy - a.synergy);

console.log('Top 5 Highest Synergy Pairs:');
console.log('| Rank | Pair | Med(Pair) | Med(A) | Med(B) | Expected Additive | Synergy |');
console.log('|---|---|---|---|---|---|---|');
for (let i = 0; i < 5; i++) {
  const p = sortedPairs[i];
  console.log(`| ${i + 1} | ${p.pair} | ${p.medPair} | ${p.medA} | ${p.medB} | ${p.expected} | ${p.synergy >= 0 ? '+' : ''}${p.synergy} |`);
}

console.log('\nTop 5 Lowest Synergy Pairs:');
console.log('| Rank | Pair | Med(Pair) | Med(A) | Med(B) | Expected Additive | Synergy |');
console.log('|---|---|---|---|---|---|---|');
for (let i = 0; i < 5; i++) {
  const p = sortedPairs[sortedPairs.length - 1 - i];
  console.log(`| ${i + 1} | ${p.pair} | ${p.medPair} | ${p.medA} | ${p.medB} | ${p.expected} | ${p.synergy >= 0 ? '+' : ''}${p.synergy} |`);
}

console.log('\nFull Pair Synergy CSV:');
console.log('relic_a,relic_b,med_a,med_b,med_pair,expected_additive,synergy');
for (const p of pairResults) {
  console.log(`${p.rA},${p.rB},${p.medA},${p.medB},${p.medPair},${p.expected},${p.synergy}`);
}

// ==========================================
// 3. Interval drafting: draftEveryMoves=25, tile thresholds off, 3x stones, enableDraft true
// ==========================================
console.log('\n=== 3. INTERVAL DRAFTING ===\n');

const goodOrder = ['diagonal_merge', 'mason', 'fault_line', 'foresight', 'triple_threat', 'gravity_well', 'anchor_row', 'pressure_cooker'];
const reversedOrder = [...goodOrder].reverse();

const draftConfigs = [
  { name: 'random', policy: 'random' },
  { name: `fixed:${goodOrder.join(',')}`, policy: `fixed:${goodOrder.join(',')}` },
  { name: `fixed:${reversedOrder.join(',')}`, policy: `fixed:${reversedOrder.join(',')}` },
];

for (const rid of goodOrder) {
  const withoutRelic = goodOrder.filter(r => r !== rid);
  draftConfigs.push({
    name: `fixed without ${rid} (${withoutRelic.join(',')})`,
    policy: `fixed:${withoutRelic.join(',')}`,
  });
}

console.log('| Policy | Median | P10 | P90 | Mean Drafts/run |');
console.log('|---|---|---|---|---|');

for (const cfg of draftConfigs) {
  const res = runBatch({
    enableDraft: true,
    draftThresholds: [],
    draftEveryMoves: 25,
    draftPolicy: cfg.policy,
    forcedRelics: [],
    forceAtMove: 0,
  });
  console.log(`| ${cfg.name} | ${res.med} | ${res.p10} | ${res.p90} | ${res.meanDrafts} |`);
}

// ==========================================
// 4. pressure_cooker only: mean moves and mean score in this config
// ==========================================
console.log('\n=== 4. PRESSURE COOKER ONLY ===\n');
const pcRes = runBatch({ forcedRelics: ['pressure_cooker'] });
console.log(`pressure_cooker (N=${N}, 3x stones, forceAtMove=30):`);
console.log(`  Mean Moves: ${pcRes.meanMoves}`);
console.log(`  Mean Score: ${pcRes.meanScore}`);
console.log(`  Median Moves: ${pcRes.med}`);
console.log(`  P10 Moves: ${pcRes.p10}`);
console.log(`  P90 Moves: ${pcRes.p90}`);
