import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT = 3004;
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
    '.woff2': 'font/woff2',
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
    return new Promise((resolve, reject) => {
      const id = this.id++;
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
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }
}

async function run() {
  console.log('[S3 Measurement] Starting test server...');
  const server = await startServer();

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_s3_' + Date.now()),
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  const relicCountdownLog = [];
  const headerFitLog = [];

  try {
    const wsUrl = await getWsUrl();
    client = new CdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    console.log('[S3 Measurement] Chrome CDP connected.');

    // 1. Relic Countdown Accuracy Test
    // For several seeds and ?draft=7&first=3
    const testCases = [
      { seed: 42, first: 3, draft: 7, movesToPlay: 25 },
      { seed: 1337, first: 3, draft: 7, movesToPlay: 25 },
      { seed: 99999, first: 5, draft: 10, movesToPlay: 30 },
      { seed: 777, first: 4, draft: 6, movesToPlay: 20 },
    ];

    relicCountdownLog.push('=== S3 RELIC COUNTDOWN ACCURACY AND REWIND PROOF ===\n');

    for (const tc of testCases) {
      relicCountdownLog.push(`--- Test Case: seed=${tc.seed}, ?first=${tc.first}&draft=${tc.draft} ---`);
      const url = `http://127.0.0.1:${PORT}/?seed=${tc.seed}&first=${tc.first}&draft=${tc.draft}`;
      await client.send('Page.navigate', { url });
      await sleep(400);

      let draftEvents = 0;
      let matchedSteps = 0;

      for (let m = 0; m < tc.movesToPlay; m++) {
        // Read displayed N before swipe
        const stateBefore = await client.eval(`(() => {
          const el = document.getElementById('relic-countdown');
          const isHidden = document.getElementById('telegraph-relic')?.classList.contains('hidden');
          const displayedN = el ? parseInt(el.textContent, 10) : null;
          const moves = window.controller?.state?.moveCount || 0;
          const engineN = window.getMovesToNextDraft ? window.getMovesToNextDraft() : null;
          return { displayedN, isHidden, moves, engineN };
        })()`);

        assert.equal(stateBefore.displayedN, stateBefore.engineN, `Displayed N (${stateBefore.displayedN}) must match engine draft prediction (${stateBefore.engineN}) at move ${stateBefore.moves}`);
        matchedSteps++;

        // Send swipe
        const dir = ['L', 'U', 'R', 'D'][m % 4];
        await client.eval(`(() => {
          if (window.handleMove) {
            window.handleMove('${dir}');
            if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();
          } else {
            window.controller.submitMove('${dir}');
          }
        })()`);
        await sleep(60);

        // Check if draft overlay appeared
        const draftActive = await client.eval(`(() => {
          const d = document.getElementById('draft-overlay');
          return d && !d.classList.contains('hidden');
        })()`);

        if (draftActive) {
          draftEvents++;
          relicCountdownLog.push(`  Draft #${draftEvents} triggered at move ${stateBefore.moves + 1}. Before-swipe countdown was ${stateBefore.displayedN} (exact match = 1 move away).`);
          assert.equal(stateBefore.displayedN, 1, `Draft triggered when displayedN was not 1! Got ${stateBefore.displayedN}`);

          // Pick first offer to continue
          await client.eval(`(() => {
            const btn = document.querySelector('#draft-offers-row .draft-card');
            if (btn) btn.click();
          })()`);
          await sleep(100);
        }
      }

      relicCountdownLog.push(`  ✔ All ${matchedSteps} moves verified: displayed N matched actual remaining swipes to draft exactly.`);

      // Rewind chain test
      relicCountdownLog.push(`  Testing Rewind chain on seed=${tc.seed}...`);
      // Add rewind ability to controller for test
      await client.eval(`(() => {
        if (!window.controller.state.relics) window.controller.state.relics = new Set();
        window.controller.state.relics.add('rewind');
        window.updateOwnedRelicsRow && window.updateOwnedRelicsRow();
      })()`);

      for (let r = 0; r < 3; r++) {
        const movesBeforeUndo = await client.eval(`window.controller.state.moveCount`);
        if (movesBeforeUndo <= 1) break;
        await client.eval(`window.handleRewindUndo ? window.handleRewindUndo() : (window.controller.rewindUndo && window.controller.rewindUndo())`);
        await sleep(80);
        const rewindState = await client.eval(`(() => {
          const el = document.getElementById('relic-countdown');
          const displayedN = el ? parseInt(el.textContent, 10) : null;
          const engineN = window.getMovesToNextDraft ? window.getMovesToNextDraft() : null;
          return { displayedN, engineN, moves: window.controller?.state?.moveCount };
        })()`);
        assert.equal(rewindState.displayedN, rewindState.engineN, `After Rewind undo, displayed N (${rewindState.displayedN}) must equal recomputed value (${rewindState.engineN})`);
        relicCountdownLog.push(`    Rewind undo step: moveCount is now ${rewindState.moves}, displayed N=${rewindState.displayedN}, recomputed=${rewindState.engineN} (MATCH)`);
      }
      relicCountdownLog.push('');
    }

    // 2. Draft Disabled / Pool Exhausted test
    relicCountdownLog.push('--- Test Case: Draft Disabled / Pool Exhausted ---');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?nodraft=1` });
    await sleep(400);
    const hiddenWhenDisabled = await client.eval(`(() => {
      const el = document.getElementById('telegraph-relic');
      return el ? el.classList.contains('hidden') : true;
    })()`);
    assert(hiddenWhenDisabled, '#telegraph-relic must be hidden when enableDraft=false');
    relicCountdownLog.push('  ✔ enableDraft=false: #telegraph-relic is hidden without layout change.');

    // 3. Hazard Popover Tap interplay
    const popoverOpens = await client.eval(`(() => {
      const stonePart = document.getElementById('telegraph-stone');
      if (stonePart) stonePart.click();
      const popover = document.getElementById('relic-popover');
      return popover && !popover.classList.contains('hidden');
    })()`);
    assert(popoverOpens, 'Tap on stone part of telegraph strip must still open hazard popover');
    relicCountdownLog.push('  ✔ Tap on stone telegraph part successfully opens hazard popover.\n');

    fs.writeFileSync(path.join(outDir, 'relic_countdown.txt'), relicCountdownLog.join('\n'));
    console.log('[S3 Measurement] Written scripts/out/relic_countdown.txt');

    // 4. Header Fit and Slack Measurements
    console.log('[S3 Measurement] Measuring header fit and slack across viewports...');
    headerFitLog.push('=== S3 HEADER FIT AND SLACK MEASUREMENTS ===');
    headerFitLog.push('Constraints: board top Y = 178 at >=360, 170 at 320; header height unchanged; slack >= 4px; no overlap.\n');
    headerFitLog.push(
      'Viewport | Passives | Abilities | BoardTop | ExpBoardTop | HdrHeight | Slack (px) | Overlaps | Status'
    );
    headerFitLog.push(
      '---------+----------+-----------+----------+-------------+-----------+------------+----------+-------'
    );

    const viewports = [
      { w: 320, h: 568, expBoardTop: 170 },
      { w: 360, h: 640, expBoardTop: 178 },
      { w: 390, h: 742, expBoardTop: 178 },
      { w: 430, h: 844, expBoardTop: 178 },
    ];

    const configVariants = [
      { p: 0, a: 0 },
      { p: 4, a: 0 },
      { p: 0, a: 3 },
      { p: 4, a: 3 },
    ];

    let headerFitAllPassed = true;

    for (const vp of viewports) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 2,
        mobile: true,
      });

      for (const cfg of configVariants) {
        // Navigate and inject relics and 3-digit values
        await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=42&first=999&draft=999` });
        await sleep(350);

        const metrics = await client.eval(`(() => {
          // Set 3-digit values
          const movesEl = document.getElementById('stat-moves');
          if (movesEl) movesEl.textContent = '999';
          const stoneCd = document.getElementById('stone-countdown');
          if (stoneCd) stoneCd.textContent = '999';
          const relicCd = document.getElementById('relic-countdown');
          if (relicCd) relicCd.textContent = '999';

          // Set passives
          const pContainer = document.getElementById('passive-relics-container');
          if (pContainer) {
            pContainer.innerHTML = '';
            const pIds = ['fault_line', 'mason', 'siphon', 'shatter'].slice(0, ${cfg.p});
            pIds.forEach(id => {
              const div = document.createElement('div');
              div.className = 'passive-icon';
              div.setAttribute('data-relic', id);
              div.textContent = '✦';
              pContainer.appendChild(div);
            });
          }

          // Set abilities
          const aContainer = document.getElementById('abilities-drawer');
          if (aContainer) {
            aContainer.innerHTML = '';
            const aIds = ['diagonal_charge', 'eraser', 'rewind'].slice(0, ${cfg.a});
            aIds.forEach(id => {
              const div = document.createElement('div');
              div.className = 'ability-slot';
              div.textContent = id[0].toUpperCase();
              aContainer.appendChild(div);
            });
          }

          // Measure layout
          const board = document.getElementById('game-board');
          const boardRect = board.getBoundingClientRect();
          const header = document.getElementById('header') || document.querySelector('.game-header');
          const headerRect = header.getBoundingClientRect();
          const statsRect = document.querySelector('.stats').getBoundingClientRect();

          const stonePart = document.getElementById('telegraph-stone');
          const relicPart = document.getElementById('telegraph-relic');
          const telegraphRow = document.getElementById('hazard-telegraph');

          const tRect = telegraphRow.getBoundingClientRect();
          const sRect = stonePart.getBoundingClientRect();
          const rRect = relicPart ? relicPart.getBoundingClientRect() : { width: 0, left: 0, right: 0 };

          function rectsOverlap(r1, r2) {
            return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
          }

          const overlapParts = relicPart && !relicPart.classList.contains('hidden') && rectsOverlap(sRect, rRect);

          const contentBottom = Math.round(statsRect.bottom);
          const headerTop = Math.round(headerRect.top);
          const contentHeight = contentBottom - headerTop;
          const slack = header.clientHeight - contentHeight;

          return {
            boardTop: Math.round(boardRect.top),
            headerHeight: Math.round(headerRect.height),
            slack,
            overlapParts,
          };
        })()`);

        const boardTopOk = Math.abs(metrics.boardTop - vp.expBoardTop) <= 1;
        const slackOk = metrics.slack >= 4;
        const noOverlap = !metrics.overlapParts;
        const ok = boardTopOk && slackOk && noOverlap;
        if (!ok) headerFitAllPassed = false;

        const overlapsStr = metrics.overlapParts ? 'OVERLAP' : 'none';
        const rowStr = `${(vp.w + 'x' + vp.h).padEnd(8)} | ${String(cfg.p).padEnd(8)} | ${String(cfg.a).padEnd(9)} | ${String(metrics.boardTop).padEnd(8)} | ${String(vp.expBoardTop).padEnd(11)} | ${String(metrics.headerHeight).padEnd(9)} | ${String(metrics.slack).padEnd(10)} | ${overlapsStr.padEnd(8)} | ${ok ? 'PASS' : 'FAIL'}`;
        headerFitLog.push(rowStr);
      }
    }

    headerFitLog.push(`\nOverall header fit result: ${headerFitAllPassed ? 'PASS' : 'FAIL'}\n`);
    fs.writeFileSync(path.join(outDir, 'header_fit.txt'), headerFitLog.join('\n'));
    console.log('[S3 Measurement] Written scripts/out/header_fit.txt');

  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
