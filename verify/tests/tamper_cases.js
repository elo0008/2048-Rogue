/**
 * verify/tests/tamper_cases.js
 *
 * Source of truth for all 13 tamper test cases (Y5).
 * Imported by both verify/tests/tamper.test.js and scripts/run_tamper_table.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRulesVersion, computeReplayVersion } from '../version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const fixturesDir = path.join(rootDir, 'verify', 'fixtures');

export function getTamperCases() {
  const fixturePath = path.join(fixturesDir, 'fixture_rewind.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const expectedHash = computeRulesVersion(rootDir);
  const expectedReplayHash = computeReplayVersion(rootDir);

  // Ensure baseFixture has valid rulesVersion and replayVersion
  const baseFixture = {
    ...rawFixture,
    rulesVersion: expectedHash,
    replayVersion: expectedReplayHash,
  };

  const endRunFixturePath = path.join(fixturesDir, 'fixture_end_run.json');
  const rawEndRunFixture = fs.existsSync(endRunFixturePath)
    ? JSON.parse(fs.readFileSync(endRunFixturePath, 'utf-8'))
    : null;
  const endRunFixture = rawEndRunFixture ? {
    ...rawEndRunFixture,
    rulesVersion: expectedHash,
    replayVersion: expectedReplayHash,
  } : null;

  const ascensionFixturePath = path.join(fixturesDir, 'fixture_ascension.json');
  const rawAscensionFixture = fs.existsSync(ascensionFixturePath)
    ? JSON.parse(fs.readFileSync(ascensionFixturePath, 'utf-8'))
    : null;
  const ascensionFixture = rawAscensionFixture ? {
    ...rawAscensionFixture,
    rulesVersion: expectedHash,
    replayVersion: expectedReplayHash,
  } : null;

  const lastStandFixturePath = path.join(fixturesDir, 'fixture_last_stand.json');
  const rawLastStandFixture = fs.existsSync(lastStandFixturePath)
    ? JSON.parse(fs.readFileSync(lastStandFixturePath, 'utf-8'))
    : null;
  const lastStandFixture = rawLastStandFixture ? {
    ...rawLastStandFixture,
    rulesVersion: expectedHash,
    replayVersion: expectedReplayHash,
  } : null;

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
      expectedStatus: 'INCOMPLETE',
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
      id: '2b',
      name: 'delete one ability event with gameOver (REJECT)',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(lastStandFixture || baseFixture));
        const idx = log.events.findIndex(e => e === 'a:rewind:-');
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
    {
      id: 14,
      name: 'delete the x:end event (INCOMPLETE)',
      expectedStatus: 'INCOMPLETE',
      generate: () => {
        const log = JSON.parse(JSON.stringify(endRunFixture || baseFixture));
        const idx = log.events.findIndex(e => e === 'x:end');
        if (idx !== -1) log.events.splice(idx, 1);
        return log;
      },
    },
    {
      id: 15,
      name: 'append a swipe after x:end',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(endRunFixture || baseFixture));
        log.events.push('s:L');
        return log;
      },
    },
    {
      id: 16,
      name: 'claim an extra ascension',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(ascensionFixture || baseFixture));
        if (!log.ascensions) log.ascensions = [];
        log.ascensions.push({ move: 999, value: 128, payout: 256, destroyedTiles: 2, destroyedStones: 1 });
        return log;
      },
    },
    {
      id: 17,
      name: 'change a claimed payout by +1',
      expectedStatus: 'REJECT',
      generate: () => {
        const log = JSON.parse(JSON.stringify(ascensionFixture || baseFixture));
        if (log.ascensions && log.ascensions.length > 0) {
          log.ascensions[0].payout = (log.ascensions[0].payout || 0) + 1;
        }
        return log;
      },
    },
    {
      id: 18,
      name: 'otherwise-legal ascensionAt 64 run submitted in daily mode',
      expectedStatus: 'REJECT',
      expectedReasonSubstring: 'ascensionAt',
      mode: 'daily',
      generate: () => {
        const log = JSON.parse(JSON.stringify(ascensionFixture || baseFixture));
        return log;
      },
    },
  ];

  return { cases, expectedHash, expectedReplayHash, baseFixture };
}
