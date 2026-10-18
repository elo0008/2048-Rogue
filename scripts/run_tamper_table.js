/**
 * scripts/run_tamper_table.js
 *
 * Runs all 13 tamper test cases against a real fixture and outputs
 * the formatted verdict table to scripts/out/tamper.txt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../verify/verify_run.js';
import { computeEngineHash } from '../verify/cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const fixturesDir = path.join(rootDir, 'verify', 'fixtures');
const outFile = path.join(rootDir, 'scripts', 'out', 'tamper.txt');

export function getTamperCases() {
  const fixturePath = path.join(fixturesDir, 'fixture_rewind.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  const baseFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const expectedHash = computeEngineHash();

  const cases = [
    {
      id: 1,
      name: 'change one swipe direction',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        const idx = log.events.findIndex(e => e.startsWith('s:'));
        const curDir = log.events[idx].slice(2);
        const altDir = curDir === 'L' ? 'R' : (curDir === 'R' ? 'U' : 'L');
        log.events[idx] = `s:${altDir}`;
        return log;
      },
    },
    {
      id: 2,
      name: 'delete one ability event',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        const idx = log.events.findIndex(e => e.startsWith('a:'));
        if (idx !== -1) {
          log.events.splice(idx, 1);
        }
        return log;
      },
    },
    {
      id: 3,
      name: 'delete one draft event',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        const idx = log.events.findIndex(e => e.startsWith('d:'));
        if (idx !== -1) {
          log.events.splice(idx, 1);
        }
        return log;
      },
    },
    {
      id: 4,
      name: 'swap two adjacent events',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        const idx = log.events.findIndex((e, i) => i < log.events.length - 1 && e !== log.events[i + 1]);
        if (idx !== -1) {
          const temp = log.events[idx];
          log.events[idx] = log.events[idx + 1];
          log.events[idx + 1] = temp;
        }
        return log;
      },
    },
    {
      id: 5,
      name: 'change claimed points by +1',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.points = (log.points || 0) + 1;
        return log;
      },
    },
    {
      id: 6,
      name: 'change the seed',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.seed = log.seed + 1;
        return log;
      },
    },
    {
      id: 7,
      name: 'change maxTile',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.maxTile = (log.maxTile || 128) * 2;
        return log;
      },
    },
    {
      id: 8,
      name: 'append a swipe after gameOver',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.events.push('s:L');
        return log;
      },
    },
    {
      id: 9,
      name: 'truncate the last 10 events (INCOMPLETE)',
      expectedStatus: 'INCOMPLETE',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.events = log.events.slice(0, Math.max(1, log.events.length - 10));
        return log;
      },
    },
    {
      id: 10,
      name: 'illegal ability target',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        // Inject an ability with an illegal target (e.g. diagonal between cell 0 and 15)
        log.events.splice(2, 0, 'a:diagonal_charge:{"from":0,"to":15}');
        return log;
      },
    },
    {
      id: 11,
      name: 'wrong rulesVersion',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.rulesVersion = '0000000000000000000000000000000000000000000000000000000000000000';
        return log;
      },
    },
    {
      id: 12,
      name: 'events array of 20001 entries',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        log.events = new Array(20001).fill('s:L');
        return log;
      },
    },
    {
      id: 13,
      name: 'legacy log without events',
      expectedStatus: 'UNVERIFIABLE_LEGACY',
      generate: () => {
        const log = JSON.parse(JSON.stringify(baseFixture));
        delete log.events;
        return log;
      },
    },
  ];

  return { cases, expectedHash, baseFixture };
}

export function runTamperSuite() {
  const { cases, expectedHash } = getTamperCases();
  const results = [];

  for (const tc of cases) {
    const tamperedLog = tc.generate();
    const res = verifyRun(tamperedLog, expectedHash);
    results.push({
      id: tc.id,
      name: tc.name,
      expectedStatus: tc.expectedStatus,
      status: res.status,
      pass: res.status === tc.expectedStatus && res.ok === false,
      reason: res.reason,
    });
  }

  const header = [
    `=== 2048-ROGUE TAMPER VERIFICATION SUITE ===`,
    `Rules Engine SHA-256 : ${expectedHash}`,
    `Total Cases Tested   : ${results.length}`,
    ``,
    `${'#'.padStart(2)} | ${'Tamper Case'.padEnd(42)} | ${'Status'.padEnd(20)} | ${'Expected'.padEnd(20)} | Reason`,
    `${'-'.repeat(2)}-+-${'-'.repeat(42)}-+-${'-'.repeat(20)}-+-${'-'.repeat(20)}-+-${'-'.repeat(40)}`,
  ];

  const rows = results.map(r => {
    const num = String(r.id).padStart(2);
    const name = r.name.padEnd(42);
    const status = String(r.status).padEnd(20);
    const expected = String(r.expectedStatus).padEnd(20);
    const reason = r.reason || 'None';
    return `${num} | ${name} | ${status} | ${expected} | ${reason}`;
  });

  const allPassed = results.every(r => r.pass);
  const footer = [
    `${'-'.repeat(2)}-+-${'-'.repeat(42)}-+-${'-'.repeat(20)}-+-${'-'.repeat(20)}-+-${'-'.repeat(40)}`,
    `Verdict: ${allPassed ? 'ALL 13 TAMPER CASES CAUGHT & VERIFIED' : 'FAILURES DETECTED'}`,
  ];

  const output = [...header, ...rows, ...footer].join('\n') + '\n';

  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(outFile, output, 'utf-8');

  return { results, output, allPassed };
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMain) {
  const { output, allPassed } = runTamperSuite();
  console.log(output);
  if (!allPassed) {
    process.exit(1);
  }
}
