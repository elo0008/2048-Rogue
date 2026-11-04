// scripts/check_deployed.js
// Fetches deployed version from LEADERBOARD_URL and verifies parity with local code

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function getLeaderboardUrl() {
  // 1. Command-line override
  const mockArgIdx = process.argv.indexOf('--url');
  if (mockArgIdx !== -1 && process.argv[mockArgIdx + 1]) {
    return process.argv[mockArgIdx + 1];
  }

  // 2. Process environment
  if (process.env.LEADERBOARD_URL) {
    return process.env.LEADERBOARD_URL;
  }

  // 3. .env.test or .env file fallback
  for (const f of ['.env.test', '.env']) {
    const p = path.join(rootDir, f);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      const m = text.match(/(?:LEADERBOARD_URL|SUPABASE_URL)\s*=\s*(.+)/);
      if (m && m[1].trim()) {
        return m[1].trim();
      }
    }
  }

  return null;
}

async function main() {
  const lbUrl = getLeaderboardUrl();
  if (!lbUrl) {
    console.error('Error: LEADERBOARD_URL is not set in environment or .env file');
    process.exit(1);
  }

  const endpoint = lbUrl.endsWith('/')
    ? `${lbUrl}functions/v1/submit-run`
    : `${lbUrl}/functions/v1/submit-run`;

  console.log('================================================================================');
  console.log('DEPLOYED VERSION PARITY CHECK (npm run check:deployed)');
  console.log(`Target Endpoint: ${endpoint.replace(/https:\/\/[^.]+\./, 'https://csdb...').replace(/localhost:\d+/, 'localhost:[PORT]')}`);
  console.log(`Timestamp:       ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  let deployedData;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.error(`HTTP Error: Endpoint returned status ${res.status}`);
      process.exit(1);
    }
    deployedData = await res.json();
  } catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }

  const localRules = computeRulesVersion(rootDir);
  const localReplay = computeReplayVersion(rootDir);

  console.log('Version Comparison:');
  console.log('--------------------------------------------------------------------------------');
  console.log(`rulesVersion:`);
  console.log(`  Deployed: ${deployedData.rulesVersion || '(missing)'}`);
  console.log(`  Local:    ${localRules}`);
  const rulesMatch = deployedData.rulesVersion === localRules;
  console.log(`  Match:    ${rulesMatch ? '✔ PASS' : '✖ MISMATCH'}`);

  console.log(`\nreplayVersion:`);
  console.log(`  Deployed: ${deployedData.replayVersion || '(missing)'}`);
  console.log(`  Local:    ${localReplay}`);
  const replayMatch = deployedData.replayVersion === localReplay;
  console.log(`  Match:    ${replayMatch ? '✔ PASS' : '✖ MISMATCH'}`);
  console.log('--------------------------------------------------------------------------------\n');

  if (!rulesMatch || !replayMatch) {
    console.error('✖ DEPLOYED VERSION CHECK FAILED: Deployed versions do not match local repository.');
    process.exit(1);
  }

  console.log('✔ DEPLOYED VERSION CHECK PASSED: Deployed edge function is 100% in parity with local repo.');
  process.exitCode = 0;
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
