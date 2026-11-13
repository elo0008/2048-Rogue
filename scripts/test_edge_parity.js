// scripts/test_edge_parity.js
// Measures parity between local Node verifyRun and Edge Runtime submit-run handler

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyRun, extractSubmission, CANONICAL_CONFIG } from '../verify/verify_run.js';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';
import { dailySeed } from '../verify/profile.js';
import { GameController } from '../game/controller.js';
import { handleSubmissionRequest } from '../supabase/functions/submit-run/handler.ts';
import { buildEdgeVendor } from './build_edge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function generateDailyRun(dayStr, movesTarget, rulesVersion, replayVersion) {
  const seed = dailySeed(dayStr);
  const ctrl = new GameController(seed, CANONICAL_CONFIG);
  for (let i = 0; i < movesTarget; i++) {
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
  if (!ctrl.isGameOver()) {
    ctrl.endRun();
  }
  const runLog = ctrl.getRunLog({ rulesVersion, replayVersion });
  runLog.startTimestamp = new Date(`${dayStr}T12:00:00.000Z`).getTime();
  return runLog;
}

async function run() {
  console.log('[test_edge_parity] Starting Edge Parity Benchmark...');

  // Ensure vendor bundle is up to date
  buildEdgeVendor();

  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);

  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const yesterdayUtc = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  const testSuites = [
    { name: 'daily_today_15m', day: todayUtc, moves: 15 },
    { name: 'daily_today_30m', day: todayUtc, moves: 30 },
    { name: 'daily_today_50m', day: todayUtc, moves: 50 },
    { name: 'daily_today_60m_draft', day: todayUtc, moves: 60 },
    { name: 'daily_today_full', day: todayUtc, moves: 100 },
    { name: 'daily_yesterday_20m', day: yesterdayUtc, moves: 20 },
    { name: 'daily_yesterday_40m', day: yesterdayUtc, moves: 40 },
    { name: 'daily_yesterday_full', day: yesterdayUtc, moves: 100 },
  ];

  const results = [];

  for (const tc of testSuites) {
    const runLog = generateDailyRun(tc.day, tc.moves, rulesVersion, replayVersion);
    const eventCount = Array.isArray(runLog.events) ? runLog.events.length : 0;

    // 1. Direct Node verifyRun verdict
    const nodeVerdict = verifyRun(runLog, {
      mode: 'daily',
      dayUTC: tc.day,
      expectedRulesVersion: rulesVersion,
      expectedReplayVersion: replayVersion,
    });
    const nodeSub = await extractSubmission(runLog, nodeVerdict);

    // 2. Edge runtime request
    const req = new Request('http://localhost:54321/functions/v1/submit-run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://rogue2048.vercel.app',
        'cf-connecting-ip': '127.0.0.1',
      },
      body: JSON.stringify({
        runLog,
        deviceId: 'anon_orhdnvl4',
      }),
    });

    const mockDb = {
      precheckSubmission: async () => ({ ok: true, reason: null, retry_scope: null }),
      recordSubmission: async (params) => ({
        status: 'ACCEPTED',
        id: 1,
        deviceId: params.deviceId,
        displayName: params.displayName,
        dayUtc: params.dayUtc,
        points: params.points,
        totalMoves: params.totalMoves,
        maxTile: params.maxTile,
        eventsHash: params.eventsHash,
        isNewDevice: true,
      }),
    };
    const edgeRes = await handleSubmissionRequest(req, mockDb);
    assert.strictEqual(edgeRes.status, 200, `Edge submission failed for ${tc.name}: ${edgeRes.status}`);
    const edgeBody = await edgeRes.json();
    const edgeVerdict = edgeBody.verdict;

    // Assert parity
    assert.strictEqual(nodeVerdict.status, edgeVerdict.status, `Status mismatch for ${tc.name}`);
    assert.strictEqual(nodeSub.points, edgeVerdict.points, `Points mismatch for ${tc.name}`);
    assert.strictEqual(nodeSub.moves, edgeVerdict.moves, `Moves mismatch for ${tc.name}`);
    assert.strictEqual(nodeSub.maxTile, edgeVerdict.maxTile, `MaxTile mismatch for ${tc.name}`);
    assert.strictEqual(nodeSub.eventsHash, edgeVerdict.eventsHash, `EventsHash mismatch for ${tc.name}`);

    results.push({
      runName: tc.name,
      events: eventCount,
      node: {
        status: nodeVerdict.status,
        points: nodeSub.points,
        moves: nodeSub.moves,
        maxTile: nodeSub.maxTile,
        eventsHash: nodeSub.eventsHash,
      },
      edge: {
        status: edgeVerdict.status,
        points: edgeVerdict.points,
        moves: edgeVerdict.moves,
        maxTile: edgeVerdict.maxTile,
        eventsHash: edgeVerdict.eventsHash,
      },
      match: true,
    });

    console.log(`  ✔ Parity confirmed for ${tc.name} (${eventCount} events): Status=${edgeVerdict.status}, Pts=${edgeVerdict.points}, Moves=${edgeVerdict.moves}, Hash=${edgeVerdict.eventsHash.slice(0, 10)}...`);
  }

  // Generate output file
  let out = '';
  out += '================================================================================\n';
  out += 'SIMULATED EDGE ENVIRONMENT: REPLAY VERIFICATION PARITY REPORT (Node.js)\n';
  out += '================================================================================\n';
  out += `Runtime:          Node.js ${process.version} (Simulated Edge Environment)\n`;
  out += `Database Engine:  In-Memory Mock Database Engine (NOT REAL POSTGRES / SUPABASE CLI)\n`;
  out += `Timestamp:        ${new Date().toISOString()}\n`;
  out += `Rules Version:    ${rulesVersion}\n`;
  out += `Replay Version:   ${replayVersion}\n`;
  out += `Verification:     Mode 'daily' (authoritative leaderboard verification constant)\n\n`;

  out += 'RUN VERIFICATION PARITY TABLE (Node.js vs. Edge Runtime)\n';
  out += '------------------------------------------------------------------------------------------------------------------------\n';
  out += '| Run Log Description     | Events | Node Verdict (Status/Pts/Moves/MaxTile) | Edge Verdict (Status/Pts/Moves/MaxTile) | Parity |\n';
  out += '------------------------------------------------------------------------------------------------------------------------\n';

  for (const r of results) {
    const nodeStr = `${r.node.status} / ${r.node.points} pts / ${r.node.moves} m / max ${r.node.maxTile}`;
    const edgeStr = `${r.edge.status} / ${r.edge.points} pts / ${r.edge.moves} m / max ${r.edge.maxTile}`;
    out += `| ${r.runName.padEnd(23)} | ${String(r.events).padStart(6)} | ${nodeStr.padEnd(39)} | ${edgeStr.padEnd(39)} |  PASS  |\n`;
  }
  out += '------------------------------------------------------------------------------------------------------------------------\n\n';

  out += 'HASH AND AUTHENTICITY DETAILS\n';
  out += '------------------------------------------------------------------------------------------------------------------------\n';
  out += '| Run Log Description     | SHA-256 Events Hash                                              | Hash Match |\n';
  out += '------------------------------------------------------------------------------------------------------------------------\n';
  for (const r of results) {
    out += `| ${r.runName.padEnd(23)} | ${r.edge.eventsHash} |    YES     |\n`;
  }
  out += '------------------------------------------------------------------------------------------------------------------------\n\n';

  out += 'CONCLUSION: All 8 runs show 100% byte-for-byte verdict parity under daily verification mode.\n';
  out += '================================================================================\n';

  const outFilePath = path.join(outDir, 'edge_parity.txt');
  fs.writeFileSync(outFilePath, out, 'utf8');
  console.log(`[test_edge_parity] Successfully written ${outFilePath}`);
}

run().catch(err => {
  console.error('[test_edge_parity] Benchmark failed:', err);
  process.exit(1);
});

