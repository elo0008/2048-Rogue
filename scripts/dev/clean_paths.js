import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

// Update scripts in scripts/
const scriptsRoot = path.join(rootDir, 'scripts');
const rootScripts = ['ghost_fuzz.js', 'icon_metrics.js', 'layout_check.js', 'run_parity_check.js', 'smoke_test.js'];

for (const name of rootScripts) {
  const p = path.join(scriptsRoot, name);
  if (!fs.existsSync(p)) continue;
  let content = fs.readFileSync(p, 'utf-8');
  if (content.includes("fs.existsSync('C:\\\\Program Files")) {
    content = "import { findChrome } from './find_chrome.js';\n" + content;
    content = content.replace(
      /const CHROME_PATH = fs\.existsSync\('C:\\\\Program Files[^\n]+\n\s+\? 'C:\\\\Program Files[^\n]+\n\s+: 'C:\\\\Program Files[^\n]+;/,
      'const CHROME_PATH = findChrome();'
    );
    fs.writeFileSync(p, content, 'utf-8');
    console.log(`Updated scripts/${name}`);
  }
}

// Update scripts in scripts/dev
const devDir = path.join(scriptsRoot, 'dev');
const devFiles = fs.readdirSync(devDir).filter(f => f.endsWith('.js'));

for (const name of devFiles) {
  const p = path.join(devDir, name);
  let content = fs.readFileSync(p, 'utf-8');
  let changed = false;

  if (content.includes("fs.existsSync('C:\\\\Program Files")) {
    content = "import { findChrome } from '../find_chrome.js';\n" + content;
    content = content.replace(
      /const CHROME_PATH = fs\.existsSync\('C:\\\\Program Files[^\n]+\n\s+\? 'C:\\\\Program Files[^\n]+\n\s+: 'C:\\\\Program Files[^\n]+;/,
      'const CHROME_PATH = findChrome();'
    );
    changed = true;
  }

  if (content.includes("const artifactDir = 'C:\\\\Users\\\\")) {
    content = content.replace(
      /const artifactDir = 'C:\\\\Users\\\\[^']+';/,
      "const artifactDir = path.resolve(rootDir, 'artifacts');"
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(p, content, 'utf-8');
    console.log(`Updated scripts/dev/${name}`);
  }
}
