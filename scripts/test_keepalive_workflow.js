// scripts/test_keepalive_workflow.js
// Hermetic verification of .github/workflows/keepalive.yml

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const workflowFile = path.join(rootDir, '.github', 'workflows', 'keepalive.yml');

function validateWorkflowContent(content, label = 'keepalive.yml') {
  // 1. Cron schedule present
  assert.match(
    content,
    /cron:\s*["']17 4 \* \* \*["']/,
    `${label} must define daily cron schedule "17 4 * * *"`
  );

  // 2. workflow_dispatch present
  assert.match(
    content,
    /workflow_dispatch:/,
    `${label} must include workflow_dispatch trigger`
  );

  // 3. permissions contents: read
  assert.match(
    content,
    /permissions:\s*\n\s*contents:\s*read/,
    `${label} must define minimal permission "contents: read"`
  );

  // 4. Secrets referenced by the two exact names via env
  assert.match(
    content,
    /SUPABASE_URL:\s*\${{\s*secrets\.SUPABASE_URL\s*}}/,
    `${label} must reference secrets.SUPABASE_URL`
  );
  assert.match(
    content,
    /SUPABASE_ANON_KEY:\s*\${{\s*secrets\.SUPABASE_ANON_KEY\s*}}/,
    `${label} must reference secrets.SUPABASE_ANON_KEY`
  );

  // 5. No literal Supabase URL
  assert.doesNotMatch(
    content,
    /https?:\/\/[a-z0-9-]+\.supabase\.co/i,
    `${label} must NOT contain any literal Supabase URL`
  );

  // 6. No literal JWT / "eyJ" key-looking string
  assert.doesNotMatch(
    content,
    /eyJ[a-zA-Z0-9_-]{20,}/,
    `${label} must NOT contain any literal JWT / key-looking string`
  );

  // 7. No echo of secrets
  assert.doesNotMatch(
    content,
    /echo.*(?:secrets|SUPABASE)/i,
    `${label} must NOT echo secrets`
  );

  // 8. No set -x
  assert.doesNotMatch(
    content,
    /set\s+-x/,
    `${label} must NOT use set -x (which prints commands and values)`
  );

  // 9. curl with --fail-with-body present
  assert.match(
    content,
    /curl[^\n]*--fail-with-body/,
    `${label} must use curl with --fail-with-body to exit non-zero on HTTP errors`
  );

  // 10. curl max-time 30 present
  assert.match(
    content,
    /--max-time\s+30/,
    `${label} must use --max-time 30`
  );

  // 11. RPC endpoint daily_best
  assert.match(
    content,
    /\/rest\/v1\/rpc\/daily_best/,
    `${label} must target the daily_best RPC endpoint`
  );

  // 12. Timeout minutes
  assert.match(
    content,
    /timeout-minutes:\s*5/,
    `${label} must set timeout-minutes: 5`
  );
}

function runSelfCheck(validContent) {
  console.log('\n--- Running Keepalive Workflow Self-Check ---');
  const fakeKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.fake_signature_for_self_check';
  const tamperedContent = validContent + `\n# Exposed secret: ${fakeKey}\n`;

  let caught = false;
  try {
    validateWorkflowContent(tamperedContent, 'tampered-keepalive.yml');
  } catch (err) {
    caught = true;
    console.log(`✔ [SELF-CHECK PASSED: expected failure occurred: ${err.message}]`);
  }

  assert.strictEqual(caught, true, 'Self-check must catch literal key insertion');
}

function main() {
  console.log('================================================================================');
  console.log('KEEPALIVE WORKFLOW VERIFICATION (scripts/test_keepalive_workflow.js)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  assert.strictEqual(fs.existsSync(workflowFile), true, `Workflow file must exist at ${workflowFile}`);
  const content = fs.readFileSync(workflowFile, 'utf8');

  validateWorkflowContent(content, '.github/workflows/keepalive.yml');
  console.log('✔ All keepalive workflow assertions passed cleanly.');

  runSelfCheck(content);

  console.log('\n================================================================================');
  console.log('ALL KEEPALIVE WORKFLOW CHECKS & SELF-CHECKS PASSED');
  console.log('================================================================================\n');
}

main();
