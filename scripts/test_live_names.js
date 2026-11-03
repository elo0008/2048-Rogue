// scripts/test_live_names.js
// Live integration tests for Custom Display Names (set-name Edge Function and Database RPCs)
// Outputs scripts/out/live_names.txt with real HTTP statuses and bodies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { assertDatabaseSafe } from './live_safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// 1. Load credentials from .env.test (gitignored)
const envFile = path.join(rootDir, '.env.test');
if (!fs.existsSync(envFile)) {
  throw new Error(`.env.test not found at ${envFile}`);
}

const env = fs.readFileSync(envFile, 'utf8').split('\n').reduce((acc, line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return acc;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    acc[k] = v;
  }
  return acc;
}, {});

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env.test');
}

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SET_NAME_URL = `${SUPABASE_URL}/functions/v1/set-name`;

function redact(str) {
  if (!str) return '';
  return str
    .replace(new RegExp(SUPABASE_ANON_KEY, 'g'), '[REDACTED_ANON_KEY]')
    .replace(new RegExp(SUPABASE_SERVICE_ROLE_KEY, 'g'), '[REDACTED_SERVICE_KEY]')
    .replace(/kudxaxewnvqurzukrnsm/g, '[REDACTED_PROJECT_REF]');
}

async function robustFetch(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    return res;
  }
  return fetch(url, options);
}

async function cleanupTestData() {
  await serviceClient.from('daily_runs').delete().like('device_id', 'test_name_%');
  await serviceClient.from('devices').delete().like('device_id', 'test_name_%');
  await serviceClient.from('abuse_rate_limits').delete().like('key', '%test_name_%');
}

async function runLiveNamesSuite() {
  const simulate = process.argv.includes('--simulate-populated');
  await assertDatabaseSafe(serviceClient, false, simulate);

  console.log('================================================================================');
  console.log('STARTING LIVE CUSTOM NAMES TEST SUITE (Hosted Supabase & Edge Function)');
  console.log(`Target: ${redact(SET_NAME_URL)}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  let log = '================================================================================\n';
  log += 'LIVE TEST REPORT: CUSTOM DISPLAY NAMES & MODERATION BACKEND\n';
  log += `Endpoint: ${redact(SET_NAME_URL)}\n`;
  log += `Timestamp: ${new Date().toISOString()}\n`;
  log += '================================================================================\n\n';

  try {
    await cleanupTestData();

  // -----------------------------------------------------------------------------
  // Test 1: Valid Name Change (200)
  // -----------------------------------------------------------------------------
  console.log('[1/9] Testing Valid Name Change (HTTP 200)...');
  const dev1 = 'test_name_dev_01';
  await serviceClient.from('devices').insert({
    device_id: dev1,
    display_name: 'Amber-Badger-101',
    generated_name: 'Amber-Badger-101',
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  const res1 = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: dev1, name: 'CoolGamer' }),
  });
  const body1 = await res1.json();

  log += 'TEST 1: Valid Name Change\n';
  log += `  Request:       POST { deviceId: "${dev1}", name: "CoolGamer" }\n`;
  log += `  HTTP Status:   ${res1.status} (Expected: 200)\n`;
  log += `  Response Body: ${JSON.stringify(body1)}\n`;

  const { data: row1 } = await serviceClient.from('devices').select('*').eq('device_id', dev1).single();
  log += `  DB State:      display_name="${row1.display_name}", name_norm="${row1.name_norm}", generated_name="${row1.generated_name}"\n`;
  const pass1 = res1.status === 200 && body1.status === 'UPDATED' && row1.display_name === 'CoolGamer' && row1.name_norm === 'coolgamer';
  log += `  Result:        ${pass1 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass1) throw new Error('Test 1 failed: Valid name change');

  // -----------------------------------------------------------------------------
  // Test 2: Validation Failures (Too short, too long, forbidden chars, reserved, sentinel)
  // -----------------------------------------------------------------------------
  console.log('[2/9] Testing Validation Failures (HTTP 400)...');
  log += 'TEST 2: Validation Failures (Character set, bounds, reserved, sentinel)\n';
  const badNames = [
    { label: 'Too short (2 chars)', name: 'Ab' },
    { label: 'Too long (17 chars)', name: 'SeventeenCharsLon' },
    { label: 'Forbidden emoji', name: 'Player🎮12' },
    { label: 'Forbidden punctuation', name: 'Player<script>' },
    { label: '5 digits total', name: 'Player12345' },
    { label: 'Reserved name admin', name: 'admin' },
    { label: 'Reserved name Anon_123', name: 'Anon_123' },
    { label: 'Sentinel with leetspeak', name: 'zzbadw0rd' },
  ];

  for (const item of badNames) {
    const res = await robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: dev1, name: item.name }),
    });
    const body = await res.json();
    const passed = res.status === 400 && body.error === 'NAME_NOT_ALLOWED';
    log += `  Scenario:      ${item.label} (Input: "${item.name}")\n`;
    log += `    HTTP Status: ${res.status} (Expected: 400)\n`;
    log += `    Response:    ${JSON.stringify(body)}\n`;
    log += `    Result:      ${passed ? 'PASS' : 'FAIL'}\n`;
    if (!passed) throw new Error(`Test 2 failed on ${item.label}: status=${res.status}, body=${JSON.stringify(body)}`);
  }
  log += '\n';

  // -----------------------------------------------------------------------------
  // Test 3: Case-Insensitive Uniqueness (409 NAME_TAKEN)
  // -----------------------------------------------------------------------------
  console.log('[3/9] Testing Case-Insensitive Uniqueness (HTTP 409 NAME_TAKEN)...');
  const dev2 = 'test_name_dev_02';
  await serviceClient.from('devices').insert({
    device_id: dev2,
    display_name: 'Azure-Falcon-202',
    generated_name: 'Azure-Falcon-202',
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  // Attempt to claim "COOLGAMER" which matches dev1's norm "coolgamer"
  const res3 = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2, name: 'COOLGAMER' }),
  });
  const body3 = await res3.json();

  log += 'TEST 3: Case-Insensitive Uniqueness Conflict\n';
  log += `  Request:       POST { deviceId: "${dev2}", name: "COOLGAMER" } (Collides with existing "CoolGamer")\n`;
  log += `  HTTP Status:   ${res3.status} (Expected: 409)\n`;
  log += `  Response Body: ${JSON.stringify(body3)}\n`;
  const pass3 = res3.status === 409 && body3.error === 'NAME_TAKEN';
  log += `  Result:        ${pass3 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass3) throw new Error('Test 3 failed: Uniqueness conflict');

  // -----------------------------------------------------------------------------
  // Test 4: Rate Limit: 4th change in a day -> 429
  // -----------------------------------------------------------------------------
  console.log('[4/9] Testing Rate Limit: 4th change in a day (HTTP 429)...');
  const dev3 = 'test_name_dev_03';
  await serviceClient.from('devices').insert({
    device_id: dev3,
    display_name: 'Calm-Gryphon-303',
    generated_name: 'Calm-Gryphon-303',
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  log += 'TEST 4: Rate Limiting: 3 Changes Permitted / Day, 4th Returns 429\n';
  const nameSequence = ['FoxOne', 'FoxTwo', 'FoxThree', 'FoxFour'];
  for (let i = 0; i < nameSequence.length; i++) {
    const candidate = nameSequence[i];
    const res = await robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: dev3, name: candidate }),
    });
    const body = await res.json();
    const isFourth = i === 3;
    const expectedStatus = isFourth ? 429 : 200;
    const retryAfter = res.headers.get('retry-after');

    log += `  Change ${i + 1} ("${candidate}"): HTTP ${res.status} (Expected: ${expectedStatus})${isFourth ? ` | Retry-After: ${retryAfter}s` : ''}\n`;
    log += `    Response: ${JSON.stringify(body)}\n`;

    if (res.status !== expectedStatus) {
      throw new Error(`Test 4 failed at step ${i + 1}: expected ${expectedStatus}, got ${res.status}`);
    }
  }
  log += '  Result:        PASS\n\n';

  // -----------------------------------------------------------------------------
  // Test 5: 20 Concurrent Requests for One Free Name (1 x 200, 19 x 409, 0 x 500)
  // -----------------------------------------------------------------------------
  console.log('[5/9] Testing 20 Concurrent Requests for One Free Name...');
  log += 'TEST 5: 20 Concurrent Requests Racing for One Free Name\n';
  const targetRaceName = 'UniqueSpeedyFox';

  // Register 20 distinct devices
  const raceDevs = [];
  for (let i = 1; i <= 20; i++) {
    const id = `test_name_race_${String(i).padStart(2, '0')}`;
    raceDevs.push(id);
    await serviceClient.from('devices').insert({
      device_id: id,
      display_name: `Race-Player-${i}`,
      generated_name: `Race-Player-${i}`,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });
  }

  // Fire 20 concurrent requests simultaneously
  const racePromises = raceDevs.map(id =>
    robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: id, name: targetRaceName }),
    }).then(async r => ({
      id,
      status: r.status,
      body: await r.json(),
    }))
  );

  const raceResults = await Promise.all(racePromises);
  const count200 = raceResults.filter(r => r.status === 200).length;
  const count409 = raceResults.filter(r => r.status === 409).length;
  const count500 = raceResults.filter(r => r.status >= 500).length;
  const otherStatuses = raceResults.filter(r => r.status !== 200 && r.status !== 409).map(r => r.status);

  log += `  Target Name:   "${targetRaceName}"\n`;
  log += `  Concurrency:   20 simultaneous POST requests from 20 registered devices\n`;
  log += `  HTTP 200 Count: ${count200} (Expected: exactly 1)\n`;
  log += `  HTTP 409 Count: ${count409} (Expected: exactly 19)\n`;
  log += `  HTTP 500 Count: ${count500} (Expected: exactly 0)\n`;
  if (otherStatuses.length > 0) {
    log += `  Other Statuses: ${JSON.stringify(otherStatuses)}\n`;
  }

  const pass5 = count200 === 1 && count409 === 19 && count500 === 0;
  log += `  Result:        ${pass5 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass5) {
    throw new Error(`Test 5 failed: Got ${count200}x 200, ${count409}x 409, ${count500}x 500`);
  }

  // -----------------------------------------------------------------------------
  // Test 6: Clearing a Name (Reset to generated_name and release name_norm)
  // -----------------------------------------------------------------------------
  console.log('[6/9] Testing Clearing a Name (name: null)...');
  const res6 = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: dev1, name: null }),
  });
  const body6 = await res6.json();

  const { data: row6 } = await serviceClient.from('devices').select('*').eq('device_id', dev1).single();

  log += 'TEST 6: Clearing Name (name: null)\n';
  log += `  Request:       POST { deviceId: "${dev1}", name: null }\n`;
  log += `  HTTP Status:   ${res6.status} (Expected: 200)\n`;
  log += `  Response Body: ${JSON.stringify(body6)}\n`;
  log += `  DB State:      display_name="${row6.display_name}", name_norm=${row6.name_norm}, generated_name="${row6.generated_name}"\n`;

  // Verify that dev2 can now claim the previously taken "CoolGamer"
  const res6b = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2, name: 'CoolGamer' }),
  });
  const body6b = await res6b.json();
  log += `  Re-claim Name: dev2 claims "CoolGamer" -> HTTP ${res6b.status} (${body6b.status})\n`;

  const pass6 = res6.status === 200 && row6.display_name === row6.generated_name && row6.name_norm === null && res6b.status === 200;
  log += `  Result:        ${pass6 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass6) throw new Error('Test 6 failed: Clearing name');

  // -----------------------------------------------------------------------------
  // Test 7: Hidden Flag Masks Names Across All Four Board Functions
  // -----------------------------------------------------------------------------
  console.log('[7/9] Testing name_hidden Masking in Leaderboard Functions...');
  const devBoard = 'test_name_dev_board';
  const testDate = '1999-03-01'; // Monday

  await serviceClient.from('devices').insert({
    device_id: devBoard,
    display_name: 'SecretChampion',
    generated_name: 'Brave-Lion-999',
    name_norm: 'secretchampion',
    name_hidden: false,
    created_at: new Date('1999-03-01T00:00:00Z').toISOString(),
    last_seen_at: new Date('1999-03-01T00:00:00Z').toISOString(),
  });

  await serviceClient.from('daily_runs').insert({
    device_id: devBoard,
    day_utc: testDate,
    seed: '7777',
    points: 5000,
    total_moves: 120,
    max_tile: 512,
    relics_owned: [],
    replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
    events_hash: 'hash_board_test_01',
    duration_ms: 30000,
    flags: [],
    received_at: '1999-03-01T10:00:00Z',
  });

  // Query boards when name_hidden = false
  const { data: dBest1 } = await anonClient.rpc('daily_best', { target_day: testDate });
  const { data: wBest1 } = await anonClient.rpc('weekly_best', { target_week_start: testDate });
  const { data: myD1 } = await anonClient.rpc('my_daily_rank', { target_day: testDate, p_device_id: devBoard });
  const { data: myW1 } = await anonClient.rpc('my_weekly_rank', { target_week_start: testDate, p_device_id: devBoard });

  const nameVisible =
    dBest1?.find(r => r.display_name === 'SecretChampion') &&
    wBest1?.find(r => r.display_name === 'SecretChampion') &&
    myD1?.[0]?.display_name === 'SecretChampion' &&
    myW1?.[0]?.display_name === 'SecretChampion';

  // Toggle name_hidden = true
  await serviceClient.from('devices').update({ name_hidden: true }).eq('device_id', devBoard);

  // Query boards when name_hidden = true
  const { data: dBest2 } = await anonClient.rpc('daily_best', { target_day: testDate });
  const { data: wBest2 } = await anonClient.rpc('weekly_best', { target_week_start: testDate });
  const { data: myD2 } = await anonClient.rpc('my_daily_rank', { target_day: testDate, p_device_id: devBoard });
  const { data: myW2 } = await anonClient.rpc('my_weekly_rank', { target_week_start: testDate, p_device_id: devBoard });

  const nameMasked =
    dBest2?.find(r => r.display_name === 'Brave-Lion-999') &&
    wBest2?.find(r => r.display_name === 'Brave-Lion-999') &&
    myD2?.[0]?.display_name === 'Brave-Lion-999' &&
    myW2?.[0]?.display_name === 'Brave-Lion-999' &&
    !dBest2?.find(r => r.display_name === 'SecretChampion') &&
    !wBest2?.find(r => r.display_name === 'SecretChampion');

  log += 'TEST 7: name_hidden Masking Across All Four Leaderboard RPCs\n';
  log += `  Initial state (name_hidden=false):  Custom name shown ("SecretChampion") -> ${nameVisible ? 'PASS' : 'FAIL'}\n`;
  log += `    daily_best:    "${dBest1?.find(r => r.display_name === 'SecretChampion')?.display_name}"\n`;
  log += `    weekly_best:   "${wBest1?.find(r => r.display_name === 'SecretChampion')?.display_name}"\n`;
  log += `    my_daily_rank: "${myD1?.[0]?.display_name}"\n`;
  log += `    my_weekly_rank:"${myW1?.[0]?.display_name}"\n`;
  log += `  After update (name_hidden=true):   Masked with generated ("Brave-Lion-999") -> ${nameMasked ? 'PASS' : 'FAIL'}\n`;
  log += `    daily_best:    "${dBest2?.find(r => r.display_name === 'Brave-Lion-999')?.display_name}"\n`;
  log += `    weekly_best:   "${wBest2?.find(r => r.display_name === 'Brave-Lion-999')?.display_name}"\n`;
  log += `    my_daily_rank: "${myD2?.[0]?.display_name}"\n`;
  log += `    my_weekly_rank:"${myW2?.[0]?.display_name}"\n`;

  const pass7 = Boolean(nameVisible && nameMasked);
  log += `  Result:        ${pass7 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass7) throw new Error('Test 7 failed: name_hidden masking in boards');

  // -----------------------------------------------------------------------------
  // Test 8: Anon Security: Cannot update devices or call set_display_name
  // -----------------------------------------------------------------------------
  console.log('[8/9] Testing Anon RLS & RPC Security...');
  const anonUpdateRes = await anonClient
    .from('devices')
    .update({ display_name: 'HackedName' })
    .eq('device_id', devBoard);

  const anonRpcRes = await anonClient.rpc('set_display_name', {
    p_device_id: devBoard,
    p_display_name: 'HackedRpc',
    p_name_norm: 'hackedrpc',
  });

  log += 'TEST 8: Anon Security Denials (RLS & RPC Privileges)\n';
  log += `  Anon UPDATE devices:        HTTP ${anonUpdateRes.status} (Expected: 401/403) | Message: "${anonUpdateRes.error?.message}"\n`;
  log += `  Anon RPC set_display_name:  HTTP ${anonRpcRes.status} (Expected: 401/403) | Message: "${anonRpcRes.error?.message}"\n`;

  const pass8 =
    (anonUpdateRes.status === 401 || anonUpdateRes.status === 403) &&
    (anonRpcRes.status === 401 || anonRpcRes.status === 403);
  log += `  Result:        ${pass8 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass8) throw new Error('Test 8 failed: Anon security checks');

  // -----------------------------------------------------------------------------
  // Test 9: Boards Still Show Names for Devices That Never Set One
  // -----------------------------------------------------------------------------
  console.log('[9/9] Testing Uncustomized Devices Show Generated Names...');
  const devUncustomized = 'test_name_dev_never';
  await serviceClient.from('devices').insert({
    device_id: devUncustomized,
    display_name: 'Default-Otter-777',
    generated_name: 'Default-Otter-777',
    name_norm: null,
    name_hidden: false,
    created_at: new Date('1999-03-01T00:00:00Z').toISOString(),
    last_seen_at: new Date('1999-03-01T00:00:00Z').toISOString(),
  });

  await serviceClient.from('daily_runs').insert({
    device_id: devUncustomized,
    day_utc: testDate,
    seed: '7778',
    points: 4000,
    total_moves: 100,
    max_tile: 256,
    relics_owned: [],
    replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
    events_hash: 'hash_board_test_02',
    duration_ms: 25000,
    flags: [],
    received_at: '1999-03-01T11:00:00Z',
  });

  const { data: dBestNever } = await anonClient.rpc('daily_best', { target_day: testDate });
  const neverRow = dBestNever?.find(r => r.display_name === 'Default-Otter-777');

  log += 'TEST 9: Uncustomized Devices Show Generated Name on Leaderboard\n';
  log += `  Queried daily_best: Found display_name="${neverRow?.display_name}" (rank=${neverRow?.rank}, points=${neverRow?.points})\n`;
  const pass9 = Boolean(neverRow && neverRow.display_name === 'Default-Otter-777');
  log += `  Result:        ${pass9 ? 'PASS' : 'FAIL'}\n\n`;
  if (!pass9) throw new Error('Test 9 failed: Uncustomized device leaderboard display');

  // -----------------------------------------------------------------------------
  // Clean Up and Verify Final Test Counts = 0
  // -----------------------------------------------------------------------------
  console.log('Cleaning up all test rows and verifying zero residue...');
  await cleanupTestData();

  const { count: finalRuns } = await serviceClient
    .from('daily_runs')
    .select('*', { count: 'exact', head: true })
    .like('device_id', 'test_name_%');

  const { count: finalDevices } = await serviceClient
    .from('devices')
    .select('*', { count: 'exact', head: true })
    .like('device_id', 'test_name_%');

  const { count: finalLimits } = await serviceClient
    .from('abuse_rate_limits')
    .select('*', { count: 'exact', head: true })
    .like('key', '%test_name_%');

  log += '================================================================================\n';
  log += 'TEST SUITE CLEANUP & HYGIENE AUDIT\n';
  log += `  Remaining test rows in public.daily_runs:        ${finalRuns || 0} (Expected: 0)\n`;
  log += `  Remaining test rows in public.devices:           ${finalDevices || 0} (Expected: 0)\n`;
  log += `  Remaining test rows in public.abuse_rate_limits: ${finalLimits || 0} (Expected: 0)\n`;

  const cleanPass = (finalRuns || 0) === 0 && (finalDevices || 0) === 0 && (finalLimits || 0) === 0;
  log += `  Hygiene Result:                                  ${cleanPass ? 'CLEAN (PASS)' : 'LEAK (FAIL)'}\n`;
  log += '================================================================================\n';

  if (!cleanPass) throw new Error('Cleanup failed: leftover test rows detected');

    fs.writeFileSync(path.join(outDir, 'live_names.txt'), log, 'utf8');
    console.log('\n✔ scripts/out/live_names.txt written successfully.');
    console.log('ALL LIVE NAMES TESTS COMPLETED AND VERIFIED.');
  } finally {
    await cleanupTestData();
  }
}

runLiveNamesSuite().catch(err => {
  console.error('\n❌ Live names test suite failed:', err);
  process.exit(1);
});

