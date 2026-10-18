#!/usr/bin/env node

/**
 * verify/cli.js
 *
 * Command-line interface for Rogue 2048 run verification.
 * Computes rulesVersion SHA-256 hash of sim/engine.js and verifies run logs.
 *
 * Usage:
 *   node verify/cli.js <path-to-run-log.json>
 *   node verify/cli.js --corpus <directory> [--out <output-file>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRun } from './verify_run.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function computeEngineHash() {
  const enginePath = path.join(rootDir, 'sim', 'engine.js');
  const content = fs.readFileSync(enginePath);
  return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
}

export function formatRunRow(result, filename = '') {
  const seed = String(result.seed ?? '-').padStart(10);
  const events = String(result.eventsCount ?? 0).padStart(7);
  const moves = String(result.moves ?? 0).padStart(6);
  const claimedPts = String(result.claimedPoints ?? 0).padStart(14);
  const replayedPts = String(result.replayedPoints ?? 0).padStart(15);
  const status = String(result.status).padEnd(20);
  const ms = String(result.ms.toFixed(2)).padStart(8);
  return `${seed} | ${events} | ${moves} | ${claimedPts} | ${replayedPts} | ${status} | ${ms}`;
}

export function verifyFile(filePath, expectedHash) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `JSON parse error: ${err.message}`,
      ms: 0,
      filePath,
      seed: 0,
      eventsCount: 0,
      moves: 0,
      claimedPoints: 0,
      replayedPoints: 0,
    };
  }

  // Handle runLog nested inside { currentRun } or directly
  const runLog = data.currentRun || data;
  const res = verifyRun(runLog, expectedHash);

  return {
    ...res,
    filePath,
    filename: path.basename(filePath),
    seed: runLog.seed,
    eventsCount: Array.isArray(runLog.events) ? runLog.events.length : 0,
    moves: res.replay?.moves ?? (runLog.moveNumberAtDeath ?? runLog.totalMoves ?? 0),
    claimedPoints: res.claimed?.points ?? (runLog.points ?? runLog.score ?? 0),
    replayedPoints: res.replay?.points ?? 0,
  };
}

export async function runCli() {
  const args = process.argv.slice(2);
  const expectedHash = computeEngineHash();

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage:');
    console.log('  node verify/cli.js <path-to-run-log.json>');
    console.log('  node verify/cli.js --corpus <dir> [--out <output-file>]');
    process.exit(args.length === 0 ? 1 : 0);
  }

  const corpusIdx = args.indexOf('--corpus');
  const outIdx = args.indexOf('--out');

  if (corpusIdx !== -1) {
    const corpusDir = path.resolve(process.cwd(), args[corpusIdx + 1]);
    const outFile = outIdx !== -1
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.join(rootDir, 'scripts', 'out', 'verify_corpus.txt');

    if (!fs.existsSync(corpusDir)) {
      console.error(`Corpus directory not found: ${corpusDir}`);
      process.exit(1);
    }

    const files = fs.readdirSync(corpusDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => path.join(corpusDir, f));

    if (files.length === 0) {
      console.error(`No .json run logs found in: ${corpusDir}`);
      process.exit(1);
    }

    const header = [
      `=== 2048-ROGUE RUN VERIFICATION CORPUS ===`,
      `Rules Engine SHA-256 : ${expectedHash}`,
      `Total Runs Evaluated : ${files.length}`,
      ``,
      `${'Seed'.padStart(10)} | ${'Events'.padStart(7)} | ${'Moves'.padStart(6)} | ${'Claimed Points'.padStart(14)} | ${'Replayed Points'.padStart(15)} | ${'Status'.padEnd(20)} | ${'Time (ms)'.padStart(8)}`,
      `${'-'.repeat(10)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(14)}-+-${'-'.repeat(15)}-+-${'-'.repeat(20)}-+-${'-'.repeat(8)}`,
    ];

    const rows = [];
    let totalEvents = 0;
    let totalMs = 0;
    let slowest = { filename: '', ms: -1, events: 0 };
    let failCount = 0;

    for (const file of files) {
      const res = verifyFile(file, expectedHash);
      totalEvents += res.eventsCount;
      totalMs += res.ms;
      if (res.ms > slowest.ms) {
        slowest = { filename: res.filename, ms: res.ms, events: res.eventsCount };
      }
      if (!res.ok) {
        failCount++;
      }
      rows.push(formatRunRow(res, res.filename));
    }

    const summary = [
      `${'-'.repeat(10)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(14)}-+-${'-'.repeat(15)}-+-${'-'.repeat(20)}-+-${'-'.repeat(8)}`,
      `Total Events Replayed : ${totalEvents}`,
      `Total Verification Ms : ${totalMs.toFixed(2)} ms`,
      `Slowest Run           : ${slowest.filename} (${slowest.events} events in ${slowest.ms.toFixed(2)} ms)`,
      `Pass Rate             : ${files.length - failCount}/${files.length} (${failCount === 0 ? 'ALL PASSED' : failCount + ' FAILED'})`,
    ];

    const fullOutput = [...header, ...rows, ...summary].join('\n') + '\n';

    const outDir = path.dirname(outFile);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outFile, fullOutput, 'utf-8');

    console.log(fullOutput);

    if (failCount > 0) {
      process.exit(1);
    }
    return;
  }

  // Single file mode
  const targetFile = path.resolve(process.cwd(), args[0]);
  if (!fs.existsSync(targetFile)) {
    console.error(`File not found: ${targetFile}`);
    process.exit(1);
  }

  const result = verifyFile(targetFile, expectedHash);
  console.log(`\nVerification Result: [${result.status}]`);
  console.log(`File              : ${targetFile}`);
  console.log(`Rules SHA-256     : ${expectedHash}`);
  console.log(`Seed              : ${result.seed}`);
  console.log(`Events Count      : ${result.eventsCount}`);
  console.log(`Moves             : ${result.moves}`);
  console.log(`Claimed Points    : ${result.claimedPoints}`);
  console.log(`Replayed Points   : ${result.replayedPoints}`);
  console.log(`Duration          : ${result.ms.toFixed(2)} ms`);
  if (result.reason) {
    console.log(`Reason            : ${result.reason}`);
  }

  if (!result.ok) {
    process.exit(1);
  }
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMain) {
  runCli();
}
