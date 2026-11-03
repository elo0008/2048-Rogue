// scripts/test_live_p1_p3.js
// Live Integration Verification for P1, P2, and P3 against hosted Supabase project.
// Exercises real HTTP calls over the network, tests race conditions and quota rollbacks,
// and writes the complete evidence report to scripts/out/live_p1_p3.txt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Load .env.test
const envFile = path.join(rootDir, '.env.test');
if (!fs.existsSync(envFile)) {
  throw new Error(`.env.test not found at ${envFile}`);
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

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SET_NAME_URL = `${SUPABASE_URL}/functions/v1/set-name`;

function redact(str) {
  if (!str) return '';
  return str
    .replace(/kudxaxewnvqurzukrnsm|csdbgcxbavrtdnazctll/g, '[REDACTED_PROJECT_REF]')
    .replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[REDACTED_IP]');
}

async function robustFetch(url, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if ((res.status === 502 || res.status === 503) && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    return res;
  }
  return fetch(url, options);
}

async function main() {
  console.log('================================================================================');
  console.log('LIVE VERIFICATION SUITE: P1, P2, P3');
  console.log(`Endpoint: ${redact(SET_NAME_URL)}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  let report = '================================================================================\n';
  report += 'LIVE VERIFICATION SUITE REPORT: P1, P2, P3\n';
  report += `Endpoint: ${redact(SET_NAME_URL)}\n`;
  report += `Timestamp: ${new Date().toISOString()}\n`;
  report += '================================================================================\n\n';

  const todayUtc = new Date().toISOString().slice(0, 10);

  // Setup test device for general tests
  const testDev = 'test_live_p1_p3_dev';
  await serviceClient.from('devices').delete().eq('device_id', testDev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${testDev}%`);
  await serviceClient.from('devices').insert({
    device_id: testDev,
    display_name: 'Anon_P1P3TestDev',
    generated_name: 'Anon_P1P3TestDev',
    name_norm: null,
  });

  // ---------------------------------------------------------------------------
  // P1: NO RULE LEAKS LIVE VERIFICATION (Rules 1-10)
  // ---------------------------------------------------------------------------
  console.log('[P1] Testing No Rule Leaks on Live HTTP endpoint for Rules 1-10...');
  report += '--------------------------------------------------------------------------------\n';
  report += 'P1: NO RULE LEAKS LIVE VERIFICATION\n';
  report += 'Requirement: Response body for invalid name must be strictly {"error":"NAME_NOT_ALLOWED"}\n';
  report += '--------------------------------------------------------------------------------\n';

  const p1LiveCases = [
    { rule: 1, name: 'Rule 1: Non-string input', payload: 12345 },
    { rule: 2, name: 'Rule 2: Length out of range', payload: 'A' },
    { rule: 3, name: 'Rule 3: Forbidden character', payload: 'Cool@Player' },
    { rule: 4, name: 'Rule 4: Invalid start/end boundary', payload: '-CoolPlayer-' },
    { rule: 5, name: 'Rule 5: Exceeded 4 digits', payload: 'Player12345' },
    { rule: 6, name: 'Rule 6: Run of 4+ identical characters', payload: 'Plaaaayer' },
    { rule: 7, name: 'Rule 7: Reserved name', payload: 'admin' },
    { rule: 8, name: 'Rule 8: Short token blocklist match', payload: 'ass' },
    { rule: 9, name: 'Rule 9: Short substring blocklist match', payload: 'qzzx' },
    { rule: 10, name: 'Rule 10: Long substring blocklist match', payload: 'Randi' },
  ];

  let p1PassedCount = 0;
  for (const c of p1LiveCases) {
    const res = await robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: testDev, name: c.payload }),
    });

    const bodyText = await res.text();
    const expectedBody = JSON.stringify({ error: 'NAME_NOT_ALLOWED' });
    const isExact = res.status === 400 && bodyText === expectedBody;

    if (isExact) {
      p1PassedCount++;
      console.log(`  [PASS] Rule ${String(c.rule).padStart(2, ' ')}: Status ${res.status}, Body = ${bodyText}`);
      report += `[PASS] Rule ${String(c.rule).padStart(2, ' ')} (${c.name}): Status ${res.status}, Body = ${bodyText}\n`;
    } else {
      console.error(`  [FAIL] Rule ${c.rule}: Status ${res.status}, Body = ${bodyText}`);
      report += `[FAIL] Rule ${c.rule} (${c.name}): Status ${res.status}, Body = ${bodyText}\n`;
      throw new Error(`P1 Live Assertion Failed for Rule ${c.rule}`);
    }
  }

  report += `\nP1 Result: ${p1PassedCount} / 10 rules verified strictly returning exact {"error":"NAME_NOT_ALLOWED"}.\n\n`;

  // ---------------------------------------------------------------------------
  // P2: MISSING NAME FIELD (Null vs Missing/Undefined)
  // ---------------------------------------------------------------------------
  console.log('\n[P2] Testing Missing Name Field...');
  report += '--------------------------------------------------------------------------------\n';
  report += 'P2: MISSING NAME FIELD VERIFICATION\n';
  report += 'Requirement: Missing/undefined name returns 400 INVALID_NAME_FIELD, consumes no quota, changes nothing\n';
  report += '--------------------------------------------------------------------------------\n';

  const p2Dev = 'test_live_p2_missing_dev';
  await serviceClient.from('devices').delete().eq('device_id', p2Dev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${p2Dev}%`);
  await serviceClient.from('devices').insert({
    device_id: p2Dev,
    display_name: 'Anon_P2OriginalName',
    generated_name: 'Anon_P2OriginalName',
    name_norm: null,
  });

  const p2Res = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ deviceId: p2Dev }), // name completely omitted
  });

  const p2Status = p2Res.status;
  const p2Body = await p2Res.json();
  const p2ExpectedError = 'INVALID_NAME_FIELD';

  // Check device state
  const { data: devAfterP2 } = await serviceClient
    .from('devices')
    .select('display_name, generated_name, name_norm')
    .eq('device_id', p2Dev)
    .single();

  // Check rate limit counter
  const limitKeyP2 = `dev_name:${p2Dev}:${todayUtc}`;
  const { data: limitRowP2 } = await serviceClient
    .from('abuse_rate_limits')
    .select('count')
    .eq('key', limitKeyP2)
    .maybeSingle();

  const p2DevUnchanged = devAfterP2?.display_name === 'Anon_P2OriginalName' && devAfterP2?.name_norm === null;
  const p2CounterUnchanged = !limitRowP2 || limitRowP2.count === 0;

  console.log(`  Status: ${p2Status} (expected 400)`);
  console.log(`  Body: ${JSON.stringify(p2Body)}`);
  console.log(`  Device name unchanged: ${p2DevUnchanged} (${devAfterP2?.display_name})`);
  console.log(`  Quota counter untouched: ${p2CounterUnchanged} (count=${limitRowP2?.count ?? 'none'})`);

  report += `HTTP Status:             ${p2Status} (expected 400)\n`;
  report += `Response Body:           ${JSON.stringify(p2Body)}\n`;
  report += `Device Name Unchanged:   ${p2DevUnchanged} (${devAfterP2?.display_name})\n`;
  report += `Quota Counter Untouched: ${p2CounterUnchanged} (count=${limitRowP2?.count ?? 'none'})\n`;

  if (p2Status !== 400 || p2Body.error !== p2ExpectedError || !p2DevUnchanged || !p2CounterUnchanged) {
    throw new Error('P2 Verification Failed');
  }
  report += 'P2 Result: PASS. Missing name returns 400 INVALID_NAME_FIELD, consumes 0 quota, changes nothing.\n\n';

  // ---------------------------------------------------------------------------
  // P3: QUOTA RACE LIVE VERIFICATION
  // ---------------------------------------------------------------------------
  console.log('\n[P3] Testing Quota Race: 10 Concurrent Requests for 10 Different Free Names...');
  report += '--------------------------------------------------------------------------------\n';
  report += 'P3: QUOTA RACE VERIFICATION\n';
  report += 'Scenario A: 1 device fires 10 concurrent requests for 10 different free names\n';
  report += 'Requirement: Number of 200s <= 3, counter ends equal to number of 200s, zero 500s\n';
  report += '--------------------------------------------------------------------------------\n';

  const p3Dev = 'test_live_p3_race_dev';
  await serviceClient.from('devices').delete().eq('device_id', p3Dev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${p3Dev}%`);
  await serviceClient.from('devices').insert({
    device_id: p3Dev,
    display_name: 'Anon_P3RaceDev',
    generated_name: 'Anon_P3RaceDev',
    name_norm: null,
  });

  const freeNames = [
    'FreeAlpha', 'FreeBravo', 'FreeCharlie', 'FreeDelta', 'FreeEcho',
    'FreeFoxtrot', 'FreeGolf', 'FreeHotel', 'FreeIndia', 'FreeJuliet'
  ];
  // Clean up any collision in devices table for those names
  for (const n of freeNames) {
    await serviceClient.from('devices').delete().eq('name_norm', n.toLowerCase());
  }

  console.log(`  Firing 10 concurrent requests for free names: ${freeNames.join(', ')}`);

  const racePromises = freeNames.map(name =>
    robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: p3Dev, name }),
    }).then(async r => ({
      name,
      status: r.status,
      body: await r.json(),
    }))
  );

  const raceResults = await Promise.all(racePromises);

  const statusCounts = {};
  let count200 = 0;
  let count429 = 0;
  let count500 = 0;

  for (const res of raceResults) {
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (res.status === 200) count200++;
    if (res.status === 429) count429++;
    if (res.status === 500) count500++;
  }

  // Check abuse_rate_limits table
  const p3LimitKey = `dev_name:${p3Dev}:${todayUtc}`;
  const { data: p3LimitRow } = await serviceClient
    .from('abuse_rate_limits')
    .select('count')
    .eq('key', p3LimitKey)
    .single();

  const finalCounter = p3LimitRow?.count ?? 0;

  console.log(`  Results Breakdown: 200s=${count200}, 429s=${count429}, 500s=${count500}`);
  console.log(`  Final DB counter: ${finalCounter}`);

  report += `Concurrent Requests Dispatched: 10\n`;
  report += `HTTP 200 Successes:             ${count200} (Required: <= 3)\n`;
  report += `HTTP 429 Rate Limited:          ${count429}\n`;
  report += `HTTP 500 Server Errors:         ${count500} (Required: 0)\n`;
  report += `Final DB abuse_rate_limits count: ${finalCounter} (Required: equals count200)\n`;

  for (let i = 0; i < raceResults.length; i++) {
    const r = raceResults[i];
    report += `  Req ${String(i + 1).padStart(2, ' ')}: Name="${r.name}" -> HTTP ${r.status} (${JSON.stringify(r.body)})\n`;
  }

  if (count200 > 3 || count500 > 0 || finalCounter !== count200) {
    throw new Error(`P3 Race Assertion Failed: count200=${count200}, count500=${count500}, finalCounter=${finalCounter}`);
  }
  report += 'P3 Scenario A Result: PASS. Atomic increment-first accurately enforced limit without races.\n\n';

  // ---------------------------------------------------------------------------
  // P3 Scenario B: 10 Concurrent Requests for ONE Taken Name
  // ---------------------------------------------------------------------------
  console.log('\n[P3] Testing Quota Race: 10 Concurrent Requests for ONE Taken Name...');
  report += '--------------------------------------------------------------------------------\n';
  report += 'P3 Scenario B: 10 concurrent requests for ONE taken name\n';
  report += 'Requirement: All return 409 NAME_TAKEN, counter remains completely unchanged\n';
  report += '--------------------------------------------------------------------------------\n';

  // Device A owns the taken name
  const ownerDev = 'test_live_p3_owner_dev';
  const takenName = 'TakenCrown';
  await serviceClient.from('devices').delete().eq('device_id', ownerDev);
  await serviceClient.from('devices').delete().eq('name_norm', takenName.toLowerCase());
  await serviceClient.from('devices').insert({
    device_id: ownerDev,
    display_name: takenName,
    generated_name: takenName,
    name_norm: takenName.toLowerCase(),
  });

  // Device B attempts to claim the taken name 10 times concurrently
  const attackerDev = 'test_live_p3_attacker_dev';
  await serviceClient.from('devices').delete().eq('device_id', attackerDev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${attackerDev}%`);
  await serviceClient.from('devices').insert({
    device_id: attackerDev,
    display_name: 'Anon_AttackerDev',
    generated_name: 'Anon_AttackerDev',
    name_norm: null,
  });

  const attackerLimitKey = `dev_name:${attackerDev}:${todayUtc}`;

  const takenPromises = Array.from({ length: 10 }, () =>
    robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: attackerDev, name: takenName }),
    }).then(async r => ({
      status: r.status,
      body: await r.json(),
    }))
  );

  const takenResults = await Promise.all(takenPromises);

  let count409 = 0;
  let taken500 = 0;
  for (const r of takenResults) {
    if (r.status === 409) count409++;
    if (r.status === 500) taken500++;
  }

  const { data: attackerLimitRow } = await serviceClient
    .from('abuse_rate_limits')
    .select('count')
    .eq('key', attackerLimitKey)
    .maybeSingle();

  const attackerCounter = attackerLimitRow?.count ?? 0;

  console.log(`  Results: 409s=${count409}, 500s=${taken500}`);
  console.log(`  Attacker counter: ${attackerCounter} (expected 0)`);

  report += `Concurrent Requests Dispatched: 10 (all targeting taken name "${takenName}")\n`;
  report += `HTTP 409 Conflict:              ${count409} (Required: 10)\n`;
  report += `HTTP 500 Server Errors:         ${taken500} (Required: 0)\n`;
  report += `Attacker DB Counter:            ${attackerCounter} (Required: 0, quota rolled back)\n`;

  if (count409 !== 10 || taken500 > 0 || attackerCounter !== 0) {
    throw new Error(`P3 Scenario B Failed: count409=${count409}, attackerCounter=${attackerCounter}`);
  }
  report += 'P3 Scenario B Result: PASS. Failed name updates on taken names rolled back quota completely.\n\n';

  // ---------------------------------------------------------------------------
  // Re-run G2 Live Proofs (Sequential edge behavior)
  // ---------------------------------------------------------------------------
  console.log('\n[G2 Re-run] Running sequential G2 proofs...');
  report += '--------------------------------------------------------------------------------\n';
  report += 'G2 LIVE PROOFS RE-RUN (Sequential Edge Behavior)\n';
  report += '--------------------------------------------------------------------------------\n';

  const g2Dev = 'test_p3_g2_seq_dev';
  await serviceClient.from('devices').delete().eq('device_id', g2Dev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${g2Dev}%`);
  await serviceClient.from('devices').insert({
    device_id: g2Dev,
    display_name: 'Anon_G2SeqDev',
    generated_name: 'Anon_G2SeqDev',
    name_norm: null,
  });

  // 3 successful changes
  const seqNames = ['SeqAlpha', 'SeqBravo', 'SeqCharlie'];
  for (let step = 0; step < 3; step++) {
    const customName = seqNames[step];
    await serviceClient.from('devices').delete().eq('name_norm', customName.toLowerCase());
    const r = await robustFetch(SET_NAME_URL, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: g2Dev, name: customName }),
    });
    const b = await r.json();
    report += `Step ${step + 1}: Set "${customName}" -> Status ${r.status} (${JSON.stringify(b)})\n`;
    if (r.status !== 200) throw new Error(`G2 Step ${step + 1} failed: ${JSON.stringify(b)}`);
  }

  // 4th change exceeds daily limit -> 429
  const r4 = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: g2Dev, name: 'SeqDelta' }),
  });
  const b4 = await r4.json();
  report += `Step 4: Exceeded daily limit -> Status ${r4.status} (${JSON.stringify(b4)})\n`;
  if (r4.status !== 429) throw new Error('G2 4th change did not return 429');

  // Clear name to null using a dedicated fresh device
  const g2ClearDev = 'test_p3_g2_clear_dev';
  await serviceClient.from('devices').delete().eq('device_id', g2ClearDev);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${g2ClearDev}%`);
  await serviceClient.from('devices').insert({
    device_id: g2ClearDev,
    display_name: 'Anon_G2ClearDev',
    generated_name: 'Anon_G2ClearDev',
    name_norm: null,
  });

  // Set name once
  await serviceClient.from('devices').delete().eq('name_norm', 'beforeclear');
  await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: g2ClearDev, name: 'BeforeClear' }),
  });

  // Reset with null
  const rClear = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: g2ClearDev, name: null }),
  });
  const bClear = await rClear.json();
  report += `Reset with null: Status ${rClear.status} (${JSON.stringify(bClear)})\n`;
  const resetName = bClear.displayName || bClear.display_name;
  if (rClear.status !== 200 || resetName !== 'Anon_G2ClearDev') {
    throw new Error(`G2 Reset with null failed: status=${rClear.status}, body=${JSON.stringify(bClear)}`);
  }

  // Unknown device -> 404
  const unknownDev = 'test_p3_unknown_dev_999';
  await serviceClient.from('devices').delete().eq('device_id', unknownDev);
  const rUnknown = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: unknownDev, name: 'SomeValidName' }),
  });
  const bUnknown = await rUnknown.json();
  report += `Unknown device: Status ${rUnknown.status} (${JSON.stringify(bUnknown)})\n`;
  if (rUnknown.status !== 404) throw new Error('G2 Unknown device did not return 404');

  report += '\nG2 Sequential Proofs Result: PASS. All 5 scenarios verified successfully.\n';
  report += '================================================================================\n';

  fs.writeFileSync(path.join(outDir, 'live_p1_p3.txt'), report, 'utf8');
  console.log(`\nAll live proofs completed! Report written to scripts/out/live_p1_p3.txt`);
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
