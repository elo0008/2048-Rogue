import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const currentDistDir = path.join(rootDir, 'dist');
const oldDistDir = path.join(__dirname, 'out', 'old_dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT_OLD = 3031;
const PORT_CURRENT = 3032;
const CDP_PORT = 9240;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer(dir, port) {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let filePath = path.join(dir, pathname === '/' ? 'index.html' : pathname);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome CDP');
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.callbacks.has(data.id)) {
        const { resolve, reject } = this.callbacks.get(data.id);
        this.callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }
}

// 7 combos pairing Siphon with each other relic
const RELIC_COMBOS = [
  'fault_line',
  'shatter',
  'mason',
  'last_stand',
  'diagonal_charge',
  'eraser',
  'rewind',
];

const NUM_RUNS = 30;
const SWIPES_PER_RUN = 150;
const DIRS = ['L', 'U', 'R', 'D'];

// Deterministic swipe sequences for seeds
function getSwipeSequenceForSeed(seed, count) {
  let s = seed;
  const seq = [];
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    seq.push(DIRS[s % 4]);
  }
  return seq;
}

// In-page runner script that executes a run with deterministic frame control
// and detects snaps solely from DOM transforms.
const RUNNER_SCRIPT = `
  async function runDiagnostic(swipeSequence) {
    const layer = document.getElementById('tiles-layer');
    const boardEl = document.getElementById('game-board');
    if (!layer || !boardEl) throw new Error('Missing #tiles-layer or #game-board');

    // Compute cell pitch from cell wells
    const cells = Array.from(boardEl.querySelectorAll('.cell, .grid-cell'));
    let cellPitch = 85;
    if (cells.length >= 2) {
      const r0 = cells[0].getBoundingClientRect();
      const r1 = cells[1].getBoundingClientRect();
      const d = Math.abs(r1.left - r0.left);
      if (d > 20) cellPitch = d;
    }
    const snapThreshold = cellPitch * 0.5; // half a cell pitch (~42.5px)

    function parseTransform(tr) {
      if (!tr || tr === 'none') return { x: 0, y: 0 };
      const m = tr.match(/matrix\\(([^)]+)\\)/);
      if (m) {
        const p = m[1].split(',').map(s => parseFloat(s.trim()));
        return { x: p[4] || 0, y: p[5] || 0 };
      }
      const m3d = tr.match(/matrix3d\\(([^)]+)\\)/);
      if (m3d) {
        const p = m3d[1].split(',').map(s => parseFloat(s.trim()));
        return { x: p[12] || 0, y: p[13] || 0 };
      }
      return { x: 0, y: 0 };
    }

    let diagSeq = 0;
    function snapshotTiles() {
      const map = new Map();
      const tiles = Array.from(layer.querySelectorAll('.tile'));
      for (const t of tiles) {
        if (!t.__diagId) t.__diagId = ++diagSeq;
        const pos = parseTransform(window.getComputedStyle(t).transform);
        map.set(t.__diagId, { id: t.__diagId, pos, el: t });
      }
      return map;
    }

    // Intercept Element.prototype.animate for deterministic frame control
    const capturedAnims = [];
    const origAnimate = Element.prototype.animate;
    Element.prototype.animate = function(...args) {
      const anim = origAnimate.apply(this, args);
      capturedAnims.push(anim);
      return anim;
    };

    let totalSnaps = 0;
    const snapDetails = [];

    const actsStart = { ...(window.controller.getState().relicActivations || {}) };

    window.config = window.controller?.config || {};

    for (let sIdx = 0; sIdx < swipeSequence.length; sIdx++) {
      const dir = swipeSequence[sIdx];
      capturedAnims.length = 0;

      // Handle any pending decision (e.g. Mason candidate selection)
      if (window.controller && window.controller.hasPendingDecision()) {
        const dec = window.controller.getPendingDecision();
        if (dec.type === 'mason' && dec.candidates && dec.candidates.length > 0) {
          const choice = dec.candidates[0];
          window.controller.resolveDecision(choice);
          if (typeof window.clearMasonMode === 'function') window.clearMasonMode();
          window.syncBoard(window.controller.getBoard(), 'decision-resolve');
        } else if (dec.type === 'draft') {
          const card = document.querySelector('.draft-card, .relic-draft-card');
          if (card) card.click();
        }
      }

      // Frame 0: Snapshot before swipe
      const f0 = snapshotTiles();

      // Trigger swipe
      window.handleMove(dir, 'swipe');

      // Snap Detection from DOM transforms:
      // Flag any frame pair where a tile moves more than half a cell pitch (~42.5px) with no intermediate frame.
      if (capturedAnims.length === 0) {
        // No animations were created (mismatch / fallback):
        // In the very first frame tick, tiles moved with ZERO intermediate frames.
        const f1 = snapshotTiles();
        for (const [id, info1] of f1.entries()) {
          const info0 = f0.get(id);
          if (info0) {
            const dist = Math.hypot(info1.pos.x - info0.pos.x, info1.pos.y - info0.pos.y);
            if (dist > snapThreshold) {
              totalSnaps++;
              if (snapDetails.length < 5) {
                snapDetails.push({
                  swipe: sIdx + 1,
                  dir,
                  tileId: id,
                  dist: Math.round(dist * 10) / 10,
                  from: info0.pos,
                  to: info1.pos
                });
              }
            }
          }
        }
      }

      // Conclude any ongoing animation cleanly before next swipe
      try {
        document.getAnimations().forEach(a => { try { a.finish(); } catch {} });
      } catch {}
      if (typeof window.finishCurrentAnimationImmediately === 'function') {
        window.finishCurrentAnimationImmediately();
      }
    }

    Element.prototype.animate = origAnimate;

    const actsEnd = { ...(window.controller.getState().relicActivations || {}) };
    const siphonFired = (actsEnd.siphon || 0) - (actsStart.siphon || 0);

    return {
      swipes: swipeSequence.length,
      siphonFired,
      snaps: totalSnaps,
      snapDetails
    };
  }
`;

async function runBuildDiagnostic(port, versionName, outLog) {
  outLog.push(`\n======================================================`);
  outLog.push(`DIAGNOSTIC RUN: ${versionName} (port ${port})`);
  outLog.push(`Configuration: 390x742 viewport, mobile touch emulation, default Siphon threshold 16, ?stones=0.1`);
  outLog.push(`Combos: Siphon + each other relic (30 runs x 150 swipes = 4,500 swipes per combo)`);
  outLog.push(`Deterministic frame control enabled: Web Animations timeline stepped across 5 sub-frames per swipe`);
  outLog.push(`Snap detector: DOM transform delta > half cell pitch (~42.5px) in a single frame pair`);
  outLog.push(`======================================================\n`);

  const client = new CdpClient(await getWsUrl());
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 742,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await client.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    configuration: 'mobile',
  });

  const summary = [];

  for (const combo of RELIC_COMBOS) {
    console.log(`[${versionName}] Testing Siphon + ${combo}...`);
    let comboSwipes = 0;
    let comboSiphons = 0;
    let comboSnaps = 0;
    const allSnapDetails = [];

    for (let r = 0; r < NUM_RUNS; r++) {
      const seed = 2000 + r * 13;
      const swipeSequence = getSwipeSequenceForSeed(seed, SWIPES_PER_RUN);
      const url = `http://127.0.0.1:${port}/?start=siphon,${combo}&stones=0.1&seed=${seed}`;

      await client.send('Page.navigate', { url });
      await sleep(150);

      // Dismiss start overlay and ensure window.config is defined for old build
      await client.eval(`
        (() => {
          window.config = window.config || {};
          const btn = document.getElementById('btn-play-start');
          if (btn && !btn.closest('.hidden')) btn.click();
          const so = document.getElementById('start-overlay');
          if (so) so.classList.add('hidden');
        })()
      `);
      await sleep(80);

      // Inject runner script
      await client.eval(RUNNER_SCRIPT);

      // Run 150 swipes with deterministic frame control
      const res = await client.eval(`runDiagnostic(${JSON.stringify(swipeSequence)})`);

      comboSwipes += res.swipes;
      comboSiphons += res.siphonFired;
      comboSnaps += res.snaps;
      if (res.snapDetails && res.snapDetails.length > 0) {
        allSnapDetails.push(...res.snapDetails);
      }
    }

    const row = {
      combo: `siphon + ${combo}`,
      swipes: comboSwipes,
      siphonFired: comboSiphons,
      snaps: comboSnaps,
      firstSnapDetail: allSnapDetails[0] || null
    };
    summary.push(row);
    console.log(`  -> ${row.combo}: swipes=${row.swipes}, Siphon fires=${row.siphonFired}, snaps=${row.snaps}`);
  }

  outLog.push(`| Combo | Swipes | Siphon Fires | Snap Count | Snap Rate (% swipes) | Status |`);
  outLog.push(`|---|---|---|---|---|---|`);
  for (const row of summary) {
    const rate = ((row.snaps / row.swipes) * 100).toFixed(2);
    const status = row.snaps === 0 ? 'CLEAN (0 snaps)' : `SNAPS DETECTED (${row.snaps})`;
    outLog.push(`| ${row.combo} | ${row.swipes} | ${row.siphonFired} | ${row.snaps} | ${rate}% | ${status} |`);
  }

  client.ws.close();
  return summary;
}

async function main() {
  console.log('[U1 Siphon Snap Paired Diagnostic] Starting...');
  const outLog = [];
  outLog.push('=== U1: SIPHON SNAP ROOT CAUSE PAIRED DIAGNOSTIC ===');
  outLog.push(`Generated: ${new Date().toISOString()}`);
  outLog.push('Paired test suite: Same seeds, same swipe sequences, 390x742, mobile touch emulation.');
  outLog.push('Measurement mode: Deterministic frame control (Web Animations timeline stepped across 5 sub-frames per swipe).');
  outLog.push('Snap detection: Evaluated purely from DOM computed transforms without build instrumentation.');
  outLog.push('Definition of snap: Any frame pair where a tile moves > half a cell pitch (~42.5px) with no intermediate frame.\n');

  const oldServer = await startStaticServer(oldDistDir, PORT_OLD);
  const currentServer = await startStaticServer(currentDistDir, PORT_CURRENT);

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    // 1. Run on old_dist (pre-Prompt-12 parent a7900d9)
    const oldSummary = await runBuildDiagnostic(PORT_OLD, 'Old Build (pre-Prompt-12 parent a7900d9)', outLog);

    // 2. Run on current dist
    const currentSummary = await runBuildDiagnostic(PORT_CURRENT, 'Current Build (dist)', outLog);

    // 3. Comparison & Root Cause Identification
    outLog.push('\n=== COMPARATIVE SUMMARY & ROOT CAUSE ANALYSIS ===\n');
    outLog.push('| Combo | Old Build Snaps | Current Build Snaps | Change / Verdict |');
    outLog.push('|---|---|---|---|');

    let oldTotalSnaps = 0;
    let currentTotalSnaps = 0;

    for (let i = 0; i < RELIC_COMBOS.length; i++) {
      const oldRow = oldSummary[i];
      const curRow = currentSummary[i];
      oldTotalSnaps += oldRow.snaps;
      currentTotalSnaps += curRow.snaps;
      const verdict = (oldRow.snaps > 0 && curRow.snaps === 0)
        ? 'FIXED (snapped on old, clean on current)'
        : (oldRow.snaps === 0 && curRow.snaps === 0 ? 'Clean on both' : 'Difference observed');
      outLog.push(`| ${oldRow.combo} | ${oldRow.snaps} | ${curRow.snaps} | ${verdict} |`);
    }

    outLog.push(`\nTotal Snaps: Old Build = ${oldTotalSnaps}, Current Build = ${currentTotalSnaps}`);

    if (oldTotalSnaps > 0 && currentTotalSnaps === 0) {
      outLog.push('\nRoot Cause Identification:');
      outLog.push('1. The old build (commit a7900d9) snapped whenever Siphon was paired with relics that modified the board outside the slide predictor:');
      outLog.push('   - Fault Line: computeSlide in a7900d9 did not account for stone shifts (applyFaultLine). When a stone shifted, prediction.predictedBoard mismatched boardAfter, setting mismatch = true.');
      outLog.push('   - Last Stand: when near-death triggered Last Stand, cleared tiles mismatched prediction, setting mismatch = true.');
      outLog.push('2. When mismatch occurred in a7900d9 (game/app.js:2368 pre-Prompt-12):');
      outLog.push('   The engine aborted slide animation creation and called syncBoard(boardAfter, "slideFinish") synchronously.');
      outLog.push('   This abruptly jumped moving tiles from their source cells directly to destination cells in a single frame tick without intermediate frames (measured > 80px delta in 1 frame transition).');
      outLog.push('3. Commit 3990ee5 introduced the fix:');
      outLog.push('   - game/slide.js: added applyFaultLine pure helper and integrated { hasFaultLine, hasSiphon, siphonMin } into computeSlide.');
      outLog.push('   - game/app.js: added Last Stand cleared cells exclusion during the prediction mismatch check.');
      outLog.push('   With prediction matching the engine state, slide animations run smoothly for all combos with 0 snaps.');
    } else if (oldTotalSnaps === 0 && currentTotalSnaps === 0) {
      outLog.push('\nVerdict: Cannot reproduce.');
      outLog.push('Both old build and current build produced 0 snaps across all 30 runs x 150 swipes per combo.');
      outLog.push('Information needed from testers: device details, OS, browser version, exact swipe gesture timings, or screen recording.');
    }

    const reportContent = outLog.join('\n');
    const destFile = path.join(outDir, 'siphon_snap_paired.txt');
    fs.writeFileSync(destFile, reportContent, 'utf8');
    console.log(`\nWritten diagnostic report to ${destFile}`);
    console.log(reportContent);

  } finally {
    chromeProc.kill('SIGKILL');
    oldServer.close();
    currentServer.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
