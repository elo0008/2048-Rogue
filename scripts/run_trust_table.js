/**
 * scripts/run_trust_table.js
 *
 * Runs the trust tamper test cases from verify/tests/trust_cases.js
 * and writes the raw verdict table to scripts/out/trust.txt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyRun } from '../verify/verify_run.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { generateTrustCases, TRUST_DAY_UTC } from '../verify/tests/trust_cases.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');
const outFile = path.join(outDir, 'trust.txt');

async function main() {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const rulesVer = computeRulesVersion(rootDir);
  const replayVer = computeReplayVersion(rootDir);
  const cases = generateTrustCases(rootDir);

  const lines = [];
  lines.push('=== TRUST TAMPER VERDICTS (Daily Mode: ' + TRUST_DAY_UTC + ') ===');
  lines.push('Rules Version : ' + rulesVer);
  lines.push('Replay Version: ' + replayVer);
  lines.push('');

  const colCase = 36;
  const colLegal = 12;
  const colStatus = 10;
  const colKey = 20;

  lines.push(
    'Case'.padEnd(colCase) + ' | ' +
    'Legal(any)'.padEnd(colLegal) + ' | ' +
    'Status'.padEnd(colStatus) + ' | ' +
    'Key'.padEnd(colKey) + ' | ' +
    'Reason'
  );
  lines.push('-'.repeat(colCase + colLegal + colStatus + colKey + 50));

  for (const c of cases) {
    const anyRes = verifyRun(c.run, {
      expectedRulesVersion: rulesVer,
      expectedReplayVersion: replayVer,
      mode: 'any',
    });

    const dailyRes = verifyRun(c.run, {
      expectedRulesVersion: rulesVer,
      expectedReplayVersion: replayVer,
      mode: 'daily',
      dayUTC: TRUST_DAY_UTC,
    });

    const keyStr = c.expectedKey || '-';
    const reasonStr = dailyRes.reason || '(none)';

    lines.push(
      c.name.padEnd(colCase) + ' | ' +
      String(anyRes.ok).padEnd(colLegal) + ' | ' +
      dailyRes.status.padEnd(colStatus) + ' | ' +
      keyStr.padEnd(colKey) + ' | ' +
      reasonStr
    );
  }

  const outputText = lines.join('\n') + '\n';
  fs.writeFileSync(outFile, outputText, 'utf-8');
  console.log(outputText);
  console.log(`Saved trust verdicts to ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
