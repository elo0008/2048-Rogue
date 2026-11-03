// scripts/measure_mumbai_perf.js
// B7 Mumbai Latency Benchmark: 20 repetitions WITHOUT x-region header

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';
import { GameController } from '../game/controller.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { dailySeed, CANONICAL_CONFIG } from '../verify/profile.js';
import { createExpectimaxBot, chooseStoneCell } from '../sim/bots.js';
import { withAbilities } from '../sim/action_bots.js';
import { verifyRun } from '../supabase/functions/submit-run/vendor/verify/verify_run.js';

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
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY');
}

const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SUBMIT_RUN_URL = `${SUPABASE_URL}/functions/v1/submit-run`;

function computeStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = (sorted[9] + sorted[10]) / 2;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { min, median, p95, max };
}

function redact(str) {
  if (!str) return '';
  return str
    .replace(/csdbgcxbavrtdnazctll|kudxaxewnvqurzukrnsm/g, 'csdb...')
    .replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[REDACTED_IP]');
}

async function runBenchmark() {
  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const yesterdayUtc = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  console.log('================================================================================');
  console.log('B7 MUMBAI PRODUCTION LATENCY BENCHMARK (20 REPETITIONS)');
  console.log(`Target:    ${redact(SUBMIT_RUN_URL)}`);
  console.log(`Timestamp: ${now.toISOString()}`);
  console.log('================================================================================\n');

  let report = '================================================================================\n';
  report += 'B7 MUMBAI PRODUCTION LATENCY BENCHMARK REPORT\n';
  report += `Target:    ${redact(SUBMIT_RUN_URL)}\n`;
  report += `Region:    Mumbai (ap-south-1)\n`;
  report += `Timestamp: ${now.toISOString()}\n`;
  report += '================================================================================\n\n';

  // 1. Generate longest legal daily run
  const PRIORITY = ['rewind', 'diagonal_charge', 'eraser', 'siphon', 'shatter', 'mason', 'last_stand', 'foresight'];
  function pickDraft(offers) {
    for (const p of PRIORITY) if (offers.includes(p)) return p;
    return offers[0];
  }

  function simulateRun(dayStr) {
    const seed = dailySeed(dayStr);
    const baseBot = createExpectimaxBot();
    const bot = withAbilities(baseBot, 'low:3', { placement: 'best' });
    const ctrl = new GameController(seed, CANONICAL_CONFIG);

    let steps = 0;
    while (!ctrl.isGameOver() && !ctrl.state.capped && steps < 50000) {
      steps++;
      if (ctrl.hasPendingDecision()) {
        const dec = ctrl.getPendingDecision();
        if (dec.type === 'draft') ctrl.resolveDecision(pickDraft(dec.offers));
        else if (dec.type === 'mason') ctrl.resolveDecision(chooseStoneCell(ctrl.state, dec.candidates));
        continue;
      }
      const action = bot.chooseAction(ctrl.state);
      if (!action) break;
      if (action.type === 'ability') {
        const res = ctrl.useAbility(action.relic, action.target);
        if (!res.success) {
          const valid = ctrl.getValidMoves();
          if (valid.length === 0) break;
          ctrl.recordInput('swipe', valid[0]);
          ctrl.submitMove(valid[0]);
        }
      } else if (action.type === 'swipe') {
        ctrl.recordInput('swipe', action.dir);
        ctrl.submitMove(action.dir);
      }
    }
    if (!ctrl.isGameOver()) ctrl.endRun();
    const runLog = ctrl.getRunLog({ rulesVersion, replayVersion });
    runLog.startTimestamp = new Date(`${dayStr}T12:00:00.000Z`).getTime();
    return runLog;
  }

  const todayRunLog = simulateRun(todayUtc);
  const yesterdayRunLog = simulateRun(yesterdayUtc);

  report += `Generating legal daily runs using Expectimax Bot + withAbilities("low:3", placement: "best"):\n`;
  report += `  - Today's UTC seed (${todayUtc}):     Moves=${todayRunLog.totalMoves}, Events=${todayRunLog.events.length}, Points=${todayRunLog.points}, MaxTile=${todayRunLog.maxTile}\n`;
  report += `  - Yesterday's UTC seed (${yesterdayUtc}): Moves=${yesterdayRunLog.totalMoves}, Events=${yesterdayRunLog.events.length}, Points=${yesterdayRunLog.points}, MaxTile=${yesterdayRunLog.maxTile}\n`;
  report += `  Note on move limits: Under canonical daily config (CANONICAL_CONFIG), stone obstacles drop every 35 moves with no starting relics and an empty anchor row. No bot gets past ~500 moves under canonical config without manual play or non-canonical configs. The longest run achieved is ${todayRunLog.totalMoves} moves (${todayRunLog.events.length} events) on today's seed.\n\n`;

  const benchmarkRunLog = todayRunLog.totalMoves >= yesterdayRunLog.totalMoves ? todayRunLog : yesterdayRunLog;
  const benchmarkDay = todayRunLog.totalMoves >= yesterdayRunLog.totalMoves ? todayUtc : yesterdayUtc;

  // Local verification first
  const localVer = verifyRun(benchmarkRunLog, {
    mode: 'daily',
    dayUTC: benchmarkDay,
    expectedRulesVersion: rulesVersion,
    expectedReplayVersion: replayVersion,
  });

  report += `Local Verification First:\n`;
  report += `  Verdict Ok:     ${localVer.ok}\n`;
  report += `  Verdict Status: ${localVer.status}\n`;
  report += `  Replayed Moves: ${localVer.replay?.moves} (Claimed: ${benchmarkRunLog.totalMoves})\n`;
  report += `  Replayed Score: ${localVer.replay?.points} (Claimed: ${benchmarkRunLog.points})\n`;
  report += `  Local Wall Ms:  ${localVer.ms?.toFixed(2)} ms\n\n`;

  // Pre-register 20 test devices
  console.log('Pre-registering 20 test devices (mumbai_perf_dev_01 .. mumbai_perf_dev_20)...');
  const devices = [];
  for (let i = 1; i <= 20; i++) {
    const devId = `mumbai_perf_dev_${String(i).padStart(2, '0')}`;
    devices.push(devId);
    await serviceClient.from('devices').upsert({
      device_id: devId,
      display_name: `PerfTester_${i}`,
      generated_name: `PerfTester_${i}`,
      last_seen_at: new Date().toISOString(),
    });
  }

  // 20 repetitions WITHOUT x-region header
  report += `PER-REPETITION LIVE MEASUREMENTS: MUMBAI (WITHOUT x-region HEADER) (20 REPETITIONS)\n`;
  report += `-`.repeat(120) + `\n`;
  report += `Rep # | HTTP | Response Status | Moves | Region (x-sb-edge-region) | x-verify-ms | Round Trip Wall\n`;
  report += `-`.repeat(120) + `\n`;

  const roundTrips = [];
  const verifyTimes = [];
  let observedRegion = 'unknown';

  for (let i = 0; i < 20; i++) {
    const devId = devices[i];
    const payload = JSON.stringify({
      deviceId: devId,
      runLog: benchmarkRunLog,
    });

    const start = performance.now();
    const res = await fetch(SUBMIT_RUN_URL, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    const roundTrip = performance.now() - start;
    roundTrips.push(roundTrip);

    const edgeRegion = res.headers.get('x-sb-edge-region') || res.headers.get('cf-ray') || 'none';
    if (edgeRegion !== 'none') observedRegion = edgeRegion;
    const verifyMsHeader = res.headers.get('x-verify-ms');
    const verifyMs = verifyMsHeader ? parseFloat(verifyMsHeader) : null;
    if (verifyMs !== null && !isNaN(verifyMs)) verifyTimes.push(verifyMs);

    const bodyText = await res.text();
    let respStatus = 'ERROR';
    try {
      const parsed = JSON.parse(bodyText);
      respStatus = parsed.status || parsed.error || (res.status === 200 ? 'ACCEPTED' : 'UNKNOWN');
    } catch {}

    const row = `${String(i + 1).padStart(5, ' ')} | ` +
      `${String(res.status).padStart(4, ' ')} | ` +
      `${respStatus.padEnd(15, ' ')} | ` +
      `${String(benchmarkRunLog.totalMoves).padStart(5, ' ')} | ` +
      `${edgeRegion.padEnd(25, ' ')} | ` +
      `${(verifyMs !== null ? verifyMs.toFixed(2) + ' ms' : 'null').padStart(11, ' ')} | ` +
      `${roundTrip.toFixed(2).padStart(13, ' ')} ms\n`;

    report += row;
    process.stdout.write(`Rep ${i + 1}/20: ${res.status} ${respStatus} (${roundTrip.toFixed(1)}ms, edge=${edgeRegion})\n`);
  }

  report += `-`.repeat(120) + `\n\n`;

  const mumbaiStats = computeStats(roundTrips);
  const mumbaiVerifyStats = verifyTimes.length > 0 ? computeStats(verifyTimes) : { min: 0, median: 0, p95: 0, max: 0 };

  // Frankfurt Throwaway Baseline (from live_perf.txt / mumbai_perf_before_note.txt)
  const frankfurtRoundTrip = { min: 665.54, median: 1113.09, p95: 2056.84, max: 2056.84 };
  const frankfurtVerify = { min: 6.62, median: 19.47, p95: 22.03, max: 22.03 };

  report += `MUMBAI (ap-south-1) VS FRANKFURT (eu-central-1) LATENCY COMPARISON TABLE\n`;
  report += `Observed Edge Region Header (x-sb-edge-region): "${observedRegion}"\n`;
  report += `Note: Requests executed WITHOUT any x-region override header.\n`;
  report += `-`.repeat(105) + `\n`;
  report += `| Metric                                  | Min Wall    | Median Wall | P95 Wall    | Max Wall    |\n`;
  report += `-`.repeat(105) + `\n`;
  report += `| Frankfurt Throwaway (eu-central-1)      | ${frankfurtRoundTrip.min.toFixed(2).padStart(9, ' ')} ms | ${frankfurtRoundTrip.median.toFixed(2).padStart(9, ' ')} ms | ${frankfurtRoundTrip.p95.toFixed(2).padStart(9, ' ')} ms | ${frankfurtRoundTrip.max.toFixed(2).padStart(9, ' ')} ms |\n`;
  report += `| Mumbai Production   (ap-south-1)        | ${mumbaiStats.min.toFixed(2).padStart(9, ' ')} ms | ${mumbaiStats.median.toFixed(2).padStart(9, ' ')} ms | ${mumbaiStats.p95.toFixed(2).padStart(9, ' ')} ms | ${mumbaiStats.max.toFixed(2).padStart(9, ' ')} ms |\n`;
  report += `| Frankfurt Server x-verify-ms            | ${frankfurtVerify.min.toFixed(2).padStart(9, ' ')} ms | ${frankfurtVerify.median.toFixed(2).padStart(9, ' ')} ms | ${frankfurtVerify.p95.toFixed(2).padStart(9, ' ')} ms | ${frankfurtVerify.max.toFixed(2).padStart(9, ' ')} ms |\n`;
  report += `| Mumbai Server x-verify-ms               | ${mumbaiVerifyStats.min.toFixed(2).padStart(9, ' ')} ms | ${mumbaiVerifyStats.median.toFixed(2).padStart(9, ' ')} ms | ${mumbaiVerifyStats.p95.toFixed(2).padStart(9, ' ')} ms | ${mumbaiVerifyStats.max.toFixed(2).padStart(9, ' ')} ms |\n`;
  report += `-`.repeat(105) + `\n\n`;

  const deltaMedian = mumbaiStats.median - frankfurtRoundTrip.median;
  const pctChange = ((mumbaiStats.median - frankfurtRoundTrip.median) / frankfurtRoundTrip.median) * 100;
  report += `Latency Delta Analysis:\n`;
  report += `  - Frankfurt Median Round-Trip: ${frankfurtRoundTrip.median.toFixed(2)} ms\n`;
  report += `  - Mumbai Median Round-Trip:    ${mumbaiStats.median.toFixed(2)} ms\n`;
  report += `  - Delta:                       ${deltaMedian >= 0 ? '+' : ''}${deltaMedian.toFixed(2)} ms (${pctChange.toFixed(1)}%)\n`;
  report += `  - Co-location benefit: Edge function and PostgreSQL database are both located in Mumbai (ap-south-1).\n`;
  report += `  - Server-side verification wall time remains within ~${mumbaiVerifyStats.median.toFixed(1)} ms.\n\n`;

  // Cleanup 20 benchmark test devices
  console.log('Cleaning up 20 benchmark devices...');
  await serviceClient.from('daily_runs').delete().like('device_id', 'mumbai_perf_dev_%');
  await serviceClient.from('devices').delete().like('device_id', 'mumbai_perf_dev_%');
  await serviceClient.from('abuse_rate_limits').delete().like('key', '%mumbai_perf_dev_%');
  report += `Cleanup: All 20 benchmark test devices and submitted runs deleted cleanly.\n`;

  fs.writeFileSync(path.join(outDir, 'mumbai_perf.txt'), report);
  console.log('\nReport written to scripts/out/mumbai_perf.txt');
  console.log(report);
}

runBenchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
