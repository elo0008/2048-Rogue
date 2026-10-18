import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { computeGameContentHash } from './build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const targetHashes = ['c34484f3', 'a80b69eb', '9b75cd49', 'aadd3e71', '222f0286'];

const recordedSites = {
  'c34484f3': [
    { file: 'app.js', line: 2089, col: 12 },
    { file: 'app.js', line: 2117, col: 12 }
  ],
  'a80b69eb': [
    { file: 'app.js', line: 2089, col: 12 },
    { file: 'app.js', line: 2117, col: 12 }
  ],
  '9b75cd49': [
    { file: 'app.js', line: 2273, col: 12 }
  ],
  'aadd3e71': [
    { file: 'app.js', line: 2273, col: 12 },
    { file: 'app.js', line: 2567, col: 68 },
    { file: 'app.js', line: 1034, col: 84 }
  ],
  '222f0286': [
    { file: 'app.js', line: 2592, col: 68 }
  ]
};

console.log('Finding commits for target build hashes...');
const revsRaw = execSync('git rev-list --all', { cwd: rootDir }).toString().trim().split('\n');

// Map of buildHash -> commitInfo
const matched = {};

// We will checkout trees to a temp directory or extract game/*.js to inspect
const tempDir = path.join(outDir, 'temp_hash_eval');
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
fs.mkdirSync(tempDir, { recursive: true });

for (const rev of revsRaw) {
  if (!rev) continue;
  try {
    // List js files in game/
    const filesOutput = execSync(`git ls-tree --name-only ${rev} game/`, { cwd: rootDir }).toString().trim().split('\n');
    const jsFiles = filesOutput.filter(f => f.trim().endsWith('.js')).map(f => f.trim()).sort();
    if (jsFiles.length === 0) continue;

    // Clean tempDir
    for (const f of fs.readdirSync(tempDir)) {
      fs.rmSync(path.join(tempDir, f), { force: true, recursive: true });
    }

    for (const relPath of jsFiles) {
      const fileName = path.basename(relPath);
      const content = execSync(`git show ${rev}:${relPath}`, { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 });
      fs.writeFileSync(path.join(tempDir, fileName), content);
    }

    const digest = computeGameContentHash(tempDir);
    if (targetHashes.includes(digest) && !matched[digest]) {
      const logLine = execSync(`git log -1 --format="%H|%ad|%s" --date=iso ${rev}`, { cwd: rootDir }).toString().trim();
      const [fullHash, date, subject] = logLine.split('|');
      matched[digest] = { commit: fullHash, date, subject, shortCommit: fullHash.slice(0, 7) };
      console.log(`Matched ${digest} -> ${fullHash.slice(0, 7)}: ${subject}`);
    }
  } catch (err) {
    // Ignore commits without game dir or broken history
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });

let output = '=== ERROR SITES AND COMMIT MAPPINGS ===\n\n';

for (const hash of targetHashes) {
  output += `--------------------------------------------------\n`;
  output += `Build Hash: ${hash}\n`;
  if (!matched[hash]) {
    output += `Commit: NO COMMIT MATCHES\n`;
    console.log(`Hash ${hash}: NO COMMIT MATCHES`);
  } else {
    const m = matched[hash];
    output += `Commit: ${m.commit} (${m.shortCommit})\n`;
    output += `Date:   ${m.date}\n`;
    output += `Subject:${m.subject}\n\n`;

    // Export tree with git archive and build it into scripts/out/old_tree_<hash>
    const treeDir = path.join(outDir, `old_tree_${hash}`);
    if (fs.existsSync(treeDir)) {
      fs.rmSync(treeDir, { recursive: true, force: true });
    }
    fs.mkdirSync(treeDir, { recursive: true });

    const archiveTar = path.join(outDir, `temp_${hash}.tar`);
    execSync(`git archive ${m.commit} --output="${archiveTar}"`, { cwd: rootDir });
    execSync(`tar -xf "${archiveTar}" -C "${treeDir}"`, { cwd: rootDir });
    fs.rmSync(archiveTar, { force: true });

    // Build it into scripts/out/old_tree_<hash> (dist folder inside treeDir)
    try {
      execSync(`node scripts/build.js`, { cwd: treeDir });
      output += `Build in ${path.relative(rootDir, treeDir)}: SUCCESS\n`;
    } catch (e) {
      output += `Build in ${path.relative(rootDir, treeDir)}: SKIPPED/FAILED (${e.message})\n`;
    }

    // Print the exact source line plus 2 lines either side at every recorded file:line:col
    const sites = recordedSites[hash] || [];
    output += `Recorded Error Sites:\n`;
    for (const site of sites) {
      // Look in treeDir/game/app.js or treeDir/dist/app.js
      let filePath = path.join(treeDir, 'game', site.file);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(treeDir, 'dist', site.file);
      }
      if (!fs.existsSync(filePath)) {
        output += `  Site ${site.file}:${site.line}:${site.col} -> FILE MISSING\n`;
        continue;
      }

      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      output += `\n  Site ${site.file}:${site.line}:${site.col}\n`;
      const startLine = Math.max(1, site.line - 2);
      const endLine = Math.min(lines.length, site.line + 2);

      for (let l = startLine; l <= endLine; l++) {
        const lineContent = lines[l - 1] || '';
        output += `  ${l.toString().padStart(5, ' ')} | ${lineContent}\n`;
        if (l === site.line) {
          const caretIndent = ' '.repeat(8 + Math.max(0, site.col - 1));
          output += `  ${caretIndent}^\n`;
        }
      }
    }
  }
  output += `\n`;
}

const errorSitesFile = path.join(outDir, 'error_sites.txt');
fs.writeFileSync(errorSitesFile, output, 'utf-8');
console.log(`Wrote error sites report to ${errorSitesFile}`);
console.log(output);
