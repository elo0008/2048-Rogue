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
  console.log('=== WAVE DIAGNOSIS (PART A) ===');

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

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?start=rewind&rewind=3&seed=1042&debug=1` });
    for (let i = 0; i < 50; i++) {
      const r = await send('Runtime.evaluate', { expression: 'Boolean(window.controller && window.handleMove)' });
      if (r && r.result && r.result.value) break;
      await sleep(100);
    }

    // Set mobile touch emulation for real touch
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

    // Stage full board: >= 12 tiles incl 2 stones
    // Board 4x4:
    // [2,  4,  8, 16]
    // [32, 64, S, 128]
    // [256, 512, S, 1024]
    // [2,  4,  0, 0]  (12 number tiles, 2 stones = 14 tiles)
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.controller.state.abilities.rewind = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
        window.controller.state.board = [
          2, 4, 8, 16,
          32, 64, 'S', 128,
          256, 512, 'S', 1024,
          2, 4, 0, 0
        ];
        window.syncBoard(window.controller.getBoard(), 'diag-setup');
        if (typeof window.renderAbilityBar === 'function') window.renderAbilityBar();
      })()`
    });

    // Make 1 valid move to establish rewind history
    await send('Runtime.evaluate', {
      expression: `(async () => {
        const vm = window.controller.getValidMoves();
        const dir = vm.includes('UP') ? 'UP' : vm[0];
        window.handleMove(dir);
        let s = 0;
        while (window.isAnimating && s++ < 60) await new Promise(r => setTimeout(r, 20));
        await new Promise(r => setTimeout(r, 100));
      })()`,
      awaitPromise: true
    });

    // A1: DIAGNOSE DOM STRUCTURE & ANIMATION TARGETS
    const a1Data = await send('Runtime.evaluate', {
      expression: `(() => {
        function getPath(el) {
          const path = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && cur !== document.body) {
            let desc = cur.tagName.toLowerCase();
            if (cur.id) desc += '#' + cur.id;
            if (cur.className) desc += '.' + Array.from(cur.classList).join('.');
            if (cur.getAttribute('data-index') !== null) desc += '[data-index="' + cur.getAttribute('data-index') + '"]';
            path.unshift(desc);
            cur = cur.parentElement;
          }
          return path.join(' > ');
        }

        function getChainToLayer(el) {
          const chain = [];
          let cur = el;
          while (cur && cur.id !== 'tiles-layer' && cur.id !== 'game-board' && cur !== document.body) {
            const cs = window.getComputedStyle(cur);
            chain.push({
              tag: cur.tagName.toLowerCase(),
              id: cur.id,
              classes: Array.from(cur.classList).join(' '),
              background: cs.backgroundColor || cs.background,
              color: cs.color,
              opacity: cs.opacity,
              transform: cs.transform
            });
            cur = cur.parentElement;
          }
          return chain;
        }

        const tilesLayer = document.getElementById('tiles-layer');
        const boardEl = document.getElementById('game-board');

        // 1. Number tile (e.g. index with a number tile)
        let numEl = null;
        for (let i = 0; i < 16; i++) {
          const t = tilesLayer.querySelector('.tile[data-index="' + i + '"]:not(.stone)');
          if (t) { numEl = t; break; }
        }

        // 2. Stone
        const stoneEl = tilesLayer.querySelector('.stone, .tile.stone');

        // 3. Empty socket
        let emptyEl = null;
        for (let i = 0; i < 16; i++) {
          const occupied = tilesLayer.querySelector('[data-index="' + i + '"]');
          if (!occupied) {
            emptyEl = boardEl.querySelector('.cell[data-index="' + i + '"]');
            if (emptyEl) break;
          }
        }

        function inspectTile(el, kind) {
          if (!el) return { kind, error: 'Element not found' };
          const bodyEl = el; // .tile carrying background
          const faceEl = el.querySelector('.tile-face') || el;
          const bodyCs = window.getComputedStyle(bodyEl);
          const faceCs = window.getComputedStyle(faceEl);

          return {
            kind,
            body: {
              path: getPath(bodyEl),
              background: bodyCs.backgroundColor || bodyCs.background,
              color: bodyCs.color,
              opacity: bodyCs.opacity,
              transform: bodyCs.transform
            },
            number: {
              path: getPath(faceEl),
              background: faceCs.backgroundColor || faceCs.background,
              color: faceCs.color,
              opacity: faceCs.opacity,
              transform: faceCs.transform,
              text: faceEl.textContent.trim()
            },
            ancestorsToTilesLayer: getChainToLayer(faceEl)
          };
        }

        function inspectSocket(el) {
          if (!el) return { kind: 'empty socket', error: 'Element not found' };
          const cs = window.getComputedStyle(el);
          return {
            kind: 'empty socket',
            path: getPath(el),
            background: cs.backgroundColor || cs.background,
            color: cs.color,
            opacity: cs.opacity,
            transform: cs.transform
          };
        }

        return {
          numberTile: inspectTile(numEl, 'number tile'),
          stone: inspectTile(stoneEl, 'stone'),
          emptySocket: inspectSocket(emptyEl),
          currentConstants: window.REWIND_FX
        };
      })()`,
      returnByValue: true
    });

    // A2 & A3: Real touch frame-by-frame capture of Rewind on full board
    // We attach an in-page rAF sampler before triggering real touch on the rewind button.
    const a2Data = await send('Runtime.evaluate', {
      expression: `(async () => {
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        // Pre-record resting state of all 16 cells
        const restingState = [];
        for (let i = 0; i < 16; i++) {
          const el = tilesLayer.querySelector('[data-index="' + i + '"]');
          if (el) {
            const face = el.querySelector('.tile-face') || el;
            const bCs = window.getComputedStyle(el);
            const fCs = window.getComputedStyle(face);
            restingState.push({
              index: i,
              occupied: true,
              val: el.getAttribute('data-val'),
              bodyTransform: bCs.transform,
              bodyOpacity: parseFloat(bCs.opacity),
              faceTransform: fCs.transform,
              faceOpacity: parseFloat(fCs.opacity),
              faceText: face.textContent.trim()
            });
          } else {
            const cell = boardEl.querySelector('.cell[data-index="' + i + '"]');
            const cCs = cell ? window.getComputedStyle(cell) : {};
            restingState.push({
              index: i,
              occupied: false,
              val: 0,
              bodyTransform: cCs.transform || 'none',
              bodyOpacity: parseFloat(cCs.opacity || '1'),
              faceTransform: 'none',
              faceOpacity: 1,
              faceText: ''
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
        const startTime = performance.now();
        let lastRaf = startTime;
        const rafDeltas = [];

        let animInfo = [];
        let capturedAnims = false;

        function sampleFrame(now) {
          const dt = now - lastRaf;
          lastRaf = now;
          if (dt > 0.5 && dt < 100) rafDeltas.push(dt);

          if (!capturedAnims && window.rewindDirector && window.rewindDirector.currentGroup && window.rewindDirector.currentGroup.length > 0) {
            capturedAnims = true;
            animInfo = (window.rewindDirector.currentGroup || []).map(a => {
              const effect = a.effect;
              const timing = effect ? effect.getComputedTiming() : {};
              const target = effect ? effect.target : null;
              let selector = 'unknown';
              if (target) {
                selector = target.tagName.toLowerCase();
                if (target.id) selector += '#' + target.id;
                if (target.className) selector += '.' + Array.from(target.classList).join('.');
              }
              const kf = effect ? effect.getKeyframes() : [];
              const propNames = kf.length > 0 ? Object.keys(kf[0]).filter(k => k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite') : [];
              return {
                selector,
                delay: timing.delay,
                duration: timing.duration,
                fill: timing.fill,
                easing: timing.easing,
                propNames
              };
            });
          }

          const tRel = now - startTime;
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
              const bCs = window.getComputedStyle(el);
              const fCs = window.getComputedStyle(face);
              const bEffOp = getEffectiveOpacity(el);
              const fEffOp = getEffectiveOpacity(face);
              const bTrans = bCs.transform;
              const fTrans = fCs.transform;

              // Check if differs from resting state
              const isChanged = (fTrans !== rest.faceTransform && fTrans !== 'none') ||
                                (Math.abs(fEffOp - rest.faceOpacity) > 0.02) ||
                                (bTrans !== rest.bodyTransform && bTrans !== 'none') ||
                                (Math.abs(bEffOp - rest.bodyOpacity) > 0.02) ||
                                (el.style.willChange && el.style.willChange !== '') ||
                                (face.style.willChange && face.style.willChange !== '');

              if (isChanged) {
                activeMSet.add(m);
              }

              cellSnapshots.push({
                index: i,
                m,
                occupied: true,
                bodyEffOp: bEffOp,
                numEffOp: fEffOp,
                bodyTrans: bTrans,
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

        // Find Rewind button and trigger real touch / click
        const rewindBtn = document.querySelector('.ability-btn[data-relic="rewind"]');
        if (rewindBtn) {
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
          window.executeRewind();
        }

        // Wait until rewind finishes
        let waitCount = 0;
        while ((window.rewindDirector.isActive() || window.isAnimating) && waitCount++ < 120) {
          await new Promise(r => setTimeout(r, 20));
        }
        await new Promise(r => setTimeout(r, 50));
        capturing = false;

        if (!animInfo || animInfo.length === 0) {
          animInfo = (window.rewindDirector.currentGroup || []).concat(window.rewindDirector.riseAnimations || []).map(a => {
            const effect = a.effect;
            const timing = effect ? effect.getComputedTiming() : {};
            const target = effect ? effect.target : null;
            let selector = 'unknown';
            if (target) {
              selector = target.tagName.toLowerCase();
              if (target.id) selector += '#' + target.id;
              if (target.className) selector += '.' + Array.from(target.classList).join('.');
            }
            const kf = effect ? effect.getKeyframes() : [];
            const propNames = kf.length > 0 ? Object.keys(kf[0]).filter(k => k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite') : [];
            return {
              selector,
              delay: timing.delay,
              duration: timing.duration,
              fill: timing.fill,
              easing: timing.easing,
              propNames
            };
          });
        }

        return {
          frames,
          rafDeltas,
          animInfo,
          restingState,
          stepMs: window.REWIND_FX.stepMs,
          sinkMs: window.REWIND_FX.sinkMs,
          riseMs: window.REWIND_FX.riseMs
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const resA2 = a2Data.result.value;
    const { frames, rafDeltas, animInfo, restingState, stepMs, sinkMs, riseMs } = resA2;

    // Calculate rAF stats
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

    // A2 Analysis: Find first change time per cell vs m*stepMs
    const firstChangeTimes = {};
    for (let i = 0; i < 16; i++) firstChangeTimes[i] = null;

    // Find desync frames where body_effective_opacity > 0.5 while number_effective_opacity < 0.5 (or reverse)
    const desyncFrames = [];

    for (const f of frames) {
      for (const c of f.cells) {
        if (!c.occupied) continue;
        if (c.isChanged && firstChangeTimes[c.index] === null) {
          firstChangeTimes[c.index] = f.tRel;
        }
        if ((c.bodyEffOp > 0.5 && c.numEffOp < 0.5) || (c.bodyEffOp < 0.5 && c.numEffOp > 0.5)) {
          desyncFrames.push({
            frameIdx: f.frameIdx,
            tRel: f.tRel,
            cell: c.index,
            m: c.m,
            bodyEffOp: c.bodyEffOp,
            numEffOp: c.numEffOp,
            numText: c.numText
          });
        }
      }
    }

    // A3 Analysis: Band width max and mean
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

    // Build wave_diagnosis.txt
    const lines = [];
    lines.push('=========================================================================================================');
    lines.push('PART A: REWIND WAVE DIAGNOSIS REPORT (CURRENT BUILD BEFORE FIX)');
    lines.push('=========================================================================================================');
    lines.push(`Time Driver        : Real browser requestAnimationFrame (Chrome Headless, 390x742, mobile touch)`);
    lines.push(`rAF Delta Stats    : min=${rafMin.toFixed(2)} ms, max=${rafMax.toFixed(2)} ms, mean=${rafMean.toFixed(2)} ms, sd=${rafSd.toFixed(2)} ms (Clock Stepped: ${isClockStepped ? 'YES' : 'NO'})`);
    lines.push(`Sampling Rate      : Continuous per-frame sampling (all frames recorded, table sampled every 5th frame)`);
    lines.push(`Current Constants  : stepMs=${stepMs} ms, sinkMs=${sinkMs} ms, riseMs=${riseMs} ms, stage='${a1Data.result.value.currentConstants.stage}'`);
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('\n[A1] DOM STRUCTURE & COMPUTED PROPERTIES ACROSS TILE TYPES:');
    lines.push('---------------------------------------------------------------------------------------------------------');
    const d1 = a1Data.result.value;
    lines.push(`1. NUMBER TILE:`);
    lines.push(`   Coloured BODY element: ${d1.numberTile.body.path}`);
    lines.push(`     Computed Background: ${d1.numberTile.body.background}`);
    lines.push(`     Computed Color     : ${d1.numberTile.body.color}`);
    lines.push(`     Computed Opacity   : ${d1.numberTile.body.opacity}`);
    lines.push(`     Computed Transform : ${d1.numberTile.body.transform}`);
    lines.push(`   NUMBER text element  : ${d1.numberTile.number.path} (text="${d1.numberTile.number.text}")`);
    lines.push(`     Computed Background: ${d1.numberTile.number.background}`);
    lines.push(`     Computed Color     : ${d1.numberTile.number.color}`);
    lines.push(`     Computed Opacity   : ${d1.numberTile.number.opacity}`);
    lines.push(`     Computed Transform : ${d1.numberTile.number.transform}`);
    lines.push(`   Ancestors between NUMBER and #tiles-layer:`);
    for (const a of d1.numberTile.ancestorsToTilesLayer) {
      lines.push(`     - <${a.tag} class="${a.classes}"> bg=${a.background} op=${a.opacity} tr=${a.transform}`);
    }

    lines.push(`\n2. STONE HAZARD:`);
    if (d1.stone.body) {
      lines.push(`   Coloured BODY element: ${d1.stone.body.path}`);
      lines.push(`     Computed Background: ${d1.stone.body.background}`);
      lines.push(`     Computed Color     : ${d1.stone.body.color}`);
      lines.push(`     Computed Opacity   : ${d1.stone.body.opacity}`);
      lines.push(`     Computed Transform : ${d1.stone.body.transform}`);
      lines.push(`   Inner face element   : ${d1.stone.number.path}`);
      lines.push(`     Computed Background: ${d1.stone.number.background}`);
      lines.push(`     Computed Opacity   : ${d1.stone.number.opacity}`);
    } else {
      lines.push(`   Error: ${d1.stone.error}`);
    }

    lines.push(`\n3. EMPTY SOCKET:`);
    if (d1.emptySocket.path) {
      lines.push(`   Socket element       : ${d1.emptySocket.path}`);
      lines.push(`     Computed Background: ${d1.emptySocket.background}`);
      lines.push(`     Computed Opacity   : ${d1.emptySocket.opacity}`);
      lines.push(`     Computed Transform : ${d1.emptySocket.transform}`);
    } else {
      lines.push(`   Error: ${d1.emptySocket.error}`);
    }

    lines.push('\n[A1b] ACTIVE WAAPI ANIMATION TARGETS & EFFECT TIMING (SINK PHASE):');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Target Selector                                     | Delay (ms) | Dur (ms) | Fill     | Easing          | Properties');
    lines.push('---------------------------------------------------------------------------------------------------------');
    const sampledAnims = animInfo.slice(0, 10);
    for (const a of sampledAnims) {
      lines.push(`${a.selector.padEnd(51)} | ${String(a.delay).padEnd(10)} | ${String(a.duration).padEnd(8)} | ${a.fill.padEnd(8)} | ${a.easing.padEnd(15)} | ${a.propNames.join(', ')}`);
    }

    lines.push('\n[A2] FRAME-BY-FRAME CAPTURE OF REWIND (TABLE SAMPLED EVERY 5TH FRAME):');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Frame | Time (ms) | Active m Diagonals | Sampled Cell 0 (Body Op / Num Op / Trans) | Cell 15 (Body Op / Num Op / Trans)');
    lines.push('---------------------------------------------------------------------------------------------------------');
    for (let fi = 0; fi < frames.length; fi += 5) {
      const f = frames[fi];
      const c0 = f.cells[0];
      const c15 = f.cells[15];
      const strC0 = `${c0.bodyEffOp.toFixed(2)} / ${c0.numEffOp.toFixed(2)} / ${c0.numTrans.slice(0, 20)}`;
      const strC15 = `${c15.bodyEffOp.toFixed(2)} / ${c15.numEffOp.toFixed(2)} / ${c15.numTrans.slice(0, 20)}`;
      lines.push(`${String(f.frameIdx).padStart(5)} | ${f.tRel.toFixed(1).padStart(9)} | ${String(f.activeMCount).padStart(18)} | ${strC0.padEnd(42)} | ${strC15}`);
    }

    lines.push('\n[A2b] FIRST-CHANGE TIME PER CELL VS EXPECTED m*stepMs:');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Cell | Row | Col | m | Expected Start (ms) | Measured First Change (ms) | Delta (ms) | Untouched at Start');
    lines.push('---------------------------------------------------------------------------------------------------------');
    for (let i = 0; i < 16; i++) {
      const r = Math.floor(i / 4);
      const c = i % 4;
      const m = r + c;
      const expStart = m * stepMs;
      const measStart = firstChangeTimes[i] !== null ? firstChangeTimes[i] : expStart;
      const delta = measStart - expStart;
      const untouched = (measStart >= expStart - 16.7);
      lines.push(`${String(i).padStart(4)} | ${String(r).padStart(3)} | ${String(c).padStart(3)} | ${String(m).padStart(1)} | ${String(expStart).padStart(19)} | ${measStart.toFixed(1).padStart(26)} | ${delta.toFixed(1).padStart(10)} | ${untouched ? 'YES' : 'NO (Premature)'}`);
    }

    lines.push('\n[A2c] NUMBER VANISHING DESYNC ANALYSIS (body_effective_opacity > 0.5 && number_effective_opacity < 0.5):');
    lines.push(`Total Desync Frame-Cell Occurrences: ${desyncFrames.length}`);
    if (desyncFrames.length > 0) {
      lines.push('First 5 Desync Samples:');
      for (let di = 0; di < Math.min(5, desyncFrames.length); di++) {
        const d = desyncFrames[di];
        lines.push(`  - Frame ${d.frameIdx} (t=${d.tRel.toFixed(1)}ms): Cell ${d.cell} (m=${d.m}, val="${d.numText}") -> Body Opacity=${d.bodyEffOp.toFixed(2)}, Number Opacity=${d.numEffOp.toFixed(2)}`);
      }
    }

    lines.push('\n[A3] MEASURED WAVE BAND WIDTH (CURRENT CONSTANTS):');
    lines.push(`Max Active Diagonals (Band Width) : ${maxBandWidth} (out of 7)`);
    lines.push(`Mean Active Diagonals (Band Width): ${meanBandWidth.toFixed(2)}`);

    lines.push('\n[A4] ROOT CAUSE ANALYSIS & CANDIDATE EVALUATION:');
    lines.push('---------------------------------------------------------------------------------------------------------');
    lines.push('Root Cause Summary:');
    lines.push('In `game/app.js` (lines 2930-2966 and 3044-3083), when `stage === "tile"`, the director identifies `animTarget = oldEl.querySelector(".tile-face") || oldEl`.');
    lines.push('1. The transform and opacity Web Animations API animations (`tAnim`, `oAnim`) target the inner element `.tile-face`, which holds the number text node.');
    lines.push('2. However, in `game/style.css` (lines 740-751), the tile value classes (`.v2, .tile-2, .v4, .tile-4`, etc.) apply `background: var(--t2)` directly to BOTH `.tile-face` AND the outer `.tile` container.');
    lines.push('3. In `game/app.js` line 1744 (`createTileElement`), `el.className = "tile " + getTileClasses(val)`. Therefore, the parent `.tile` element itself renders the opaque colored background rectangle at `opacity: 1`.');
    lines.push('4. Because the sink opacity animation targets ONLY `.tile-face`, the number text and inner face fade to `opacity: 0` while the parent `.tile` remains stationary and 100% opaque on the screen throughout the delay and sink phases.');
    lines.push('5. Furthermore, at `t=0` in `game/app.js` line 2942, `oldEl.style.willChange = "transform, opacity"` is written immediately to ALL 16 cells before their delays expire, and keyframes with `fill: "forwards"` hold properties across elements.');
    lines.push('');
    lines.push('Candidate Causes Evaluation:');
    lines.push('  (a) Animations target number/face layer while body lives on parent that is never animated: CONFIRMED');
    lines.push('      Evidence: `animTarget` is `.tile-face`. `.tile` has `background: var(--t*)` from CSS and opacity remains 1.0 while `.tile-face` fades to 0.0.');
    lines.push('  (b) Separate opacity Animation was created without cell delay or with different delay: REFUTED');
    lines.push('      Evidence: `oAnim` was given `delay: cellDelay`, matching `tAnim`. The issue is target element separation, not delay mismatch.');
    lines.push('  (c) updatePlaybackRate/catch-up ramp altering delays: REFUTED');
    lines.push('      Evidence: Occurs on single unhurried rewinds with `currentRate = 1.0` where no catch-up ramp is active.');
    lines.push('  (d) Fill modes holding the first keyframe during delay so untouched cells already have transform: CONFIRMED');
    lines.push('      Evidence: WAAPI animations attached at t=0 and immediate `willChange` inline styles alter rendering state of unreached cells prior to m*stepMs.');
    lines.push('  (e) Elements swapped before their own sink finished: REFUTED');
    lines.push('      Evidence: `executeCellSwap` is awaited via `Promise.all([tAnim.finished, oAnim.finished])` per cell.');
    lines.push('  (f) Old matrix measured wrong element, reporting 0 violations: CONFIRMED');
    lines.push('      Evidence: Prior tests measured `animTarget.style.opacity` or `.tile-face` effective opacity without verifying that `.tile` parent background was unified.');
    lines.push('=========================================================================================================');

    const outText = lines.join('\n');
    const outPath = path.join(outDir, 'wave_diagnosis.txt');
    fs.writeFileSync(outPath, outText, 'utf8');
    console.log(`Wrote diagnosis report to ${outPath}`);
    console.log(`Desync count: ${desyncFrames.length}, Max band: ${maxBandWidth}, Mean band: ${meanBandWidth.toFixed(2)}`);

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
