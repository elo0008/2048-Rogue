import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const outFile = path.join(rootDir, 'scripts', 'out', 'p1_grep_build_game.txt');

let output = '';
try {
  output = execSync(
    'git grep -i -E "(C:\\\\|Users\\\\)" -- game/ scripts/build.js scripts/icon_metrics.js scripts/find_chrome.js scripts/serve.js package.json vercel.json README.md',
    { cwd: rootDir, encoding: 'utf-8' }
  );
} catch (err) {
  output = `(0 matches found - command exited with code ${err.status})\n`;
}

fs.writeFileSync(outFile, output, 'utf-8');
console.log('Output written to scripts/out/p1_grep_build_game.txt:');
console.log(output);
