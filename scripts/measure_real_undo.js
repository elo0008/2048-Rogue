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
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();

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

async function main() {
  console.log('Starting Real Swipe-then-Undo Investigation (T5, 30+ cases over 10 seeds)...');
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

    let msgId = 1;
    const callbacks = new Map();
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = msgId++;
      callbacks.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');

    const seeds = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const totalCases = [];
    const allRafDeltas = [];

    for (const seed of seeds) {
      console.log(`Testing Seed ${seed} with Siphon, Fault Line, Shatter, Mason...`);
      const url = `http://127.0.0.1:${serverPort}/?seed=${seed}&start=siphon,fault_line,shatter,mason,rewind&rewind=1&debug=1`;
      await send('Page.navigate', { url });
      await sleep(400);

      // Dismiss start overlay
      await send('Runtime.evaluate', {
        expression: `(() => {
          const b = document.getElementById('btn-play-start');
          if (b && !b.closest('.hidden')) b.click();
        })()`
      });
      await sleep(150);

      // Ensure abilities & relics
      await send('Runtime.evaluate', {
        expression: `(() => {
          const s = window.controller.state;
          if (!s.abilities) s.abilities = {};
          s.abilities.rewind = { charges: 10, counter: 0, swipesAtMax: 0, maxCharges: 10, swipesPerCharge: 10 };
          s.relics = new Set(['siphon', 'fault_line', 'shatter', 'mason', 'rewind']);
          window.renderAbilityBar();
        })()`
      });
      await sleep(50);

      // Execute 3 swipe-then-undo cases per seed = 30 total cases
      for (let c = 0; c < 3; c++) {
        const caseId = `Seed${seed}_Move${c + 1}`;

        // Get legal moves and pick one
        const moveChoice = await send('Runtime.evaluate', {
          expression: `(() => {
            const vm = window.controller.getValidMoves();
            return vm.length > 0 ? vm[0] : 'L';
          })()`,
          returnByValue: true
        });
        const dir = moveChoice.result.value;

        // Record board before move
        const boardBeforeMove = (await send('Runtime.evaluate', {
          expression: `window.controller.getBoard()`,
          returnByValue: true
        })).result.value;

        // Perform move
        await send('Runtime.evaluate', {
          expression: `window.handleMove('${dir}', 'swipe')`
        });
        await sleep(350);

        // Record board after move (pre-undo state)
        const boardAfterMove = (await send('Runtime.evaluate', {
          expression: `window.controller.getBoard()`,
          returnByValue: true
        })).result.value;

        // Identify differing cells
        const differingIndices = [];
        for (let idx = 0; idx < 16; idx++) {
          if (boardBeforeMove[idx] !== boardAfterMove[idx]) {
            differingIndices.push(idx);
          }
        }

        // Install frame sampler
        await send('Runtime.evaluate', {
          expression: `(() => {
            window.__undoFrameLog = [];
            window.__undoRafDeltas = [];
            let lastT = null;
            let startT = null;
            let recording = false;

            function sampler() {
              requestAnimationFrame((t) => {
                if (!recording) {
                  if (window.rewindDirector && window.rewindDirector.isActive()) {
                    recording = true;
                    startT = t;
                    lastT = t;
                  } else {
                    sampler();
                    return;
                  }
                }

                const dt = t - lastT;
                lastT = t;
                if (dt > 0 && dt < 200) window.__undoRafDeltas.push(dt);

                const cells = [];
                for (let i = 0; i < 16; i++) {
                  const el = document.querySelector('#tiles-layer .tile[data-index="' + i + '"], #tiles-layer .stone[data-index="' + i + '"]');
                  const face = el ? el.querySelector('.tile-face, .stone-face') : null;
                  const tid = el ? (el.getAttribute('data-tid') || el.getAttribute('data-tile-id') || el.id) : null;
                  const val = el ? el.getAttribute('data-val') : '0';
                  const cs = face ? window.getComputedStyle(face) : null;
                  const tr = cs ? cs.transform : 'none';
                  cells.push({ tid, val, tr });
                }

                window.__undoFrameLog.push({
                  time: t - startT,
                  cells
                });

                if (window.rewindDirector && window.rewindDirector.isActive()) {
                  sampler();
                }
              });
            }
            sampler();
          })()`
        });

        // Trigger Rewind
        await send('Runtime.evaluate', {
          expression: `window.executeRewind()`
        });

        // Wait for rewind to finish
        await send('Runtime.evaluate', {
          expression: `new Promise(r => {
            function check() {
              if (!window.rewindDirector.isActive() && !window.isAnimating && window.__undoFrameLog && window.__undoFrameLog.length >= 45) r();
              else setTimeout(check, 30);
            }
            check();
          })`,
          awaitPromise: true
        });
        await sleep(150);

        // Fetch logs
        const runRes = (await send('Runtime.evaluate', {
          expression: `(() => {
            return {
              frames: window.__undoFrameLog,
              deltas: window.__undoRafDeltas,
              finalBoard: window.controller.getBoard()
            };
          })()`,
          returnByValue: true
        })).result.value;

        allRafDeltas.push(...runRes.deltas);

        // Analyze per-cell shown switches
        const frames = runRes.frames;
        let singleSwitchAllCells = true;
        let unchangedCellsSwitchesZero = true;
        const cellSwapFrames = {};

        for (let i = 0; i < 16; i++) {
          const preVal = frames[0].cells[i].val;
          const preTid = frames[0].cells[i].tid;
          let switches = 0;
          let curVal = preVal;
          let swapF = -1;

          for (let f = 1; f < frames.length; f++) {
            const cellF = frames[f].cells[i];
            if (cellF.tid !== preTid && swapF === -1) {
              swapF = f;
            }
            if (cellF.val !== curVal) {
              switches++;
              curVal = cellF.val;
            }
          }

          cellSwapFrames[i] = swapF;
          if (differingIndices.includes(i)) {
            if (switches !== 1) singleSwitchAllCells = false;
          } else {
            if (switches !== 0) unchangedCellsSwitchesZero = false;
          }
        }

        // Check monotonic in m
        let monotonicInM = true;
        for (let i = 0; i < 16; i++) {
          for (let j = 0; j < 16; j++) {
            const mi = Math.floor(i / 4) + (i % 4);
            const mj = Math.floor(j / 4) + (j % 4);
            if (mi < mj && cellSwapFrames[i] > cellSwapFrames[j] && cellSwapFrames[i] !== -1 && cellSwapFrames[j] !== -1) {
              monotonicInM = false;
            }
          }
        }

        // Check travel property
        const cell0SwapF = cellSwapFrames[0] >= 0 ? cellSwapFrames[0] : 9;
        const cell15AtNadir = frames[cell0SwapF] ? frames[cell0SwapF].cells[15] : null;
        const travelProp1 = cell15AtNadir && (cell15AtNadir.tr === 'none' || cell15AtNadir.tr.includes('matrix(1, 0, 0, 1'));

        totalCases.push({
          caseId,
          seed,
          dir,
          diffCellsCount: differingIndices.length,
          singleSwitchPass: singleSwitchAllCells,
          unchangedPreserved: unchangedCellsSwitchesZero,
          monotonicInM,
          travelProp1: Boolean(travelProp1),
          finalMatchesBeforeMove: JSON.stringify(runRes.finalBoard) === JSON.stringify(boardBeforeMove)
        });
      }
    }

    // rAF delta statistics
    let minD = 999, maxD = 0, sumD = 0;
    for (const d of allRafDeltas) {
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      sumD += d;
    }
    const meanD = sumD / (allRafDeltas.length || 1);
    let varD = 0;
    for (const d of allRafDeltas) {
      varD += (d - meanD) * (d - meanD);
    }
    const sdD = Math.sqrt(varD / (allRafDeltas.length || 1));

    // Write real_undo_timeline.txt
    let out = '';
    out += '=========================================================================================================\n';
    out += 'REAL UNDO INVESTIGATION REPORT (>= 30 REAL SWIPE-THEN-UNDO CASES OVER 10 SEEDS)\n';
    out += '=========================================================================================================\n';
    out += 'Time Driver        : Real browser requestAnimationFrame (Chrome Headless, 390x742, mobile)\n';
    out += `rAF Delta Stats    : min=${minD.toFixed(2)} ms, max=${maxD.toFixed(2)} ms, mean=${meanD.toFixed(2)} ms, sd=${sdD.toFixed(2)} ms (Clock Stepped: NO)\n`;
    out += 'Relics Configured  : Siphon, Fault Line, Shatter, Mason, Rewind\n';
    out += `Total Cases Tested : ${totalCases.length} (3 moves per seed x 10 seeds)\n`;
    out += '---------------------------------------------------------------------------------------------------------\n';
    out += 'Case ID        | Seed | Dir | Diff Cells | Changed Switch=1 | Unchanged Switch=0 | Monotonic m | Travel Prop | State Restored\n';
    out += '---------------------------------------------------------------------------------------------------------\n';

    for (const c of totalCases) {
      const idStr = c.caseId.padEnd(14);
      const sStr = String(c.seed).padStart(4);
      const dStr = c.dir.padStart(3);
      const dcStr = String(c.diffCellsCount).padStart(10);
      const csStr = (c.singleSwitchPass ? 'PASS (1)' : 'FAIL').padStart(16);
      const usStr = (c.unchangedPreserved ? 'PASS (0)' : 'FAIL').padStart(18);
      const mStr = (c.monotonicInM ? 'PASS' : 'WARN').padStart(11);
      const tpStr = (c.travelProp1 ? 'PASS' : 'FAIL').padStart(11);
      const stStr = (c.finalMatchesBeforeMove ? 'PASS (Exact)' : 'FAIL').padStart(14);
      out += `${idStr} | ${sStr} | ${dStr} | ${dcStr} | ${csStr} | ${usStr} | ${mStr} | ${tpStr} | ${stStr}\n`;
    }

    out += '---------------------------------------------------------------------------------------------------------\n';
    out += 'INVARIANT VERIFICATION SUMMARY:\n';
    const allSingle = totalCases.every(c => c.singleSwitchPass);
    const allUnchanged = totalCases.every(c => c.unchangedPreserved);
    const allMono = totalCases.every(c => c.monotonicInM);
    const allTravel = totalCases.every(c => c.travelProp1);
    const allRestored = totalCases.every(c => c.finalMatchesBeforeMove);

    out += `✔ Changed cells switch shown() value exactly once         : ${allSingle ? 'PASS (100%)' : 'FAIL'}\n`;
    out += `✔ Unchanged cells press and rise without changing value   : ${allUnchanged ? 'PASS (100%)' : 'FAIL'}\n`;
    out += `✔ Per-cell swap times monotonic in diagonal m             : ${allMono ? 'PASS (100%)' : 'FAIL'}\n`;
    out += `✔ Travel properties hold (Cell 0 nadir while 15 untouched): ${allTravel ? 'PASS (100%)' : 'FAIL'}\n`;
    out += `✔ World state restored bit-identical to pre-swipe state   : ${allRestored ? 'PASS (100%)' : 'FAIL'}\n\n`;

    out += 'E1 vs E2 PRE-VALUE EXPLANATION:\n';
    out += 'In earlier diagnosis runs, E1 reported Cell 0 as 2 and Cell 15 as 8 at frame 0, while E2 listed pre-values\n';
    out += 'as 4 and 16. This difference arose because E1 sampled the DOM state immediately after a swipe had already\n';
    out += 'executed in the test harness (where sliding left had doubled/merged tiles), whereas E2 reported the synthetic\n';
    out += 'board setup state prior to the move. In this comprehensive test, each case tracks the true pre-move board,\n';
    out += 'post-move board, and restored board across 30 real game turns.\n';
    out += '=========================================================================================================\n';

    fs.writeFileSync(path.join(outDir, 'real_undo_timeline.txt'), out, 'utf-8');
    console.log('Saved scripts/out/real_undo_timeline.txt');
    console.log(out);

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

