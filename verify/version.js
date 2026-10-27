/**
 * verify/version.js
 *
 * Computes rulesVersion and replayVersion across the core game files.
 *
 * Replay version definition:
 * SHA-256 over the LF-normalized bytes of sim/engine.js, sim/relics.js,
 * game/controller.js, and every other file they import (derived via import
 * statement parsing), concatenated in sorted relative path order.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENTRY_FILES = [
  'game/controller.js',
  'sim/engine.js',
  'sim/relics.js',
];

/**
 * Extracts relative import specifiers from a Javascript source string.
 */
export function parseRelativeImports(code, fromFilePath) {
  const importRegex = /import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
  const results = [];
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const spec = match[1];
    if (spec.startsWith('.')) {
      const resolved = path.normalize(path.join(path.dirname(fromFilePath), spec)).replace(/\\/g, '/');
      results.push(resolved);
    }
  }
  return results;
}

/**
 * Derives the complete sorted list of files by recursively parsing import statements.
 */
export function deriveReplayFileList(rootDir = process.cwd()) {
  const visited = new Set();
  const queue = [...ENTRY_FILES];

  while (queue.length > 0) {
    const relFile = queue.shift();
    if (!visited.has(relFile)) {
      visited.add(relFile);
      const absPath = path.join(rootDir, relFile);
      if (fs.existsSync(absPath)) {
        const code = fs.readFileSync(absPath, 'utf-8');
        const imports = parseRelativeImports(code, relFile);
        for (const imp of imports) {
          if (!visited.has(imp)) {
            queue.push(imp);
          }
        }
      }
    }
  }

  return Array.from(visited).sort();
}

/**
 * Computes replayVersion = SHA256 over LF-normalized bytes of the derived file list,
 * concatenated in sorted path order.
 *
 * @param {string} rootDir - Root directory of the repository
 * @returns {string} Uppercase 64-character SHA256 hex string
 */
export function computeReplayVersion(rootDir = process.cwd()) {
  const fileList = deriveReplayFileList(rootDir);
  const hash = crypto.createHash('sha256');

  for (const relFile of fileList) {
    const absPath = path.join(rootDir, relFile);
    const content = fs.readFileSync(absPath, 'utf-8');
    // LF-normalization: replace \r\n with \n
    const lfNormalized = content.replace(/\r\n/g, '\n');
    hash.update(Buffer.from(lfNormalized, 'utf-8'));
  }

  return hash.digest('hex').toUpperCase();
}

/**
 * Computes rulesVersion = SHA256 of sim/engine.js
 */
export function computeRulesVersion(rootDir = process.cwd()) {
  const enginePath = path.join(rootDir, 'sim', 'engine.js');
  const content = fs.readFileSync(enginePath);
  return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}
