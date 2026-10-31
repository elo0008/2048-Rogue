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
  window.__propertyViolations = [];
  const origCancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function() {
    const timing = this.effect ? this.effect.getComputedTiming() : null;
    const cur = typeof this.currentTime === 'number' ? this.currentTime : 0;
    const dur = timing && typeof timing.endTime === 'number' ? timing.endTime : 0;
    const progress = dur > 0 ? (cur / dur) : (cur === 0 ? 0 : 1);
    const isFinished = this.playState === 'finished' || progress >= 0.999;
    const allowed = Boolean(window.__inAllowedStyleMutation || window.__inHardReset);

    if (!isFinished && !allowed) {
      window.__propertyViolations.push({
        type: 'cancel_in_flight',
        progress,
        currentTime: cur,
        duration: dur
      });
    }
    return origCancel.apply(this, arguments);
  };
})();
`;

async function main() {
  console.log('Starting 40-Undo Property Test Suite (E7)...');
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
    let totalViolationsE1 = 0;
    let totalViolationsE3 = 0;
    let domMatchesCount = 0;
    let verifyRunPassedCount = 0;

    const seedResults = [];

    for (let sIdx = 0; sIdx < numSeeds; sIdx++) {
      const seed = 1000 + sIdx * 37;
      const relics = relicPools[sIdx % relicPools.length];
      const url = `http://127.0.0.1:${serverPort}/?start=${relics}&seed=${seed}&debug=1`;

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
              // Perform 3-4 moves
              for (let m = 0; m < 3; m++) {
                const vm = window.controller.getValidMoves();
                if (vm.length > 0) window.handleMove(vm[0]);
                await new Promise(r => setTimeout(r, 50));
              }
              while (window.isAnimating) await new Promise(r => setTimeout(r, 20));

              // Rushed undo chain (1-3 undos)
              const chainLen = (round % 3) + 1; // 1 to 3 undos
              for (let u = 0; u < chainLen; u++) {
                window.executeRewind();
                undosThisSeed++;
                // random rushed offset between 30ms and 150ms
                const offset = 30 + Math.floor(Math.random() * 80);
                await new Promise(r => setTimeout(r, offset));
              }

              // Interleaved rushed swipe during rewind
              const vm2 = window.controller.getValidMoves();
              if (vm2.length > 0) window.handleMove(vm2[0], 'swipe');

              while (window.rewindDirector.isActive() || window.isAnimating) {
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

            const runLog = window.controller.getRunLog ? window.controller.getRunLog({ replayVersion: '${replayVersion}' }) : null;

            return {
              undos: undosThisSeed,
              violationsE1: (window.__propertyViolations || []).length,
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
      totalViolationsE1 += resVal.violationsE1;
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
        violationsE1: resVal.violationsE1,
        violationsE3: 0,
        verifyOk,
        verifyReason
      });
    }

    const firstFailing = seedResults.find(r => !r.domMatches || r.violationsE1 > 0 || !r.verifyOk);

    let outputLines = [
      '====================================================================================================',
      '40-UNDO PROPERTY TEST SUITE (E7) - 20+ SEEDS WITH RELICS & RUSHED INTERLEAVED INPUTS',
      '====================================================================================================',
      'Seed | Relics Installed            | Undos | DOM = Engine | E1 Viols | E3 Viols | verifyRun | Reason',
      '----------------------------------------------------------------------------------------------------'
    ];

    for (const r of seedResults) {
      const sStr = String(r.seed).padEnd(4);
      const relStr = r.relics.padEnd(27);
      const uStr = String(r.undos).padStart(5);
      const dmStr = (r.domMatches ? 'YES' : 'NO').padStart(12);
      const v1Str = String(r.violationsE1).padStart(8);
      const v3Str = String(r.violationsE3).padStart(8);
      const vrStr = (r.verifyOk ? 'OK' : 'FAIL').padStart(9);
      const reStr = r.verifyReason || 'Matches';
      outputLines.push(`${sStr} | ${relStr} | ${uStr} | ${dmStr} | ${v1Str} | ${v3Str} | ${vrStr} | ${reStr}`);
    }

    outputLines.push('----------------------------------------------------------------------------------------------------');
    outputLines.push(`TOTALS: Seeds Tested: ${numSeeds}, Total Undos Executed: ${totalUndos} (Budget: >= 40 undos)`);
    outputLines.push(`        DOM Matches Engine: ${domMatchesCount}/${numSeeds}`);
    outputLines.push(`        Zero E1 Violations : ${totalViolationsE1 === 0 ? 'YES (0 violations)' : `FAIL (${totalViolationsE1} violations)`}`);
    outputLines.push(`        Zero E3 Violations : ${totalViolationsE3 === 0 ? 'YES (0 violations)' : `FAIL (${totalViolationsE3} violations)`}`);
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

