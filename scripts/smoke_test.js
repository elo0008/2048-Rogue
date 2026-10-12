import { findChrome } from './find_chrome.js';
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

const CHROME_PATH = findChrome();

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
  constructor(wsUrl, onConsoleError, onException, onRequest = () => {}) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.onConsoleError = onConsoleError;
    this.onException = onException;
    this.onRequest = onRequest;

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Network.requestWillBeSent') {
        if (data.params?.request?.url) {
          this.onRequest(data.params.request.url);
        }
      } else if (data.method === 'Runtime.consoleAPICalled') {
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

export function printUsage() {
  console.log('Usage: node scripts/smoke_test.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --url <base>    Run smoke test against an existing deployed base URL (no local server)');
  console.log('  -h, --help      Display this help message');
}

async function runSmokeTest() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  // Check all JS files first
  runNodeCheck();

  let server = null;
  let targetBaseUrl = '';
  const urlIdx = process.argv.indexOf('--url');
  if (urlIdx !== -1 && process.argv[urlIdx + 1]) {
    targetBaseUrl = process.argv[urlIdx + 1];
    console.log(`[Smoke Test] Testing against external URL: ${targetBaseUrl} (skipping local server)`);
  } else {
    server = await startStaticServer();
    const serverPort = server.address().port;
    targetBaseUrl = `http://127.0.0.1:${serverPort}/`;
    console.log(`[Smoke Test] Serving dist/ on random free port ${serverPort}`);
  }

  function makeUrl(subpathAndQuery = '') {
    const normBase = targetBaseUrl.endsWith('/') ? targetBaseUrl : targetBaseUrl + '/';
    if (!subpathAndQuery) return normBase;
    if (subpathAndQuery.startsWith('/')) subpathAndQuery = subpathAndQuery.slice(1);
    return new URL(subpathAndQuery, normBase).href;
  }

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
    const externalRequests = [];
    const cdp = new CdpClient(
      wsUrl,
      (err) => {
        console.error('[Browser Console Error]', err);
        consoleErrors.push(err);
      },
      (exc) => {
        console.error('[Browser Uncaught Exception]', exc);
        uncaughtExceptions.push(exc);
      },
      (url) => {
        if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith('data:') && !url.startsWith('blob:')) {
          externalRequests.push(url);
        }
      }
    );
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Console.enable');
    await cdp.send('Network.enable');

    // -------------------------------------------------------------
    // Test 1: Standard launch, START hides overlay, 2 tiles appear, one swipe works
    // -------------------------------------------------------------
    console.log(`[Smoke Test] Navigating to ${makeUrl('')} ...`);
    await cdp.send('Page.navigate', { url: makeUrl('') });
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

    // Assert computed touch-action on board, overscroll-behavior, user-select, and hit-area >= 36px (R4c, R4e, R5)
    const styleCheck = await cdp.eval(`
      (() => {
        const boardStyle = window.getComputedStyle(document.getElementById('game-board'));
        const bodyStyle = window.getComputedStyle(document.body);
        const menuBtn = document.getElementById('btn-pause-menu');
        const menuRect = menuBtn ? menuBtn.getBoundingClientRect() : null;
        let effectiveWidth = menuRect ? menuRect.width : 0;
        let effectiveHeight = menuRect ? menuRect.height : 0;
        if (menuBtn) {
          const beforeStyle = window.getComputedStyle(menuBtn, '::before');
          if (beforeStyle && beforeStyle.content !== 'none') {
            const top = parseFloat(beforeStyle.top) || 0;
            const bottom = parseFloat(beforeStyle.bottom) || 0;
            const left = parseFloat(beforeStyle.left) || 0;
            const right = parseFloat(beforeStyle.right) || 0;
            effectiveWidth += Math.abs(left) + Math.abs(right);
            effectiveHeight += Math.abs(top) + Math.abs(bottom);
          }
        }
        return {
          boardTouchAction: boardStyle.touchAction,
          bodyOverscroll: bodyStyle.overscrollBehavior,
          bodyUserSelect: bodyStyle.userSelect || bodyStyle.webkitUserSelect,
          menuWidth: effectiveWidth,
          menuHeight: effectiveHeight
        };
      })()
    `);
    assert.strictEqual(styleCheck.boardTouchAction, 'none', 'game-board must have computed touch-action: none');
    assert.strictEqual(styleCheck.bodyOverscroll, 'none', 'body must have computed overscroll-behavior: none');
    assert.strictEqual(styleCheck.bodyUserSelect, 'none', 'body must have computed user-select: none');
    assert.ok(styleCheck.menuWidth >= 36 && styleCheck.menuHeight >= 36, `Menu button hit area must be >= 36px, got ${styleCheck.menuWidth}x${styleCheck.menuHeight}`);
    console.log('[Smoke Test] ✔ Computed touch-action: none, overscroll-behavior: none, user-select: none, and menu hit area >= 36px verified.');

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
    console.log(`[Smoke Test] Navigating to ${makeUrl('?start=rewind')} ...`);
    await cdp.send('Page.navigate', { url: makeUrl('?start=rewind') });
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
    await cdp.send('Page.navigate', { url: makeUrl('') });
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
    for (let i = 0; i < 20; i++) {
      const isOver = await cdp.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
      if (isOver) break;
      await sleep(50);
    }

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
    for (let i = 0; i < 20; i++) {
      const isOver = await cdp.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
      if (isOver) break;
      await sleep(50);
    }

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

    // -------------------------------------------------------------
    // G4 Check (a) & (b): Real run with points > 0 (3+ merges) and stones on end-screen mini board
    // -------------------------------------------------------------
    console.log('[Smoke Test] Testing real run with stones=0.1, merges > 0, score vs moves, and mini board stones...');
    await cdp.send('Page.navigate', { url: makeUrl('?seed=42&stones=0.1') });
    await sleep(400);

    // Click START
    await cdp.eval(`document.getElementById('btn-play-start').click()`);
    await sleep(200);

    // Play real moves (at least 10 moves and at least 3 merges)
    const DIRS = ['ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'];
    for (let m = 0; m < 25; m++) {
      const dir = DIRS[m % DIRS.length];
      await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      await sleep(50);
    }

    // Trigger game over for this real run
    await cdp.eval(`window.handleGameOver()`);
    await sleep(200);

    const endScreenCheck = await cdp.eval(`
      (() => {
        const endScoreEl = document.getElementById('end-score');
        const displayedScore = parseInt((endScoreEl ? endScoreEl.textContent : '0').replace(/,/g, ''), 10);
        const payload = window.getCopyPayload();
        const currentPoints = payload.currentRun?.points ?? -1;
        const totalMoves = payload.currentRun?.totalMoves ?? -1;

        // Mini board and board stones
        const boardStones = Array.from(document.querySelectorAll('#game-board .stone, #game-board .tile-stone'));
        const miniStones = Array.from(document.querySelectorAll('#end-mini-board .stone, #end-mini-board .mini-stone, #end-mini-board .ms.stone'));
        const allStones = [...boardStones, ...miniStones];
        const violations = allStones.filter(s => s.textContent.trim().length > 0 || Array.from(s.children).some(c => !c.classList.contains('tile-face') && !c.classList.contains('stone-face')));

        return {
          displayedScore,
          currentPoints,
          totalMoves,
          boardStoneCount: boardStones.length,
          miniStoneCount: miniStones.length,
          violations: violations.map(v => ({ tag: v.tagName, text: v.textContent, html: v.innerHTML }))
        };
      })()
    `);

    // (a) Assert SCORE text equals run's points, points > 0, and is not equal to moves
    assert.ok(endScreenCheck.currentPoints > 0, `Run must have earned points > 0 (got ${endScreenCheck.currentPoints})`);
    assert.strictEqual(
      endScreenCheck.displayedScore,
      endScreenCheck.currentPoints,
      `End-screen SCORE headline (${endScreenCheck.displayedScore}) must equal run points (${endScreenCheck.currentPoints})`
    );
    assert.notStrictEqual(
      endScreenCheck.displayedScore,
      endScreenCheck.totalMoves,
      `End-screen SCORE headline (${endScreenCheck.displayedScore}) must not equal moves (${endScreenCheck.totalMoves})`
    );
    console.log(`[Smoke Test] ✔ End-screen SCORE headline (${endScreenCheck.displayedScore}) equals points (${endScreenCheck.currentPoints}) and != moves (${endScreenCheck.totalMoves}).`);

    // (b) Assert mini board has at least one stone, and no text content in any stones
    assert.ok(endScreenCheck.miniStoneCount >= 1, `End-screen mini board must contain at least 1 stone (found ${endScreenCheck.miniStoneCount})`);
    assert.strictEqual(endScreenCheck.violations.length, 0, `Stones must contain only texture, no inner text or glyphs.`);
    console.log(`[Smoke Test] ✔ End-screen mini board has ${endScreenCheck.miniStoneCount} stone(s) with 0 text violations.`);

    // -------------------------------------------------------------
    // U7 Smoke Check 3: Sound toggle persists across reload
    // -------------------------------------------------------------
    console.log('[Smoke Test] Testing sound toggle persistence across reload...');
    await cdp.eval(`
      (() => {
        // Toggle sound via toggle button
        const soundBtn = document.getElementById('btn-sound-start') || document.getElementById('btn-pause-sound');
        if (soundBtn) soundBtn.click();
      })()
    `);
    const soundStateBeforeReload = await cdp.eval(`localStorage.getItem('2048_rogue_sound_enabled')`);

    // Reload page
    await cdp.send('Page.navigate', { url: makeUrl('') });
    await sleep(400);

    const soundStateAfterReload = await cdp.eval(`localStorage.getItem('2048_rogue_sound_enabled')`);
    assert.strictEqual(
      soundStateAfterReload,
      soundStateBeforeReload,
      `Sound setting in localStorage must persist across page reload (before: ${soundStateBeforeReload}, after: ${soundStateAfterReload})`
    );
    console.log(`[Smoke Test] ✔ Sound toggle setting (${soundStateAfterReload}) persists across reload.`);

    // -------------------------------------------------------------
    // Z2 Smoke Check: Self-hosted Outfit font loaded, weights, zero external font requests
    // -------------------------------------------------------------
    console.log('[Smoke Test] Testing self-hosted Outfit variable font loading and weights...');
    const fontCheck = await cdp.eval(`
      (async () => {
        await document.fonts.ready;
        const weights = [400, 600, 700, 800, 900];
        const loaded = {};
        for (const w of weights) {
          loaded[w] = document.fonts.check(w + ' 16px Outfit');
        }
        const hasOutfit = document.fonts.check('16px Outfit');
        const rootFont = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
        return { hasOutfit, loaded, rootFont };
      })()
    `);
    assert.ok(fontCheck.hasOutfit, `Outfit font must be loaded in document.fonts`);
    for (const [w, ok] of Object.entries(fontCheck.loaded)) {
      assert.ok(ok, `Outfit weight ${w} must be loaded in document.fonts`);
    }
    assert.strictEqual(
      externalRequests.length,
      0,
      `Expected 0 external font/CDN requests, got: ${JSON.stringify(externalRequests)}`
    );
    console.log(`[Smoke Test] ✔ Self-hosted Outfit font verified for weights (400, 600, 700, 800, 900) with 0 external requests.`);

    // -------------------------------------------------------------
    // Z3 Smoke Check: Touch emulation mobile check for Eraser & Diagonal (no persistent yellow border)
    // -------------------------------------------------------------
    console.log('[Smoke Test] Testing mobile touch emulation for Eraser and Diagonal (no persistent focus highlight)...');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    });

    await cdp.send('Page.navigate', { url: makeUrl('?seed=1212&start=eraser,diagonal_charge&debug=1') });
    await sleep(500);

    // Setup board with tile at cell 0
    await cdp.eval(`
      (() => {
        window.controller.state.over = false;
        window.controller.state.board = [
          64, 0, 0, 0,
          0, 2, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.controller.state.abilities.eraser = { charges: 3, maxCharges: 3, counter: 0, swipesAtMax: 0, swipesPerCharge: 10 };
        window.controller.state.abilities.diagonal_charge = { charges: 3, maxCharges: 3, counter: 0, swipesAtMax: 0, swipesPerCharge: 10 };
        window.syncBoard(window.controller.getBoard(), 'resync');
      })()
    `);
    await sleep(100);

    // Touch tap Eraser button then tap tile cell 0
    const tapEraserCoords = await cdp.eval(`
      (() => {
        const btn = document.querySelector('[data-ability="eraser"]');
        const cell = document.querySelector('.cell[data-index="0"]');
        const br = btn.getBoundingClientRect();
        const cr = cell.getBoundingClientRect();
        return {
          btn: { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) },
          cell: { x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2) }
        };
      })()
    `);

    // Dispatch touch tap on Eraser button
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: tapEraserCoords.btn.x, y: tapEraserCoords.btn.y }]
    });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);

    // Dispatch touch tap on tile 0
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: tapEraserCoords.cell.x, y: tapEraserCoords.cell.y }]
    });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);

    // Check board and activeElement after Eraser tap
    const postEraserCheck = await cdp.eval(`
      (() => {
        const active = document.activeElement;
        const board = document.getElementById('game-board');
        const boardComp = board ? window.getComputedStyle(board) : null;
        const sel = window.getSelection();
        return {
          activeTag: active ? active.tagName : null,
          activeId: active ? active.id : null,
          boardActive: active === board,
          boardOutlineStyle: boardComp ? boardComp.outlineStyle : null,
          boardOutlineWidth: boardComp ? boardComp.outlineWidth : null,
          selectionText: sel ? sel.toString() : ''
        };
      })()
    `);

    assert.ok(!postEraserCheck.boardActive, `#game-board must not be document.activeElement after touch tap (active is ${postEraserCheck.activeTag}#${postEraserCheck.activeId})`);
    assert.ok(
      postEraserCheck.boardOutlineStyle === 'none' || postEraserCheck.boardOutlineWidth === '0px',
      `#game-board must not have focus highlight outline (got style: ${postEraserCheck.boardOutlineStyle}, width: ${postEraserCheck.boardOutlineWidth})`
    );
    assert.strictEqual(postEraserCheck.selectionText, '', `Text selection must be empty after ability execution`);
    console.log(`[Smoke Test] ✔ Post-Eraser mobile touch: board is not activeElement, outline is ${postEraserCheck.boardOutlineStyle}, selection is empty.`);
    assert.strictEqual(consoleErrors.length, 0, `Expected 0 console errors, got: ${JSON.stringify(consoleErrors)}`);
    assert.strictEqual(uncaughtExceptions.length, 0, `Expected 0 uncaught exceptions, got: ${JSON.stringify(uncaughtExceptions)}`);
    console.log('[Smoke Test] ✔ Zero console errors and uncaught exceptions.');

    cdp.close();
  } finally {
    if (chromeProcess) chromeProcess.kill();
    if (server) server.close();
    console.log(`[Smoke Test] Closed server and terminated headless Chrome.`);
  }

  console.log('\n================================================================');
  console.log('✔ PERMANENT SMOKE TEST PASSED COMPLETELY');
  console.log('================================================================\n');
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage();
} else {
  runSmokeTest().catch(err => {
    console.error('❌ Smoke test failed:', err);
    process.exit(1);
  });
}
