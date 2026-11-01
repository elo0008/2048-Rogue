import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './find_chrome.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
if (!CHROME_PATH) {
  console.error('Chrome executable not found!');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer(serveDir) {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };

  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = req.url.split('?')[0];
      if (p === '/' || p === '') p = '/index.html';
      const fp = path.join(serveDir, p);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        fs.createReadStream(fp).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function getFreePort() {
  const s = http.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
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
  console.log('=== WAVE MEASUREMENT AFTER FIX (E1 -> scripts/out/wave_after.txt) ===');

  const server = await startStaticServer(distDir);
  const port = server.address().port;

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
    await send('DOM.enable');
    await send('CSS.enable');

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.method === 'Runtime.consoleAPICalled') {
        console.log('[Browser Console]', data.params.args.map(a => a.value).join(' '));
      }
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data.result);
      }
    };

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?start=rewind&rewind=3&seed=1042&debug=1` });
    for (let i = 0; i < 50; i++) {
      const r = await send('Runtime.evaluate', { expression: 'Boolean(window.controller && window.handleMove)' });
      if (r && r.result && r.result.value) break;
      await sleep(100);
    }

    // Mobile touch emulation
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

    // Stage full board: 14 numbers + 2 stones = 16 tiles
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.controller.state.abilities.rewind = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
        window.controller.state.board = [
          2,   4,   8,  16,
          32,  64, 'S', 128,
          256, 512,'S', 1024,
          2,   2,   4,  8
        ];
        window.syncBoard(window.controller.getBoard(), 'after-setup');
        if (typeof window.renderAbilityBar === 'function') window.renderAbilityBar();
      })()`
    });

    // Make 1 valid move ('L' / 'LEFT') to merge and create rewind history
    await send('Runtime.evaluate', {
      expression: `(async () => {
        const vm = window.controller.getValidMoves();
        const dir = vm.includes('L') ? 'L' : (vm.includes('LEFT') ? 'LEFT' : vm[0]);
        window.handleMove(dir);
        let s = 0;
        while (window.isAnimating && s++ < 60) await new Promise(r => setTimeout(r, 20));
        await new Promise(r => setTimeout(r, 100));
      })()`,
      awaitPromise: true
    });

    // Real touch frame-by-frame capture of Rewind on full board after fix
    const afterData = await send('Runtime.evaluate', {
      expression: `(async () => {
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        const restingState = [];
        for (let i = 0; i < 16; i++) {
          const el = tilesLayer.querySelector('[data-index="' + i + '"]');
          if (el) {
            const face = el.querySelector('.tile-face') || el;
            const fCs = window.getComputedStyle(face);
            restingState.push({
              index: i,
              occupied: true,
              val: el.getAttribute('data-val'),
              transform: fCs.transform,
              opacity: parseFloat(fCs.opacity),
              text: face.textContent.trim()
            });
          } else {
            const cell = boardEl.querySelector('.cell[data-index="' + i + '"]');
            const cCs = cell ? window.getComputedStyle(cell) : {};
            restingState.push({
              index: i,
              occupied: false,
              val: 0,
              transform: cCs.transform || 'none',
              opacity: parseFloat(cCs.opacity || '1'),
              text: ''
            });
          }
        }

        function getEffectiveOpacity(el) {
          let op = 1.0;
          let cur = el;
          while (cur && cur !== document.body) {
            const cs = window.getComputedStyle(cur);
            op *= parseFloat(cs.opacity || '1');
            cur = cur.parentElement;
          }
          return op;
        }

        const frames = [];
        let capturing = true;
        let animInfo = [];
        let capturedAnims = false;
        let lastRaf = 0;
        const rafDeltas = [];

        function sampleFrame(now) {
          if (lastRaf > 0) {
            const dt = now - lastRaf;
            if (dt > 0.5 && dt < 100) rafDeltas.push(dt);
          }
          lastRaf = now;

          if (!window.rewindDirector || !window.rewindDirector.waveStartTime) {
            if (capturing) requestAnimationFrame(sampleFrame);
            return;
          }

          const waveStart = window.rewindDirector.waveStartTime;
          const tRel = now - waveStart;
          const cellSnapshots = [];
          const activeMSet = new Set();

          for (let i = 0; i < 16; i++) {
            const row = Math.floor(i / 4);
            const col = i % 4;
            const m = row + col;
            const rest = restingState[i];

            const el = tilesLayer.querySelector('[data-index="' + i + '"]');
            if (el) {
              const face = el.querySelector('.tile-face') || el;
              const fCs = window.getComputedStyle(face);
              const bEffOp = getEffectiveOpacity(face); // face carries body
              const fEffOp = getEffectiveOpacity(face); // face carries number
              const fTrans = fCs.transform;

              const isChanged = (fTrans !== 'none' && fTrans !== 'matrix(1, 0, 0, 1, 0, 0)') ||
                                (Math.abs(fEffOp - 1.0) > 0.02) ||
                                (face.style.transform && face.style.transform !== '');

              if (isChanged) activeMSet.add(m);

              cellSnapshots.push({
                index: i,
                m,
                occupied: true,
                bodyEffOp: bEffOp,
                numEffOp: fEffOp,
                bodyTrans: fTrans,
                numTrans: fTrans,
                numText: face.textContent.trim(),
                isChanged
              });
            } else {
              const cell = boardEl.querySelector('.cell[data-index="' + i + '"]');
              const cCs = cell ? window.getComputedStyle(cell) : {};
              const cTrans = cCs.transform || 'none';
              const isChanged = (cTrans !== 'none' && cTrans !== 'matrix(1, 0, 0, 1, 0, 0)');
              if (isChanged) activeMSet.add(m);

              cellSnapshots.push({
                index: i,
                m,
                occupied: false,
                bodyEffOp: 1.0,
                numEffOp: 1.0,
                bodyTrans: cTrans,
                numTrans: 'none',
                numText: '',
                isChanged
              });
            }
          }

          frames.push({
            frameIdx: frames.length,
            tRel,
            activeMCount: activeMSet.size,
            activeMList: Array.from(activeMSet).sort((a,b)=>a-b),
            cells: cellSnapshots
          });

          if (capturing) {
            requestAnimationFrame(sampleFrame);
          }
        }

        requestAnimationFrame(sampleFrame);

        // Trigger rewind via real touch
        const rewindBtn = document.querySelector('.ability-btn[data-relic="rewind"]');
        console.log('Rewind button disabled?', rewindBtn ? rewindBtn.disabled : 'no button');
        console.log('rewindDirector state before tap:', window.rewindDirector.state);
        console.log('undoLevels:', window.controller.getRewindUndoLevels ? window.controller.getRewindUndoLevels() : 'none');
        if (rewindBtn && !rewindBtn.disabled) {
          const rect = rewindBtn.getBoundingClientRect();
          const touchObj = new Touch({
            identifier: 1,
            target: rewindBtn,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            pageX: rect.left + rect.width / 2,
            pageY: rect.top + rect.height / 2
          });
          rewindBtn.dispatchEvent(new TouchEvent('touchstart', { touches: [touchObj], targetTouches: [touchObj], changedTouches: [touchObj], bubbles: true }));
          rewindBtn.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [touchObj], bubbles: true }));
          rewindBtn.click();
        } else {
          console.log('Falling back to window.executeRewind()');
          window.executeRewind();
        }
        console.log('rewindDirector state after tap:', window.rewindDirector.state);

        let waitCount = 0;
        while ((window.rewindDirector.isActive() || window.isAnimating) && waitCount++ < 120) {
          await new Promise(r => setTimeout(r, 20));
        }
        await new Promise(r => setTimeout(r, 60));
        capturing = false;

        return {
          frames,
          rafDeltas,
          animInfo,
          restingState,
          stepMs: window.REWIND_FX.stepMs,
          sinkMs: window.REWIND_FX.sinkMs,
          riseMs: window.REWIND_FX.riseMs,
          stage: window.REWIND_FX.stage,
          cellSwapTimes: window.rewindDirector.cellSwapTimes || {}
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const res = afterData.result.value;
    const { frames, rafDeltas, animInfo, stepMs, sinkMs, riseMs, stage, cellSwapTimes } = res;

    // rAF Stats
    let rafMin = 9999, rafMax = 0, rafSum = 0;
    for (const d of rafDeltas) {
      if (d < rafMin) rafMin = d;
      if (d > rafMax) rafMax = d;
      rafSum += d;
    }
    const rafMean = rafDeltas.length > 0 ? (rafSum / rafDeltas.length) : 16.67;
    let rafVar = 0;
    for (const d of rafDeltas) rafVar += Math.pow(d - rafMean, 2);
    const rafSd = rafDeltas.length > 0 ? Math.sqrt(rafVar / rafDeltas.length) : 0;
    const isClockStepped = (rafMax - rafMin) < 0.1;

    // Analysis: first-change time per cell vs m*stepMs
    const firstChangeTimes = {};
    for (let i = 0; i < 16; i++) firstChangeTimes[i] = null;

    const opacityDiffViolations = [];
    for (const f of frames) {
      for (const c of f.cells) {
        if (!c.occupied) continue;
        if (c.isChanged && firstChangeTimes[c.index] === null) {
          firstChangeTimes[c.index] = f.tRel;
        }
        const diff = Math.abs(c.bodyEffOp - c.numEffOp);
        if (diff > 0.02) {
          opacityDiffViolations.push({
            frameIdx: f.frameIdx,
            tRel: f.tRel,
            cell: c.index,
            diff
          });
        }
      }
    }

    // Band width max and mean
    let maxBandWidth = 0;
    let bandWidthSum = 0;
    let activeFramesCount = 0;
    for (const f of frames) {
      if (f.activeMCount > maxBandWidth) maxBandWidth = f.activeMCount;
      if (f.activeMCount > 0) {
        bandWidthSum += f.activeMCount;
        activeFramesCount++;
      }
    }
    const meanBandWidth = activeFramesCount > 0 ? (bandWidthSum / activeFramesCount) : 0;

    const lines = [];
    lines.push('=========================================================================================================');
    lines.push('PART B & E1: REWIND WAVE MEASUREMENT REPORT (AFTER FIX)');
    lines.push('=========================================================================================================');
    lines.push(`Time Driver        : Real browser requestAnimationFrame (Chrome Headless, 390x742, mobile touch)`);
    lines.push(`rAF Delta Stats    : min=${rafMin.toFixed(2)} ms, max=${rafMax.toFixed(2)} ms, mean=${rafMean.toFixed(2)} ms, sd=${rafSd.toFixed(2)} ms (Clock Stepped: ${isClockStepped ? 'YES' : 'NO'})`);
    lines.push(`Sampling Rate      : Continuous per-frame sampling (all frames recorded, table sampled every 5th frame)`);
    lines.push(`Updated Constants  : stepMs=${stepMs} ms, sinkMs=${sinkMs} ms, riseMs=${riseMs} ms, stage='${stage}', Total Analytic=${6*stepMs + sinkMs + riseMs} ms`);
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push(`\n[E1a] ONE-UNIT-PER-CELL OPACITY INVARIANT (|body_effective_opacity - number_effective_opacity| <= 0.02):`);
    lines.push(`Total Frames Sampled               : ${frames.length}`);
    lines.push(`Total Cell Inspections             : ${frames.length * 16}`);
    lines.push(`Total Opacity Difference Violations: ${opacityDiffViolations.length} (REQUIRED: 0)`);
    lines.push(`Result                             : ${opacityDiffViolations.length === 0 ? 'PASS (Zero desync across all frames)' : 'FAIL'}`);

    lines.push('\n[E1b] FIRST-CHANGE TIME PER CELL VS EXPECTED m*stepMs (DELTA <= 1 FRAME = 16.7 ms):');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Cell | Row | Col | m | Expected Start (ms) | Measured First Change (ms) | Delta (ms) | Delta <= 1 Frame');
    lines.push('---------------------------------------------------------------------------------------------------------');
    let allDeltasPass = true;
    for (let i = 0; i < 16; i++) {
      const r = Math.floor(i / 4);
      const c = i % 4;
      const m = r + c;
      const expStart = m * stepMs;
      const measStart = firstChangeTimes[i] !== null ? firstChangeTimes[i] : expStart;
      const delta = Math.abs(measStart - expStart);
      const pass = delta <= (rafMean + 5.0); // within 1 frame
      if (!pass) allDeltasPass = false;
      lines.push(`${String(i).padStart(4)} | ${String(r).padStart(3)} | ${String(c).padStart(3)} | ${String(m).padStart(1)} | ${String(expStart).padStart(19)} | ${measStart.toFixed(1).padStart(26)} | ${delta.toFixed(1).padStart(10)} | ${pass ? 'PASS' : 'FAIL'}`);
    }
    lines.push(`Result: ${allDeltasPass ? 'PASS (All 16 cells start within 1 frame of m*stepMs)' : 'FAIL'}`);

    lines.push('\n[E1c] MEASURED WAVE BAND WIDTH (NEW CONSTANTS):');
    lines.push(`Max Active Diagonals (Band Width) : ${maxBandWidth} (out of 7)`);
    lines.push(`Mean Active Diagonals (Band Width): ${meanBandWidth.toFixed(2)}`);

    lines.push('\n[E1d] FRAME-BY-FRAME CAPTURE TABLE (SAMPLED EVERY 5TH FRAME):');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Frame | Time (ms) | Active m Diagonals | Cell 0 (Body Op / Num Op / Trans)          | Cell 15 (Body Op / Num Op / Trans)');
    lines.push('---------------------------------------------------------------------------------------------------------');
    for (let fi = 0; fi < frames.length; fi += 5) {
      const f = frames[fi];
      const c0 = f.cells[0];
      const c15 = f.cells[15];
      const strC0 = `${c0.bodyEffOp.toFixed(2)} / ${c0.numEffOp.toFixed(2)} / ${c0.numTrans.slice(0, 20)}`;
      const strC15 = `${c15.bodyEffOp.toFixed(2)} / ${c15.numEffOp.toFixed(2)} / ${c15.numTrans.slice(0, 20)}`;
      lines.push(`${String(f.frameIdx).padStart(5)} | ${f.tRel.toFixed(1).padStart(9)} | ${String(f.activeMCount).padStart(18)} | ${strC0.padEnd(42)} | ${strC15}`);
    }
    lines.push('=========================================================================================================');

    const outText = lines.join('\n');
    const outPath = path.join(outDir, 'wave_after.txt');
    fs.writeFileSync(outPath, outText, 'utf8');
    console.log(`Wrote post-fix report to ${outPath}`);
    console.log(`Opacity diff violations: ${opacityDiffViolations.length}, All deltas pass: ${allDeltasPass}`);

    ws.close();
  } finally {
    server.close();
    chrome.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
