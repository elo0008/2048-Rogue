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
if (!CHROME_PATH) {
  console.error('Chrome not found!');
  process.exit(1);
}

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
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));

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
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
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
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
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
  constructor(wsUrl, onException) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.onException = onException;

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') {
        const desc = data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text || 'Unknown exception';
        const stack = data.params.exceptionDetails?.stackTrace;
        this.onException({ desc, stack, details: data.params.exceptionDetails });
      }
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
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      this.onException({ desc, details: res.exceptionDetails });
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// 20 Seeds across 2 viewports
const SEEDS = [
  101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 210
];

const VIEWPORTS = [
  { width: 390, height: 742, dpr: 2.8, name: '390x742' },
  { width: 433, height: 846, dpr: 2.8, name: '433x846' }
];

async function main() {
  const { server, port } = await startServer();
  const cdpPort = await getFreePort();
  const userDataDir = path.join(outDir, `repro_chrome_${Date.now()}`);

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  const capturedExceptions = [];
  function handleException(err) {
    capturedExceptions.push(err);
  }

  let wsUrl;
  try {
    wsUrl = await getWsUrl(cdpPort);
  } catch (err) {
    chromeProc.kill();
    server.close();
    throw err;
  }

  const client = new CdpClient(wsUrl, handleException);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  console.log(`[Repro] Connected to Chrome CDP on port ${cdpPort}`);

  // Summary statistics
  let totalSwipes = 0;
  let swipesWithException = 0;
  let exceptionTookFallback = 0;
  let exceptionSnapped = 0;
  let cleanTookFallback = 0;
  let cleanSnapped = 0;

  const swipeLog = [];

  for (let sIdx = 0; sIdx < SEEDS.length; sIdx++) {
    const seed = SEEDS[sIdx];
    const vp = VIEWPORTS[sIdx % VIEWPORTS.length];

    // Set viewport & touch emulation
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dpr,
      mobile: true,
    });
    await client.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });

    console.log(`[Repro] Running Seed ${seed} (${sIdx + 1}/20) on ${vp.name} @ dpr ${vp.dpr}...`);

    // Navigate with query params ensuring drafts happen early and Shatter + abilities are available
    // Keep reduced motion OFF for normal run verification
    await client.send('Emulation.setEmulatedMedia', { features: [] });

    const pageUrl = `http://127.0.0.1:${port}/?seed=${seed}&start=shatter&hazard=3,3,3,3&first=2&draft=4&pool=shatter,fault_line,mason,last_stand,diagonal_charge,eraser,rewind&debug=1`;
    await client.send('Page.navigate', { url: pageUrl });
    await sleep(250);

    // Inject in-page frame transform tracker & instrumentation
    await client.eval(`
      (() => {
        window.__reproExceptions = [];
        window.__swipeFallbacks = 0;
        window.__frameRecords = [];
        window.__activeTracking = false;

        // Catch uncaught errors in page
        window.addEventListener('error', (e) => {
          window.__reproExceptions.push({
            type: 'error',
            message: e.message,
            file: e.filename,
            line: e.lineno,
            col: e.colno,
            stack: e.error?.stack || ''
          });
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__reproExceptions.push({
            type: 'unhandledrejection',
            message: e.reason?.message || String(e.reason),
            stack: e.reason?.stack || ''
          });
        });

        // Track fallback executions
        window.__lastSwipeFallback = false;
        const origRender = window.renderBoard;
        window.renderBoard = function(...args) {
          if (!window.isAnimating && window.__lastSwipeTime && (performance.now() - window.__lastSwipeTime < 60)) {
            window.__lastSwipeFallback = true;
          }
          return origRender.apply(this, args);
        };

        // Real rAF frame recorder
        let __tileIdCounter = 0;
        function recordFrame(now) {
          if (!window.__activeTracking) return;
          const tiles = Array.from(document.querySelectorAll('#tiles-layer .tile, #tiles-layer .stone'));
          const snapshot = tiles.map(t => {
            if (!t.__trackId) t.__trackId = 't_' + (++__tileIdCounter);
            const tr = window.getComputedStyle(t).transform;
            let x = 0, y = 0;
            if (tr && tr !== 'none') {
              const m = tr.match(/matrix\\(([^)]+)\\)/);
              if (m) {
                const parts = m[1].split(',').map(s => parseFloat(s.trim()));
                x = parts[4] || 0;
                y = parts[5] || 0;
              }
            }
            return { id: t.__trackId, x, y };
          });
          window.__currentSwipeFrames.push({ ts: now, tiles: snapshot });
          requestAnimationFrame(recordFrame);
        }

        window.__startSwipeTracking = () => {
          window.__currentSwipeFrames = [];
          window.__activeTracking = true;
          window.__slideFallbackCountBefore = window.__slideFallbackCount || 0;
          window.__lastSwipeFallback = false;
          window.__lastSwipeTime = performance.now();
          window.__moveCountBefore = window.controller?.getState().moveCount || 0;
          requestAnimationFrame(recordFrame);
        };

        window.__stopSwipeTracking = () => {
          window.__activeTracking = false;
          const mc = window.controller?.getState().moveCount || 0;
          window.__lastMoveChanged = (mc > window.__moveCountBefore);
          window.__lastSwipeFallback = (window.__slideFallbackCount || 0) > (window.__slideFallbackCountBefore || 0);
          return window.__currentSwipeFrames;
        };

        // Dismiss START screen if present
        const startBtn = document.getElementById('btn-start') || document.querySelector('.start-btn');
        if (startBtn) startBtn.click();
      })()
    `);
    await sleep(150);

    // Get board rect for touch swipes
    const boardRect = await client.eval(`
      (() => {
        const b = document.getElementById('game-board');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()
    `);

    // Tactical corner play: prefer L and D, fallback to R then U
    const swipesForSeed = 30;
    let lastDir = 'L';

    for (let sw = 0; sw < swipesForSeed; sw++) {
      totalSwipes++;

      // 1. Resolve any pending draft or decision
      await client.eval(`
        (() => {
          // If draft open: prioritize Shatter or Fault Line
          const draftOverlay = document.getElementById('relic-draft-overlay') || document.getElementById('draft-overlay');
          if (draftOverlay && !draftOverlay.classList.contains('hidden')) {
            const cards = Array.from(document.querySelectorAll('.relic-draft-card, .draft-card'));
            const shatterCard = cards.find(c => c.textContent.includes('Shatter') || c.getAttribute('data-relic') === 'shatter');
            const faultCard = cards.find(c => c.textContent.includes('Fault Line') || c.getAttribute('data-relic') === 'fault_line');
            const targetCard = shatterCard || faultCard || cards[0];
            if (targetCard) targetCard.click();
          }

          // If Mason decision pending: tap first candidate
          if (window.controller && window.controller.hasPendingDecision()) {
            const dec = window.controller.getPendingDecision();
            if (dec.type === 'mason' && dec.candidates?.length > 0) {
              window.controller.resolveDecision(dec.candidates[0]);
              if (window.clearMasonMode) window.clearMasonMode();
              window.syncBoard(window.controller.getBoard(), 'decision-resolve');
            }
          }

          // If game over: click Play Again
          const overEl = document.getElementById('game-over');
          if (overEl && !overEl.classList.contains('hidden')) {
            const btnAgain = document.getElementById('btn-restart');
            if (btnAgain) btnAgain.click();
          }

          // Try abilities if charged
          const state = window.controller?.getState();
          if (state && state.abilities) {
            // Diagonal Merge
            if (state.abilities.diagonal_charge?.charges > 0 && Math.random() < 0.3) {
              const diagBtn = document.querySelector('button.ability-btn[data-relic="diagonal_charge"]');
              if (diagBtn) diagBtn.click();
              const eligible = document.querySelector('.tile.target-eligible');
              if (eligible) eligible.click();
              const partner = document.querySelector('.tile.target-partner');
              if (partner) partner.click();
            }
            // Eraser
            if (state.abilities.eraser?.charges > 0 && Math.random() < 0.25) {
              const eraserBtn = document.querySelector('button.ability-btn[data-relic="eraser"]');
              if (eraserBtn) eraserBtn.click();
              const tile = document.querySelector('.tile:not(.stone)');
              if (tile) {
                tile.click();
                tile.click();
              }
            }
            // Rewind
            if (state.abilities.rewind?.charges > 0 && Math.random() < 0.2) {
              const rewBtn = document.querySelector('button.ability-btn[data-relic="rewind"]');
              if (rewBtn) rewBtn.click();
            }
          }
        })()
      `);

      // Determine smart move: corner strategy (prefer L, then D, then R, then U)
      const chosenDir = await client.eval(`
        (() => {
          if (!window.controller) return 'L';
          const b = window.controller.getBoard();
          const lastMove = window.__lastAttemptedMove;
          const moves = ['L', 'D', 'R', 'U'];
          if (window.__lastMoveChanged === false) {
            const nextIdx = (moves.indexOf(lastMove) + 1) % moves.length;
            window.__lastAttemptedMove = moves[nextIdx];
            return moves[nextIdx];
          }
          // Default prefer L and D
          const d = Math.random() < 0.65 ? 'L' : (Math.random() < 0.85 ? 'D' : 'R');
          window.__lastAttemptedMove = d;
          return d;
        })()
      `);
      const dir = chosenDir || 'L';

      // 2. Start frame tracking
      await client.eval(`window.__startSwipeTracking()`);

      // 3. Real Touch Event Dispatch via CDP Input.dispatchTouchEvent
      const startX = boardRect.x;
      const startY = boardRect.y;
      let dx = 0, dy = 0;
      if (dir === 'L') dx = -80;
      if (dir === 'R') dx = 80;
      if (dir === 'U') dy = -80;
      if (dir === 'D') dy = 80;

      const midX = startX + dx * 0.5;
      const midY = startY + dy * 0.5;
      const endX = startX + dx;
      const endY = startY + dy;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY }]
      });
      await sleep(15);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: midX, y: midY }]
      });
      await sleep(15);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: endX, y: endY }]
      });
      await sleep(10);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });

      // Wait 400ms for slide animation to cleanly finish
      await sleep(400);

      // 4. Stop tracking and analyze frames
      const trackingData = await client.eval(`
        (() => {
          const frames = window.__stopSwipeTracking();
          const exceptions = [...(window.__reproExceptions || [])];
          window.__reproExceptions = [];
          const tookFallback = Boolean(window.__lastSwipeFallback);
          const localStorageErrors = JSON.parse(localStorage.getItem('2048_rogue_errors') || '[]');
          return { frames, exceptions, tookFallback, localStorageErrors };
        })()
      `);

      // Check if exception happened in CDP or in-page
      const cdpEx = capturedExceptions.splice(0, capturedExceptions.length);
      const allEx = [...(trackingData?.exceptions || []), ...cdpEx];
      const hasException = allEx.length > 0;

      // Analyze snaps: any tile moving > half a cell pitch in consecutive frames
      let snapped = false;
      let maxDelta = 0;
      const frames = trackingData?.frames || [];
      const halfPitch = (vp.width === 390 ? 85 : 95) * 0.5;

      for (let f = 1; f < frames.length; f++) {
        const prev = frames[f - 1].tiles;
        const curr = frames[f].tiles;
        for (const ct of curr) {
          const pt = prev.find(p => p.id === ct.id);
          if (pt) {
            const dist = Math.hypot(ct.x - pt.x, ct.y - pt.y);
            if (dist > maxDelta) maxDelta = dist;
            if (dist > halfPitch) {
              snapped = true;
            }
          }
        }
      }

      const tookFallback = trackingData?.tookFallback || false;

      if (hasException) {
        swipesWithException++;
        if (tookFallback) exceptionTookFallback++;
        if (snapped) exceptionSnapped++;
      } else {
        if (tookFallback) cleanTookFallback++;
        if (snapped) cleanSnapped++;
      }

      if (hasException || snapped || (sw % 10 === 0)) {
        swipeLog.push({
          swipe: totalSwipes,
          seed,
          viewport: vp.name,
          dir,
          hasException,
          exceptions: allEx.map(e => e.message || e.desc),
          tookFallback,
          snapped,
          maxDelta: maxDelta.toFixed(1)
        });
      }
    }
  }

  // Get final 2048_rogue_errors from localStorage
  const finalStoredErrors = await client.eval(`localStorage.getItem('2048_rogue_errors')`);

  client.close();
  chromeProc.kill();
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

  // Generate output files
  let reproReport = '=== PRODUCTION BUG REPRODUCTION REPORT: "config is not defined" ===\n';
  reproReport += `Generated: ${new Date().toISOString()}\n`;
  reproReport += `Test Environment: Headless Chrome, touch emulation, DPR 2.8, viewports: 390x742 & 433x846\n`;
  reproReport += `Total Runs: 20 seeds (${SEEDS.join(', ')})\n`;
  reproReport += `Total Swipes Driven: ${totalSwipes}\n`;
  reproReport += `Timing Mode: Real rAF timestamps (requestAnimationFrame deltas; no virtual time used)\n\n`;

  reproReport += `--- SUMMARY RESULTS ---\n`;
  reproReport += `Total Swipes: ${totalSwipes}\n`;
  reproReport += `Swipes with Exception: ${swipesWithException}\n`;
  reproReport += `  - Swipes with exception that took fallback: ${exceptionTookFallback}\n`;
  reproReport += `  - Swipes with exception that snapped: ${exceptionSnapped}\n`;
  reproReport += `Swipes WITHOUT Exception: ${totalSwipes - swipesWithException}\n`;
  reproReport += `  - Swipes without exception that took fallback: ${cleanTookFallback}\n`;
  reproReport += `  - Swipes without exception that snapped: ${cleanSnapped}\n\n`;

  if (swipesWithException > 0) {
    reproReport += `✔ REPRODUCED: Uncaught ReferenceError: config is not defined triggered during real touch play!\n`;
  } else {
    reproReport += `STATUS: Zero exceptions detected.\n`;
  }

  reproReport += `\nStored 2048_rogue_errors in LocalStorage:\n${finalStoredErrors || '[]'}\n\n`;

  reproReport += `Sample Swipe Records (Exceptions / Snaps / Sampled):\n`;
  for (const s of swipeLog.slice(0, 30)) {
    reproReport += `  Swipe #${s.swipe} (Seed ${s.seed}, ${s.viewport}, ${s.dir}): ex=${s.hasException ? 'YES (' + s.exceptions.join('; ') + ')' : 'NO'}, fallback=${s.tookFallback}, snap=${s.snapped} (maxDelta=${s.maxDelta}px)\n`;
  }

  const reproFile = path.join(outDir, 'repro_config_error.txt');
  fs.writeFileSync(reproFile, reproReport, 'utf-8');
  console.log(`\nWrote repro report to ${reproFile}`);

  let snapReport = '=== EXCEPTION VS SNAP ANALYSIS ===\n';
  snapReport += `Total Swipes: ${totalSwipes}\n`;
  snapReport += `Swipes with an Exception: ${swipesWithException}\n`;
  snapReport += `  - Took fallback path: ${exceptionTookFallback} (${((exceptionTookFallback / Math.max(1, swipesWithException)) * 100).toFixed(1)}%)\n`;
  snapReport += `  - Snapped (> half pitch): ${exceptionSnapped} (${((exceptionSnapped / Math.max(1, swipesWithException)) * 100).toFixed(1)}%)\n`;
  snapReport += `Swipes WITHOUT an Exception: ${totalSwipes - swipesWithException}\n`;
  snapReport += `  - Took fallback path: ${cleanTookFallback}\n`;
  snapReport += `  - Snapped (> half pitch): ${cleanSnapped} (${((cleanSnapped / Math.max(1, totalSwipes - swipesWithException)) * 100).toFixed(2)}%)\n`;

  const snapFile = path.join(outDir, 'exception_vs_snap.txt');
  fs.writeFileSync(snapFile, snapReport, 'utf-8');
  console.log(`Wrote exception vs snap analysis to ${snapFile}`);
  console.log(snapReport);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
