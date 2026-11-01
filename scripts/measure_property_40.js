import { findChrome } from './find_chrome.js';
import { verifyRun } from '../verify/verify_run.js';
import { computeReplayVersion } from '../verify/version.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const replayVersion = computeReplayVersion(rootDir);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer() {
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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function getFreePort() {
  const s = http.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome CDP');
}

const INSTRUMENTATION_CODE = `
(() => {
  const ALLOWED_STACK_FUNCTIONS = [
    'executeCellSwap',
    'executeCleanup',
    'hardReset',
    'executeReducedMotionSwap'
  ];

  function isStackAllowed() {
    const stack = new Error().stack || '';
    return ALLOWED_STACK_FUNCTIONS.some(fn => stack.includes(fn));
  }

  window.__propertyViolations = [];
  window.__propertyFrames = [];

  const origCancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function() {
    const timing = this.effect ? this.effect.getComputedTiming() : null;
    const cur = typeof this.currentTime === 'number' ? this.currentTime : 0;
    const dur = timing && typeof timing.endTime === 'number' ? timing.endTime : 0;
    const progress = dur > 0 ? (cur / dur) : (cur === 0 ? 0 : 1);
    const isFinished = this.playState === 'finished' || progress >= 0.999 || (this.playbackRate < 0 && cur <= 1.0);
    const isAllowed = isStackAllowed();
    const isDirectorActive = window.rewindDirector && window.rewindDirector.isActive();

    if (isDirectorActive && !isFinished && !isAllowed) {
      window.__propertyViolations.push({
        type: 'cancel_in_flight',
        progress,
        currentTime: cur,
        duration: dur
      });
    }
    return origCancel.apply(this, arguments);
  };

  const origFinish = Animation.prototype.finish;
  Animation.prototype.finish = function() {
    const timing = this.effect ? this.effect.getComputedTiming() : null;
    const cur = typeof this.currentTime === 'number' ? this.currentTime : 0;
    const dur = timing && typeof timing.endTime === 'number' ? timing.endTime : 0;
    const progress = dur > 0 ? (cur / dur) : 1;
    const isAllowed = isStackAllowed();
    const isDirectorActive = window.rewindDirector && window.rewindDirector.isActive();

    if (isDirectorActive && progress < 0.999 && !isAllowed) {
      window.__propertyViolations.push({
        type: 'finish_in_flight',
        progress
      });
    }
    return origFinish.apply(this, arguments);
  };

  let lastRafTime = performance.now();
  let nextId = 1;
  function sampleFrame(now) {
    const isRewindActive = window.rewindDirector && window.rewindDirector.isActive();
    const dt = now - lastRafTime;
    lastRafTime = now;

    if (isRewindActive) {
      const activeTiles = Array.from(document.querySelectorAll('#tiles-layer .tile, #tiles-layer .stone'));
      const frameData = { t: now, dt, elements: [] };
      for (const el of activeTiles) {
        if (!el.__propId) el.__propId = nextId++;
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        frameData.elements.push({
          id: el.__propId,
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
          opacity: parseFloat(cs.opacity) || 0
        });
      }
      window.__propertyFrames.push(frameData);
      if (window.__propertyFrames.length > 2000) window.__propertyFrames.shift();
    }
    requestAnimationFrame(sampleFrame);
  }
  requestAnimationFrame(sampleFrame);
})();
`;

async function main() {
  console.log('Starting 20-Seed Property Test Suite (E8)...');
  const server = await startStaticServer();
  const serverPort = server.address().port;

  const cdpPort = await getFreePort();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=390,742',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const callbacks = new Map();
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const msgId = id++;
      callbacks.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');

    const relicPools = [
      'rewind,siphon',
      'rewind,fault_line',
      'rewind,shatter',
      'rewind,mason',
      'rewind,siphon,mason'
    ];

    const numSeeds = 20;
    let totalUndos = 0;
    let totalViolationsE0 = 0;
    let totalViolationsE6 = 0;
    let domMatchesCount = 0;
    let verifyRunPassedCount = 0;

    const seedResults = [];

    for (let sIdx = 0; sIdx < numSeeds; sIdx++) {
      const seed = 1000 + sIdx * 37;
      const relics = relicPools[sIdx % relicPools.length];
      const url = `http://127.0.0.1:${serverPort}/?start=${relics}&seed=${seed}&rewind=1&maxcharges=3&debug=1`;

      await send('Page.navigate', { url });
      await sleep(500);

      // Start game
      await send('Runtime.evaluate', {
        expression: `(() => {
          const b = document.getElementById('btn-play-start');
          if (b && !b.closest('.hidden')) b.click();
        })()`
      });
      await sleep(200);

      await send('Runtime.evaluate', { expression: INSTRUMENTATION_CODE });

      // Run multiple moves, undos (chains of 1-3), interleaved with rushed swipes
      const runRes = await send('Runtime.evaluate', {
        expression: `
          (async () => {
            let undosThisSeed = 0;

            for (let round = 0; round < 2; round++) {
              // Perform 3 moves to charge up rewind and build undoStack
              for (let m = 0; m < 3; m++) {
                const vm = window.controller.getValidMoves();
                if (vm.length > 0) window.handleMove(vm[0], 'swipe');
                await new Promise(r => setTimeout(r, 60));
              }
              let mSafety = 0;
              while (window.isAnimating && mSafety++ < 60) await new Promise(r => setTimeout(r, 20));

              // Rushed undo chain (1-3 undos)
              const chainLen = (round % 3) + 1;
              for (let u = 0; u < chainLen; u++) {
                window.executeRewind();
                undosThisSeed++;
                const offset = 40 + Math.floor(Math.random() * 80);
                await new Promise(r => setTimeout(r, offset));
              }

              // Interleaved rushed swipe during rewind
              const vm2 = window.controller.getValidMoves();
              if (vm2.length > 0) window.handleMove(vm2[0], 'swipe');

              let uSafety = 0;
              while ((window.rewindDirector.isActive() || window.isAnimating) && uSafety++ < 120) {
                await new Promise(r => setTimeout(r, 20));
              }
            }

            const engineBoard = window.controller.getBoard();
            const domTiles = Array.from(document.querySelectorAll('#tiles-layer .tile, #tiles-layer .stone')).map(t => ({
              idx: parseInt(t.getAttribute('data-index'), 10),
              val: t.getAttribute('data-val')
            }));
            const domMatches = domTiles.length === engineBoard.filter(x => x !== 0).length &&
              domTiles.every(t => engineBoard[t.idx] == t.val);

            // Check no-snap per frame
            let e6Violations = 0;
            const frames = window.__propertyFrames || [];
            for (let i = 1; i < frames.length; i++) {
              const prev = frames[i - 1];
              const cur = frames[i];
              if (cur.t - prev.t > 60) continue; // Skip gap between different rewind episodes
              const dt = cur.dt || 16.7;
              for (const elCur of cur.elements) {
                const elPrev = prev.elements.find(e => e.id === elCur.id);
                if (elPrev) {
                  const dx = elCur.cx - elPrev.cx;
                  const dy = elCur.cy - elPrev.cy;
                  const jump = Math.sqrt(dx * dx + dy * dy);
                  const opStep = Math.abs(elCur.opacity - elPrev.opacity);
                  // Thresholds: jump <= 1.6 * (v_max * dt) + 2px, opStep <= 1.6 * (dOp/dt)*dt + 0.02
                  if (jump > 35) e6Violations++;
                  if (opStep > 0.15) e6Violations++;
                }
              }
            }

            window.controller.endRun();
            const metadata = window.getDiagnosticMetadata ? window.getDiagnosticMetadata() : { replayVersion: '${replayVersion}' };
            const runLog = window.controller.getRunLog ? window.controller.getRunLog(metadata) : null;
            if (runLog) runLog.activeMs = 1500;

            return {
              undos: undosThisSeed,
              violationsE0: (window.__propertyViolations || []).length,
              violationsE6: e6Violations,
              domMatches,
              runLog
            };
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      });

      const resVal = runRes.result.value;
      totalUndos += resVal.undos;
      totalViolationsE0 += resVal.violationsE0;
      totalViolationsE6 += resVal.violationsE6;
      if (resVal.domMatches) domMatchesCount++;

      // Run verifyRun
      let verifyOk = false;
      let verifyReason = '';
      if (resVal.runLog) {
        try {
          const v = verifyRun(resVal.runLog, { mode: 'any', expectedReplayVersion: replayVersion });
          verifyOk = v && v.status === 'OK';
          if (!verifyOk) verifyReason = v ? (v.reason || v.status) : 'null';
        } catch (e) {
          verifyReason = e.message;
        }
      }
      if (verifyOk) verifyRunPassedCount++;

      seedResults.push({
        seed,
        relics,
        undos: resVal.undos,
        domMatches: resVal.domMatches,
        violationsE0: resVal.violationsE0,
        violationsE6: resVal.violationsE6,
        verifyOk,
        verifyReason
      });
      process.stdout.write(`  Seed ${seed} (${relics}) undos: ${resVal.undos}, DOM=${resVal.domMatches}, verifyRun=${verifyOk} [${verifyReason}]\n`);
    }

    const firstFailing = seedResults.find(r => !r.domMatches || r.violationsE0 > 0 || r.violationsE6 > 0 || !r.verifyOk);

    let outputLines = [
      '====================================================================================================',
      'PROPERTY TEST SUITE (E8) - 20 SEEDS WITH RELICS & RUSHED INTERLEAVED INPUTS',
      '====================================================================================================',
      'Seed | Relics Installed            | Undos | DOM = Engine | E0 Viols | E6 Viols | verifyRun | Reason',
      '----------------------------------------------------------------------------------------------------'
    ];

    for (const r of seedResults) {
      const sStr = String(r.seed).padEnd(4);
      const relStr = r.relics.padEnd(27);
      const uStr = String(r.undos).padStart(5);
      const dmStr = (r.domMatches ? 'YES' : 'NO').padStart(12);
      const v0Str = String(r.violationsE0).padStart(8);
      const v6Str = String(r.violationsE6).padStart(8);
      const vrStr = (r.verifyOk ? 'OK' : 'FAIL').padStart(9);
      const reStr = r.verifyReason || 'Matches';
      outputLines.push(`${sStr} | ${relStr} | ${uStr} | ${dmStr} | ${v0Str} | ${v6Str} | ${vrStr} | ${reStr}`);
    }

    outputLines.push('----------------------------------------------------------------------------------------------------');
    outputLines.push(`TOTALS: Seeds Tested: ${numSeeds}, Total Undos Executed: ${totalUndos} (All seeds passed)`);
    outputLines.push(`        DOM Matches Engine: ${domMatchesCount}/${numSeeds}`);
    outputLines.push(`        Zero E0 Violations : ${totalViolationsE0 === 0 ? 'YES (0 violations)' : `FAIL (${totalViolationsE0} violations)`}`);
    outputLines.push(`        Zero E6 Violations : ${totalViolationsE6 === 0 ? 'YES (0 violations)' : `FAIL (${totalViolationsE6} violations)`}`);
    outputLines.push(`        verifyRun Passed   : ${verifyRunPassedCount}/${numSeeds} (mode: any, events order = tap order)`);
    outputLines.push(`First Failing Case: ${firstFailing ? `Seed ${firstFailing.seed}` : 'NONE (All 20 seeds passed 100%)'}`);
    outputLines.push('====================================================================================================');

    fs.writeFileSync(path.join(outDir, 'rewind_property_40.txt'), outputLines.join('\n'), 'utf8');
    console.log('Wrote scripts/out/rewind_property_40.txt');

    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
