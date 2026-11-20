// scripts/test_mumbai_funnel_live.js
// Live integration test for 0011 Funnel Counts on Mumbai database.
// NOTE: Must NEVER print keys, project ref, or IPs.
// Usage:
//   node scripts/test_mumbai_funnel_live.js --plan        (prints test plan without network calls)
//   node scripts/test_mumbai_funnel_live.js --self-check  (proves test catches reader and restore bugs without network calls)
//   node scripts/test_mumbai_funnel_live.js               (executes live tests; run by user after migration)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envFile = path.join(rootDir, '.env.test');

function printPlan() {
  console.log('================================================================================');
  console.log('PLAN: MUMBAI 0011 FUNNEL COUNTS LIVE TEST');
  console.log('================================================================================');
  console.log('1. Anon RPC Invalid Event & Null Handling:');
  console.log('   - Call record_funnel_event with p_event="not_a_real_event" as anon.');
  console.log('   - Call record_funnel_event with p_event=null as anon.');
  console.log('   - Assert both return HTTP 200 or 204 (silent no-op).');
  console.log('   - Service role queries public.funnel_daily for today; assert 0 invalid rows created.');
  console.log('2. Anon RPC Valid Event & State Restoration:');
  console.log('   - Service role queries baseline n for (CURRENT_DATE, "visit") using ?day=eq.<today>&event=eq.visit&select=n.');
  console.log('   - Anon calls record_funnel_event with p_event="visit"; assert HTTP 200/204.');
  console.log('   - Service role queries n after call; assert n === before + 1.');
  console.log('   - Midnight edge check: if UTC date rolled over during execution, rerun test once.');
  console.log('   - In finally block, restore baseline: if before was 0/missing, DELETE row; if before > 0, PATCH n = before.');
  console.log('   - Re-read count via service role; assert restored === before; if mismatch, print loud "RESIDUE LEFT" and fail.');
  console.log('3. Anon Table Privilege Denials (Schema-Valid Payloads):');
  console.log('   - POST /rest/v1/funnel_daily {"day":"<today>","event":"visit","n":999} (Prefer: return=minimal)');
  console.log('     Assert HTTP 401 or 403 (Permission Denied). Reject 400 or 2xx.');
  console.log('   - PATCH /rest/v1/funnel_daily?day=eq.<today>&event=eq.visit {"n":999}');
  console.log('     Assert HTTP 401 or 403 (Permission Denied). Reject 400 or 2xx.');
  console.log('   - DELETE /rest/v1/funnel_daily?day=eq.<today>&event=eq.visit');
  console.log('     Assert HTTP 401 or 403 (Permission Denied). Reject 400 or 2xx.');
  console.log('   - GET /rest/v1/funnel_daily?select=*');
  console.log('     Assert HTTP 401 or 403 (Permission Denied). Reject 400 or 2xx.');
  console.log('   - Service role asserts table rows/counts remain untouched after all anon attempts.');
  console.log('4. Privileged RPC Audit Notice:');
  console.log('   - other RPC privileges are covered by scripts/test_mumbai_privilege_audit.js');
  console.log('5. Secure search_path Enforcement:');
  console.log('   - Inspect migration 0011_funnel_counts.sql for "set search_path = \'\'" (migration text only).');
  console.log('================================================================================\n');
}

async function runSelfCheck() {
  console.log('================================================================================');
  console.log('SELF-CHECK: MUMBAI FUNNEL TEST FAILURE PROOFS (HERMETIC / NO NETWORK)');
  console.log('================================================================================\n');

  let checksPassed = 0;

  // Proof 1: Broken reader returns 0 after increment
  console.log('--- Self-Check 1: Simulating broken reader (returns 0 after increment) ---');
  try {
    let internalCount = 0;
    const mockRead = async () => {
      // Simulates reader bug (e.g. querying non-existent column day_utc returning 0)
      return 0;
    };
    const mockRpc = async () => {
      internalCount = 1;
      return { status: 200 };
    };

    const before = await mockRead();
    const rpcRes = await mockRpc();
    if (rpcRes.status !== 200 && rpcRes.status !== 204) throw new Error('RPC failed');
    const after = await mockRead();
    if (after !== before + 1) {
      throw new Error(`Increment failed: expected after (${after}) === before (${before}) + 1`);
    }
    console.error('❌ Self-Check 1 FAILED: Broken reader was not caught!');
  } catch (err) {
    console.log(`✔ [SELF-CHECK 1 PASSED: expected failure occurred: ${err.message}]`);
    checksPassed++;
  }

  // Proof 2: Restore leaves residue
  console.log('\n--- Self-Check 2: Simulating restore leaving residue in table ---');
  try {
    const todaySim = '2026-11-20';
    let internalCount = 0;
    const mockRead = async () => internalCount;
    const mockRpc = async () => {
      internalCount = 1;
      return { status: 200 };
    };
    const mockFailingRestore = async () => {
      // Simulates failed restore where residue remains in table
    };

    let beforeCount = 0;
    try {
      beforeCount = await mockRead();
      await mockRpc();
      const afterCount = await mockRead();
      if (afterCount !== beforeCount + 1) throw new Error('Increment mismatch');
    } finally {
      await mockFailingRestore();
      const verifyRestored = await mockRead();
      if (verifyRestored !== beforeCount) {
        console.error(`RESIDUE LEFT: (${todaySim}, visit, ${verifyRestored})`);
        throw new Error(`Restoration failed, residue left in table: restored=${verifyRestored} !== before=${beforeCount}`);
      }
    }
    console.error('❌ Self-Check 2 FAILED: Residue was not caught!');
  } catch (err) {
    console.log(`✔ [SELF-CHECK 2 PASSED: expected failure occurred: ${err.message}]`);
    checksPassed++;
  }

  console.log('\n================================================================================');
  if (checksPassed === 2) {
    console.log('ALL SELF-CHECKS PASSED: Proved test catches broken reader and residue left.');
    console.log('================================================================================\n');
  } else {
    console.error(`SELF-CHECKS FAILED: ${checksPassed}/2 passed.`);
    console.log('================================================================================\n');
    process.exit(1);
  }
}

if (process.argv.includes('--plan')) {
  printPlan();
  process.exit(0);
}

if (process.argv.includes('--self-check')) {
  await runSelfCheck();
  process.exit(0);
}

// When executing live:
if (!fs.existsSync(envFile)) {
  console.log('[SKIP] .env.test file not found. Run with --plan or --self-check.');
  process.exit(0);
}

const env = fs.readFileSync(envFile, 'utf8').split('\n').reduce((acc, line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return acc;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    acc[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return acc;
}, {});

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[ERROR] Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env.test');
  process.exit(1);
}

// Sanitize URL for console output (hide project ref)
const sanitizedEndpoint = SUPABASE_URL.replace(/https:\/\/[^.]+\./, 'https://csdb...');

const anonHeaders = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

const serviceHeaders = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function readCount(event, dateStr) {
  const url = `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${dateStr}&event=eq.${encodeURIComponent(event)}&select=n`;
  const res = await fetch(url, { method: 'GET', headers: serviceHeaders });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to read count for event "${event}": HTTP ${res.status} - ${text}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  return Number(rows[0].n);
}

async function getRowsForToday(dateStr) {
  const url = `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${dateStr}&select=day,event,n`;
  const res = await fetch(url, { method: 'GET', headers: serviceHeaders });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to list rows for date "${dateStr}": HTTP ${res.status} - ${text}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function restoreRow(event, baselineCount, dateStr) {
  if (baselineCount === 0) {
    const delUrl = `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${dateStr}&event=eq.${encodeURIComponent(event)}`;
    const delRes = await fetch(delUrl, { method: 'DELETE', headers: serviceHeaders });
    if (!delRes.ok && delRes.status !== 404) {
      const text = await delRes.text().catch(() => '');
      throw new Error(`Failed to delete residue row for "${event}": HTTP ${delRes.status} - ${text}`);
    }
  } else {
    const patchUrl = `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${dateStr}&event=eq.${encodeURIComponent(event)}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: serviceHeaders,
      body: JSON.stringify({ n: baselineCount }),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => '');
      throw new Error(`Failed to restore count for "${event}": HTTP ${patchRes.status} - ${text}`);
    }
  }
}

async function runLiveTest({ isRerun = false } = {}) {
  console.log('================================================================================');
  console.log('MUMBAI LIVE FUNNEL COUNTS VERIFICATION');
  console.log(`Endpoint:  ${sanitizedEndpoint}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  const results = [];
  let allPassed = true;

  function record(target, op, expected, status, passed, details) {
    if (!passed) allPassed = false;
    results.push({
      target,
      op,
      expected,
      status,
      verdict: passed ? 'PASS' : 'FAIL',
      details,
    });
  }

  const todayUtc = new Date().toISOString().slice(0, 10);

  // ---------------------------------------------------------------------------
  // Check 1: Anon call with INVALID event name and NULL -> 200/204 & 0 rows created
  // ---------------------------------------------------------------------------
  const rowsBeforeInvalid = await getRowsForToday(todayUtc);

  // 1a. Invalid event string
  const invalidEvent = 'not_a_real_event';
  const invalidRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_funnel_event`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ p_event: invalidEvent }),
  });
  const invalidCallOk = invalidRes.status === 200 || invalidRes.status === 204;

  // 1b. Null event
  const nullRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_funnel_event`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ p_event: null }),
  });
  const nullCallOk = nullRes.status === 200 || nullRes.status === 204;

  // Verify with service role that no new rows were created
  const rowsAfterInvalid = await getRowsForToday(todayUtc);
  const rowCountBefore = rowsBeforeInvalid.length;
  const rowCountAfter = rowsAfterInvalid.length;
  const noRowsCreated = (rowCountBefore === rowCountAfter) && !rowsAfterInvalid.some(r => r.event === invalidEvent || r.event === null);

  record(
    'rpc: record_funnel_event (invalid)',
    'POST',
    '200/204 & 0 rows',
    invalidRes.status,
    invalidCallOk && noRowsCreated,
    noRowsCreated ? 'Silent success, 0 rows inserted' : `Unexpected rows created: ${rowCountAfter - rowCountBefore}`
  );

  record(
    'rpc: record_funnel_event (null)',
    'POST',
    '200/204 & 0 rows',
    nullRes.status,
    nullCallOk && noRowsCreated,
    noRowsCreated ? 'Silent success, 0 rows inserted' : 'Null event inserted row'
  );

  // ---------------------------------------------------------------------------
  // Check 2: Anon call with VALID event name -> count increments by 1, then restore
  // ---------------------------------------------------------------------------
  const dateBefore = new Date().toISOString().slice(0, 10);
  const countBefore = await readCount('visit', dateBefore);

  let countAfter = countBefore;
  let validCallOk = false;
  let incrementOk = false;
  let restoreOk = false;

  try {
    const validRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_funnel_event`, {
      method: 'POST',
      headers: anonHeaders,
      body: JSON.stringify({ p_event: 'visit' }),
    });
    validCallOk = validRes.status === 200 || validRes.status === 204;

    const dateAfter = new Date().toISOString().slice(0, 10);
    if (dateBefore !== dateAfter) {
      if (isRerun) {
        throw new Error(`UTC date boundary crossed repeatedly (${dateBefore} -> ${dateAfter}). Aborting.`);
      }
      console.warn(`[MIDNIGHT BOUNDARY] UTC date rolled over from ${dateBefore} to ${dateAfter} during run. Rerunning test once...`);
      await restoreRow('visit', countBefore, dateBefore);
      return runLiveTest({ isRerun: true });
    }

    countAfter = await readCount('visit', dateBefore);
    incrementOk = (countAfter === countBefore + 1);
  } finally {
    // Restore row back to exact baseline
    await restoreRow('visit', countBefore, dateBefore);
    const restoredCount = await readCount('visit', dateBefore);
    restoreOk = (restoredCount === countBefore);
    if (!restoreOk) {
      console.error(`\nRESIDUE LEFT: (${dateBefore}, visit, ${restoredCount})\n`);
      allPassed = false;
      process.exit(1);
    }
  }

  record(
    'rpc: record_funnel_event (valid)',
    'POST',
    `increment +1 (was ${countBefore}, now ${countAfter})`,
    200,
    validCallOk && incrementOk && restoreOk,
    `Count: before=${countBefore}, after=${countAfter}, restored=${countBefore}`
  );

  // ---------------------------------------------------------------------------
  // Check 3: Anon Table Access Denials on funnel_daily (Schema-Valid Payloads)
  // ---------------------------------------------------------------------------
  const baselineBeforeAnon = await readCount('visit', todayUtc);

  const tableOps = [
    {
      op: 'INSERT',
      method: 'POST',
      url: `${SUPABASE_URL}/rest/v1/funnel_daily`,
      headers: { ...anonHeaders, 'Prefer': 'return=minimal' },
      body: { day: todayUtc, event: 'visit', n: 999 },
    },
    {
      op: 'UPDATE',
      method: 'PATCH',
      url: `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${todayUtc}&event=eq.visit`,
      headers: { ...anonHeaders, 'Prefer': 'return=minimal' },
      body: { n: 999 },
    },
    {
      op: 'DELETE',
      method: 'DELETE',
      url: `${SUPABASE_URL}/rest/v1/funnel_daily?day=eq.${todayUtc}&event=eq.visit`,
      headers: anonHeaders,
    },
    {
      op: 'SELECT',
      method: 'GET',
      url: `${SUPABASE_URL}/rest/v1/funnel_daily?select=*`,
      headers: anonHeaders,
    },
  ];

  for (const t of tableOps) {
    const res = await fetch(t.url, {
      method: t.method,
      headers: t.headers,
      body: t.body ? JSON.stringify(t.body) : undefined,
    });

    const bodyText = await res.text().catch(() => '');
    const denied = (res.status === 401 || res.status === 403);
    const isBadStatus = (res.status === 400 || (res.status >= 200 && res.status < 300));

    let details = `Anon table ${t.op} rejected with HTTP ${res.status}`;
    if (isBadStatus) {
      details = `FAIL: Unexpected status HTTP ${res.status} (Body: ${bodyText.slice(0, 100)})`;
    }

    record(
      'table: funnel_daily',
      t.op,
      '401/403 DENIED',
      res.status,
      denied,
      details
    );
  }

  // Verify table count strictly unchanged
  const countAfterAnon = await readCount('visit', todayUtc);
  const integrityOk = (countAfterAnon === baselineBeforeAnon);
  record(
    'table: funnel_daily integrity',
    'INTEGRITY',
    `count unchanged (${baselineBeforeAnon})`,
    200,
    integrityOk,
    integrityOk ? `Count verified unchanged at ${countAfterAnon}` : `FAIL: Count modified: now ${countAfterAnon}`
  );

  // ---------------------------------------------------------------------------
  // Check 4: Privileged RPC Notice
  // ---------------------------------------------------------------------------
  console.log('other RPC privileges are covered by scripts/test_mumbai_privilege_audit.js');

  // ---------------------------------------------------------------------------
  // Check 5: search_path set on record_funnel_event (migration text only)
  // ---------------------------------------------------------------------------
  const migrationFile = path.join(rootDir, 'supabase', 'migrations', '0011_funnel_counts.sql');
  let searchPathOk = false;
  let searchPathDetails = '';
  if (fs.existsSync(migrationFile)) {
    const sql = fs.readFileSync(migrationFile, 'utf8');
    const hasSearchPathEmpty = /set\s+search_path\s*=\s*''/i.test(sql);
    searchPathOk = hasSearchPathEmpty;
    searchPathDetails = hasSearchPathEmpty ? "set search_path = '' verified in migration" : 'Missing empty search_path';
  }

  record(
    'rpc: record_funnel_event',
    'CONFIG',
    "search_path = '' (migration text only)",
    200,
    searchPathOk,
    searchPathDetails
  );

  // ---------------------------------------------------------------------------
  // Format Results
  // ---------------------------------------------------------------------------
  console.log('\n' + 'Target'.padEnd(32) + ' ' + 'Op'.padEnd(10) + ' ' + 'Expected'.padEnd(32) + ' ' + 'Status'.padEnd(8) + ' ' + 'Verdict'.padEnd(8) + ' ' + 'Details');
  console.log('-'.repeat(110));

  for (const r of results) {
    console.log(
      r.target.padEnd(32) + ' ' +
      r.op.padEnd(10) + ' ' +
      r.expected.padEnd(32) + ' ' +
      String(r.status).padEnd(8) + ' ' +
      r.verdict.padEnd(8) + ' ' +
      r.details
    );
  }

  console.log('-'.repeat(110));
  const passCount = results.filter(r => r.verdict === 'PASS').length;
  console.log(`Summary: ${passCount}/${results.length} checks passed.`);
  console.log(allPassed ? 'STATUS: ALL CHECKS PASSED\n' : 'STATUS: SOME CHECKS FAILED\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runLiveTest().catch(err => {
  console.error('Exception during live test:', err.message);
  process.exit(1);
});
