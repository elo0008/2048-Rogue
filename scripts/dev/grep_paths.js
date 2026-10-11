import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const outFile = path.join(rootDir, 'scripts', 'out', 'grep_paths.txt');

let output = '';
try {
  output = execSync('git grep -i -E "(C:\\\\|Users\\\\)"', { cwd: rootDir, encoding: 'utf-8' });
} catch (err) {
  // Exit code 1 means no matches found
  output = `(0 matches found - command exited with code ${err.status})\n`;
}

fs.writeFileSync(outFile, output, 'utf-8');
console.log('Wrote output to scripts/out/grep_paths.txt:');
console.log(output);
