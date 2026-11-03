// scripts/run_live_suite.js
// Sequential live test runner for 'npm run test:live'
// Runs the five live scripts sequentially with RAW output and records exit codes

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const scripts = [
  'scripts/test_live.js',
  'scripts/test_live_names.js',
  'scripts/test_live_hardening_fixes.js',
  'scripts/test_live_g2_g6.js',
  'scripts/test_live_p1_p3.js',
];

console.log('================================================================================');
console.log('STARTING SEQUENTIAL LIVE TEST RUNNER (npm run test:live)');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

const results = [];
let anyFailed = false;

try {
  for (const scriptRel of scripts) {
    const scriptPath = path.join(rootDir, scriptRel);
    console.log(`\n>>> RUNNING: ${scriptRel} >>>`);

    const proc = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: rootDir,
      env: process.env,
    });

    const exitCode = proc.status ?? 1;
    results.push({ script: scriptRel, exitCode });

    console.log(`<<< FINISHED: ${scriptRel} (Exit Code: ${exitCode}) <<<\n`);
    if (exitCode !== 0) {
      anyFailed = true;
      break; // stop on failure so user sees failure plainly
    }
  }
} finally {
  try {
    const fs = await import('node:fs');
    const envFile = path.join(rootDir, '.env.test');
    if (fs.existsSync(envFile)) {
      const { createClient } = await import('@supabase/supabase-js');
      const envText = fs.readFileSync(envFile, 'utf8');
      const url = envText.match(/SUPABASE_URL\s*=\s*(.+)/)?.[1]?.trim();
      const key = envText.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)/)?.[1]?.trim();
      if (url && key) {
        const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        await sb.from('daily_runs').delete().like('device_id', 'test_%');
        await sb.from('daily_runs').delete().like('device_id', 'g5_%');
        await sb.from('devices').delete().like('device_id', 'test_%');
        await sb.from('devices').delete().like('device_id', 'g5_%');
        await sb.from('abuse_rate_limits').delete().neq('key', '');
      }
    }
  } catch (e) {
    // Ignore cleanup warning
  }
}

console.log('\n================================================================================');
console.log('LIVE TEST SUITE SUMMARY (EXIT CODES)');
console.log('================================================================================');
for (const r of results) {
  console.log(`  ${r.script.padEnd(40)} : Exit Code ${r.exitCode}`);
}
console.log('================================================================================');

if (anyFailed) {
  console.error('\n✖ One or more live scripts exited with non-zero status.');
  process.exit(1);
} else {
  console.log('\n✔ All live scripts completed with exit code 0.');
  process.exit(0);
}

