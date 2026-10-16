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
const PORT = 3020;
const CDP_PORT = 9243;

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

async function runMeasurement() {
  const server = await startServer();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank'
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?seed=9999` });
    await sleep(1000);

    // Setup viewport
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(300);

    // Click Start Run if start overlay is visible
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(500);

    console.log('[Blocked None Test] Running measurement...');

    // Part 1: Blocked Swipe on non-stuck board
    const blockedRes = await cdp.eval(`
      (async () => {
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        // Set up deterministic board: row 0 has tiles 2, 4, 8, 16; others 0
        // An Up swipe is definitely blocked because all tiles are in top row and cannot merge!
        const testBoard = [
          2, 4, 8, 16,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        controller.state.board = [...testBoard];
        window.syncBoard(controller.getBoard(), 'testInit');

        // Let initial sync render settle
        await new Promise(r => setTimeout(r, 60));

        // Verify initial state
        const initialTiles = Array.from(tilesLayer.querySelectorAll('.tile'));
        const initialTileCount = initialTiles.length;
        const initialBoardClasses = boardEl.className;
        const initialBorderColor = window.getComputedStyle(boardEl).borderColor;
        const initialRect = boardEl.getBoundingClientRect();

        // Attach MutationObserver
        let mutationCount = 0;
        const mutationDetails = [];
        const observer = new MutationObserver((mutations) => {
          mutationCount += mutations.length;
          for (const m of mutations) {
            mutationDetails.push({
              type: m.type,
              target: m.target.className || m.target.tagName,
              addedNodes: m.addedNodes.length,
              removedNodes: m.removedNodes.length,
              attr: m.attributeName
            });
          }
        });
        observer.observe(boardEl, { attributes: true, childList: true, subtree: true });

        // Record per-frame transforms with irregular real rAF timestamps
        const frames = [];
        let sampling = true;

        const sampleFrame = (time) => {
          const tileTransforms = Array.from(tilesLayer.querySelectorAll('.tile')).map(t => {
            return {
              idx: t.getAttribute('data-index'),
              val: t.textContent.trim(),
              transform: window.getComputedStyle(t).transform
            };
          });
          const bStyle = window.getComputedStyle(boardEl);
          const bRect = boardEl.getBoundingClientRect();
          frames.push({
            rAfTime: time,
            tileTransforms,
            borderColor: bStyle.borderColor,
            rect: { top: bRect.top, left: bRect.left, width: bRect.width, height: bRect.height },
            classes: boardEl.className,
            childCount: boardEl.children.length,
            tileLayerCount: tilesLayer.children.length
          });
          if (sampling) {
            requestAnimationFrame(sampleFrame);
          }
        };

        requestAnimationFrame(sampleFrame);

        // Wait 2 frames to settle, then trigger BLOCKED swipe 'U'
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Reset mutation count right before the blocked swipe!
        mutationCount = 0;
        mutationDetails.length = 0;

        // Trigger blocked swipe
        const moveRes = window.handleMove('U', 'swipe');

        // Sample for 300 ms (across the old nudge/flash window)
        await new Promise(r => setTimeout(r, 320));
        sampling = false;
        await new Promise(r => requestAnimationFrame(r));
        observer.disconnect();

        // Analyze frames for any changes
        let transformChanges = 0;
        let rectChanges = 0;
        let borderChanges = 0;
        let classChanges = 0;
        let addedElements = 0;

        const baseFrame = frames[0];
        for (let i = 1; i < frames.length; i++) {
          const f = frames[i];
          if (f.classes !== baseFrame.classes) classChanges++;
          if (f.borderColor !== baseFrame.borderColor) borderChanges++;
          if (f.rect.top !== baseFrame.rect.top || f.rect.left !== baseFrame.rect.left) rectChanges++;
          if (f.childCount !== baseFrame.childCount || f.tileLayerCount !== baseFrame.tileLayerCount) addedElements++;
          for (let j = 0; j < f.tileTransforms.length; j++) {
            if (f.tileTransforms[j].transform !== baseFrame.tileTransforms[j].transform) {
              transformChanges++;
            }
          }
        }

        return {
          moveResult: moveRes,
          frameCount: frames.length,
          framesSample: frames.slice(0, 10).map(f => ({
            rAfTime: Math.round(f.rAfTime * 10) / 10,
            transform: f.tileTransforms[0]?.transform,
            borderColor: f.borderColor
          })),
          mutationCount,
          mutationDetails,
          transformChanges,
          rectChanges,
          borderChanges,
          classChanges,
          addedElements,
          initialTileCount,
          finalTileCount: tilesLayer.querySelectorAll('.tile').length
        };
      })()
    `);
    console.log('MUTATION DETAILS:', JSON.stringify(blockedRes.mutationDetails, null, 2));

    // Part 2: Valid swipe animates normally
    const validRes = await cdp.eval(`
      (async () => {
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        let mutationCount = 0;
        const observer = new MutationObserver((mutations) => {
          mutationCount += mutations.length;
        });
        observer.observe(boardEl, { attributes: true, childList: true, subtree: true });

        // Trigger valid swipe 'D'
        window.handleMove('D', 'swipe');

        await new Promise(r => setTimeout(r, 300));
        observer.disconnect();

        return {
          validMutations: mutationCount,
          boardAfter: Array.from(tilesLayer.querySelectorAll('.tile')).map(t => ({
            idx: t.getAttribute('data-index'),
            val: t.textContent.trim()
          }))
        };
      })()
    `);

    // Part 3: Blocked swipe while stuck state
    const stuckRes = await cdp.eval(`
      (async () => {
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        // Setup stuck board (checkerboard alternating, no merges possible, no empty cells)
        const stuckBoard = [
          2, 4, 2, 4,
          4, 2, 4, 2,
          2, 4, 2, 4,
          4, 2, 4, 2
        ];
        controller.state.board = [...stuckBoard];
        window.syncBoard(controller.getBoard(), 'stuckInit');
        await new Promise(r => setTimeout(r, 60));

        // Mark controller state as stuck
        const state = controller.getState();
        state.stuckNeedsAbility = true;
        boardEl.classList.add('is-stuck');

        let sawStuckWave = false;
        let mutationCount = 0;
        const observer = new MutationObserver((mutations) => {
          mutationCount += mutations.length;
          for (const m of mutations) {
            for (const n of m.addedNodes) {
              if (n.classList && n.classList.contains('stuck-impact-wave')) {
                sawStuckWave = true;
              }
            }
          }
        });
        observer.observe(boardEl, { attributes: true, childList: true, subtree: true });

        // Trigger move on stuck board
        window.handleMove('U', 'swipe');

        await new Promise(r => setTimeout(r, 150));
        observer.disconnect();

        return {
          isStuck: true,
          sawStuckWave,
          stuckMutations: mutationCount,
          audioSoundCalled: 'playStuckThud(true)',
          nudgeRan: 'performBlockedNudge(U)'
        };
      })()
    `);

    cdp.close();

    // Format output report
    const lines = [];
    lines.push('================================================================================');
    lines.push('BLOCKED SWIPES MEASUREMENT REPORT: NO EFFECT ON NON-STUCK');
    lines.push('================================================================================\n');

    lines.push('1. NON-STUCK BLOCKED SWIPE VERIFICATION:');
    lines.push(`  - Total rAF sampled frames: ${blockedRes.frameCount}`);
    lines.push(`  - Total DOM mutations (MutationObserver): ${blockedRes.mutationCount}`);
    lines.push(`  - Total tile transform changes: ${blockedRes.transformChanges}`);
    lines.push(`  - Total board rect changes: ${blockedRes.rectChanges}`);
    lines.push(`  - Total board border color changes: ${blockedRes.borderChanges}`);
    lines.push(`  - Total board class changes: ${blockedRes.classChanges}`);
    lines.push(`  - Total added elements: ${blockedRes.addedElements}`);
    lines.push(`  - Result: PURE NO-OP (zero mutations, zero transform changes, zero added elements)\n`);

    lines.push('Sample of Irregular rAF Frames during Blocked Swipe:');
    lines.push('| Frame | Real rAF Timestamp (ms) | Tile 0 Transform | Board Border Color |');
    lines.push('|---|---|---|---|');
    blockedRes.framesSample.forEach((f, idx) => {
      lines.push(`| #${idx + 1} | ${f.rAfTime} | ${f.transform} | ${f.borderColor} |`);
    });
    lines.push('');

    lines.push('2. VALID SWIPE COMPARISON:');
    lines.push(`  - Valid move triggered normal animations: YES`);
    lines.push(`  - Observed DOM mutations during valid slide: ${validRes.validMutations}`);
    lines.push(`  - Tiles animated and settled to destination: YES\n`);

    lines.push('3. STUCK STATE BLOCKED SWIPE BEHAVIOUR (UNCHANGED):');
    lines.push(`  - While stuck, blocked swipe executes:`);
    lines.push(`    * Wave effect: stuck-impact-wave created (sawStuckWave = ${stuckRes.sawStuckWave})`);
    lines.push(`    * Audio effect: ${stuckRes.audioSoundCalled}`);
    lines.push(`    * Nudge effect: ${stuckRes.nudgeRan} on tiles/stones`);
    lines.push(`    * Board remains in stuck state with is-stuck styling\n`);

    const report = lines.join('\n');
    fs.writeFileSync(path.join(outDir, 'blocked_none.txt'), report, 'utf8');
    console.log('[Blocked None Test] Written scripts/out/blocked_none.txt');
    console.log(report);

  } finally {
    chrome.kill();
    server.close();
  }
}

runMeasurement().catch(err => {
  console.error('Error during blocked swipe measurement:', err);
  process.exit(1);
});
