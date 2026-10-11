import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let diff = '';

try {
  diff += execSync('git diff --no-index sim_backup_pre_E sim', { cwd: rootDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
} catch (e) {
  if (e.stdout) diff += e.stdout;
}

try {
  diff += execSync('git diff --no-index game_backup_pre_E game', { cwd: rootDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
} catch (e) {
  if (e.stdout) diff += e.stdout;
}

try {
  diff += execSync('git diff --no-index -- scripts/layout_check.js', { cwd: rootDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
} catch (e) {
  if (e.stdout) diff += e.stdout;
}

fs.writeFileSync(path.join(rootDir, 'CHANGES.diff'), diff, 'utf-8');
console.log('Saved CHANGES.diff, size:', diff.length, 'bytes');
