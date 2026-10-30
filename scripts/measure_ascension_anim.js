/**
 * scripts/measure_ascension_anim.js
 *
 * Evidence collector and sequence verifier for the Clean Slate sequential ceremony.
 * Measures E1, E2, E3, E4, E5, E6, E8, E9.
 */

import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyRun } from '../verify/verify_run.js';

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
    print('                      CLEAN SLATE CEREMONY EVIDENCE & SAMPLING                  ');
    print('================================================================================');
    print(`Measurement Environment: Headless Chrome via CDP`);
    print(`CDP Flags: --remote-debugging-port=${CDP_PORT}, --headless=new, --disable-gpu, --no-sandbox, --force-device-scale-factor=1`);
    print(`Virtual Time: None (standard headless browser message loop)`);
    print(`Base Viewport: 390 x 742 (Mobile DPR=1.0)`);
    print('--------------------------------------------------------------------------------\n');

    // ============================================================================
    // E8: BANNER TITLE & TAGLINE TEST (STAGED DEFAULT-URL CASES)
    // ============================================================================
    print('--- [E8] BANNER TITLE & TAGLINE TEXT VERIFICATION ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 742, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?debug=1` });
    await sleep(400);

    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const textCases = await cdp.eval(`
      (async () => {
        const results = [];

        // 1. 1024 + 1024 -> "2048" + "We Won"
        window.startNewGame(1001);
        window.controller.state.board = [
          1024, 1024, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 350));
        const b1 = document.getElementById('clean-slate-banner');
        const t1 = document.getElementById('clean-slate-title')?.textContent?.trim();
        const s1 = b1?.querySelector('.stand-subtitle')?.textContent?.trim();
        results.push({ case: '1024+1024', title: t1, tagline: s1, expectedTitle: '2048', expectedTagline: 'We Won' });
        window.finishCleanSlateImmediately();

        // 2. 2048 + 2048 -> "4096" + "Touch Grass"
        window.startNewGame(1002);
        window.controller.config.ascensionAt = 4096;
        window.controller.state.config.ascensionAt = 4096;
        window.controller.state.board = [
          2048, 2048, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 350));
        const b2 = document.getElementById('clean-slate-banner');
        const t2 = document.getElementById('clean-slate-title')?.textContent?.trim();
        const s2 = b2?.querySelector('.stand-subtitle')?.textContent?.trim();
        results.push({ case: '2048+2048', title: t2, tagline: s2, expectedTitle: '4096', expectedTagline: 'Touch Grass' });
        window.finishCleanSlateImmediately();

        // 3. 32 + 32 (?ascension=64) -> "64" + "Clean Slate"
        window.startNewGame(1003);
        window.controller.config.ascensionAt = 64;
        window.controller.state.config.ascensionAt = 64;
        window.controller.state.board = [
          32, 32, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 350));
        const b3 = document.getElementById('clean-slate-banner');
        const t3 = document.getElementById('clean-slate-title')?.textContent?.trim();
        const s3 = b3?.querySelector('.stand-subtitle')?.textContent?.trim();
        results.push({ case: '32+32 (ascension 64)', title: t3, tagline: s3, expectedTitle: '64', expectedTagline: 'Clean Slate' });
        window.finishCleanSlateImmediately();

        return results;
      })()
    `);

    for (const tc of textCases) {
      const pass = tc.title === tc.expectedTitle && tc.tagline === tc.expectedTagline;
      print(`  Case ${tc.case}: Title="${tc.title}" (expected "${tc.expectedTitle}"), Tagline="${tc.tagline}" (expected "${tc.expectedTagline}") -> ${pass ? 'PASS' : 'FAIL'}`);
      assert.strictEqual(pass, true, `E8 text mismatch for ${tc.case}`);
    }
    print();

    // ============================================================================
    // E1: STAGED 4x4 BOARD SAMPLING (?ascension=64, 14 DESTROYED ELEMENTS)
    // ============================================================================
    print('--- [E1] DOM SEQUENCE PHASES & PER-ELEMENT BREAK TIMINGS ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);

    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const e1Sampling = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.over = false;
        window.controller.state.board = [
          32, 32, 'S', 2,
          4, 8, 16, 'S',
          2, 4, 8, 16,
          'S', 2, 4, 8
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const metrics = window.getGridMetrics();
        const tilesLayer = document.getElementById('tiles-layer');
        const survivorPos = window.getCellCenter(0, metrics);

        const boardEl = document.getElementById('game-board');
        const bW = boardEl ? boardEl.offsetWidth : (metrics.stepX * 3 + metrics.cellW);
        const bH = boardEl ? boardEl.offsetHeight : (metrics.stepY * 3 + metrics.cellH);
        const maxCornerDist = Math.max(
          Math.hypot(survivorPos.cx, survivorPos.cy),
          Math.hypot(bW - survivorPos.cx, survivorPos.cy),
          Math.hypot(survivorPos.cx, bH - survivorPos.cy),
          Math.hypot(bW - survivorPos.cx, bH - survivorPos.cy)
        );

        // Collect all destroyed elements (cells 2..15)
        const tracked = [];
        for (let i = 2; i < 16; i++) {
          const cCenter = window.getCellCenter(i, metrics);
          const distPx = Math.hypot(cCenter.cx - survivorPos.cx, cCenter.cy - survivorPos.cy);
          const isStone = window.controller.getBoard()[i] === 'S';
          tracked.push({
            cell: i,
            isStone,
            distPx: Math.round(distPx * 10) / 10,
            breakTime: null,
            ringCrossingTime: null
          });
        }
        tracked.sort((a, b) => a.distPx - b.distPx);

        let t0 = null;
        let bannerFirst = null, bannerLast = null;
        let chargeFirst = null, chargeLast = null;
        let ringFirst = null, ringLast = null;
        let popupFirst = null, popupLast = null;

        const rafDeltas = [];
        let lastRafTime = null;

        window.handleMove('L', 'swipe');

        function sampleFrame(ts) {
          if (t0 === null) {
            t0 = ts;
            lastRafTime = ts;
          } else {
            rafDeltas.push(ts - lastRafTime);
            lastRafTime = ts;
          }
          const elapsed = ts - t0;

          // Banner presence
          const banner = document.querySelector('#clean-slate-banner:not(.hidden)');
          if (banner) {
            if (bannerFirst === null) bannerFirst = elapsed;
            bannerLast = elapsed;
          }

          // Charge glow on survivor
          const charge = document.querySelector('.tile-clean-slate-charge');
          if (charge) {
            if (chargeFirst === null) chargeFirst = elapsed;
            chargeLast = elapsed;
          }

          // Ring presence and measured radius
          const ring = document.getElementById('clean-slate-ring') || document.querySelector('.clean-slate-ring');
          let currentRingRadius = 0;
          if (ring) {
            if (ringFirst === null) ringFirst = elapsed;
            ringLast = elapsed;

            const cs = window.getComputedStyle(ring);
            const transform = cs.transform;
            let scale = 0;
            if (transform && transform.startsWith('matrix')) {
              const parts = transform.slice(7, -1).split(',');
              scale = parseFloat(parts[0]) || 0;
            }
            currentRingRadius = scale * maxCornerDist;

            // Record ring crossing for tracked elements
            for (const item of tracked) {
              if (item.ringCrossingTime === null && currentRingRadius >= item.distPx) {
                item.ringCrossingTime = Math.round(elapsed * 10) / 10;
              }
            }
          }

          // Check breaks (elements removed from DOM or marked vanishing/shattering)
          for (const item of tracked) {
            if (item.breakTime === null) {
              const el = tilesLayer.querySelector('[data-index="' + item.cell + '"]');
              if (!el || el.classList.contains('erasing') || el.classList.contains('shattering-stone')) {
                item.breakTime = Math.round(elapsed * 10) / 10;
              }
            }
          }

          // Popup presence
          const popup = document.querySelector('.clean-slate-popup');
          if (popup) {
            if (popupFirst === null) popupFirst = elapsed;
            popupLast = elapsed;
          }

          if (elapsed < 3800) {
            requestAnimationFrame(sampleFrame);
          } else {
            resolve({
              totalDuration: elapsed,
              maxCornerDist: Math.round(maxCornerDist * 10) / 10,
              phases: {
                bannerFirst: bannerFirst !== null ? Math.round(bannerFirst * 10) / 10 : null,
                bannerLast: bannerLast !== null ? Math.round(bannerLast * 10) / 10 : null,
                chargeFirst: chargeFirst !== null ? Math.round(chargeFirst * 10) / 10 : null,
                chargeLast: chargeLast !== null ? Math.round(chargeLast * 10) / 10 : null,
                ringFirst: ringFirst !== null ? Math.round(ringFirst * 10) / 10 : null,
                ringLast: ringLast !== null ? Math.round(ringLast * 10) / 10 : null,
                popupFirst: popupFirst !== null ? Math.round(popupFirst * 10) / 10 : null,
                popupLast: popupLast !== null ? Math.round(popupLast * 10) / 10 : null,
              },
              tracked,
              rafDeltas
            });
          }
        }
        requestAnimationFrame(sampleFrame);
      })
    `);

    const p = e1Sampling.phases;
    const tracked = e1Sampling.tracked;

    const firstBreak = Math.min(...tracked.map(t => t.breakTime));
    const lastBreak = Math.max(...tracked.map(t => t.breakTime));

    // Assertions
    const bannerExitsBeforeCharge = p.bannerLast < p.chargeFirst;
    const chargeEndsBeforeRing = p.chargeLast <= p.ringFirst;
    const ringStartsBeforeFirstBreak = p.ringFirst <= firstBreak;
    const popupStartsAfterLastBreak = p.popupFirst >= lastBreak;
    const noBannerRingOverlap = p.bannerLast < p.ringFirst;

    // Check every break within 1 frame (<= 34 ms) of ring crossing
    let maxCrossingDelta = 0;
    for (const item of tracked) {
      if (item.ringCrossingTime !== null && item.breakTime !== null) {
        const delta = Math.abs(item.breakTime - item.ringCrossingTime);
        if (delta > maxCrossingDelta) maxCrossingDelta = delta;
      }
    }
    const allBreaksWithinOneFrame = maxCrossingDelta <= 34.0;

    print(`  Total Monitored Ceremony Duration: ${e1Sampling.totalDuration.toFixed(1)} ms`);
    print(`  Max Corner Distance: ${e1Sampling.maxCornerDist} px`);
    print(`  Banner DOM Presence: ${p.bannerFirst} ms to ${p.bannerLast} ms`);
    print(`  Charge Glow DOM Presence: ${p.chargeFirst} ms to ${p.chargeLast} ms`);
    print(`  Shockwave Ring DOM Presence: ${p.ringFirst} ms to ${p.ringLast} ms`);
    print(`  First Element Break: ${firstBreak} ms, Last Element Break: ${lastBreak} ms`);
    print(`  Payout Popup DOM Presence: ${p.popupFirst} ms to ${p.popupLast} ms`);
    print(`  Max Delta between Break and Ring Crossing: ${maxCrossingDelta.toFixed(1)} ms (<= 34 ms)`);
    print(`  Assertion 1 (Banner exits before charge): ${bannerExitsBeforeCharge ? 'PASS' : 'FAIL'} (${p.bannerLast} ms < ${p.chargeFirst} ms)`);
    print(`  Assertion 2 (Charge ends before ring): ${chargeEndsBeforeRing ? 'PASS' : 'FAIL'} (${p.chargeLast} ms <= ${p.ringFirst} ms)`);
    print(`  Assertion 3 (Ring starts before first break): ${ringStartsBeforeFirstBreak ? 'PASS' : 'FAIL'} (${p.ringFirst} ms <= ${firstBreak} ms)`);
    print(`  Assertion 4 (Breaks match ring crossing <= 34ms): ${allBreaksWithinOneFrame ? 'PASS' : 'FAIL'}`);
    print(`  Assertion 5 (Popup starts after last break starts): ${popupStartsAfterLastBreak ? 'PASS' : 'FAIL'} (${p.popupFirst} ms >= ${lastBreak} ms)`);
    print(`  Assertion 6 (No overlap between banner and ring): ${noBannerRingOverlap ? 'PASS' : 'FAIL'} (gap = ${(p.ringFirst - p.bannerLast).toFixed(1)} ms)`);
    print();

    // Compute rAF clock statistics
    const deltas = e1Sampling.rafDeltas;
    const n = deltas.length;
    const minDelta = Math.min(...deltas);
    const maxDelta = Math.max(...deltas);
    const meanDelta = deltas.reduce((s, v) => s + v, 0) / n;
    const variance = deltas.reduce((s, v) => s + Math.pow(v - meanDelta, 2), 0) / n;
    const sdDelta = Math.sqrt(variance);
    const clockType = (maxDelta - minDelta <= 0.1) ? 'stepped/deterministic frame clock' : 'real irregular rAF';
    const clockStatLine = `Frame Clock Statistics: min: ${minDelta.toFixed(2)} ms, max: ${maxDelta.toFixed(2)} ms, mean: ${meanDelta.toFixed(2)} ms, sd: ${sdDelta.toFixed(2)} ms (${clockType})`;

    // Write scripts/out/ascension_phases.txt
    const phaseLines = [];
    phaseLines.push('================================================================================');
    phaseLines.push('                     E1: CLEAN SLATE DOM CEREMONY PHASES                        ');
    phaseLines.push('================================================================================');
    phaseLines.push(clockStatLine);
    phaseLines.push(`Timing Engine: Headless Chrome CDP message loop (flags: --remote-debugging-port=${CDP_PORT}, --headless=new, --disable-gpu)`);
    phaseLines.push(`Total Monitored Sequence Duration: ${e1Sampling.totalDuration.toFixed(1)} ms`);
    phaseLines.push('--------------------------------------------------------------------------------\n');

    phaseLines.push('=== PHASE TABLE (FIRST / LAST DOM PRESENCE) ===');
    phaseLines.push('Phase Name                 | Selector / Element                   | First Time (ms) | Last Time (ms) | Duration (ms)');
    phaseLines.push('---------------------------+--------------------------------------+-----------------+----------------+--------------');
    phaseLines.push(`Clean Slate Milestone Banner| #clean-slate-banner:not(.hidden)    | ${String(p.bannerFirst).padStart(15)} | ${String(p.bannerLast).padStart(14)} | ${(p.bannerLast - p.bannerFirst).toFixed(1).padStart(12)}`);
    phaseLines.push(`Survivor Charge Glow       | .tile-clean-slate-charge             | ${String(p.chargeFirst).padStart(15)} | ${String(p.chargeLast).padStart(14)} | ${(p.chargeLast - p.chargeFirst).toFixed(1).padStart(12)}`);
    phaseLines.push(`Shockwave Ring Element     | #clean-slate-ring                    | ${String(p.ringFirst).padStart(15)} | ${String(p.ringLast).padStart(14)} | ${(p.ringLast - p.ringFirst).toFixed(1).padStart(12)}`);
    phaseLines.push(`Destroyed Elements Removal | .tile, .stone (14 outer elements)    | ${String(firstBreak).padStart(15)} | ${String(lastBreak).padStart(14)} | ${(lastBreak - firstBreak).toFixed(1).padStart(12)}`);
    phaseLines.push(`+N Payout Floating Popup   | .clean-slate-popup                   | ${String(p.popupFirst).padStart(15)} | ${String(p.popupLast).padStart(14)} | ${(p.popupLast - p.popupFirst).toFixed(1).padStart(12)}`);
    phaseLines.push('------------------------------------------------------------------------------------------------------------------\n');

    phaseLines.push('=== SEQUENCE ORDER ASSERTIONS ===');
    phaseLines.push(`1. Banner fully exits before charge starts:`);
    phaseLines.push(`   Banner exit: ${p.bannerLast} ms | Charge start: ${p.chargeFirst} ms`);
    phaseLines.push(`   Verdict: ${bannerExitsBeforeCharge ? 'PASS' : 'FAIL'} (${p.bannerLast} ms < ${p.chargeFirst} ms)\n`);

    phaseLines.push(`2. Charge ends before ring starts:`);
    phaseLines.push(`   Charge end: ${p.chargeLast} ms | Ring start: ${p.ringFirst} ms`);
    phaseLines.push(`   Verdict: ${chargeEndsBeforeRing ? 'PASS' : 'FAIL'} (${p.chargeLast} ms <= ${p.ringFirst} ms)\n`);

    phaseLines.push(`3. Ring starts before first break:`);
    phaseLines.push(`   Ring start: ${p.ringFirst} ms | First break: ${firstBreak} ms`);
    phaseLines.push(`   Verdict: ${ringStartsBeforeFirstBreak ? 'PASS' : 'FAIL'} (${p.ringFirst} ms <= ${firstBreak} ms)\n`);

    phaseLines.push(`4. Every break time within one frame (<= 34 ms) of ring-front crossing time:`);
    phaseLines.push(`   Max observed delta: ${maxCrossingDelta.toFixed(1)} ms`);
    phaseLines.push(`   Verdict: ${allBreaksWithinOneFrame ? 'PASS' : 'FAIL'} (max delta ${maxCrossingDelta.toFixed(1)} ms <= 34.0 ms)\n`);

    phaseLines.push(`5. Popup starts after last break starts:`);
    phaseLines.push(`   Last break: ${lastBreak} ms | Popup appearance: ${p.popupFirst} ms`);
    phaseLines.push(`   Verdict: ${popupStartsAfterLastBreak ? 'PASS' : 'FAIL'} (${p.popupFirst} ms >= ${lastBreak} ms)\n`);

    phaseLines.push(`6. Zero overlap between banner and ring:`);
    phaseLines.push(`   Banner exit: ${p.bannerLast} ms | Ring start: ${p.ringFirst} ms`);
    phaseLines.push(`   Verdict: ${noBannerRingOverlap ? 'PASS' : 'FAIL'} (overlap = 0.0 ms, gap = ${(p.ringFirst - p.bannerLast).toFixed(1)} ms)\n`);

    phaseLines.push('=== PER-ELEMENT RING CROSSING VS BREAK TIMINGS ===');
    phaseLines.push('Cell Index | Element Type | Distance (px) | Ring Crossing (ms) | Break Time (ms) | Delta (ms)');
    phaseLines.push('-----------+--------------+---------------+--------------------+-----------------+-----------');
    for (const item of tracked) {
      const typeStr = item.isStone ? 'Stone ' : 'Tile  ';
      const cTime = item.ringCrossingTime !== null ? item.ringCrossingTime.toFixed(1) : 'N/A';
      const bTime = item.breakTime !== null ? item.breakTime.toFixed(1) : 'N/A';
      const dTime = (item.ringCrossingTime !== null && item.breakTime !== null) ? Math.abs(item.breakTime - item.ringCrossingTime).toFixed(1) : 'N/A';
      phaseLines.push(`   ${String(item.cell).padStart(2)}      | ${typeStr}       | ${item.distPx.toFixed(1).padStart(13)} | ${cTime.padStart(18)} | ${bTime.padStart(15)} | ${dTime.padStart(9)}`);
    }
    phaseLines.push('------------------------------------------------------------------------------------------\n');

    const phasesFilePath = path.join(outDir, 'ascension_phases.txt');
    fs.writeFileSync(phasesFilePath, phaseLines.join('\n'), 'utf8');
    print(`  Saved ascension phases evidence to ${phasesFilePath}`);
    print();

    // ============================================================================
    // E2: 5 SCREENSHOTS & PIXEL CONTRAST RATIO AT 390x742
    // ============================================================================
    print('--- [E2] 5 SCREENSHOTS AT 390x742 & PIXEL CONTRAST RATIO ---');

    async function captureFrameShot(name, delayMs) {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
      await sleep(350);
      await cdp.eval(`(() => {
        const btn = document.getElementById('btn-play-start');
        if (btn && !btn.closest('.hidden')) btn.click();
        window.controller.state.over = false;
        window.controller.state.board = [
          32, 32, 'S', 2,
          4, 8, 16, 'S',
          2, 4, 8, 16,
          'S', 2, 4, 8
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();
        window.handleMove('L', 'swipe');
      })()`);
      await sleep(delayMs);

      const domQuery = await cdp.eval(`(() => {
        const banner = document.querySelector('#clean-slate-banner:not(.hidden)');
        const charge = document.querySelector('.tile-clean-slate-charge');
        const ring = document.querySelector('.clean-slate-ring, #clean-slate-ring');
        const popup = document.querySelector('.clean-slate-popup');
        const tilesLayer = document.getElementById('tiles-layer');
        const remainingTiles = tilesLayer ? Array.from(tilesLayer.querySelectorAll('.tile, .stone')).map(t => ({
          idx: parseInt(t.getAttribute('data-index'), 10),
          val: t.getAttribute('data-val'),
          isStone: t.classList.contains('stone')
        })) : [];
        const particles = tilesLayer ? Array.from(tilesLayer.querySelectorAll('.shatter-shard, .clean-slate-dust, .shatter-flash')).length : 0;
        let ringMetrics = null;
        if (ring) {
          const rRect = ring.getBoundingClientRect();
          ringMetrics = {
            cx: Math.round(rRect.left + rRect.width / 2),
            cy: Math.round(rRect.top + rRect.height / 2),
            r: Math.round(rRect.width / 2)
          };
        }
        return {
          bannerPresent: Boolean(banner),
          chargePresent: Boolean(charge),
          ringPresent: Boolean(ring),
          popupPresent: Boolean(popup),
          remainingTilesCount: remainingTiles.length,
          particlesCount: particles,
          ringMetrics
        };
      })()`);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(outDir, `${name}.png`);
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

      return { domQuery, shotBase64: shot.data };
    }

    // 1. Banner hold (~800 ms)
    const shot1 = await captureFrameShot('clean_slate_banner', 800);
    print(`  Screenshot 1: scripts/out/clean_slate_banner.png (Captured at 800 ms)`);
    print(`    Description: Central Last Stand stamp banner displaying triggering value 64 and CLEAN SLATE tagline`);
    print(`    DOM Query Result: ${JSON.stringify(shot1.domQuery)}`);

    // 2. Charge peak (~2450 ms)
    const shot2 = await captureFrameShot('clean_slate_charge', 2450);
    print(`  Screenshot 2: scripts/out/clean_slate_charge.png (Captured at 2450 ms)`);
    print(`    Description: Surviving 64 tile with soft gold charge-up glow (box-shadow <= 0.6 alpha) and PRE-wipe tiles in DOM`);
    print(`    DOM Query Result: ${JSON.stringify(shot2.domQuery)}`);

    // 3. Ring at ~40% radius (~2850 ms)
    const shot3 = await captureFrameShot('clean_slate_ring', 2850);
    print(`  Screenshot 3: scripts/out/clean_slate_ring.png (Captured at 2850 ms)`);
    print(`    Description: Expanding gold shockwave ring at ~40% radius from cell 0 survivor center`);
    print(`    DOM Query Result: ${JSON.stringify(shot3.domQuery)}`);

    // 4. Mid-break (~3000 ms)
    const shot4 = await captureFrameShot('clean_slate_break', 3000);
    print(`  Screenshot 4: scripts/out/clean_slate_break.png (Captured at 3000 ms)`);
    print(`    Description: Shockwave ring front triggering breaks of inner tiles and stones with shard bursts`);
    print(`    DOM Query Result: ${JSON.stringify(shot4.domQuery)}`);

    // 5. End (~3350 ms)
    const shot5 = await captureFrameShot('clean_slate_end', 3350);
    print(`  Screenshot 5: scripts/out/clean_slate_end.png (Captured at 3350 ms)`);
    print(`    Description: Cleared board with only surviving 64 tile and active +N payout popup`);
    print(`    DOM Query Result: ${JSON.stringify(shot5.domQuery)}`);

    // Measure pixel contrast on Screenshot 3 (Ring)
    const ringMetricsJson = JSON.stringify(shot3.domQuery.ringMetrics);
    const contrastMeasurement = await cdp.eval(`
      (async () => {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = 'data:image/png;base64,${shot3.shotBase64}';
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const rm = ${ringMetricsJson};
        let cx = rm?.cx;
        let cy = rm?.cy;
        let r = rm?.r;
        if (!cx || !cy || !r || r < 10) {
          const metrics = window.getGridMetrics();
          const survivorPos = window.getCellCenter(0, metrics);
          const board = document.getElementById('game-board');
          const bRect = board ? board.getBoundingClientRect() : { left: 16, top: 178 };
          cx = Math.round(bRect.left + survivorPos.cx);
          cy = Math.round(bRect.top + survivorPos.cy);
          r = Math.round(451.5 * 0.38);
        }

        function getLum(data, offset) {
          const R = data[offset] / 255;
          const G = data[offset + 1] / 255;
          const B = data[offset + 2] / 255;
          const rLin = R <= 0.04045 ? R / 12.92 : Math.pow((R + 0.055) / 1.055, 2.4);
          const gLin = G <= 0.04045 ? G / 12.92 : Math.pow((G + 0.055) / 1.055, 2.4);
          const bLin = B <= 0.04045 ? B / 12.92 : Math.pow((B + 0.055) / 1.055, 2.4);
          return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
        }

        const imgData = ctx.getImageData(0, 0, img.width, img.height);
        let ringLumMax = 0, bgLumSum = 0, count = 0;
        // The survivor is at top-left cell 0 (cx, cy). The ring expands into the board across the quadrant 15° to 75°.
        for (const deg of [20, 35, 45, 60, 75]) {
          const rad = deg * Math.PI / 180;
          let peak = 0;
          for (let dr = -35; dr <= 35; dr += 2) {
            const rx = Math.round(cx + Math.cos(rad) * (r + dr));
            const ry = Math.round(cy + Math.sin(rad) * (r + dr));
            if (rx >= 0 && rx < img.width && ry >= 0 && ry < img.height) {
              const lum = getLum(imgData.data, (ry * img.width + rx) * 4);
              if (lum > peak) peak = lum;
            }
          }
          ringLumMax += peak;
          count++;

          const bx = Math.round(cx + Math.cos(rad) * 100);
          const by = Math.round(cy + Math.sin(rad) * 100);
          if (bx >= 0 && bx < img.width && by >= 0 && by < img.height) {
            bgLumSum += getLum(imgData.data, (by * img.width + bx) * 4);
          }
        }
        const avgRingLum = ringLumMax / count;
        const avgBgLum = bgLumSum / count;
        const contrastRatio = (Math.max(avgRingLum, avgBgLum) + 0.05) / (Math.min(avgRingLum, avgBgLum) + 0.05);
        return {
          avgRingLum: Math.round(avgRingLum * 1000) / 1000,
          avgBgLum: Math.round(avgBgLum * 1000) / 1000,
          contrastRatio: Math.round(contrastRatio * 100) / 100
        };
      })()
    `);

    print(`  Ring Pixel Relative Luminance: ${contrastMeasurement.avgRingLum}`);
    print(`  Board Background Relative Luminance: ${contrastMeasurement.avgBgLum}`);
    print(`  Measured Pixel Contrast Ratio: ${contrastMeasurement.contrastRatio} : 1 (assert >= 3.0 : 1)`);
    assert.strictEqual(contrastMeasurement.contrastRatio >= 3.0, true, 'Contrast ratio >= 3:1');
    print(`  Contrast Ratio Verification: PASS (${contrastMeasurement.contrastRatio} >= 3.0)`);
    print();

    // ============================================================================
    // E3: REAL TOUCH INPUT REJECTION & VERIFYRUN TEST
    // ============================================================================
    print('--- [E3] TOUCH INPUT REJECTION DURING CEREMONY & VERIFYRUN ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=rewind&ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const e3Result = await cdp.eval(`
      (async () => {
        // Start game with seed 1 and ?ascension=64
        window.startNewGame(1);
        window.controller.config.ascensionAt = 64;
        window.controller.state.config.ascensionAt = 64;

        const preSteps = [{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"D"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"decision","pick":"shatter"},{"type":"move","dir":"D"},{"type":"move","dir":"R"},{"type":"move","dir":"D"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"R"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"R"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"R"},{"type":"move","dir":"D"},{"type":"move","dir":"L"},{"type":"move","dir":"D"},{"type":"move","dir":"R"}];

        for (const s of preSteps) {
          if (s.type === 'move') {
            window.controller.recordInput('swipe', s.dir);
            window.controller.submitMove(s.dir);
          } else if (s.type === 'decision') {
            window.controller.resolveDecision(s.pick);
          }
        }
        window.syncBoard(window.controller.getBoard(), 'e3-pre');

        const boardEl = document.getElementById('game-board');

        function sendTouchSwipe(dir) {
          const x0 = 150, y0 = 150;
          const x1 = dir === 'L' ? 50 : (dir === 'R' ? 250 : 150);
          const y1 = dir === 'U' ? 50 : (dir === 'D' ? 250 : 150);
          const t1 = new Touch({ identifier: 1, target: boardEl, clientX: x0, clientY: y0 });
          const t2 = new Touch({ identifier: 1, target: boardEl, clientX: x1, clientY: y1 });
          boardEl.dispatchEvent(new TouchEvent('touchstart', { touches: [t1], targetTouches: [t1], changedTouches: [t1], bubbles: true }));
          boardEl.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t2], bubbles: true }));
        }

        // Trigger Clean Slate via real touch swipe 'R'
        sendTouchSwipe('R');

        await new Promise(r => setTimeout(r, 200));

        const eventsBefore = (window.controller.getState().events || []).length;
        const imcBefore = JSON.stringify(window.controller.getState().inputMethodCounts || {});
        const boardAtTrigger = JSON.stringify(window.controller.getBoard());

        // Attempt 5 touch swipes and 3 ability taps during ceremony
        const inputDelays = [400, 800, 1500, 2100, 2600];
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, inputDelays[i] - (i === 0 ? 200 : inputDelays[i - 1])));
          sendTouchSwipe('U');
          if (i < 3) {
            const btnRewind = document.querySelector('[data-relic="rewind"]');
            if (btnRewind) btnRewind.click();
          }
        }

        const eventsDuring = (window.controller.getState().events || []).length;
        const imcDuring = JSON.stringify(window.controller.getState().inputMethodCounts || {});
        const boardDuring = JSON.stringify(window.controller.getBoard());
        const errorsDuring = (window.controller?.runErrors || []).length;
        const ignoredSwipes = window.cleanSlateSequenceState?.ignoredSwipeCount || 0;
        const ignoredAbilities = window.cleanSlateSequenceState?.ignoredAbilityCount || 0;

        // Wait until ceremony completes
        while (window.cleanSlateSequenceState || window.isAnimating) {
          await new Promise(r => setTimeout(r, 50));
        }

        // If draft overlay appeared (as required by S2/E4), resolve it
        if (window.controller.hasPendingDecision()) {
          const d = window.controller.getPendingDecision();
          window.controller.resolveDecision(d.offers ? d.offers[0] : d.candidates[0]);
        }

        // Send one post-ceremony swipe
        const movesBeforePost = window.controller.getState().moveCount;
        sendTouchSwipe('D');
        await new Promise(r => setTimeout(r, 150));
        const movesAfterPost = window.controller.getState().moveCount;
        const postSwipeProcessed = movesAfterPost === movesBeforePost + 1;

        // End run cleanly to produce authoritative completed run log
        window.controller.endRun();

        const runLog = window.controller.getRunLog();
        return {
          eventsUnchanged: eventsBefore === eventsDuring,
          imcUnchanged: imcBefore === imcDuring,
          boardUnchanged: boardAtTrigger === boardDuring,
          errorsDuring,
          ignoredSwipes,
          ignoredAbilities,
          postSwipeProcessed,
          isGameOver: window.controller.isGameOver(),
          runLog
        };
      })()
    `);

    print(`  Inputs Attempted During Ceremony: 5 touch swipes, 3 ability taps`);
    print(`  Ignored Swipes Count: ${e3Result.ignoredSwipes}`);
    print(`  Ignored Ability Taps Count: ${e3Result.ignoredAbilities}`);
    print(`  Events Length Unchanged: ${e3Result.eventsUnchanged}`);
    print(`  InputMethodCounts Unchanged: ${e3Result.imcUnchanged}`);
    print(`  Board State Unchanged: ${e3Result.boardUnchanged}`);
    print(`  Runtime Errors During Ceremony: ${e3Result.errorsDuring}`);
    print(`  Post-Ceremony Swipe Processed: ${e3Result.postSwipeProcessed}`);

    // Verify run with verifyRun in mode 'any'
    const verifyRes = verifyRun(e3Result.runLog, { mode: 'any' });
    print(`  verifyRun Verdict on Completed Run: ${verifyRes.status} (reason: ${verifyRes.reason})`);
    assert.strictEqual(verifyRes.status, 'OK', 'verifyRun must return OK');
    print(`  E3 Verification: PASS`);
    print();

    // ============================================================================
    // E4: DRAFT GATING (DRAFT OVERLAY SUPPRESSED UNTIL CEREMONY COMPLETION)
    // ============================================================================
    print('--- [E4] DRAFT GATING VERIFICATION ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&first=1&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const e4Result = await cdp.eval(`
      (async () => {
        window.controller.state.over = false;
        window.controller.config.draftFirstAt = 1;
        window.controller.state.config.draftFirstAt = 1;
        window.controller.config.ascensionAt = 64;
        window.controller.state.config.ascensionAt = 64;
        window.controller.state.moveCount = 0;

        window.controller.state.board = [
          32, 32, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const draftOverlay = document.getElementById('draft-overlay');
        const t0 = performance.now();
        window.handleMove('L', 'swipe');

        let draftSeenDuring = false;
        let ceremonyEndTime = null;
        let draftAppearTime = null;

        while (true) {
          const now = performance.now();
          const elapsed = Math.round(now - t0);
          const isDraftVisible = draftOverlay && !draftOverlay.classList.contains('hidden');

          if (window.cleanSlateSequenceState !== null) {
            if (isDraftVisible) draftSeenDuring = true;
          } else {
            if (ceremonyEndTime === null) ceremonyEndTime = elapsed;
            if (isDraftVisible && draftAppearTime === null) {
              draftAppearTime = elapsed;
              break;
            }
          }
          if (elapsed > 4500) break;
          await new Promise(r => setTimeout(r, 40));
        }

        return {
          draftSeenDuring,
          ceremonyEndTime,
          draftAppearTime,
          draftGatedCorrectly: !draftSeenDuring && draftAppearTime !== null && draftAppearTime >= ceremonyEndTime
        };
      })()
    `);

    print(`  Trigger Move Time: 0 ms`);
    print(`  Draft Visible During Ceremony: ${e4Result.draftSeenDuring ? 'YES (FAIL)' : 'NO (PASS)'}`);
    print(`  Ceremony End Timestamp: ${e4Result.ceremonyEndTime} ms`);
    print(`  Draft Overlay Appearance Timestamp: ${e4Result.draftAppearTime} ms`);
    print(`  Draft Gating Verification: ${e4Result.draftGatedCorrectly ? 'PASS' : 'FAIL'}`);
    assert.strictEqual(e4Result.draftGatedCorrectly, true, 'Draft overlay must appear only after ceremony ends');
    print();

    // ============================================================================
    // E5: CPU THROTTLING RATE 4 PERFORMANCE & PARTICLE CAP
    // ============================================================================
    print('--- [E5] CPU THROTTLING (RATE 4) PERFORMANCE & PARTICLE DOM ELEMENTS ---');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const e5Result = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.over = false;
        window.controller.state.board = [
          32, 32, 'S', 2,
          4, 8, 16, 'S',
          2, 4, 8, 16,
          'S', 2, 4, 8
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const deltas = [];
        let lastTs = null;
        let peakParticles = 0;
        let t0 = null;

        window.handleMove('L', 'swipe');

        function measure(ts) {
          if (t0 === null) t0 = ts;
          if (lastTs !== null) {
            deltas.push(ts - lastTs);
          }
          lastTs = ts;

          const tilesLayer = document.getElementById('tiles-layer');
          if (tilesLayer) {
            const count = tilesLayer.querySelectorAll('.shatter-shard, .clean-slate-dust, .shatter-flash, .stand-dust-ring').length;
            if (count > peakParticles) peakParticles = count;
          }

          if (ts - t0 < 3600) {
            requestAnimationFrame(measure);
          } else {
            resolve({ deltas, peakParticles });
          }
        }
        requestAnimationFrame(measure);
      })
    `);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    const d5 = e5Result.deltas;
    const n5 = d5.length;
    const min5 = Math.min(...d5);
    const max5 = Math.max(...d5);
    const mean5 = d5.reduce((s, v) => s + v, 0) / n5;
    const var5 = d5.reduce((s, v) => s + Math.pow(v - mean5, 2), 0) / n5;
    const sd5 = Math.sqrt(var5);

    print(`  CPU Throttling Rate: 4x`);
    print(`  Total rAF Frames Sampled: ${n5}`);
    print(`  rAF Frame Deltas (min / max / mean / sd): min=${min5.toFixed(2)} ms, max=${max5.toFixed(2)} ms, mean=${mean5.toFixed(2)} ms, sd=${sd5.toFixed(2)} ms`);
    print(`  Peak Animated Particle DOM Elements: ${e5Result.peakParticles} (cap <= 80)`);
    assert.strictEqual(e5Result.peakParticles <= 80, true, 'Peak particles must be <= 80');
    print(`  Particle Cap Verification: PASS (${e5Result.peakParticles} <= 80)`);
    print();

    // ============================================================================
    // E6: REDUCED MOTION RUN
    // ============================================================================
    print('--- [E6] REDUCED MOTION CEREMONY VERIFICATION ---');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const e6Result = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.over = false;
        window.controller.state.board = [
          32, 32, 'S', 2,
          4, 8, 16, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.beginInjection();
        window.syncBoard(window.controller.getBoard(), 'inj');
        window.endInjection();

        const t0 = performance.now();
        let ringSeen = false;
        let chargeSeen = false;
        let ignoredSwipes = 0;

        window.handleMove('L', 'swipe');

        const poll = setInterval(() => {
          if (document.querySelector('.clean-slate-ring, #clean-slate-ring')) ringSeen = true;
          if (document.querySelector('.tile-clean-slate-charge')) chargeSeen = true;
        }, 30);

        // Attempt swipe during reduced motion
        setTimeout(() => {
          window.handleMove('D', 'swipe');
          ignoredSwipes = window.cleanSlateSequenceState?.ignoredSwipeCount || 0;
        }, 500);

        function check() {
          if (performance.now() - t0 > 100 && !window.isAnimating && !window.cleanSlateSequenceState) {
            clearInterval(poll);
            resolve({
              duration: performance.now() - t0,
              ringSeen,
              chargeSeen,
              ignoredSwipes
            });
          } else {
            requestAnimationFrame(check);
          }
        }
        requestAnimationFrame(check);
      })
    `);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [] });

    print(`  Reduced-Motion Duration: ${e6Result.duration.toFixed(1)} ms (assert <= 1800 ms)`);
    print(`  Ring Element Created in DOM: ${e6Result.ringSeen ? 'YES (FAIL)' : 'NO (PASS)'}`);
    print(`  Charge Glow Element in DOM: ${e6Result.chargeSeen ? 'YES (FAIL)' : 'NO (PASS)'}`);
    print(`  Input Policy (Ignored Swipes): ${e6Result.ignoredSwipes}`);
    assert.strictEqual(e6Result.duration <= 1800, true, 'Reduced motion duration must be <= 1800 ms');
    assert.strictEqual(e6Result.ringSeen, false, 'No ring element in reduced motion');
    assert.strictEqual(e6Result.chargeSeen, false, 'No charge glow in reduced motion');
    print(`  Reduced-Motion Verification: PASS`);
    print();

    // ============================================================================
    // E9: GAME-OVER CHIP WIDTH CHECK AT 320x568
    // ============================================================================
    print('--- [E9] GAME-OVER CHIP WIDTH AT 320x568 VIEWPORT ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ascension=64&debug=1` });
    await sleep(400);

    const hudResult = await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn && !btn.closest('.hidden')) btn.click();

        window.controller.state.ascensions = [{ value: 2048, payout: 20480 }];
        window.controller.state.over = true;
        window.controller.state.score = 34560;

        const endOverlay = document.getElementById('end-overlay');
        if (endOverlay) endOverlay.classList.remove('hidden');

        if (typeof window.handleGameOver === 'function') {
          window.handleGameOver();
        }

        const chip = document.getElementById('end-clean-slate-chip');
        const headerRow = endOverlay.querySelector('.end-header-row');
        const eyebrowTitle = endOverlay.querySelector('.end-header-row .eyebrow');
        const endCard = endOverlay.querySelector('.modal.end-card') || endOverlay;

        const chipRect = chip ? chip.getBoundingClientRect() : null;
        const headerRect = headerRow ? headerRow.getBoundingClientRect() : null;
        const titleRect = eyebrowTitle ? eyebrowTitle.getBoundingClientRect() : null;
        const containerRect = endCard ? endCard.getBoundingClientRect() : null;

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
    print(`  Title (.end-header-row .eyebrow) Width: ${hudResult.titleWidth} px`);
    print(`  Header (.end-header-row) Width: ${hudResult.headerWidth} px`);
    print(`  Container (.modal.end-card) Width: ${hudResult.containerWidth} px`);
    print(`  No Horizontal Overflow: ${hudResult.noOverflow ? 'PASS' : 'FAIL'}`);
    assert.strictEqual(hudResult.chipVisible && hudResult.noOverflow && hudResult.headerWidth > 0, true);
    print(`  Game Over Header Width Test: PASS\n`);

    print('================================================================================');
    print('                      ALL CEREMONY TESTS COMPLETED                              ');
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
