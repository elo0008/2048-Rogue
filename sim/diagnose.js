import { createGame, step, STONE } from './engine.js';
import { createBot } from './bots.js';
import { RELIC_IDS } from './relics.js';

function runDiagnoseE1(n = 500) {
  console.log(`\n=== 1. DIAGNOSE E1 (N=${n} per bot) ===\n`);
  const bots = ['random', 'greedy', 'corner'];

  for (const botName of bots) {
    const moveCounts = [];
    const scores = [];
    let assertionsPassed = true;
    let assertionFailures = 0;

    let totalStonesAtGameOver = 0;
    let totalNumberTilesAtGameOver = 0;

    for (let i = 0; i < n; i++) {
      const seed = (42 + i * 31) >>> 0;
      const botSeed = (seed + 0x7f4a7c15) >>> 0;
      const bot = createBot(botName, botSeed);
      const game = createGame(seed, { forcedRelics: [], enableDraft: false });

      while (!game.gameOver && !game.capped) {
        const move = bot.chooseMove(game);
        if (!move) break;
        const res = step(game, move, bot);
        if (!res.valid) break;
      }

      if (game.score !== game.moveCount) {
        assertionsPassed = false;
        assertionFailures++;
      }

      moveCounts.push(game.moveCount);
      scores.push(game.score);

      // Count stones and numbers on board at game over
      let stones = 0;
      let numbers = 0;
      for (const cell of game.board) {
        if (cell === STONE) stones++;
        else if (typeof cell === 'number' && cell > 0) numbers++;
      }
      totalStonesAtGameOver += stones;
      totalNumberTilesAtGameOver += numbers;
    }

    const meanMoves = moveCounts.reduce((a, b) => a + b, 0) / n;
    const meanScore = scores.reduce((a, b) => a + b, 0) / n;
    const minMoves = Math.min(...moveCounts);
    const maxMoves = Math.max(...moveCounts);

    // Histogram in buckets of 25: 0-24, 25-49, 50-74, ...
    const buckets = {};
    for (const m of moveCounts) {
      const b = Math.floor(m / 25) * 25;
      const key = `${b}-${b + 24}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }

    console.log(`Bot: ${botName}`);
    console.log(`  Mean Moves: ${meanMoves.toFixed(2)}`);
    console.log(`  Mean Score: ${meanScore.toFixed(2)}`);
    console.log(`  Min Moves: ${minMoves}, Max Moves: ${maxMoves}`);
    console.log(`  Score === MoveCount assertion: ${assertionsPassed ? 'PASSED (0 failures)' : `FAILED (${assertionFailures} failures)`}`);
    console.log(`  Mean Stones at Game Over: ${(totalStonesAtGameOver / n).toFixed(2)}`);
    console.log(`  Mean Number Tiles at Game Over: ${(totalNumberTilesAtGameOver / n).toFixed(2)}`);
    console.log(`  Histogram (buckets of 25):`);
    const sortedBucketKeys = Object.keys(buckets).sort((a, b) => parseInt(a) - parseInt(b));
    for (const k of sortedBucketKeys) {
      const count = buckets[k];
      const bar = '#'.repeat(Math.round((count / n) * 50));
      console.log(`    ${k.padStart(10)}: ${count.toString().padStart(4)} (${((count / n) * 100).toFixed(1)}%) ${bar}`);
    }
    console.log('');
  }
}

function runDiagnoseE4(n = 200) {
  console.log(`\n=== 3. DIAGNOSE E4 (N=${n}, greedy bot) ===\n`);
  const draftsCounts = [];
  let atLeast1 = 0;
  let atLeast3 = 0;
  let atLeast5 = 0;

  for (let i = 0; i < n; i++) {
    const seed = (42 + i * 31) >>> 0;
    const botSeed = (seed + 0x7f4a7c15) >>> 0;
    const bot = createBot('greedy', botSeed);
    const game = createGame(seed, { draftPolicy: 'random' });

    while (!game.gameOver && !game.capped) {
      const move = bot.chooseMove(game);
      if (!move) break;
      const res = step(game, move, bot);
      if (!res.valid) break;
    }

    const draftsTriggered = game.draftHistory.length;
    draftsCounts.push(draftsTriggered);
    if (draftsTriggered >= 1) atLeast1++;
    if (draftsTriggered >= 3) atLeast3++;
    if (draftsTriggered >= 5) atLeast5++;
  }

  const meanDrafts = draftsCounts.reduce((a, b) => a + b, 0) / n;
  console.log(`Greedy Bot E4 Draft Trigger Statistics:`);
  console.log(`  Mean drafts triggered per run: ${meanDrafts.toFixed(2)}`);
  console.log(`  Runs with >= 1 draft: ${atLeast1}/${n} (${((atLeast1 / n) * 100).toFixed(1)}%)`);
  console.log(`  Runs with >= 3 drafts: ${atLeast3}/${n} (${((atLeast3 / n) * 100).toFixed(1)}%)`);
  console.log(`  Runs with >= 5 drafts: ${atLeast5}/${n} (${((atLeast5 / n) * 100).toFixed(1)}%)`);
}

runDiagnoseE1(500);
runDiagnoseE4(200);
