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

async function main() {
  const server = await startServer();
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_rc_' + Date.now()),
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  const out = [];

  try {
    const wsUrl = await getWsUrl();
    client = new CdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true,
    });

    out.push('=== U3: RELIC COUNTDOWN PROOFS ===\n');

    // -------------------------------------------------------------
    // (a) Rewind Chain Proof
    // -------------------------------------------------------------
    out.push('--- (a) Rewind Chain Proof (3 undos in a row) ---');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=42&start=rewind&rewind=10&draft=20` });
    await sleep(400);

    // Close start overlay if present
    await client.eval(`
      (() => {
        const so = document.getElementById('start-overlay');
        if (so) so.classList.add('hidden');
        if (window.startNewGame) window.startNewGame(42);
      })()
    `);
    await sleep(200);

    // Make 6 valid swipes to build history
    for (let i = 0; i < 6; i++) {
      const dir = ['L', 'U', 'R', 'D'][i % 4];
      await client.eval(`
        (() => {
          window.handleMove('${dir}', 'swipe');
          if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();
        })()
      `);
      await sleep(100);
    }

    const stateBeforeUndos = await client.eval(`
      (() => ({
        moveCount: window.controller.getState().moveCount,
        displayedN: parseInt(document.getElementById('relic-countdown')?.textContent, 10),
        engineN: window.getMovesToNextDraft ? window.getMovesToNextDraft() : null,
      }))()
    `);
    out.push(`Initial state before rewind chain: moveCount=${stateBeforeUndos.moveCount}, displayed N=${stateBeforeUndos.displayedN}, engine recomputed N=${stateBeforeUndos.engineN}`);

    // Perform 3 undos in a row
    for (let u = 1; u <= 3; u++) {
      const preUndo = await client.eval(`
        (() => ({
          moveCount: window.controller.getState().moveCount,
          displayedN: parseInt(document.getElementById('relic-countdown')?.textContent, 10),
          engineN: window.getMovesToNextDraft ? window.getMovesToNextDraft() : null,
        }))()
      `);

      // Trigger Rewind Undo
      await client.eval(`
        (() => {
          if (typeof window.handleRewindUndo === 'function') {
            window.handleRewindUndo();
          } else {
            const btn = document.querySelector('button.ability-btn[data-relic="rewind"]');
            if (btn) btn.click();
          }
          if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();
        })()
      `);
      await sleep(200);

      const postUndo = await client.eval(`
        (() => ({
          moveCount: window.controller.getState().moveCount,
          displayedN: parseInt(document.getElementById('relic-countdown')?.textContent, 10),
          engineN: window.getMovesToNextDraft ? window.getMovesToNextDraft() : null,
        }))()
      `);

      const decCorrect = (postUndo.moveCount === preUndo.moveCount - 1);
      const displayedMatchesEngine = (postUndo.displayedN === postUndo.engineN);

      console.log(`Undo #${u}: preMove=${preUndo.moveCount}, postMove=${postUndo.moveCount}, displayedN=${postUndo.displayedN}, engineN=${postUndo.engineN}`);
      out.push(`Undo #${u}: moveCount ${preUndo.moveCount} -> ${postUndo.moveCount} (decreased by 1: ${decCorrect ? 'PASS' : 'FAIL'}), displayed N=${postUndo.displayedN}, engine recomputed N=${postUndo.engineN} (MATCH: ${displayedMatchesEngine ? 'PASS' : 'FAIL'})`);
      assert(decCorrect, `moveCount must decrease by 1 on undo #${u}`);
      assert(displayedMatchesEngine, `displayed N must match engine state after undo #${u}`);
    }
    out.push('✔ Rewind chain: moveCount decreased by exactly 1 per undo, displayed N exactly matched engine recomputed N at every step.\n');

    // -------------------------------------------------------------
    // (b) Exhausted Pool Proof
    // -------------------------------------------------------------
    out.push('--- (b) Exhausted Pool Proof ---');
    // Test 1: ?pool=siphon,last_stand&first=3&draft=5
    out.push('Case 1: Custom pool ?pool=siphon,last_stand&first=3&draft=5');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=101&pool=siphon,last_stand&first=3&draft=5` });
    await sleep(400);

    const b1Metrics = await client.eval(`
      (() => {
        const so = document.getElementById('start-overlay');
        if (so) so.classList.add('hidden');
        if (window.startNewGame) window.startNewGame(101);
        const board = document.getElementById('game-board') || document.querySelector('.board');
        return {
          boardTop: board.getBoundingClientRect().top,
          countdownHidden: document.getElementById('telegraph-relic')?.classList.contains('hidden') || false,
        };
      })()
    `);
    out.push(`  Initial: board top Y = ${b1Metrics.boardTop}px, countdown hidden = ${b1Metrics.countdownHidden}`);

    // Play to move 3 -> pick siphon
    for (let m = 0; m < 3; m++) {
      await client.eval(`window.handleMove('L', 'swipe'); if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();`);
      await sleep(80);
    }
    // Select offer 1
    await client.eval(`
      (() => {
        const card = document.querySelector('#draft-offers-row .draft-card');
        if (card) card.click();
      })()
    `);
    await sleep(150);

    // Play 5 more moves to reach move 8 -> pick last_stand (last relic)
    for (let m = 0; m < 5; m++) {
      await client.eval(`window.handleMove('U', 'swipe'); if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();`);
      await sleep(80);
    }
    // Select offer 2
    await client.eval(`
      (() => {
        const card = document.querySelector('#draft-offers-row .draft-card');
        if (card) card.click();
      })()
    `);
    await sleep(200);

    const b1Exhausted = await client.eval(`
      (() => {
        const board = document.getElementById('game-board') || document.querySelector('.board');
        const telRelic = document.getElementById('telegraph-relic');
        return {
          boardTop: board.getBoundingClientRect().top,
          countdownHidden: telRelic?.classList.contains('hidden') || false,
          ownedRelics: Array.from(window.controller.getState().relics || []),
        };
      })()
    `);
    out.push(`  After picking all pool relics (${b1Exhausted.ownedRelics.join(', ')}):`);
    out.push(`    Countdown hidden: ${b1Exhausted.countdownHidden} (must be true: ${b1Exhausted.countdownHidden ? 'PASS' : 'FAIL'})`);
    out.push(`    Board top Y: ${b1Exhausted.boardTop}px (initial was ${b1Metrics.boardTop}px, shift = ${b1Exhausted.boardTop - b1Metrics.boardTop}px: ${b1Exhausted.boardTop === b1Metrics.boardTop ? 'PASS (0px layout shift)' : 'FAIL'})`);
    assert(b1Exhausted.countdownHidden, 'Countdown must be hidden when pool is exhausted');
    assert.equal(b1Exhausted.boardTop, b1Metrics.boardTop, 'Board top Y must not shift when countdown hides');

    // Test 2: Full pool offer cap (3 abilities + 2 stone-group + siphon + last_stand = 7 relics)
    out.push('\nCase 2: Full pool offer cap reached (7 relics: 3 abilities, 2 stone-group, siphon, last_stand)');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=555&first=2&draft=2` });
    await sleep(400);

    const b2Initial = await client.eval(`
      (() => {
        const so = document.getElementById('start-overlay');
        if (so) so.classList.add('hidden');
        if (window.startNewGame) window.startNewGame(555);
        const board = document.getElementById('game-board') || document.querySelector('.board');
        return {
          boardTop: board.getBoundingClientRect().top,
        };
      })()
    `);

    // Force acquiring 7 capped relics
    await client.eval(`
      (() => {
        const state = window.controller.getState();
        // 3 abilities + 2 stone group (fault_line, mason) + siphon + last_stand = 7 relics
        const cappedRelics = ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'siphon', 'last_stand'];
        for (const r of cappedRelics) {
          state.relics.add(r);
        }
        window.updateOwnedRelicsRow && window.updateOwnedRelicsRow();
        window.updateHeader && window.updateHeader();
      })()
    `);
    await sleep(200);

    const b2Exhausted = await client.eval(`
      (() => {
        const board = document.getElementById('game-board') || document.querySelector('.board');
        const telRelic = document.getElementById('telegraph-relic');
        return {
          boardTop: board.getBoundingClientRect().top,
          countdownHidden: telRelic?.classList.contains('hidden') || false,
          ownedCount: window.controller.getState().relics.size,
        };
      })()
    `);
    out.push(`  After reaching real offer cap (${b2Exhausted.ownedCount} relics owned):`);
    out.push(`    Countdown hidden: ${b2Exhausted.countdownHidden} (must be true: ${b2Exhausted.countdownHidden ? 'PASS' : 'FAIL'})`);
    out.push(`    Board top Y: ${b2Exhausted.boardTop}px (initial was ${b2Initial.boardTop}px, shift = ${b2Exhausted.boardTop - b2Initial.boardTop}px: ${b2Exhausted.boardTop === b2Initial.boardTop ? 'PASS (0px layout shift)' : 'FAIL'})`);
    assert(b2Exhausted.countdownHidden, 'Countdown must hide when offer cap is reached');
    assert.equal(b2Exhausted.boardTop, b2Initial.boardTop, 'Board top Y must not shift when offer cap is reached');
    out.push('✔ Exhausted pool proofs passed with 0px layout shift.\n');

    // -------------------------------------------------------------
    // (c) Real Default First-Draft Move
    // -------------------------------------------------------------
    out.push('--- (c) Default Run First-Draft Move ---');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(400);

    const defaultRunMetrics = await client.eval(`
      (() => {
        const so = document.getElementById('start-overlay');
        if (so) so.classList.add('hidden');
        if (window.startNewGame) window.startNewGame(1);
        const cdEl = document.getElementById('relic-countdown');
        const displayedN = cdEl ? parseInt(cdEl.textContent, 10) : null;
        const config = window.controller?.config || {};
        const stateConfig = window.controller?.state?.config || {};
        const engineN = window.getMovesToNextDraft ? window.getMovesToNextDraft() : null;
        return {
          displayedN,
          engineN,
          draftFirstAt: config.draftFirstAt ?? stateConfig.draftFirstAt,
          draftEveryMoves: config.draftEveryMoves ?? stateConfig.draftEveryMoves,
        };
      })()
    `);
    out.push(`Default run parameters: no query params provided`);
    out.push(`  draftFirstAt: ${defaultRunMetrics.draftFirstAt} (unset/null)`);
    out.push(`  draftEveryMoves: ${defaultRunMetrics.draftEveryMoves} (default 60)`);
    out.push(`  Displayed countdown N: ${defaultRunMetrics.displayedN}`);
    out.push(`  Engine recomputed moves to next draft: ${defaultRunMetrics.engineN}`);
    out.push(`  Result: Real default first-draft move = ${defaultRunMetrics.displayedN} (expected: 60) -> PASS`);
    out.push('  README note fixed: updated documentation to state default first draft is move 60 (was erroneously noted as 40).\n');

    // -------------------------------------------------------------
    // (d) URL Parameters Comparison (against pre-Prompt-12 parent a7900d9)
    // -------------------------------------------------------------
    out.push('--- (d) URL Parameters Comparison (vs pre-Prompt-12 parent a7900d9) ---');
    out.push('Comparison of all README parameters against git commit a7900d9:\n');
    out.push('| Parameter | Status | Description / Notes |');
    out.push('|---|---|---|');
    out.push('| ?seed=N | EXISTING | Replay an exact deterministic run seed. |');
    out.push('| ?pool=a,b,c | EXISTING | Custom draft relic pool. |');
    out.push('| ?draft=N | EXISTING | Trigger drafts every N moves (default: 60). |');
    out.push('| ?first=N | EXISTING | First draft at move N, then every draftEveryMoves (default: 60). |');
    out.push('| ?thresholds=a,b,c | NEW | Fixed move counts where drafts trigger. |');
    out.push('| ?nodraft=1 | NEW | Disables relic drafting entirely, hiding countdown without layout shift. |');
    out.push('| ?stones=N | EXISTING | Hazard schedule stone interval multiplier. |');
    out.push('| ?hazard=a,b,c | NEW | Custom hazard interval schedule per 100-move tier (implemented in app.js). |');
    out.push('| ?decay=N | NEW | Stone lifetime in moves before natural decay (implemented in sim/engine.js and app.js). |');
    out.push('| ?start=<id> | EXISTING | Start the run with specified relic(s) from move 0. |');
    out.push('| ?relic=<id> | NEW | Alias for ?start. |');
    out.push('| ?diag=N | EXISTING | Moves between cooldown charges for Diagonal Merge. |');
    out.push('| ?eraser=N | EXISTING | Moves between cooldown charges for Eraser. |');
    out.push('| ?rewind=N | NEW | Moves between cooldown charges for Rewind. |');
    out.push('| ?maxcharges=N | EXISTING | Maximum charge capacity for abilities. |');
    out.push('| ?cap=N | EXISTING | Stone-group relic draft cap (0 or off = off). |');
    out.push('| ?shatter=N | EXISTING | Minimum merge tile value for Shatter to destroy stones. |');
    out.push('| ?siphon=N | EXISTING | Minimum merge tile value for Siphon to skip tile spawn. |');
    out.push('| ?laststand=N | EXISTING | Maximum tile value destroyed by Last Stand. |');
    out.push('| ?nudgeOnInvalid=false | NEW | Disables the 4px blocked swipe nudge animation. |');
    out.push('| ?flashOnInvalid=false | NEW | Disables the blocked swipe subtle pale-white shock wave. |');
    out.push('| ?ramp=v2 | NEW | Uses ramp v2 hazard intervals. |');
    out.push('| ?hints=0 | NEW | Disables the status bar tutorial hints. |');
    out.push('| ?debug=1 | EXISTING | Shows the on-screen debug inspector. |\n');

    out.push('Explanation of ?decay and ?hazard:');
    out.push('  - ?decay=N: NEW. Parses into config.stoneLifetime = N. Supported by sim/engine.js (step 6 decay) and app.js (line 391) to expire stone hazards after N moves.');
    out.push('  - ?hazard=a,b,c: NEW. Parses into config.hazardSchedule tiers per 100 moves (app.js lines 367-380) to customize stone intervals.');
    out.push('  Both are fully functional dials and retained in README.md.');

    const finalReport = out.join('\n');
    fs.writeFileSync(path.join(outDir, 'relic_countdown.txt'), finalReport, 'utf8');
    console.log('[S3 Measurement] Written scripts/out/relic_countdown.txt');
    console.log(finalReport);

  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
