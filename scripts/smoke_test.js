import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 1. Run `node --check` over every .js file in repository
function runNodeCheck() {
  console.log('[Smoke Test] Running `node --check` over all .js files...');
  function getJsFiles(dir) {
    let res = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) res = res.concat(getJsFiles(full));
      else if (ent.name.endsWith('.js')) res.push(full);
    }
    return res;
  }

  const jsFiles = getJsFiles(rootDir);
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', f]);
  }
  console.log(`[Smoke Test] ✔ ${jsFiles.length} JS files passed syntax check.`);
}

function startStaticServer() {
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
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
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
  constructor(wsUrl, onConsoleError, onException) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.onConsoleError = onConsoleError;
    this.onException = onException;

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.consoleAPICalled') {
        if (data.params.type === 'error') {
          const text = data.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' ');
          this.onConsoleError(text);
        }
      } else if (data.method === 'Runtime.exceptionThrown') {
        const desc = data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text;
        this.onException(desc);
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
      this.onException(desc);
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runSmokeTest() {
  // Check all JS files first
  runNodeCheck();

  const server = await startStaticServer();
  const serverPort = server.address().port;
  console.log(`[Smoke Test] Serving dist/ on random free port ${serverPort}`);

  const cdpPort = await getFreePort();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  const consoleErrors = [];
  const uncaughtExceptions = [];

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const cdp = new CdpClient(
      wsUrl,
      (err) => {
        console.error('[Browser Console Error]', err);
        consoleErrors.push(err);
      },
      (exc) => {
        console.error('[Browser Uncaught Exception]', exc);
        uncaughtExceptions.push(exc);
      }
    );
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Console.enable');

    // -------------------------------------------------------------
    // Test 1: Standard launch, START hides overlay, 2 tiles appear, one swipe works
    // -------------------------------------------------------------
    console.log('[Smoke Test] Navigating to http://127.0.0.1:' + serverPort + '/ ...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await sleep(400);

    // Assert START overlay is visible
    const overlayVisibleBefore = await cdp.eval(`
      (() => {
        const el = document.getElementById('start-overlay');
        return el && !el.classList.contains('hidden');
      })()
    `);
    assert.strictEqual(overlayVisibleBefore, true, 'Start overlay must be visible initially');

    // Click START button
    console.log('[Smoke Test] Clicking START button...');
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        btn.click();
      })()
    `);
    await sleep(200);

    // Assert START hides overlay
    const overlayHiddenAfter = await cdp.eval(`
      (() => {
        const el = document.getElementById('start-overlay');
        return el && el.classList.contains('hidden');
      })()
    `);
    assert.strictEqual(overlayHiddenAfter, true, 'START button must hide overlay');

    // Assert 2 tiles appear on game board
    const initialTileCount = await cdp.eval(`
      (() => {
        const tiles = document.querySelectorAll('#game-board .tile');
        const validTiles = Array.from(tiles).filter(t => t.textContent.trim().length > 0);
        return validTiles.length;
      })()
    `);
    assert.strictEqual(initialTileCount, 2, 'Exactly 2 initial tiles must appear on the board');
    console.log(`[Smoke Test] ✔ 2 tiles appeared on board.`);

    // Perform one valid swipe
    const moveCountBefore = await cdp.eval(`window.controller.getState().moveCount`);
    assert.strictEqual(moveCountBefore, 0, 'moveCount should start at 0');

    console.log('[Smoke Test] Performing one swipe...');
    const swipeResult = await cdp.eval(`
      (() => {
        const validMoves = window.controller.getValidMoves();
        if (validMoves.length === 0) return { ok: false, error: 'no valid moves' };
        const move = validMoves[0];
        const keyMap = { 'L': 'ArrowLeft', 'R': 'ArrowRight', 'U': 'ArrowUp', 'D': 'ArrowDown' };
        const key = keyMap[move];
        window.dispatchEvent(new KeyboardEvent('keydown', { code: key, key }));
        return { ok: true, move, key };
      })()
    `);
    assert.strictEqual(swipeResult.ok, true, 'Swipe must be triggered');
    await sleep(250);

    const moveCountAfter = await cdp.eval(`window.controller.getState().moveCount`);
    assert.strictEqual(moveCountAfter, 1, 'moveCount must increment to 1 after one swipe');
    console.log(`[Smoke Test] ✔ One swipe works (direction ${swipeResult.move}, moveCount=1).`);

    // -------------------------------------------------------------
    // Test 2: ?start=rewind then swipe then Rewind restores the board
    // -------------------------------------------------------------
    console.log('[Smoke Test] Navigating to http://127.0.0.1:' + serverPort + '/?start=rewind ...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/?start=rewind` });
    await sleep(400);

    // Click START
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        btn.click();
      })()
    `);
    await sleep(200);

    // Verify rewind relic is owned
    const hasRewind = await cdp.eval(`window.controller.getState().relics.has('rewind')`);
    assert.strictEqual(hasRewind, true, 'Must own rewind relic via ?start=rewind');

    // Record initial board
    const preSwipeBoard = await cdp.eval(`JSON.stringify(window.controller.getBoard())`);

    // Perform one valid swipe
    const rewindSwipe = await cdp.eval(`
      (() => {
        const validMoves = window.controller.getValidMoves();
        const move = validMoves[0];
        const keyMap = { 'L': 'ArrowLeft', 'R': 'ArrowRight', 'U': 'ArrowUp', 'D': 'ArrowDown' };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: keyMap[move], key: keyMap[move] }));
        return move;
      })()
    `);
    await sleep(250);

    const midSwipeBoard = await cdp.eval(`JSON.stringify(window.controller.getBoard())`);
    assert.notStrictEqual(midSwipeBoard, preSwipeBoard, 'Board must change after swipe');
    const midMoveCount = await cdp.eval(`window.controller.getState().moveCount`);
    assert.strictEqual(midMoveCount, 1, 'moveCount must be 1');

    // Trigger Rewind ability button
    console.log('[Smoke Test] Triggering Rewind ability...');
    const rewindClicked = await cdp.eval(`
      (() => {
        const btn = document.querySelector('button.ability-btn[data-relic="rewind"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    assert.strictEqual(rewindClicked, true, 'Rewind button must exist and be clicked');
    await sleep(250);

    // Assert Rewind restores the board
    const postRewindBoard = await cdp.eval(`JSON.stringify(window.controller.getBoard())`);
    assert.strictEqual(postRewindBoard, preSwipeBoard, 'Rewind must restore the exact pre-swipe board');
    const postRewindMoveCount = await cdp.eval(`window.controller.getState().moveCount`);
    assert.strictEqual(postRewindMoveCount, 0, 'Rewind must restore moveCount to 0');
    console.log('[Smoke Test] ✔ Rewind successfully restored the board and moveCount.');

    // -------------------------------------------------------------
    // Test 3: Finish two real UI runs, assert stored history has 2 records with non-null runId, test copy payload
    // -------------------------------------------------------------
    console.log('[Smoke Test] Testing two full UI runs and history persistence...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await sleep(400);
    await cdp.eval(`localStorage.clear()`);

    // Click START
    await cdp.eval(`document.getElementById('btn-play-start').click()`);
    await sleep(200);

    // Run 1: trigger game over
    await cdp.eval(`
      (() => {
        window.controller.state.board = [
          8, 16, 32, 64,
          128, 256, 512, 1024,
          8, 16, 32, 64,
          128, 0, 256, 1024
        ];
        window.renderBoard(window.controller.getBoard());
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
      })()
    `);
    await sleep(300);

    const run1Over = await cdp.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
    assert.strictEqual(run1Over, true, 'Run 1 must reach game over');

    // Run 2: click play again, then trigger game over
    await cdp.eval(`document.getElementById('btn-play-again').click()`);
    await sleep(200);

    await cdp.eval(`
      (() => {
        window.controller.state.board = [
          8, 16, 32, 64,
          128, 256, 512, 1024,
          8, 16, 32, 64,
          128, 0, 256, 1024
        ];
        window.renderBoard(window.controller.getBoard());
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
      })()
    `);
    await sleep(300);

    const run2Over = await cdp.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
    assert.strictEqual(run2Over, true, 'Run 2 must reach game over');

    // Verify stored history has 2 records with non-null runId
    const historyCheck = await cdp.eval(`
      (() => {
        const history = JSON.parse(localStorage.getItem('2048_rogue_run_history') || '[]');
        return {
          length: history.length,
          runIds: history.map(r => r.runId),
          recordsValid: history.every(r => r.runId && typeof r.runId === 'string' && r.runId.length > 0)
        };
      })()
    `);
    assert.strictEqual(historyCheck.length, 2, 'Stored history must have exactly 2 records');
    assert.strictEqual(historyCheck.recordsValid, true, 'Each history record must have non-null string runId');
    assert.notStrictEqual(historyCheck.runIds[0], historyCheck.runIds[1], 'Run IDs must be distinct');
    console.log(`[Smoke Test] ✔ Two UI runs recorded in history with runIds: ${historyCheck.runIds.join(', ')}`);

    // Verify Copy Run Log payload format: { currentRun: <record>, history: [<last 20 records>] }
    const copyPayloadCheck = await cdp.eval(`
      (() => {
        const payload = window.getCopyPayload();
        return {
          hasCurrentRun: Boolean(payload.currentRun && payload.currentRun.runId),
          historyLength: Array.isArray(payload.history) ? payload.history.length : 0,
          currentRunId: payload.currentRun?.runId
        };
      })()
    `);
    assert.strictEqual(copyPayloadCheck.hasCurrentRun, true, 'Copy payload must include currentRun with runId');
    assert.strictEqual(copyPayloadCheck.historyLength, 2, 'Copy payload history must include both runs');
    console.log('[Smoke Test] ✔ Copy Run Log payload correctly formatted as { currentRun, history }.');

    // Assert zero console errors and zero uncaught exceptions
    assert.strictEqual(consoleErrors.length, 0, `Expected 0 console errors, got: ${JSON.stringify(consoleErrors)}`);
    assert.strictEqual(uncaughtExceptions.length, 0, `Expected 0 uncaught exceptions, got: ${JSON.stringify(uncaughtExceptions)}`);
    console.log('[Smoke Test] ✔ Zero console errors and uncaught exceptions.');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
    console.log(`[Smoke Test] Closed server and terminated headless Chrome.`);
  }

  console.log('\n================================================================');
  console.log('✔ PERMANENT SMOKE TEST PASSED COMPLETELY');
  console.log('================================================================\n');
}

runSmokeTest().catch(err => {
  console.error('❌ Smoke test failed:', err);
  process.exit(1);
});
