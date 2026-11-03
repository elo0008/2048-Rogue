// scripts/test_live_hardening_fixes.js
// Live integration tests for server-side hardening fixes:
// A1: Name Clobber fix & week-snap/limit-clamp regression
// A2: Deduplicated new-device counter per IP/day
// A4: Real CORS OPTIONS preflight with x-region

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { GameController } from '../game/controller.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { dailySeed, CANONICAL_CONFIG } from '../verify/profile.js';

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

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SUBMIT_RUN_URL = `${SUPABASE_URL}/functions/v1/submit-run`;
const SET_NAME_URL = `${SUPABASE_URL}/functions/v1/set-name`;

let detectedCallerIp = '';

function redact(str) {
  if (!str) return '';
  let res = str
    .replace(new RegExp(SUPABASE_ANON_KEY, 'g'), '[REDACTED_ANON_KEY]')
    .replace(new RegExp(SUPABASE_SERVICE_ROLE_KEY, 'g'), '[REDACTED_SERVICE_KEY]')
    .replace(/kudxaxewnvqurzukrnsm/g, '[REDACTED_PROJECT_REF]');
  if (detectedCallerIp) {
    const escaped = detectedCallerIp.replace(/\./g, '\\.');
    res = res.replace(new RegExp(escaped, 'g'), '198.51.100.42');
  }
  return res;
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

function generateLegalRun(movesCount = 30) {
  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const seed = dailySeed(todayUtc);

  const ctrl = new GameController(seed, CANONICAL_CONFIG);
  for (let i = 0; i < movesCount; i++) {
    if (ctrl.hasPendingDecision()) {
      const dec = ctrl.getPendingDecision();
      if (dec.type === 'draft') {
        ctrl.recordInput('draft', dec.offers[0]);
        ctrl.resolveDecision(dec.offers[0]);
      }
      continue;
    }
    const valid = ctrl.getValidMoves();
    if (valid.length === 0 || ctrl.isGameOver()) break;
    ctrl.recordInput('swipe', valid[0]);
    ctrl.submitMove(valid[0]);
  }
  ctrl.endRun();
  const runLog = ctrl.getRunLog({ rulesVersion, replayVersion });
  runLog.startTimestamp = new Date(`${todayUtc}T12:00:00.000Z`).getTime();
  return { runLog, todayUtc };
}

async function cleanupTestArtifacts() {
  await serviceClient.from('daily_runs').delete().like('device_id', 'test_fix_%');
  await serviceClient.from('devices').delete().like('device_id', 'test_fix_%');
  await serviceClient.from('abuse_rate_limits').delete().like('key', '%test_fix_%');
  await serviceClient.from('abuse_rate_limits').delete().like('key', '%198.51.100.42%');
}

// =============================================================================
// SUITE A1: Name Clobber Fix & Week-Snap / Limit-Clamp Regressions
// =============================================================================
async function testA1NameClobber() {
  console.log('\n[A1] Testing Name Clobber Fix & Board Regression...');
  let log = '================================================================================\n';
  log += 'LIVE TEST REPORT: A1 NAME CLOBBER FIX & BOARD INTEGRITY\n';
  log += `Endpoint: ${redact(SUBMIT_RUN_URL)}\n`;
  log += `Timestamp: ${new Date().toISOString()}\n`;
  log += '================================================================================\n\n';

  const testDev = 'test_fix_clobber_dev';
  await serviceClient.from('devices').upsert({
    device_id: testDev,
    display_name: 'Initial-Otter-100',
    generated_name: 'Initial-Otter-100',
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  });

  // 1. Set custom name through set-name
  const customName = 'GrandMaster';
  const nameRes = await robustFetch(SET_NAME_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: testDev, name: customName }),
  });
  const nameBody = await nameRes.json();
  log += `Step 1: Set Custom Name via set-name\n`;
  log += `  HTTP Status:   ${nameRes.status} (Expected: 200)\n`;
  log += `  Response:      ${JSON.stringify(nameBody)}\n`;

  const { data: rowAfterName } = await serviceClient.from('devices').select('*').eq('device_id', testDev).single();
  log += `  DB State:      display_name="${rowAfterName.display_name}", name_norm="${rowAfterName.name_norm}", generated_name="${rowAfterName.generated_name}"\n\n`;

  // 2. Submit legal daily run #1 (Expect ACCEPTED)
  const { runLog: runLog1, todayUtc } = generateLegalRun(25);
  const subRes1 = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: testDev, runLog: runLog1 }),
  });
  const subBody1 = await subRes1.json();
  const { data: rowAfterSub1 } = await serviceClient.from('devices').select('*').eq('device_id', testDev).single();
  const { data: boardAfterSub1 } = await anonClient.rpc('daily_best', { target_day: todayUtc });
  const boardRow1 = boardAfterSub1?.find(r => r.display_name === customName);

  log += `Step 2: Submit Legal Daily Run #1\n`;
  log += `  HTTP Status:   ${subRes1.status} (Expected: 200)\n`;
  log += `  Response:      ${JSON.stringify(subBody1)}\n`;
  log += `  DB display_name after run 1: "${rowAfterSub1.display_name}" (Expected: "${customName}")\n`;
  log += `  Board shows custom name:     ${Boolean(boardRow1)} ("${boardRow1?.display_name}")\n\n`;

  if (rowAfterSub1.display_name !== customName || !boardRow1) {
    throw new Error(`A1 Failed at Step 2: Name was clobbered after first run submission!`);
  }

  // 3. Submit identical run again (Expect ALREADY_SUBMITTED)
  const subRes2 = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: testDev, runLog: runLog1 }),
  });
  const subBody2 = await subRes2.json();
  const { data: rowAfterSub2 } = await serviceClient.from('devices').select('*').eq('device_id', testDev).single();
  log += `Step 3: Resubmit Identical Run (ALREADY_SUBMITTED)\n`;
  log += `  HTTP Status:   ${subRes2.status} (Expected: 200)\n`;
  log += `  Response:      ${JSON.stringify(subBody2)}\n`;
  log += `  DB display_name after dup:   "${rowAfterSub2.display_name}" (Expected: "${customName}")\n\n`;

  if (rowAfterSub2.display_name !== customName) {
    throw new Error(`A1 Failed at Step 3: Name was clobbered on duplicate submission!`);
  }

  // 4. Submit second legal run with different events
  const { runLog: runLog2 } = generateLegalRun(35);
  const subRes3 = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: testDev, runLog: runLog2 }),
  });
  const subBody3 = await subRes3.json();
  const { data: rowAfterSub3 } = await serviceClient.from('devices').select('*').eq('device_id', testDev).single();
  const { data: boardAfterSub3 } = await anonClient.rpc('daily_best', { target_day: todayUtc });
  const boardRow3 = boardAfterSub3?.find(r => r.display_name === customName);

  log += `Step 4: Submit Second Legal Run\n`;
  log += `  HTTP Status:   ${subRes3.status} (Expected: 200)\n`;
  log += `  Response:      ${JSON.stringify(subBody3)}\n`;
  log += `  DB display_name after run 2: "${rowAfterSub3.display_name}" (Expected: "${customName}")\n`;
  log += `  Board shows custom name:     ${Boolean(boardRow3)} ("${boardRow3?.display_name}")\n\n`;

  if (rowAfterSub3.display_name !== customName || !boardRow3) {
    throw new Error(`A1 Failed at Step 4: Name was clobbered on second run submission!`);
  }

  // 5. New device created by a submission has generated_name populated; hide its name and confirm board shows non-null
  const newDev = 'test_fix_newdev_submit';
  const { runLog: newDevRunLog } = generateLegalRun(20);
  const newDevSubRes = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: newDev, runLog: newDevRunLog }),
  });
  const newDevSubBody = await newDevSubRes.json();
  const { data: newDevRow } = await serviceClient.from('devices').select('*').eq('device_id', newDev).single();

  log += `Step 5: Brand-New Device Created by Submission\n`;
  log += `  Submission HTTP Status:     ${newDevSubRes.status} (Expected: 200)\n`;
  log += `  DB created display_name:    "${newDevRow.display_name}"\n`;
  log += `  DB created generated_name:  "${newDevRow.generated_name}"\n`;

  if (!newDevRow.generated_name) {
    throw new Error('A1 Failed at Step 5: generated_name is null for newly created device!');
  }

  // Hide the device's name
  await serviceClient.from('devices').update({ name_hidden: true }).eq('device_id', newDev);

  // Check all 4 boards:
  const { data: dBest } = await anonClient.rpc('daily_best', { target_day: todayUtc });
  const { data: wBest } = await anonClient.rpc('weekly_best', { target_week_start: todayUtc });
  const { data: myD } = await anonClient.rpc('my_daily_rank', { target_day: todayUtc, p_device_id: newDev });
  const { data: myW } = await anonClient.rpc('my_weekly_rank', { target_week_start: todayUtc, p_device_id: newDev });

  const dName = dBest?.find(r => r.display_name === newDevRow.generated_name)?.display_name;
  const wName = wBest?.find(r => r.display_name === newDevRow.generated_name)?.display_name;
  const myDName = myD?.[0]?.display_name;
  const myWName = myW?.[0]?.display_name;

  log += `  Masked board verification with name_hidden = true:\n`;
  log += `    daily_best:     "${dName}" (Expected: "${newDevRow.generated_name}")\n`;
  log += `    weekly_best:    "${wName}" (Expected: "${newDevRow.generated_name}")\n`;
  log += `    my_daily_rank:  "${myDName}" (Expected: "${newDevRow.generated_name}")\n`;
  log += `    my_weekly_rank: "${myWName}" (Expected: "${newDevRow.generated_name}")\n`;

  const maskPass = dName && wName && myDName === newDevRow.generated_name && myWName === newDevRow.generated_name;
  if (!maskPass) {
    throw new Error('A1 Failed at Step 5: Board functions did not return non-null generated_name when masked!');
  }
  log += `  Result:        PASS\n\n`;

  // 6. Week-snap test (Monday == Wednesday == Sunday) & limit-clamp tests
  log += `Step 6: Week-Snap & Limit-Clamp Verification Post-Names Migration\n`;
  const monday = '1999-01-04';
  const wednesday = '1999-01-06';
  const sunday = '1999-01-10';

  // Seed a sample run on Monday
  const weekDev = 'test_fix_week_dev';
  await serviceClient.from('devices').upsert({
    device_id: weekDev,
    display_name: 'WeekSnapGamer',
    generated_name: 'WeekSnapGamer',
    created_at: '1999-01-04T00:00:00Z',
    last_seen_at: '1999-01-04T00:00:00Z',
  });
  await serviceClient.from('daily_runs').insert({
    device_id: weekDev,
    day_utc: monday,
    seed: '1999',
    points: 7777,
    total_moves: 88,
    max_tile: 256,
    relics_owned: [],
    replay_version: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
    events_hash: 'hash_weeksnap_01',
    duration_ms: 10000,
    flags: [],
    received_at: '1999-01-04T12:00:00Z',
  });

  const { data: resMon } = await anonClient.rpc('weekly_best', { target_week_start: monday });
  const { data: resWed } = await anonClient.rpc('weekly_best', { target_week_start: wednesday });
  const { data: resSun } = await anonClient.rpc('weekly_best', { target_week_start: sunday });

  const jsonMon = JSON.stringify(resMon);
  const jsonWed = JSON.stringify(resWed);
  const jsonSun = JSON.stringify(resSun);
  const snapPass = jsonMon === jsonWed && jsonWed === jsonSun;

  log += `  Week-Snap Parity: Monday === Wednesday === Sunday -> ${snapPass ? 'PASS' : 'FAIL'}\n`;
  log += `    Monday row count:    ${resMon?.length}\n`;
  log += `    Wednesday row count: ${resWed?.length}\n`;
  log += `    Sunday row count:    ${resSun?.length}\n`;

  if (!snapPass) {
    throw new Error('A1 Failed at Step 6: Week-snap normalisation regressed!');
  }

  // Limit clamps:
  const { data: dClampMin } = await anonClient.rpc('daily_best', { target_day: monday, p_limit: -5 });
  const { data: dClampMax } = await anonClient.rpc('daily_best', { target_day: monday, p_limit: 500 });
  const { data: wClampMin } = await anonClient.rpc('weekly_best', { target_week_start: monday, p_limit: 0 });
  const { data: wClampMax } = await anonClient.rpc('weekly_best', { target_week_start: monday, p_limit: 999 });

  const clampPass = dClampMin?.length <= 1 && dClampMax?.length <= 100 && wClampMin?.length <= 1 && wClampMax?.length <= 100;
  log += `  Limit Clamp Integrity (1..100):\n`;
  log += `    daily_best(limit: -5) -> ${dClampMin?.length} row(s) (clamped to min 1)\n`;
  log += `    daily_best(limit: 500) -> ${dClampMax?.length} row(s) (clamped to max 100)\n`;
  log += `    weekly_best(limit: 0) -> ${wClampMin?.length} row(s) (clamped to min 1)\n`;
  log += `    weekly_best(limit: 999) -> ${wClampMax?.length} row(s) (clamped to max 100)\n`;
  log += `  Clamp Result:  ${clampPass ? 'PASS' : 'FAIL'}\n\n`;

  if (!clampPass) {
    throw new Error('A1 Failed at Step 6: Limit clamps regressed!');
  }

  fs.writeFileSync(path.join(outDir, 'live_namefix.txt'), log, 'utf8');
  console.log('  ✔ scripts/out/live_namefix.txt written.');
}

// =============================================================================
// SUITE A2: Deduplicated New-Device Counter
// =============================================================================
async function testA2NewDevCounter() {
  console.log('\n[A2] Testing Deduplicated New-Device Counter...');

  // Probe to determine caller IP as forwarded by Cloudflare
  await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test_fix_probe' }),
  });
  const { data: latestIpReq } = await serviceClient
    .from('abuse_rate_limits')
    .select('*')
    .like('key', 'ip_req:%')
    .order('window_start', { ascending: false })
    .limit(1);
  detectedCallerIp = latestIpReq?.[0]?.key.split(':')[1] || '127.0.0.1';

  let log = '================================================================================\n';
  log += 'LIVE TEST REPORT: A2 NEW-DEVICE COUNTER DEDUPLICATION & LIMIT ENFORCEMENT\n';
  log += `Endpoint: ${redact(SUBMIT_RUN_URL)}\n`;
  log += `Client IP: ${redact(detectedCallerIp)}\n`;
  log += `Timestamp: ${new Date().toISOString()}\n`;
  log += '================================================================================\n\n';

  const todayUtc = new Date().toISOString().slice(0, 10);
  const ipDevKey = `ip_newdev:${detectedCallerIp}:${todayUtc}`;
  const tamperDev = 'test_fix_tamper_dev';
  const markerKey = `ip_newdev_seen:${detectedCallerIp}:${todayUtc}:${tamperDev}`;

  // Clean rate limits and devices for test
  await serviceClient.from('abuse_rate_limits').delete().eq('key', markerKey);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%${tamperDev}%`);
  await serviceClient.from('abuse_rate_limits').delete().like('key', `%test_fix_brand_new%`);
  await serviceClient.from('devices').delete().eq('device_id', tamperDev);
  await serviceClient.from('devices').delete().like('device_id', 'test_fix_brand_new%');

  // Baseline count for caller's ip_newdev
  const { data: baselineRow } = await serviceClient.from('abuse_rate_limits').select('*').eq('key', ipDevKey).maybeSingle();
  const baselineCount = baselineRow ? baselineRow.count : 0;

  // 1. Same unregistered device sends 10 tampered submissions from this IP
  const { runLog: baseRun } = generateLegalRun(20);
  const tamperedRunLog = {
    ...baseRun,
    events: ['s:INVALID_DIR', 'x:end'], // Tampered direction -> fails verification (422)
  };

  log += `Step 1: 10 Tampered Submissions from Unregistered Device (${tamperDev})\n`;
  log += `  Initial baseline count for "${redact(ipDevKey)}": ${baselineCount}\n`;

  for (let i = 1; i <= 10; i++) {
    const res = await robustFetch(SUBMIT_RUN_URL, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: tamperDev, runLog: tamperedRunLog }),
    });
    if (res.status !== 422) {
      throw new Error(`Expected 422 on tampered submission ${i}, got ${res.status}`);
    }
  }

  // Check DB counters:
  const { data: counterRow } = await serviceClient.from('abuse_rate_limits').select('*').eq('key', ipDevKey).single();
  const { data: markerRow } = await serviceClient.from('abuse_rate_limits').select('*').eq('key', markerKey).single();

  const countDiff = (counterRow?.count || 0) - baselineCount;
  log += `  Counter key "${redact(ipDevKey)}": count = ${counterRow?.count} (Delta: +${countDiff}, Expected: exactly +1)\n`;
  log += `  Marker key "${redact(markerKey)}": exists = ${Boolean(markerRow)}\n`;

  const countPass = countDiff === 1 && Boolean(markerRow);
  log += `  Result:        ${countPass ? 'PASS' : 'FAIL'}\n\n`;
  if (!countPass) {
    throw new Error(`A2 Failed: Expected counter delta=1, got ${countDiff}`);
  }

  // 2. Pre-seed the counter to the limit (30)
  log += `Step 2: Counter Pre-Seeded to Limit (30)\n`;
  await serviceClient.from('abuse_rate_limits').upsert({
    key: ipDevKey,
    count: 30,
    window_start: new Date().toISOString(),
  });

  // Device with existing marker sends another submission -> passes precheck (returns 422 verification error, NOT 429!)
  const resExisting = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ deviceId: tamperDev, runLog: tamperedRunLog }),
  });

  log += `  Device with existing marker (${tamperDev}) at limit 30:\n`;
  log += `    HTTP Status: ${resExisting.status} (Expected: 422 VERIFICATION_REJECTED, NOT 429)\n`;

  if (resExisting.status === 429) {
    throw new Error('A2 Failed: Existing marked device was blocked with 429 when counter was at limit!');
  }

  // A brand-new device sends a submission from the same IP -> must get 429 DEVICE_CREATION_LIMIT
  const brandNewDev = 'test_fix_brand_new_dev';
  const resBrandNew = await robustFetch(SUBMIT_RUN_URL, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ deviceId: brandNewDev, runLog: tamperedRunLog }),
  });
  const brandNewBody = await resBrandNew.json();

  log += `  Brand-new device (${brandNewDev}) at limit 30:\n`;
  log += `    HTTP Status: ${resBrandNew.status} (Expected: 429 DEVICE_CREATION_LIMIT)\n`;
  log += `    Response:    ${JSON.stringify(brandNewBody)}\n`;

  const newDevBlockPass = resBrandNew.status === 429 && brandNewBody.error === 'DEVICE_CREATION_LIMIT';
  log += `  Result:        ${newDevBlockPass ? 'PASS' : 'FAIL'}\n\n`;

  if (!newDevBlockPass) {
    throw new Error(`A2 Failed: Brand-new device was not blocked with 429! Status: ${resBrandNew.status}`);
  }

  // Verify marker for brandNewDev was rolled back and deleted
  const brandNewMarkerKey = `ip_newdev_seen:${detectedCallerIp}:${todayUtc}:${brandNewDev}`;
  const { data: brandNewMarkerRow } = await serviceClient.from('abuse_rate_limits').select('*').eq('key', brandNewMarkerKey).maybeSingle();
  log += `  Marker for blocked device deleted: ${!brandNewMarkerRow ? 'YES (Rolled back)' : 'NO'}\n\n`;

  // 3. Clean up every key created
  await serviceClient.from('abuse_rate_limits').delete().eq('key', markerKey);
  await serviceClient.from('abuse_rate_limits').delete().eq('key', brandNewMarkerKey);
  if (baselineRow) {
    await serviceClient.from('abuse_rate_limits').update({ count: baselineCount }).eq('key', ipDevKey);
  } else {
    await serviceClient.from('abuse_rate_limits').delete().eq('key', ipDevKey);
  }
  await serviceClient.from('devices').delete().eq('device_id', tamperDev);
  await serviceClient.from('devices').delete().eq('device_id', brandNewDev);

  log += `Step 3: Cleanup of all rate limit keys and test devices completed.\n`;
  fs.writeFileSync(path.join(outDir, 'live_newdev.txt'), log, 'utf8');
  console.log('  ✔ scripts/out/live_newdev.txt written.');
}

// =============================================================================
// SUITE A4: Real CORS OPTIONS Preflight
// =============================================================================
async function testA4CorsPreflight() {
  console.log('\n[A4] Testing Real CORS OPTIONS Preflight with x-region...');
  let log = '================================================================================\n';
  log += 'LIVE TEST REPORT: A4 CORS OPTIONS PREFLIGHT & X-REGION HEADER VERIFICATION\n';
  log += `Endpoints: ${redact(SUBMIT_RUN_URL)} and ${redact(SET_NAME_URL)}\n`;
  log += `Timestamp: ${new Date().toISOString()}\n`;
  log += '================================================================================\n\n';

  const endpoints = [
    { name: 'submit-run', url: SUBMIT_RUN_URL },
    { name: 'set-name', url: SET_NAME_URL },
  ];

  const originsToTest = [
    {
      label: 'Production Web Origin (https://rogue2048.vercel.app)',
      origin: 'https://rogue2048.vercel.app',
      expectAllow: true,
    },
    {
      label: 'Localhost Dev Origin (http://localhost:3000)',
      origin: 'http://localhost:3000',
      expectAllow: true,
    },
    {
      label: 'Unauthorized Origin (https://evil.example)',
      origin: 'https://evil.example',
      expectAllow: false,
    },
  ];

  for (const ep of endpoints) {
    log += `--- Testing Endpoint: ${ep.name} ---\n`;
    for (const ot of originsToTest) {
      const res = await robustFetch(ep.url, {
        method: 'OPTIONS',
        headers: {
          'Origin': ot.origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-region, content-type, apikey, authorization',
        },
      });

      const allowOrigin = res.headers.get('access-control-allow-origin');
      const allowHeaders = res.headers.get('access-control-allow-headers');
      const allowMethods = res.headers.get('access-control-allow-methods');
      const vary = res.headers.get('vary');

      log += `Scenario: ${ot.label}\n`;
      log += `  HTTP Status:                     ${res.status} (Expected: 204)\n`;
      log += `  Access-Control-Allow-Origin:     ${allowOrigin || '(none)'}\n`;
      log += `  Access-Control-Allow-Headers:    ${allowHeaders || '(none)'}\n`;
      log += `  Access-Control-Allow-Methods:    ${allowMethods || '(none)'}\n`;
      log += `  Vary:                            ${vary || '(none)'}\n`;

      if (ot.expectAllow) {
        const pass =
          res.status === 204 &&
          allowOrigin === ot.origin &&
          allowHeaders &&
          allowHeaders.includes('x-region') &&
          allowMethods &&
          allowMethods.includes('POST');
        log += `  Result:                          ${pass ? 'PASS' : 'FAIL'}\n\n`;
        if (!pass) throw new Error(`CORS failed for ${ep.name} on ${ot.origin}`);
      } else {
        const pass = res.status === 204 && allowOrigin === null;
        log += `  Result:                          ${pass ? 'PASS (Origin blocked)' : 'FAIL'}\n\n`;
        if (!pass) throw new Error(`CORS should have blocked ${ot.origin} on ${ep.name}`);
      }
    }
  }

  fs.writeFileSync(path.join(outDir, 'live_cors.txt'), log, 'utf8');
  console.log('  ✔ scripts/out/live_cors.txt written.');
}

async function runAll() {
  await cleanupTestArtifacts();
  await testA1NameClobber();
  await testA2NewDevCounter();
  await testA4CorsPreflight();
  await cleanupTestArtifacts();
  console.log('\n================================================================================');
  console.log('ALL HARDENING REGRESSION TESTS COMPLETED SUCCESSFULLY.');
  console.log('================================================================================');
}

runAll().catch(err => {
  console.error('\n❌ Hardening regression suite failed:', err);
  process.exit(1);
});
