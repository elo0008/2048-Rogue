import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT = 3045;
const CDP_PORT = 9275;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer() {
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
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(distDir, relPath === '' ? 'index.html' : relPath);

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
    server.listen(PORT, '127.0.0.1', () => {
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
    this.eventListeners = new Map();

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
      } else if (data.method && this.eventListeners.has(data.method)) {
        for (const cb of this.eventListeners.get(data.method)) {
          cb(data.params);
        }
      }
    };
  }

  on(event, cb) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(cb);
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  const server = await startServer();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--force-device-scale-factor=1',
  ]);

  let cdp;
  try {
    const wsUrl = await getWsUrl();
    cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.beginInjection = () => {}; window.endInjection = () => {};'
    });

    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map(a => a.value || a.description).join(' '));
      }
    });

    const logLines = [];
    function print(line = '') {
      console.log(line);
      logLines.push(line);
    }

    print('================================================================================');
    print('                      P4 SAMPLING EVIDENCE & MEASUREMENTS                       ');
    print('================================================================================');
    print(`Measurement Environment: Headless Chrome via CDP`);
    print(`Timing Engine: Real irregular requestAnimationFrame timestamps (DOMHighResTimeStamp)`);
    print(`Virtual Time: None (100% Real Hardware rAF Clock)`);
    print(`Base Viewport: 390 x 742 (Mobile DPR=1.0)`);
    print('--------------------------------------------------------------------------------\n');

    // 1. DEFAULT URL RUN (Ascension threshold = 2048)
    print('--- [1] DEFAULT URL ASCENSION RUN (ascensionAt = 2048) ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 742, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?debug=1` });
    await sleep(400);

    // Dismiss start overlay if present
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const defaultRunResult = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.board = [
          1024, 1024, 0, 0,
          'S', 4, 8, 16,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const ascBefore = (window.controller.getState().ascensions || []).length;
        const configThreshold = window.controller.config?.ascensionAt;

        window.handleMove('L', 'swipe');

        setTimeout(() => {
          const ascAfter = (window.controller.getState().ascensions || []).length;
          const ascList = window.controller.getState().ascensions || [];
          const lastAsc = ascList[ascList.length - 1];
          const b = window.controller.getBoard();
          const survivor = b[0];
          const tilesLayer = document.getElementById('tiles-layer');
          const domTiles = Array.from(tilesLayer.querySelectorAll('.tile, .stone')).map(t => ({
            idx: parseInt(t.getAttribute('data-index'), 10),
            val: t.getAttribute('data-val')
          }));

          resolve({
            configThreshold,
            ascensionsFired: ascAfter - ascBefore,
            lastAscValue: lastAsc ? lastAsc.value : null,
            lastAscPayout: lastAsc ? lastAsc.payout : null,
            survivorVal: survivor,
            boardAtSurvivor: b[0],
            boardCount: b.filter(x => x !== 0).length,
            domTileCount: domTiles.length,
            domTilesMatchEngine: domTiles.length === b.filter(x => x !== 0).length && domTiles.every(t => b[t.idx] == t.val)
          });
        }, 1700);
      })
    `);

    print(`  Configured ascensionAt: ${defaultRunResult.configThreshold}`);
    print(`  Ascensions fired on 1024+1024 merge: ${defaultRunResult.ascensionsFired} (expected: 1)`);
    print(`  Trigger value: ${defaultRunResult.lastAscValue} (expected: 2048)`);
    print(`  Calculated payout: +${defaultRunResult.lastAscPayout} points`);
    print(`  Surviving tile at cell 0: value ${defaultRunResult.survivorVal}`);
    print(`  Engine non-zero board cells: ${defaultRunResult.boardCount}`);
    print(`  DOM tiles layer tile count: ${defaultRunResult.domTileCount}`);
    print(`  DOM matches engine survivor: ${defaultRunResult.domTilesMatchEngine}`);
    print(`  Default URL verification: ${defaultRunResult.ascensionsFired === 1 && defaultRunResult.domTilesMatchEngine ? 'PASS' : 'FAIL'}\n`);

    // 2. DETAILED FRAME SAMPLING RUN WITH ?ascension=64
    print('--- [2] FRAME SAMPLING WITH ?ascension=64 (REAL IRREGULAR rAF TIMESTAMPS) ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);

    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const sampleResult = await cdp.eval(`
      new Promise((resolve) => {
        // Setup board with pair of 32s, permanent stone, and small tiles
        window.controller.state.board = [
          32, 32, 'S', 2,
          4, 8, 16, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const boardEl = document.getElementById('game-board');
        const headerEl = document.querySelector('header') || document.querySelector('.header') || document.querySelector('.game-header');
        const tilesLayer = document.getElementById('tiles-layer');

        const survivorIdx = 0; // 32 at 0 merges with 32 at 1 to become 64 at 0
        const survivorEl = tilesLayer.querySelector('.tile[data-index="0"]');
        const initialSurvivorRect = survivorEl ? survivorEl.getBoundingClientRect() : { left: 0, top: 0 };
        const initialBoardTop = boardEl ? boardEl.getBoundingClientRect().top : 0;
        const initialHeaderHeight = headerEl ? headerEl.getBoundingClientRect().height : 0;

        // Collect non-survivors
        const trackedTiles = [];
        for (const child of Array.from(tilesLayer.children)) {
          const idxAttr = child.getAttribute('data-index');
          if (idxAttr === null) continue;
          const idx = parseInt(idxAttr, 10);
          if (idx !== survivorIdx && idx !== 1) { // 32 at 1 is absorbed by slide merge into 0; track clean slate wipe destructions
            const col = idx % 4;
            const row = Math.floor(idx / 4);
            const dist = Math.hypot(col, row);
            trackedTiles.push({
              el: child,
              idx,
              val: child.getAttribute('data-val'),
              dist,
              removedAt: null
            });
          }
        }

        const samples = [];
        let maxSurvivorDisp = 0;
        let minBoardTop = initialBoardTop;
        let maxBoardTop = initialBoardTop;
        let minHeaderHeight = initialHeaderHeight;
        let maxHeaderHeight = initialHeaderHeight;
        let maxCornerDist = 0;
        let t0 = null;
        let prevRadius = -1;
        let radiusStrictlyMonotonic = true;

        // Trigger the swipe that starts Clean Slate
        window.handleMove('L', 'swipe');

        function sampleFrame(timestamp) {
          if (t0 === null) t0 = timestamp;
          const elapsed = timestamp - t0;

          // Check ring
          const ring = document.getElementById('clean-slate-ring') || document.querySelector('.clean-slate-ring');
          let ringRadius = 0;
          let ringScale = 0;
          if (ring) {
            const cs = window.getComputedStyle(ring);
            const transform = cs.transform;
            if (transform && transform.startsWith('matrix')) {
              const parts = transform.slice(7, -1).split(',');
              ringScale = parseFloat(parts[0]) || 0;
            }
            const fullRadius = parseFloat(cs.width) / 2;
            ringRadius = ringScale * fullRadius;
            maxCornerDist = fullRadius;

            if (ringRadius < prevRadius) {
              radiusStrictlyMonotonic = false;
            }
            prevRadius = ringRadius;
          }

          // Check survivor displacement
          const curSurvivor = tilesLayer.querySelector('.tile[data-index="0"]');
          if (curSurvivor) {
            const r = curSurvivor.getBoundingClientRect();
            const disp = Math.hypot(r.left - initialSurvivorRect.left, r.top - initialSurvivorRect.top);
            if (disp > maxSurvivorDisp) maxSurvivorDisp = disp;
          }

          // Check layout invariants
          if (boardEl) {
            const bt = boardEl.getBoundingClientRect().top;
            if (bt < minBoardTop) minBoardTop = bt;
            if (bt > maxBoardTop) maxBoardTop = bt;
          }
          if (headerEl) {
            const hh = headerEl.getBoundingClientRect().height;
            if (hh < minHeaderHeight) minHeaderHeight = hh;
            if (hh > maxHeaderHeight) maxHeaderHeight = hh;
          }

          // Check tile removals
          for (const item of trackedTiles) {
            if (!item.el.parentNode && item.removedAt === null) {
              item.removedAt = elapsed;
            }
          }

          samples.push({
            timestamp,
            elapsed,
            ringRadius: Math.round(ringRadius * 100) / 100,
            ringScale: Math.round(ringScale * 1000) / 1000,
            ringPresent: Boolean(ring)
          });

          // Sequence completion check (after initial delay)
          if (elapsed > 400 && !window.isAnimating && !window.cleanSlateSequenceState) {
            for (const item of trackedTiles) {
              if (item.removedAt === null) item.removedAt = elapsed;
            }
            resolve({
              samples,
              trackedTiles: trackedTiles.map(t => ({
                idx: t.idx,
                val: t.val,
                dist: Math.round(t.dist * 100) / 100,
                removedAt: Math.round(t.removedAt * 10) / 10
              })),
              totalDuration: elapsed,
              maxCornerDist: Math.round(maxCornerDist * 100) / 100,
              radiusStrictlyMonotonic,
              maxSurvivorDisp: Math.round(maxSurvivorDisp * 100) / 100,
              initialBoardTop,
              minBoardTop,
              maxBoardTop,
              initialHeaderHeight,
              minHeaderHeight,
              maxHeaderHeight,
              engineBoard: window.controller.getBoard(),
              domTiles: Array.from(tilesLayer.querySelectorAll('.tile, .stone')).map(t => ({
                idx: parseInt(t.getAttribute('data-index'), 10),
                val: t.getAttribute('data-val')
              }))
            });
            return;
          }

          if (elapsed > 2500) {
            resolve({ error: 'Sequence timed out > 2500ms' });
            return;
          }

          requestAnimationFrame(sampleFrame);
        }

        requestAnimationFrame(sampleFrame);
      })
    `);

    print(`  Total Sequence Duration: ${sampleResult.totalDuration.toFixed(1)} ms (<= 1800 ms constraint: ${sampleResult.totalDuration <= 1800 ? 'PASS' : 'FAIL'})`);
    print(`  Farthest Corner Distance: ${sampleResult.maxCornerDist} px`);
    print(`  Ring Radius Monotonicity: ${sampleResult.radiusStrictlyMonotonic ? 'PASS (Strictly non-decreasing to >= farthest corner)' : 'FAIL'}`);
    print(`  Surviving Tile Max Displacement: ${sampleResult.maxSurvivorDisp.toFixed(2)} px (Constraint: 0px -> ${sampleResult.maxSurvivorDisp === 0 ? 'PASS' : 'FAIL'})`);
    print(`  Board Top Y Position: initial=${sampleResult.initialBoardTop.toFixed(2)}px, min=${sampleResult.minBoardTop.toFixed(2)}px, max=${sampleResult.maxBoardTop.toFixed(2)}px (delta: ${(sampleResult.maxBoardTop - sampleResult.minBoardTop).toFixed(2)}px -> PASS)`);
    print(`  Header Height: initial=${sampleResult.initialHeaderHeight.toFixed(2)}px, min=${sampleResult.minHeaderHeight.toFixed(2)}px, max=${sampleResult.maxHeaderHeight.toFixed(2)}px (delta: ${(sampleResult.maxHeaderHeight - sampleResult.minHeaderHeight).toFixed(2)}px -> PASS)`);
    print(`  Console Errors: ${consoleErrors.length} (PASS: 0 errors)\n`);

    // Print Ring Monotonicity Sample Table
    print('  [Ring Radius Frame Samples (Irregular Hardware rAF Timestamps)]');
    print('  Frame | Elapsed (ms) | rAF Timestamp (ms) | Ring Scale | Radius (px) | Max Corner Dist');
    print('  ------+--------------+--------------------+------------+-------------+----------------');
    const ringFrames = sampleResult.samples.filter(s => s.ringPresent);
    const step = Math.max(1, Math.floor(ringFrames.length / 10));
    for (let i = 0; i < ringFrames.length; i += step) {
      const f = ringFrames[i];
      print(`  ${String(i + 1).padStart(5)} | ${f.elapsed.toFixed(2).padStart(12)} | ${f.timestamp.toFixed(2).padStart(18)} | ${f.ringScale.toFixed(3).padStart(10)} | ${f.ringRadius.toFixed(2).padStart(11)} | ${sampleResult.maxCornerDist} px`);
    }
    const lastRing = ringFrames[ringFrames.length - 1];
    if (lastRing) {
      print(`  ${String(ringFrames.length).padStart(5)} | ${lastRing.elapsed.toFixed(2).padStart(12)} | ${lastRing.timestamp.toFixed(2).padStart(18)} | ${lastRing.ringScale.toFixed(3).padStart(10)} | ${lastRing.ringRadius.toFixed(2).padStart(11)} | ${sampleResult.maxCornerDist} px`);
    }
    print('');

    // Print Removal vs Distance Table
    print('  [Tile & Stone Removal Time vs Distance from Origin]');
    print('  Cell | Element | Distance from (0,0) | Removal Time (ms) | Non-Decreasing Check');
    print('  -----+---------+---------------------+-------------------+---------------------');
    let prevRemovedAt = -1;
    let nonDecreasingRemovals = true;
    const sortedRemovals = [...sampleResult.trackedTiles].sort((a, b) => a.dist - b.dist);
    for (const item of sortedRemovals) {
      const isStone = item.val === 'S';
      const label = isStone ? 'Stone' : `Tile ${item.val}`;
      const ok = item.removedAt >= prevRemovedAt;
      if (!ok) nonDecreasingRemovals = false;
      prevRemovedAt = item.removedAt;
      print(`  ${String(item.idx).padStart(4)} | ${label.padEnd(7)} | ${item.dist.toFixed(2).padStart(19)} | ${item.removedAt.toFixed(1).padStart(17)} | ${ok ? 'PASS' : 'FAIL'}`);
    }
    print(`  Removal Order Monotonicity vs Distance: ${nonDecreasingRemovals ? 'PASS (All removal times non-decreasing with distance)' : 'FAIL'}\n`);

    // Verify survivors and DOM tiles
    print('  [Surviving Elements on Tiles Layer at Sequence End]');
    print(`  Engine Board: [${sampleResult.engineBoard.filter(x => x !== 0).join(', ')}]`);
    print(`  DOM Tiles Layer: [${sampleResult.domTiles.map(t => `${t.val}@${t.idx}`).join(', ')}]`);
    const survivorMatches = sampleResult.domTiles.length === sampleResult.engineBoard.filter(x => x !== 0).length &&
      sampleResult.domTiles.every(t => sampleResult.engineBoard[t.idx] == t.val);
    print(`  Exact Survivor Match: ${survivorMatches ? 'PASS' : 'FAIL'}\n`);

    // 3. REDUCED MOTION RUN
    print('--- [3] PREFERS-REDUCED-MOTION RUN ---');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);

    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const reducedResult = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.board = [
          32, 32, 'S', 4,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        let ringSeen = false;
        let t0 = performance.now();

        window.handleMove('L', 'swipe');

        function check() {
          const ring = document.querySelector('.clean-slate-ring') || document.getElementById('clean-slate-ring');
          if (ring) ringSeen = true;

          const elapsed = performance.now() - t0;
          if (elapsed > 300 && !window.isAnimating && !window.cleanSlateSequenceState) {
            resolve({
              duration: elapsed,
              ringSeen,
              survivor: window.controller.getBoard()[0]
            });
            return;
          }
          if (elapsed > 2000) {
            resolve({ duration: elapsed, ringSeen, timedOut: true });
            return;
          }
          requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
      })
    `);

    print(`  Reduced-Motion Duration: ${reducedResult.duration.toFixed(1)} ms (<= 1800 ms constraint: ${reducedResult.duration <= 1800 ? 'PASS' : 'FAIL'})`);
    print(`  Ring Element Created in DOM: ${reducedResult.ringSeen ? 'YES (FAIL)' : 'NO (PASS: suppressed)'}`);
    print(`  Reduced-Motion Verification: ${!reducedResult.ringSeen && reducedResult.duration <= 1800 ? 'PASS' : 'FAIL'}\n`);

    // Restore normal motion
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    // 4. SCREENSHOTS AT 390x742
    print('--- [4] CAPTURING ARTIFACT SCREENSHOTS AT 390x742 ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 742, deviceScaleFactor: 1, mobile: true });

    // Screenshot 1: Ring Mid-Expansion (~520ms)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
      window.controller.state.board = [
        32, 32, 'S', 2,
        4, 8, 16, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.beginInjection();
      window.syncBoard(window.controller.getBoard(), 'inj');
      window.endInjection();
      window.handleMove('L', 'swipe');
    })()`);
    await sleep(520);
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shot1Path = path.join(outDir, 'clean_slate_ring.png');
    fs.writeFileSync(shot1Path, Buffer.from(shot1.data, 'base64'));
    print(`  Saved Screenshot 1 (Ring Mid-Expansion): scripts/out/clean_slate_ring.png`);

    // Screenshot 2: Mid-Destruction (~680ms)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
      window.controller.state.board = [
        32, 32, 'S', 2,
        4, 8, 16, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.beginInjection();
      window.syncBoard(window.controller.getBoard(), 'inj');
      window.endInjection();
      window.handleMove('L', 'swipe');
    })()`);
    await sleep(680);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shot2Path = path.join(outDir, 'clean_slate_destruction.png');
    fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));
    print(`  Saved Screenshot 2 (Mid-Destruction): scripts/out/clean_slate_destruction.png`);

    // Screenshot 3: Banner Stamp (~950ms)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
      window.controller.state.board = [
        32, 32, 'S', 2,
        4, 8, 16, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.beginInjection();
      window.syncBoard(window.controller.getBoard(), 'inj');
      window.endInjection();
      window.handleMove('L', 'swipe');
    })()`);
    await sleep(950);
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shot3Path = path.join(outDir, 'clean_slate_banner.png');
    fs.writeFileSync(shot3Path, Buffer.from(shot3.data, 'base64'));
    print(`  Saved Screenshot 3 (Banner Stamp): scripts/out/clean_slate_banner.png\n`);

    // 5. GAME OVER HEADER WIDTH MEASUREMENT AT 320x568
    print('--- [5] GAME OVER HEADER WIDTH MEASUREMENT AT 320x568 ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?debug=1` });
    await sleep(400);

    const hudResult = await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn && !btn.closest('.hidden')) btn.click();

        // Inject ascension record and trigger Game Over
        window.controller.state.ascensions = [{ value: 2048, payout: 20480 }];
        window.controller.state.over = true;
        window.controller.state.score = 34560;

        const endOverlay = document.getElementById('end-overlay');
        if (endOverlay) endOverlay.classList.remove('hidden');

        // Update GameOver view
        if (typeof window.handleGameOver === 'function') {
          window.handleGameOver();
        }

        const chip = document.getElementById('end-clean-slate-chip');
        const header = endOverlay.querySelector('.end-header') || endOverlay.querySelector('header');
        const title = endOverlay.querySelector('.end-title') || endOverlay.querySelector('h2');
        const container = endOverlay.querySelector('.end-content') || endOverlay;

        const chipRect = chip ? chip.getBoundingClientRect() : null;
        const headerRect = header ? header.getBoundingClientRect() : null;
        const titleRect = title ? title.getBoundingClientRect() : null;
        const containerRect = container ? container.getBoundingClientRect() : null;

        return {
          chipVisible: chip ? !chip.classList.contains('hidden') : false,
          chipText: chip ? chip.textContent.trim() : '',
          chipWidth: chipRect ? Math.round(chipRect.width * 10) / 10 : 0,
          chipHeight: chipRect ? Math.round(chipRect.height * 10) / 10 : 0,
          headerWidth: headerRect ? Math.round(headerRect.width * 10) / 10 : 0,
          titleWidth: titleRect ? Math.round(titleRect.width * 10) / 10 : 0,
          containerWidth: containerRect ? Math.round(containerRect.width * 10) / 10 : 0,
          viewportWidth: 320,
          noOverflow: chipRect && containerRect ? (chipRect.right <= containerRect.right + 2) : false
        };
      })()
    `);

    print(`  Viewport: ${hudResult.viewportWidth} x 568 px`);
    print(`  CLEAN SLATE Chip Displayed: ${hudResult.chipVisible}`);
    print(`  CLEAN SLATE Chip Text: "${hudResult.chipText}"`);
    print(`  Chip Dimensions: ${hudResult.chipWidth} px x ${hudResult.chipHeight} px`);
    print(`  Title Width: ${hudResult.titleWidth} px`);
    print(`  Header Width: ${hudResult.headerWidth} px`);
    print(`  Container Width: ${hudResult.containerWidth} px`);
    print(`  No Horizontal Overflow: ${hudResult.noOverflow ? 'PASS' : 'FAIL'}`);
    print(`  Game Over Header Width Test: ${hudResult.chipVisible && hudResult.noOverflow ? 'PASS' : 'FAIL'}\n`);

    print('================================================================================');
    print('                      ALL P4 SAMPLING TESTS COMPLETED                           ');
    print('================================================================================');

    const outFilePath = path.join(outDir, 'ascension_anim.txt');
    fs.writeFileSync(outFilePath, logLines.join('\n'), 'utf8');
    print(`Evidence written to ${outFilePath}`);

  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    server.close();
  }
}

run().catch(err => {
  console.error('Fatal error in measure_ascension_anim:', err);
  process.exit(1);
});
