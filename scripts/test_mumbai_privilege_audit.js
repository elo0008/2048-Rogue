// scripts/test_mumbai_privilege_audit.js
// B3 Privilege Audit on Mumbai database with anon key

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envFile = path.join(rootDir, '.env.test');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
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

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env.test');
}

const headers = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

async function audit() {
  const results = [];
  let allPassed = true;

  console.log('================================================================================');
  console.log('B3 MUMBAI PRODUCTION PRIVILEGE AUDIT (ANON KEY)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Endpoint:  ${SUPABASE_URL.replace(/https:\/\/[^.]+\./, 'https://csdb...')}...`);
  console.log('================================================================================\n');

  // 1. Table Access Audit with schema-valid payloads
  const tableTests = [
    { target: 'table: devices', op: 'SELECT', method: 'GET', url: `${SUPABASE_URL}/rest/v1/devices?select=*` },
    { target: 'table: devices', op: 'INSERT', method: 'POST', url: `${SUPABASE_URL}/rest/v1/devices`, body: { device_id: 'audit_test', display_name: 'Audit' } },
    { target: 'table: devices', op: 'UPDATE', method: 'PATCH', url: `${SUPABASE_URL}/rest/v1/devices?device_id=eq.audit_test`, body: { display_name: 'Audit2' } },
    { target: 'table: devices', op: 'DELETE', method: 'DELETE', url: `${SUPABASE_URL}/rest/v1/devices?device_id=eq.audit_test` },

    { target: 'table: daily_runs', op: 'SELECT', method: 'GET', url: `${SUPABASE_URL}/rest/v1/daily_runs?select=*` },
    { target: 'table: daily_runs', op: 'INSERT', method: 'POST', url: `${SUPABASE_URL}/rest/v1/daily_runs`, body: { device_id: 'audit_test', day_utc: '2026-11-03', seed: 1, points: 1, total_moves: 1, max_tile: 2, relics_owned: [], replay_version: 'v', events_hash: 'h' } },
    { target: 'table: daily_runs', op: 'UPDATE', method: 'PATCH', url: `${SUPABASE_URL}/rest/v1/daily_runs?id=eq.1`, body: { points: 2 } },
    { target: 'table: daily_runs', op: 'DELETE', method: 'DELETE', url: `${SUPABASE_URL}/rest/v1/daily_runs?id=eq.1` },

    { target: 'table: abuse_rate_limits', op: 'SELECT', method: 'GET', url: `${SUPABASE_URL}/rest/v1/abuse_rate_limits?select=*` },
    { target: 'table: abuse_rate_limits', op: 'INSERT', method: 'POST', url: `${SUPABASE_URL}/rest/v1/abuse_rate_limits`, body: { key: 'audit_test', count: 1, window_start: '2026-11-03T00:00:00Z' } },
    { target: 'table: abuse_rate_limits', op: 'UPDATE', method: 'PATCH', url: `${SUPABASE_URL}/rest/v1/abuse_rate_limits?key=eq.audit_test`, body: { count: 2 } },
    { target: 'table: abuse_rate_limits', op: 'DELETE', method: 'DELETE', url: `${SUPABASE_URL}/rest/v1/abuse_rate_limits?key=eq.audit_test` },

    { target: 'table: challenges', op: 'SELECT', method: 'GET', url: `${SUPABASE_URL}/rest/v1/challenges?select=*` },
    { target: 'table: challenges', op: 'INSERT', method: 'POST', url: `${SUPABASE_URL}/rest/v1/challenges`, body: { code: 'audit1234567', creator_device_id: 'audit_test', mode: 'daily', expires_at: '2026-11-20T00:00:00Z' } },
    { target: 'table: challenges', op: 'UPDATE', method: 'PATCH', url: `${SUPABASE_URL}/rest/v1/challenges?code=eq.audit1234567`, body: { open_count: 1 } },
    { target: 'table: challenges', op: 'DELETE', method: 'DELETE', url: `${SUPABASE_URL}/rest/v1/challenges?code=eq.audit1234567` },
  ];

  for (const t of tableTests) {
    const res = await fetch(t.url, {
      method: t.op === 'SELECT' ? 'GET' : t.op === 'INSERT' ? 'POST' : t.op === 'UPDATE' ? 'PATCH' : 'DELETE',
      headers,
      body: t.body ? JSON.stringify(t.body) : undefined,
    });

    const bodyText = await res.text();
    let errorBody = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      errorBody = parsed.message || parsed.error || bodyText;
    } catch {}

    const denied = (res.status === 401 || res.status === 403 || res.status === 404);
    const passed = denied && res.status !== 200 && res.status !== 201 && res.status !== 204;
    if (!passed) allPassed = false;

    results.push({
      target: t.target,
      operation: t.op,
      expected: 'DENIED (401/403/404)',
      status: res.status,
      result: passed ? 'PASS' : 'FAIL',
      details: errorBody.slice(0, 80).replace(/\r?\n/g, ' '),
    });
  }

  // 2. Denied RPCs (D3d: 404 counts as FAIL; only 401/403 permission denied passes)
  const deniedRPCs = [
    { name: 'consume_rate_limit', body: { p_key: 'test', p_limit: 10 } },
    { name: 'precheck_submission', body: { p_ip: '127.0.0.1', p_device_id: 'test_dev', p_hour_key: '2026-11-03T10', p_day_key: '2026-11-03', p_ip_req_limit: 600, p_ip_newdev_limit: 30 } },
    { name: 'record_submission', body: { p_device_id: 'test_dev', p_display_name: 'test', p_day_utc: '2026-11-03', p_seed: 1, p_points: 0, p_total_moves: 0, p_max_tile: 2, p_relics: [], p_replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98', p_events_hash: 'h', p_duration_ms: 100, p_flags: [], p_dev_key: 'k', p_dev_limit: 60 } },
    { name: 'set_display_name', body: { p_device_id: 'test_dev', p_display_name: 'test', p_name_norm: 'test' } },
    { name: 'set_display_name_limited', body: { p_device_id: 'test_dev', p_display_name: 'test', p_name_norm: 'test', p_limit_key: 'k', p_limit: 3 } },
    { name: 'cleanup_rate_limits', body: {} },
    { name: 'create_daily_challenge', body: { p_device_id: 'test_dev', p_code: 'audit1234567' } },
    { name: 'create_free_challenge', body: { p_device_id: 'test_dev', p_display_name: 'test', p_code: 'audit1234567', p_points: 0, p_total_moves: 0, p_max_tile: 2, p_relics: [], p_seed: '1', p_final_board: null, p_replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98', p_events_hash: 'h', p_expires_at: '2026-11-20T00:00:00Z' } },
    { name: 'record_challenge_event', body: { p_code: 'audit1234567', p_kind: 'open' } },
  ];

  for (const rpc of deniedRPCs) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/${rpc.name}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc.body),
    });

    const bodyText = await res.text();
    let errorBody = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      errorBody = parsed.message || parsed.error || bodyText;
    } catch {}

    // D3d: 404 counts as FAIL; only 401 or 403 passes
    const passed = (res.status === 401 || res.status === 403) && errorBody.includes('permission denied');
    if (!passed) allPassed = false;

    results.push({
      target: `rpc: ${rpc.name}`,
      operation: 'CALL',
      expected: '401/403 PERMISSION DENIED',
      status: res.status,
      result: passed ? 'PASS' : 'FAIL',
      details: errorBody.slice(0, 80).replace(/\r?\n/g, ' '),
    });
  }

  // 3. Allowed RPCs (Must return 200)
  const allowedRPCs = [
    { name: 'daily_best', body: { target_day: '2026-11-03', p_limit: 10 } },
    { name: 'weekly_best', body: { target_week_start: '2026-11-02', p_limit: 10 } },
    { name: 'my_daily_rank', body: { target_day: '2026-11-03', p_device_id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'my_weekly_rank', body: { target_week_start: '2026-11-02', p_device_id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'get_challenge', body: { code: '000000000000' } },
  ];

  for (const rpc of allowedRPCs) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/${rpc.name}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc.body),
    });

    const bodyText = await res.text();
    const passed = (res.status === 200);
    if (!passed) allPassed = false;

    results.push({
      target: `rpc: ${rpc.name}`,
      operation: 'CALL',
      expected: '200 OK',
      status: res.status,
      result: passed ? 'PASS' : 'FAIL',
      details: bodyText.slice(0, 80).replace(/\r?\n/g, ' '),
    });
  }

  // Format table output
  let out = '';
  out += 'Target'.padEnd(28) + ' ' + 'Op'.padEnd(8) + ' ' + 'Expected'.padEnd(22) + ' ' + 'Status'.padEnd(8) + ' ' + 'Verdict'.padEnd(8) + ' ' + 'Details\n';
  out += '-'.repeat(100) + '\n';

  for (const r of results) {
    out += r.target.padEnd(28) + ' ' +
           r.operation.padEnd(8) + ' ' +
           r.expected.padEnd(22) + ' ' +
           String(r.status).padEnd(8) + ' ' +
           r.result.padEnd(8) + ' ' +
           r.details + '\n';
  }

  out += '-'.repeat(100) + '\n';
  out += `Summary: ${results.filter(r => r.result === 'PASS').length}/${results.length} passed.\n`;
  if (!allPassed) {
    out += 'STATUS: AUDIT FAILED\n';
  } else {
    out += 'STATUS: AUDIT PASSED CLEANLY\n';
  }

  fs.writeFileSync(path.join(outDir, 'mumbai_privilege_audit.txt'), out);
  console.log(out);

  if (!allPassed) {
    process.exit(1);
  }
}

audit().catch(err => {
  console.error('Audit script exception:', err);
  process.exit(1);
});
