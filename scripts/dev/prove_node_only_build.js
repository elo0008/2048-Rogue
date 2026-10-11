import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const outFile = path.join(rootDir, 'scripts', 'out', 'p1_build_proof.txt');

const outLines = [];
function log(msg) {
  console.log(msg);
  outLines.push(msg);
}

log(`=== P1: NODE-ONLY BUILD VERIFICATION ===`);
const nodeVer = process.version;
log(`Node Version: ${nodeVer}`);

// First ensure a normal build exists in repo with consistent epoch
const epoch = Math.floor(Date.now() / 1000).toString();
execSync('npm run build', { cwd: rootDir, encoding: 'utf-8', env: { ...process.env, SOURCE_DATE_EPOCH: epoch } });

// Get git ls-files -co --exclude-standard
const lsOutput = execSync('git ls-files -co --exclude-standard', { cwd: rootDir, encoding: 'utf-8' });
const files = lsOutput.split(/\r?\n/).map(f => f.trim()).filter(Boolean);

// Create temp directory
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogue2048-build-test-'));
log(`Temporary Directory: ${tempDir}`);
log(`Copying ${files.length} tracked/untracked-not-ignored files...`);

for (const file of files) {
  const src = path.join(rootDir, file);
  const dest = path.join(tempDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

log(`Running npm run build with NO_CHROME=1 and CHROME_PATH unset...`);
let buildStdout = '';
try {
  buildStdout = execSync('npm run build', {
    cwd: tempDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_CHROME: '1',
      CHROME_PATH: '',
      SOURCE_DATE_EPOCH: epoch,
    },
  });
} catch (err) {
  buildStdout = (err.stdout || '') + '\n' + (err.stderr || '');
  log(`BUILD FAILED:\n${buildStdout}`);
  fs.writeFileSync(outFile, outLines.join('\n'), 'utf-8');
  process.exit(1);
}

log(`--- Build Output ---`);
log(buildStdout.trim());
log(`--------------------`);

// List dist files in temp folder with sizes and sha256
function getDistFiles(dir, prefix = '') {
  let res = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      res = res.concat(getDistFiles(full, rel));
    } else {
      const buf = fs.readFileSync(full);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      res.push({
        path: rel,
        size: buf.length,
        sha256: hash,
        content: buf.toString('utf-8'),
      });
    }
  }
  return res.sort((a, b) => a.path.localeCompare(b.path));
}

const tempDist = getDistFiles(path.join(tempDir, 'dist'));
const normalDist = getDistFiles(path.join(rootDir, 'dist'));

log(`\nTemp Dist Files (${tempDist.length} files):`);
log(`Filename                   | Size (bytes) | SHA256`);
log(`---------------------------+--------------+-----------------------------------------------------------------`);
for (const f of tempDist) {
  log(`${f.path.padEnd(26)} | ${String(f.size).padStart(12)} | ${f.sha256}`);
}

log(`\nComparison vs Normal dist/:`);
let allMatch = true;
let exactShaMatch = true;
let normalizedShaMatch = true;

const tempNames = tempDist.map(f => f.path);
const normalNames = normalDist.map(f => f.path);
const namesEqual = JSON.stringify(tempNames) === JSON.stringify(normalNames);

log(`File lists match: ${namesEqual ? 'YES' : 'NO'}`);

for (const tf of tempDist) {
  const nf = normalDist.find(f => f.path === tf.path);
  if (!nf) {
    log(`  [MISSING] ${tf.path} not in normal dist`);
    allMatch = false;
    continue;
  }
  const shaEqual = tf.sha256 === nf.sha256;
  if (!shaEqual) {
    exactShaMatch = false;
    // Check if difference is purely due to buildId timestamp
    const tfNorm = tf.content.replace(/build_[0-9T\-_]+_[a-f0-9]+/g, '__BUILD_ID__');
    const nfNorm = nf.content.replace(/build_[0-9T\-_]+_[a-f0-9]+/g, '__BUILD_ID__');
    if (tfNorm === nfNorm) {
      log(`  ${tf.path.padEnd(25)} : SHA256 differs ONLY by build timestamp in buildId (content identical)`);
    } else {
      normalizedShaMatch = false;
      log(`  ${tf.path.padEnd(25)} : SHA256 differs (content mismatch)`);
    }
  } else {
    log(`  ${tf.path.padEnd(25)} : Exact SHA256 match (${tf.sha256.slice(0, 16)}...)`);
  }
}

log(`\nVerdict:`);
log(`- File names equal: ${namesEqual ? 'YES' : 'NO'}`);
log(`- File SHA256 hashes equal: ${exactShaMatch ? 'YES (100% bit-identical)' : 'NO'}`);

// Clean up temp directory
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {}

fs.writeFileSync(outFile, outLines.join('\n'), 'utf-8');
log(`\nSaved proof to ${outFile}`);
