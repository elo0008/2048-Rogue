import { GameController } from '../game/controller.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Start a game with seed 5 and diagonal_charge + rewind
const controller = new GameController(5, {
  forcedRelics: ['diagonal_charge', 'rewind'],
  forceAtMove: 0,
}, 'playtester_agent');

// Record some keyboard moves
controller.recordInput('key');
// At move 0 on seed 5, diagonal pair is at { from: 12, to: 9 }
controller.recordInput('tap'); // tap ability button & tiles
const abRes = controller.useAbility('diagonal_charge', { from: 12, to: 9 });

// Make 1 swipe, then test rewind
const vMoves = controller.getValidMoves();
if (vMoves.length > 0) {
  controller.recordInput('swipe');
  controller.submitMove(vMoves[0]);
  controller.recordInput('tap');
  controller.useAbility('rewind', null);
}

// Make moves until game over
const dirs = ['D', 'L', 'R', 'U'];
let moveIdx = 0;
while (!controller.isGameOver() && moveIdx < 100) {
  const valids = controller.getValidMoves();
  if (valids.length === 0) break;
  const d = valids[moveIdx % valids.length];
  controller.recordInput(moveIdx % 2 === 0 ? 'key' : 'swipe');
  controller.submitMove(d);
  moveIdx++;
}

const metadata = {
  viewport: { w: 390, h: 844, dpr: 2 },
  queryString: '?seed=5&start=diagonal_charge',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Mobile Safari/537.36',
  buildId: 'v2048-rogue-abilities',
};

const runLog = controller.getRunLog(metadata);
fs.writeFileSync(path.join(rootDir, 'sample_run_log.json'), JSON.stringify(runLog, null, 2));
console.log('Generated run log with ability uses:', runLog.abilityUses.length);
console.log(JSON.stringify(runLog, null, 2));
