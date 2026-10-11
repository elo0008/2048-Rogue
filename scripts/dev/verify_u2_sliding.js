import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 3006;
const CDP_PORT = 9226;

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
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);

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
    server.listen(PORT, () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
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

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runU2Verification() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });

    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
    await sleep(400);

    // Dismiss start overlay and set up deterministic board state
    // Row 0: [2, 2, 0, 0] -> merge into [4, 0, 0, 0] on swipe L
    // Row 1: [8, 0, 0, 0] -> unchanged tile on swipe L
    // Rows 2 & 3: 0
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    const setupResult = await cdp.eval(`
      (() => {
        // Force deterministic board in controller
        const b = [
          2, 2, 0, 0,
          8, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.controller.state.board = [...b];
        window.renderBoard(b);

        // Target cell 0 rect
        const cell0 = document.querySelector('.cell[data-index="0"]');
        const cell0Rect = cell0.getBoundingClientRect();

        // Target cell 4 rect
        const cell4 = document.querySelector('.cell[data-index="4"]');
        const cell4Rect = cell4.getBoundingClientRect();

        // Attach MutationObserver to board and tilesLayer
        window.__mutationAddedNodes = [];
        window.__mutationRemovedNodes = [];
        const boardEl = document.getElementById('game-board');
        const tilesLayer = document.getElementById('tiles-layer');

        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) {
                window.__mutationAddedNodes.push({
                  tag: n.tagName,
                  className: n.className,
                  val: n.getAttribute('data-val')
                });
              }
            }
            for (const n of m.removedNodes) {
              if (n.nodeType === 1) {
                window.__mutationRemovedNodes.push({
                  tag: n.tagName,
                  className: n.className,
                  val: n.getAttribute('data-val')
                });
              }
            }
          }
        });

        observer.observe(boardEl, { childList: true, subtree: true });
        window.__u2Observer = observer;

        // Tag initial tiles with test IDs
        const t_0 = document.querySelector('.tile[data-index="0"]');
        const t_1 = document.querySelector('.tile[data-index="1"]');
        const t_4 = document.querySelector('.tile[data-index="4"]');
        if (t_0) t_0.id = 'test-tile-0';
        if (t_1) t_1.id = 'test-tile-1';
        if (t_4) t_4.id = 'test-tile-4';

        return {
          cell0Rect: { left: Math.round(cell0Rect.left * 10) / 10, top: Math.round(cell0Rect.top * 10) / 10, width: Math.round(cell0Rect.width * 10) / 10, height: Math.round(cell0Rect.height * 10) / 10 },
          cell4Rect: { left: Math.round(cell4Rect.left * 10) / 10, top: Math.round(cell4Rect.top * 10) / 10, width: Math.round(cell4Rect.width * 10) / 10, height: Math.round(cell4Rect.height * 10) / 10 },
          initialTileCount: tilesLayer.querySelectorAll('.tile').length
        };
      })()
    `);

    // Initiate sampling every 20ms from t = 0 to 320ms during swipe Left
    const sampleScript = `
      new Promise((resolve) => {
        const samples = [];
        const startTime = performance.now();

        // Trigger swipe Left
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));

        const interval = setInterval(() => {
          const elapsed = Math.round(performance.now() - startTime);
          const t0 = document.getElementById('test-tile-0');
          const t1 = document.getElementById('test-tile-1');
          const t4 = document.getElementById('test-tile-4');

          const getR = (el) => {
            if (!el || !el.isConnected) return null;
            const r = el.getBoundingClientRect();
            return {
              left: Math.round(r.left * 10) / 10,
              top: Math.round(r.top * 10) / 10,
              width: Math.round(r.width * 10) / 10,
              height: Math.round(r.height * 10) / 10,
              val: el.getAttribute('data-val')
            };
          };

          samples.push({
            t: elapsed,
            t0: getR(t0),
            t1: getR(t1),
            t4: getR(t4)
          });

          if (elapsed >= 330) {
            clearInterval(interval);
            resolve(samples);
          }
        }, 20);
      });
    `;

    const samples = await cdp.eval(sampleScript);

    // Stop observer and get mutations
    const mutationResults = await cdp.eval(`
      (() => {
        if (window.__u2Observer) window.__u2Observer.disconnect();
        return {
          added: window.__mutationAddedNodes,
          removed: window.__mutationRemovedNodes
        };
      })()
    `);

    cdp.close();

    console.log('\n================================== U2 (a) MUTATION OBSERVER REPORT ==================================');
    console.log(`Initial tiles: ${setupResult.initialTileCount}`);
    console.log(`Added nodes count: ${mutationResults.added.length}`);
    for (const a of mutationResults.added) {
      console.log(`  + Added: <${a.tag} class="${a.className}" data-val="${a.val}">`);
    }
    console.log(`Removed nodes count: ${mutationResults.removed.length}`);
    for (const r of mutationResults.removed) {
      console.log(`  - Removed: <${r.tag} class="${r.className}" data-val="${r.val}">`);
    }
    const onlySpawnedAdded = mutationResults.added.length === 1 && (mutationResults.added[0].className.includes('spawn') || mutationResults.added[0].className.includes('tile'));
    console.log(`Assertion (a): Only spawned tile added (no whole-grid rebuild)? => ${onlySpawnedAdded ? 'PASS' : 'FAIL'}`);
    console.log('====================================================================================================\n');

    console.log('================================== U2 (b) 20ms TILE SAMPLING TABLE (0ms - 320ms) ==================================');
    console.log('Time  | Tile at (0,1) [Absorbed, slides to (0,0)] | Tile at (1,0) [Unmoved]       | Tile at (0,0) [Survivor/Target]');
    console.log('      | left    top     width  height               | left    top     width  height  | left    top     width  height');
    console.log('-------------------------------------------------------------------------------------------------------------------');

    const t1LeftHistory = [];
    const t4LeftHistory = [];
    const settledT0Rects = [];

    for (const s of samples) {
      const t1 = s.t1;
      const t4 = s.t4;
      const t0 = s.t0;

      const t1Str = t1 ? `${t1.left}`.padEnd(7) + `${t1.top}`.padEnd(7) + `${t1.width}`.padEnd(7) + `${t1.height}` : 'removed at merge end     ';
      const t4Str = t4 ? `${t4.left}`.padEnd(7) + `${t4.top}`.padEnd(7) + `${t4.width}`.padEnd(7) + `${t4.height}` : 'missing                 ';
      const t0Str = t0 ? `${t0.left}`.padEnd(7) + `${t0.top}`.padEnd(7) + `${t0.width}`.padEnd(7) + `${t0.height}` + ` (val=${t0.val})` : 'missing                 ';

      console.log(`${s.t}ms`.padEnd(6) + '| ' + t1Str.padEnd(42) + '| ' + t4Str.padEnd(30) + '| ' + t0Str);

      if (t1) t1LeftHistory.push({ t: s.t, left: t1.left });
      if (t4) t4LeftHistory.push({ t: s.t, left: t4.left, top: t4.top });
      if (s.t >= 240 && t0) {
        settledT0Rects.push(t0);
      }
    }
    console.log('===================================================================================================================\n');

    // Assertion (b1): Unmoved tile (val 8 at cell 4) has constant rect
    const t4First = t4LeftHistory[0];
    const t4Constant = t4LeftHistory.every(h => h.left === t4First.left && h.top === t4First.top);
    console.log(`Assertion (b1): Unmoved tile rect is strictly constant across all samples? => ${t4Constant ? 'PASS' : 'FAIL'} (left=${t4First.left}, top=${t4First.top})`);

    // Assertion (b2): After settle, 3 consecutive samples identical to target cell rect
    const last3Settled = settledT0Rects.slice(-3);
    const settledMatchesTarget = last3Settled.length === 3 && last3Settled.every(s =>
      Math.abs(s.left - setupResult.cell0Rect.left) < 0.5 &&
      Math.abs(s.top - setupResult.cell0Rect.top) < 0.5
    );
    console.log(`Target Cell (0,0) rect: left=${setupResult.cell0Rect.left}, top=${setupResult.cell0Rect.top}`);
    console.log(`Last 3 settled samples: ${last3Settled.map(s => `(${s.left}, ${s.top})`).join('; ')}`);
    console.log(`Assertion (b2): 3 consecutive samples after settle identical to target cell rect? => ${settledMatchesTarget ? 'PASS' : 'FAIL'}`);

    // Assertion (c): Assert exactly one direction reversal per moved tile (overshoot then settle)
    let reversals = 0;
    let prevDiff = 0;
    for (let i = 1; i < t1LeftHistory.length; i++) {
      const diff = t1LeftHistory[i].left - t1LeftHistory[i - 1].left;
      if (Math.abs(diff) > 0.3) {
        if (prevDiff !== 0) {
          if ((prevDiff < 0 && diff > 0) || (prevDiff > 0 && diff < 0)) {
            reversals++;
            console.log(`  Direction reversal detected at t=${t1LeftHistory[i].t}ms: diff was ${prevDiff.toFixed(1)}px, now ${diff.toFixed(1)}px`);
          }
        }
        prevDiff = diff;
      }
    }
    console.log(`Assertion (c): Direction reversals for moved tile (overshoot then settle back): ${reversals} (expected: 1) => ${reversals === 1 ? 'PASS' : 'FAIL'}`);

    if (!onlySpawnedAdded || !t4Constant || !settledMatchesTarget || reversals !== 1) {
      console.error('❌ U2 verification failed one or more assertions!');
      process.exit(1);
    } else {
      console.log('\n✔ All U2 Pure Sliding assertions PASSED completely!\n');
    }

  } finally {
    chromeProcess.kill();
    server.close();
  }
}

runU2Verification().catch(err => {
  console.error(err);
  process.exit(1);
});
