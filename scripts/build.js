import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

console.log('Building self-contained static bundle in dist/ ...');

// Generate buildId from build timestamp + short content hash of game/*.js
const gameFiles = fs.readdirSync(path.join(rootDir, 'game'))
  .filter(f => f.endsWith('.js'))
  .sort();

const hash = crypto.createHash('sha256');
for (const f of gameFiles) {
  hash.update(fs.readFileSync(path.join(rootDir, 'game', f)));
}
const contentHash = hash.digest('hex').slice(0, 8);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const buildId = `build_${timestamp}_${contentHash}`;
console.log(`Generated buildId: ${buildId}`);

// Clean or create dist
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Copy index.html with buildId replacement
let indexHtml = fs.readFileSync(path.join(rootDir, 'game', 'index.html'), 'utf-8');
indexHtml = indexHtml.replaceAll('__BUILD_ID__', buildId);
fs.writeFileSync(path.join(distDir, 'index.html'), indexHtml, 'utf-8');

// Copy style.css
const styleCss = fs.readFileSync(path.join(rootDir, 'game', 'style.css'), 'utf-8');
fs.writeFileSync(path.join(distDir, 'style.css'), styleCss, 'utf-8');

// Copy app.js with buildId replacement
let appJs = fs.readFileSync(path.join(rootDir, 'game', 'app.js'), 'utf-8');
appJs = appJs.replaceAll('__BUILD_ID__', buildId);
fs.writeFileSync(path.join(distDir, 'app.js'), appJs, 'utf-8');

// Copy controller.js and adjust imports to self-contained relative paths
let controllerJs = fs.readFileSync(path.join(rootDir, 'game', 'controller.js'), 'utf-8');
controllerJs = controllerJs
  .replace(/from\s+['"]\.\.\/sim\/engine\.js['"]/g, "from './engine.js'")
  .replace(/from\s+['"]\.\.\/sim\/relics\.js['"]/g, "from './relics.js'")
  .replaceAll('__BUILD_ID__', buildId);
fs.writeFileSync(path.join(distDir, 'controller.js'), controllerJs, 'utf-8');

// Copy engine.js
const engineJs = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'), 'utf-8');
fs.writeFileSync(path.join(distDir, 'engine.js'), engineJs, 'utf-8');

// Copy relics.js
const relicsJs = fs.readFileSync(path.join(rootDir, 'sim', 'relics.js'), 'utf-8');
fs.writeFileSync(path.join(distDir, 'relics.js'), relicsJs, 'utf-8');

// Copy icons directory to dist/icons
const iconsSrcDir = path.join(rootDir, 'game', 'icons');
const iconsDistDir = path.join(distDir, 'icons');
if (fs.existsSync(iconsSrcDir)) {
  fs.mkdirSync(iconsDistDir, { recursive: true });
  for (const f of fs.readdirSync(iconsSrcDir)) {
    fs.copyFileSync(path.join(iconsSrcDir, f), path.join(iconsDistDir, f));
  }
}

// Calculate real total size recursively
function getDirSizeBytes(dir) {
  let bytes = 0;
  for (const item of fs.readdirSync(dir)) {
    const p = path.join(dir, item);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      bytes += getDirSizeBytes(p);
    } else {
      bytes += stat.size;
    }
  }
  return bytes;
}

const totalBytes = getDirSizeBytes(distDir);
const totalKb = (totalBytes / 1024).toFixed(2);
const totalMb = (totalBytes / (1024 * 1024)).toFixed(3);

console.log('\n--- Dist Files ---');
function logDirFiles(dir, prefix = '') {
  for (const item of fs.readdirSync(dir)) {
    const p = path.join(dir, item);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      logDirFiles(p, path.join(prefix, item));
    } else {
      const relPath = path.join(prefix, item);
      console.log(`  ${relPath.padEnd(25)} : ${stat.size.toLocaleString().padStart(8)} bytes (${(stat.size / 1024).toFixed(2)} KB)`);
    }
  }
}
logDirFiles(distDir);

console.log('------------------');
console.log(`Total dist/ size: ${totalBytes.toLocaleString()} bytes (${totalKb} KB / ${totalMb} MB)`);

if (totalBytes < 1024 * 1024) {
  console.log('✔ Bundle size is under 1 MB limit.\n');
} else {
  console.warn('⚠ WARNING: Bundle size exceeds 1 MB limit!\n');
}
