import { createGame, step } from './engine.js';
import { createBot } from './bots.js';

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

function runPacing(configOverrides) {
  const schedule = buildHazardSchedule(3);
  const runs = [];
  const draftMovesByOrder = [[], [], [], [], [], []]; // for drafts #1 to #6

  for (let i = 0; i < N; i++) {
    const seed = (SEED + i * 31) >>> 0;
    const botSeed = (seed + 0x7f4a7c15) >>> 0;
    const bot = createBot('greedy', botSeed);
    const game = createGame(seed, {
      moveCap: CAP,
      hazardSchedule: schedule,
      ...configOverrides,
    });

    while (!game.gameOver && !game.capped) {
      const move = bot.chooseMove(game);
      if (!move) break;
      const res = step(game, move, bot);
      if (!res.valid) break;
    }

    runs.push(game);

    // Track move numbers of drafts #1 - #6
    for (let k = 0; k < Math.min(6, game.draftHistory.length); k++) {
      draftMovesByOrder[k].push(game.draftHistory[k].move);
    }
  }

  const moveCounts = runs.map(g => g.moveCount).sort((a, b) => a - b);
  const totalDrafts = runs.reduce((s, g) => s + g.draftHistory.length, 0);
  const meanDrafts = Math.round((totalDrafts / N) * 100) / 100;

  const meanDraftMoves = draftMovesByOrder.map((arr, idx) => {
    if (arr.length === 0) return { order: idx + 1, count: 0, meanMove: null };
    const mean = Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
    return { order: idx + 1, count: arr.length, meanMove: mean };
  });

  return {
    runs,
    meanDrafts,
    meanDraftMoves,
    med: Math.round(getPercentile(moveCounts, 50) * 10) / 10,
    p10: Math.round(getPercentile(moveCounts, 10) * 10) / 10,
    p90: Math.round(getPercentile(moveCounts, 90) * 10) / 10,
  };
}

console.log('================================================================');
console.log('5. DRAFT PACING (Greedy, 3x Stones, N=' + N + ')');
console.log('================================================================\n');

// (a) Extended tile thresholds
const resA = runPacing({
  enableDraft: true,
  draftThresholds: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096],
  draftEveryMoves: null,
  draftPolicy: 'random',
});

// (b) Tile thresholds off with draftEveryMoves=25
const resB = runPacing({
  enableDraft: true,
  draftThresholds: [],
  draftEveryMoves: 25,
  draftPolicy: 'random',
});

console.log('--- Draft Pacing Comparison ---\n');
console.log('| Mode | Mean Drafts/Run | Draft #1 Mean Move (N) | Draft #2 Mean Move (N) | Draft #3 Mean Move (N) | Draft #4 Mean Move (N) | Draft #5 Mean Move (N) | Draft #6 Mean Move (N) |');
console.log('|---|---|---|---|---|---|---|---|');

function formatDraftCols(res) {
  return res.meanDraftMoves.map(d => d.meanMove !== null ? `${d.meanMove} (${d.count})` : 'N/A (0)').join(' | ');
}

console.log(`| (a) Extended Thresholds | ${resA.meanDrafts} | ${formatDraftCols(resA)} |`);
console.log(`| (b) draftEveryMoves=25  | ${resB.meanDrafts} | ${formatDraftCols(resB)} |`);

// Now for (a), run the 3 policies
console.log('\n--- Draft Policy Comparison under (a) Extended Thresholds ---\n');

const policyList = 'diagonal_merge,mason,fault_line,foresight,triple_threat,gravity_well,anchor_row,pressure_cooker';
const policyListRev = policyList.split(',').reverse().join(',');

const policies = [
  { name: 'random', policy: 'random' },
  { name: `fixed:${policyList}`, policy: `fixed:${policyList}` },
  { name: `fixed:${policyListRev}`, policy: `fixed:${policyListRev}` },
];

console.log('| Policy | Median Moves | P10 | P90 | Mean Drafts/Run |');
console.log('|---|---|---|---|---|');

for (const p of policies) {
  const r = runPacing({
    enableDraft: true,
    draftThresholds: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096],
    draftEveryMoves: null,
    draftPolicy: p.policy,
  });
  console.log(`| ${p.name} | ${r.med} | ${r.p10} | ${r.p90} | ${r.meanDrafts} |`);
}
