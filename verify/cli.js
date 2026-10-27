#!/usr/bin/env node

/**
 * verify/cli.js
 *
 * Command-line interface for Rogue 2048 run verification.
 * Computes rulesVersion and replayVersion and verifies run logs.
 *
 * Usage:
 *   node verify/cli.js <path-to-run-log.json> [--mode daily|challenge|any] [--day YYYY-MM-DD]
 *   node verify/cli.js --corpus <directory> [--out <output-file>] [--mode daily|challenge|any] [--day YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from './verify_run.js';
import { computeRulesVersion, computeReplayVersion } from './version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function computeEngineHash() {
  return computeRulesVersion(rootDir);
}

export function formatRunRow(result, filename = '') {
  const seed = String(result.seed ?? '-').padStart(10);
  const events = String(result.eventsCount ?? 0).padStart(7);
  const moves = String(result.moves ?? 0).padStart(6);
  const claimedPts = String(result.claimedPoints ?? 0).padStart(14);
  const replayedPts = String(result.replayedPoints ?? 0).padStart(15);
  const status = String(result.status).padEnd(20);
  const ms = String(typeof result.ms === 'number' ? result.ms.toFixed(2) : '-').padStart(8);
  return `${seed} | ${events} | ${moves} | ${claimedPts} | ${replayedPts} | ${status} | ${ms}`;
}

export function verifySingleLog(runLog, options = {}) {
  const rulesVer = options.expectedRulesVersion || computeRulesVersion(rootDir);
  const replayVer = options.expectedReplayVersion || computeReplayVersion(rootDir);
  const mode = options.mode || 'daily';

  let dayUTC = options.dayUTC || null;
  if (!dayUTC && typeof runLog.startTimestamp === 'number') {
    dayUTC = new Date(runLog.startTimestamp).toISOString().slice(0, 10);
  }

  const res = verifyRun(runLog, {
    expectedRulesVersion: rulesVer,
    expectedReplayVersion: replayVer,
    mode,
    dayUTC,
  });

  return {
    ...res,
    seed: runLog.seed,
    dayUTC,
    mode,
    eventsCount: Array.isArray(runLog.events) ? runLog.events.length : 0,
    moves: res.replay?.moves ?? (runLog.moveNumberAtDeath ?? runLog.totalMoves ?? 0),
    claimedPoints: res.claimed?.points ?? (runLog.points ?? runLog.score ?? 0),
    replayedPoints: res.replay?.points ?? 0,
  };
}

export async function runCli() {
  const args = process.argv.slice(2);
  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage:');
    console.log('  node verify/cli.js <path-to-run-log.json> [--mode daily|challenge|any] [--day YYYY-MM-DD]');
    console.log('  node verify/cli.js --corpus <dir> [--out <output-file>] [--mode daily|challenge|any] [--day YYYY-MM-DD]');
    process.exit(args.length === 0 ? 1 : 0);
  }

  // Parse flags
  let mode = 'daily';
  let dayUTC = null;
  let corpusDir = null;
  let outFile = null;
  let targetFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && i + 1 < args.length) {
      mode = args[++i];
    } else if (args[i] === '--day' && i + 1 < args.length) {
      dayUTC = args[++i];
    } else if (args[i] === '--corpus' && i + 1 < args.length) {
      corpusDir = path.resolve(process.cwd(), args[++i]);
    } else if (args[i] === '--out' && i + 1 < args.length) {
      outFile = path.resolve(process.cwd(), args[++i]);
    } else if (!args[i].startsWith('--') && !targetFile) {
      targetFile = path.resolve(process.cwd(), args[i]);
    }
  }

  // 1. Corpus mode
  if (corpusDir) {
    if (!outFile) {
      outFile = path.join(rootDir, 'scripts', 'out', 'verify_corpus.txt');
    }
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
      `Rules Engine SHA-256   : ${rulesVersion}`,
      `Replay Version SHA-256 : ${replayVersion}`,
      `Mode                   : ${mode}`,
      `Total Runs Evaluated   : ${files.length}`,
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
      const raw = fs.readFileSync(file, 'utf-8');
      const data = JSON.parse(raw);
      const runLog = data.currentRun || data;
      const res = verifySingleLog(runLog, {
        expectedRulesVersion: rulesVersion,
        expectedReplayVersion: replayVersion,
        mode,
        dayUTC,
      });

      totalEvents += res.eventsCount;
      totalMs += res.ms;
      if (res.ms > slowest.ms) {
        slowest = { filename: path.basename(file), ms: res.ms, events: res.eventsCount };
      }
      if (!res.ok) {
        failCount++;
      }
      rows.push(formatRunRow(res, path.basename(file)));
    }

    const summary = [
      `${'-'.repeat(10)}-+-${'-'.repeat(7)}-+-${'-'.repeat(6)}-+-${'-'.repeat(14)}-+-${'-'.repeat(15)}-+-${'-'.repeat(20)}-+-${'-'.repeat(8)}`,
      `Total Events Replayed : ${totalEvents}`,
      `Total Verification Ms : ${totalMs.toFixed(2)} ms`,
      `Slowest Run           : ${slowest.filename} (${slowest.events} events in ${slowest.ms.toFixed(2)} ms)`,
      `Pass Rate             : ${files.length - failCount}/${files.length} (${failCount === 0 ? 'ALL PASSED' : failCount + ' FAILED'})`,
    ];

    const fullOutput = [...header, ...rows, ...summary].join('\n') + '\n';

    const outDirPath = path.dirname(outFile);
    if (!fs.existsSync(outDirPath)) {
      fs.mkdirSync(outDirPath, { recursive: true });
    }
    fs.writeFileSync(outFile, fullOutput, 'utf-8');

    console.log(fullOutput);

    if (failCount > 0) {
      process.exit(1);
    }
    return;
  }

  // 2. Single file mode (Bare log or Copy Run Log wrapper)
  if (!targetFile || !fs.existsSync(targetFile)) {
    console.error(`File not found: ${targetFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(targetFile, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`JSON parse error: ${err.message}`);
    process.exit(1);
  }

  const isWrapper = Boolean(data && typeof data === 'object' && ('currentRun' in data));

  console.log(`=== 2048-ROGUE RUN VERIFICATION ===`);
  console.log(`File              : ${targetFile}`);
  console.log(`Rules SHA-256     : ${rulesVersion}`);
  console.log(`Replay SHA-256    : ${replayVersion}`);
  console.log(`Mode Selected     : ${mode}`);
  console.log(`Payload Type      : ${isWrapper ? 'Copy Run Log Wrapper ({ currentRun, history })' : 'Bare Run Log'}`);
  console.log('');

  const entriesToVerify = [];
  if (isWrapper) {
    if (data.currentRun) {
      entriesToVerify.push({ label: 'currentRun', log: data.currentRun });
    }
    if (Array.isArray(data.history)) {
      data.history.forEach((h, idx) => {
        entriesToVerify.push({ label: `history[${idx}]`, log: h });
      });
    }
  } else {
    entriesToVerify.push({ label: 'run', log: data });
  }

  let allOk = true;

  for (const entry of entriesToVerify) {
    const res = verifySingleLog(entry.log, {
      expectedRulesVersion: rulesVersion,
      expectedReplayVersion: replayVersion,
      mode,
      dayUTC,
    });

    const runDay = res.dayUTC || '(none)';
    console.log(`[${entry.label}] Verdict: ${res.status} | Mode: ${mode} | Day: ${runDay} | Seed: ${res.seed ?? '-'} | Moves: ${res.moves} | Points: ${res.replayedPoints} | Ms: ${res.ms.toFixed(2)}`);
    if (res.flags && res.flags.length > 0) {
      console.log(`   Flags: [${res.flags.join(', ')}]`);
    }
    if (res.reason) {
      console.log(`   Reason: ${res.reason}`);
    }

    if (!res.ok && res.status !== 'UNVERIFIABLE_LEGACY') {
      allOk = false;
    }
  }

  if (!allOk) {
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
