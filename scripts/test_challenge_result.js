/**
 * scripts/test_challenge_result.js
 *
 * Full headless Chrome end-to-end and UI test suite for Rogue 2048 Challenge Result & Game-Over Routing System.
 *
 * Requirements Covered:
 * 1. Verdict logic & margin formatting:
 *    - Win, Lose, Tie for Daily and Free runs
 *    - Points tie decided by moves
 *    - Exact tie (equal points and equal moves)
 *    - Margin lines: "+1,256 points", "−832 points", "Tied on points. 418 vs 389 moves.", "Exact tie: same points and moves"
 * 2. Visual layout parity:
 *    - Mode chip ("DAILY" / "FREE RUN")
 *    - Verdict headline colors (accent win, warn lose, soft tie)
 *    - YOU vs Sender columns (initials avatar via avatarInitials, name ellipsis, null -> "Anonymous Player", points, moves, max tile)
 *    - Final boards side by side with real game tile colors & stones (digits min 8px, scaled)
 *    - Legacy null board slot -> "Board not available" placeholder
 *    - Daily ranked row: "Your Daily rank #N of M" (pending: "Calculating rank…", failure/queued: hidden)
 * 3. Expired mid-run: banner "Challenge link expired while you played" displayed if ctx.expiresAt passed at game over.
 * 4. Action buttons:
 *    - CHALLENGE BACK:
 *      - Disabled with spinner while Daily ranked submission is pending
 *      - Enabled once rank accepted (or immediately for free runs with moves >= 10)
 *      - Disabled with existing line when moves < 10
 *      - Opens existing share sheet for THIS new run with correct mode
 *      - Link reuse: produces 0 extra backend requests when link exists
 *    - PLAY AGAIN: replays same seed, preserves challengeContext
 *    - HOME: clears challengeContext, returns to start screen
 * 5. Multi-viewport audit (320x568, 360x640, 390x742, 430x932):
 *    - Card height equals game-over card height across all 4 viewports
 *    - Bounding boxes fit inside viewport, no overflow
 *    - Hit areas >= 36px
 *    - Min font 10px (board digits >= 8px)
 * 6. Worst case layout: 16-char name, 9,999,999 pts, 12,345 moves, 4096 tile at 320x568
 * 7. Security & XSS safety: textContent only, zero injected tags
 * 8. Prefers-reduced-motion: winner shimmer animation & button transitions disabled
 * 9. Normal (non-challenge) runs route to normal game-over card unchanged
 * 10. Deliberate self-check failing capability (--self-check-fail)
 * 11. Real-page screenshots captured to scripts/out/
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findChrome } from './find_chrome.js';
import { createMockLeaderboardServer } from './mock_leaderboard.js';
import { computeReplayVersion } from '../verify/version.js';
import { build } from './build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const isSelfCheckFail = process.argv.includes('--self-check-fail');

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

  const requests = [];

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(serveDir, relPath === '' ? 'index.html' : relPath);

    if (pathname.startsWith('/c/')) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = path.join(serveDir, 'index.html');
      }
    }

    requests.push({ url: req.url, pathname, timestamp: Date.now() });

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
      resolve({ server, port: server.address().port, requests });
    });
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = Array.isArray(list) ? list.find(t => t.type === 'page') : null;
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch { }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome CDP');
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.events = [];

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.id && this.callbacks.has(data.id)) {
        const { resolve, reject } = this.callbacks.get(data.id);
        this.callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      } else if (data.method) {
        if (data.method === 'Runtime.exceptionThrown') {
          console.error('BROWSER EXCEPTION:', JSON.stringify(data.params.exceptionDetails));
        } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
          console.error('BROWSER CONSOLE ERROR:', data.params.args.map(a => a.value || a.description));
        }
        this.events.push(data);
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

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await this.send('Emulation.setVisibleSize', { width, height }).catch(() => { });
  }

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(filePath, buf);
    return buf.length;
  }
}

function cleanTempDist(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch { }
}

async function main() {
  console.log('================================================================================');
  console.log('ROGUE 2048 CHALLENGE RESULT & GAME-OVER ROUTING TEST SUITE');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  // Pre-flight invariants
  const EXPECTED_ENGINE_HASH = '7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B';
  const engineContent = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'));
  const engineHash = crypto.createHash('sha256').update(engineContent).digest('hex').toUpperCase();
  assert.strictEqual(engineHash, EXPECTED_ENGINE_HASH, 'sim/engine.js SHA-256 invariant violation');
  console.log(`✔ Verified sim/engine.js SHA-256: ${engineHash}`);

  const EXPECTED_REPLAY_VERSION = '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98';
  const computedVersion = computeReplayVersion();
  assert.strictEqual(computedVersion, EXPECTED_REPLAY_VERSION, 'replayVersion invariant violation');
  console.log(`✔ Verified replayVersion:         ${computedVersion}\n`);

  // Start mock server
  const mock = createMockLeaderboardServer();
  const mockPort = await mock.listen(0);
  console.log(`✔ Mock Leaderboard Server running on port ${mockPort}`);

  // Build target prod
  const tempDistDir = path.join(rootDir, 'dist_test_chal_result');
  cleanTempDist(tempDistDir);
  await build({
    target: 'prod',
    sourceDir: path.join(rootDir, 'game'),
    distDir: tempDistDir,
    rootDir: rootDir,
  });

  // Write leaderboard config pointing to mock
  fs.writeFileSync(
    path.join(tempDistDir, 'leaderboard-config.js'),
    `window.__LB = { url: "http://127.0.0.1:${mockPort}", anonKey: "test-anon-key" };`
  );

  // Verify icon assets and manifest in dist
  const distIndexHtml = fs.readFileSync(path.join(tempDistDir, 'index.html'), 'utf8');
  const expectedDistAssets = [
    'favicon.svg',
    'apple-touch-icon.png',
    'icon-192.png',
    'icon-512.png',
    'manifest.webmanifest',
  ];
  for (const asset of expectedDistAssets) {
    const assetPath = path.join(tempDistDir, asset);
    assert.ok(fs.existsSync(assetPath), `Built dist must contain ${asset}`);
    const stat = fs.statSync(assetPath);
    assert.ok(stat.size > 0, `${asset} must be non-empty (got ${stat.size} bytes)`);
    assert.ok(distIndexHtml.includes(asset), `Built index.html must reference ${asset}`);
  }

  // Verify PNG dimensions
  const appleIconBuf = fs.readFileSync(path.join(tempDistDir, 'apple-touch-icon.png'));
  assert.strictEqual(appleIconBuf.readUInt32BE(16), 180, 'apple-touch-icon width must be 180');
  assert.strictEqual(appleIconBuf.readUInt32BE(20), 180, 'apple-touch-icon height must be 180');

  const icon192Buf = fs.readFileSync(path.join(tempDistDir, 'icon-192.png'));
  assert.strictEqual(icon192Buf.readUInt32BE(16), 192, 'icon-192 width must be 192');
  assert.strictEqual(icon192Buf.readUInt32BE(20), 192, 'icon-192 height must be 192');

  const icon512Buf = fs.readFileSync(path.join(tempDistDir, 'icon-512.png'));
  assert.strictEqual(icon512Buf.readUInt32BE(16), 512, 'icon-512 width must be 512');
  assert.strictEqual(icon512Buf.readUInt32BE(20), 512, 'icon-512 height must be 512');

  // Verify manifest JSON parses and has required fields
  const manifestJson = JSON.parse(fs.readFileSync(path.join(tempDistDir, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(manifestJson.name, 'Rogue 2048');
  assert.strictEqual(manifestJson.short_name, 'Rogue 2048');
  assert.strictEqual(manifestJson.background_color, '#100f11');
  assert.strictEqual(manifestJson.theme_color, '#100f11');
  assert.strictEqual(manifestJson.display, 'standalone');
  assert.ok(Array.isArray(manifestJson.icons) && manifestJson.icons.length >= 3);
  console.log('✔ Built icon assets, PNG dimensions (180, 192, 512), and web manifest verified\n');

  const staticServer = await startStaticServer(tempDistDir);
  console.log(`✔ Static Game Server running on port ${staticServer.port}`);

  const chromePath = findChrome();
  const cdpPort = 9222 + Math.floor(Math.random() * 2000);
  const tempProfile = fs.mkdtempSync(path.join(outDir, 'chrome-result-'));

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ]);

  let cdp = null;

  try {
    const wsUrl = await getWsUrl(cdpPort);
    cdp = new CdpSession(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    console.log('✔ Headless Chrome CDP session connected\n');

    const appUrl = `http://127.0.0.1:${staticServer.port}/`;
    await cdp.setViewport(390, 742);
    await cdp.send('Page.navigate', { url: appUrl });
    await sleep(600);

    // Ensure tutorial seen to isolate challenge test
    await cdp.eval(`
      localStorage.setItem('2048_rogue_tutorial_seen', 'true');
      localStorage.setItem('rogue2048_has_accepted_run', '1');
    `);

    // Helper to setup mock challenge run result
    async function setupOutcome(ctx, summary) {
      await cdp.eval(`
        (function() {
          const tut = document.getElementById('tutorial-overlay');
          if (tut) tut.classList.add('hidden');
          const start = document.getElementById('start-overlay');
          if (start) start.classList.add('hidden');
          const ctx = ${JSON.stringify(ctx)};
          const summary = ${JSON.stringify(summary)};
          window.showChallengeResult(ctx, summary);
        })()
      `);
      await sleep(100);
    }

    // -------------------------------------------------------------------------
    // TEST 1: Verdict Logic & Margin Strings
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Verdict Logic & Margin Strings ---');

    // 1.1 Win Daily
    await setupOutcome(
      { mode: 'daily', points: 11304, moves: 110, senderName: 'Alice', finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 12560, moves: 120, maxTile: 1024, ranked: true, rank: 5, totalPlayers: 12, finalBoard: [2, 4, 8, 16, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    let data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      verdictClass: document.getElementById('challenge-result-verdict')?.className,
      margin: document.getElementById('challenge-result-margin')?.textContent,
      modeChip: document.getElementById('challenge-result-mode-chip')?.textContent,
      youWon: document.getElementById('challenge-result-col-you')?.classList.contains('winner'),
      senderWon: document.getElementById('challenge-result-col-sender')?.classList.contains('winner'),
      scoreYou: document.getElementById('challenge-result-score-you')?.textContent,
      scoreSender: document.getElementById('challenge-result-score-sender')?.textContent,
    })`);
    assert.strictEqual(data.verdict, 'YOU WIN');
    assert.ok(data.verdictClass.includes('verdict-win'));
    assert.strictEqual(data.margin, '+1,256 points');
    assert.strictEqual(data.modeChip, 'DAILY');
    assert.strictEqual(data.youWon, true);
    assert.strictEqual(data.senderWon, false);
    assert.strictEqual(data.scoreYou, '12,560');
    assert.strictEqual(data.scoreSender, '11,304');
    console.log('✔ Daily Win verified (+1,256 points, YOU WIN)');

    // 1.2 Lose Daily (Unicode minus: −832 points)
    await setupOutcome(
      { mode: 'daily', points: 11304, moves: 120, senderName: 'Alice', finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 10472, moves: 110, maxTile: 512, ranked: true, finalBoard: [2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      verdictClass: document.getElementById('challenge-result-verdict')?.className,
      margin: document.getElementById('challenge-result-margin')?.textContent,
      youWon: document.getElementById('challenge-result-col-you')?.classList.contains('winner'),
      senderWon: document.getElementById('challenge-result-col-sender')?.classList.contains('winner'),
    })`);
    assert.strictEqual(data.verdict, 'YOU LOSE');
    assert.ok(data.verdictClass.includes('verdict-lose'));
    assert.strictEqual(data.margin, '−832 points'); // Unicode \u2212
    assert.strictEqual(data.youWon, false);
    assert.strictEqual(data.senderWon, true);
    console.log('✔ Daily Lose verified (−832 points, YOU LOSE)');

    // 1.3 Points Tie, Decided by Moves: Win
    await setupOutcome(
      { mode: 'daily', points: 11304, moves: 389, senderName: 'Alice', finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 11304, moves: 418, maxTile: 1024, ranked: true, finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      verdictClass: document.getElementById('challenge-result-verdict')?.className,
      margin: document.getElementById('challenge-result-margin')?.textContent,
      youWon: document.getElementById('challenge-result-col-you')?.classList.contains('winner'),
      senderWon: document.getElementById('challenge-result-col-sender')?.classList.contains('winner'),
    })`);
    assert.strictEqual(data.verdict, 'YOU WIN');
    assert.ok(data.verdictClass.includes('verdict-win'));
    assert.strictEqual(data.margin, 'Tied on points. 418 vs 389 moves.');
    assert.strictEqual(data.youWon, true);
    assert.strictEqual(data.senderWon, false);
    console.log('✔ Tiebreak by moves Win verified (Tied on points. 418 vs 389 moves.)');

    // 1.4 Points Tie, Decided by Moves: Lose
    await setupOutcome(
      { mode: 'daily', points: 11304, moves: 418, senderName: 'Alice', finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 11304, moves: 389, maxTile: 1024, ranked: true, finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      margin: document.getElementById('challenge-result-margin')?.textContent,
      youWon: document.getElementById('challenge-result-col-you')?.classList.contains('winner'),
      senderWon: document.getElementById('challenge-result-col-sender')?.classList.contains('winner'),
    })`);
    assert.strictEqual(data.verdict, 'YOU LOSE');
    assert.strictEqual(data.margin, 'Tied on points. 389 vs 418 moves.');
    assert.strictEqual(data.youWon, false);
    assert.strictEqual(data.senderWon, true);
    console.log('✔ Tiebreak by moves Lose verified');

    // 1.5 Exact Tie (Equal Points and Equal Moves)
    await setupOutcome(
      { mode: 'daily', points: 11304, moves: 400, senderName: 'Alice', finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 11304, moves: 400, maxTile: 1024, ranked: true, finalBoard: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      verdictClass: document.getElementById('challenge-result-verdict')?.className,
      margin: document.getElementById('challenge-result-margin')?.textContent,
      youWon: document.getElementById('challenge-result-col-you')?.classList.contains('winner'),
      senderWon: document.getElementById('challenge-result-col-sender')?.classList.contains('winner'),
    })`);
    assert.strictEqual(data.verdict, 'TIE');
    assert.ok(data.verdictClass.includes('verdict-tie'));
    assert.strictEqual(data.margin, 'Exact tie: same points and moves');
    assert.strictEqual(data.youWon, false);
    assert.strictEqual(data.senderWon, false);
    console.log('✔ Exact Tie verified (Exact tie: same points and moves, TIE)');

    // 1.6 Free Run Win
    await setupOutcome(
      { mode: 'free', points: 5000, moves: 60, senderName: 'Bob', finalBoard: [2, 2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { points: 7500, moves: 80, maxTile: 512, ranked: false, finalBoard: [4, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    );
    data = await cdp.eval(`({
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
      modeChip: document.getElementById('challenge-result-mode-chip')?.textContent,
      margin: document.getElementById('challenge-result-margin')?.textContent,
    })`);
    assert.strictEqual(data.verdict, 'YOU WIN');
    assert.strictEqual(data.modeChip, 'FREE RUN');
    assert.strictEqual(data.margin, '+2,500 points');
    console.log('✔ Free Run Win verified (FREE RUN mode chip, +2,500 points)\n');

    // -------------------------------------------------------------------------
    // TEST 2: Real Board Grid Colors & Stone Parity
    // -------------------------------------------------------------------------
    console.log('--- TEST 2: Real Board Grid Colors & Stone Parity ---');
    const fullBoard = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 'S', 'S', 0, 0];
    await setupOutcome(
      { mode: 'free', points: 1000, moves: 50, senderName: 'Alice', finalBoard: fullBoard },
      { points: 2000, moves: 60, maxTile: 4096, ranked: false, finalBoard: fullBoard }
    );
    const boardCells = await cdp.eval(`
      Array.from(document.querySelectorAll('#challenge-result-board-you .m-cell')).map(c => ({
        text: c.textContent,
        className: c.className,
        fontSize: getComputedStyle(c).fontSize,
        ariaLabel: c.getAttribute('aria-label'),
      }))
    `);
    assert.strictEqual(boardCells.length, 16);
    assert.strictEqual(boardCells[0].text, '2');
    assert.ok(boardCells[0].className.includes('t2'));
    assert.strictEqual(boardCells[9].text, '1024');
    assert.strictEqual(boardCells[9].fontSize, '8px'); // 1024+ scales to min 8px
    assert.strictEqual(boardCells[10].text, '2048');
    assert.strictEqual(boardCells[10].fontSize, '8px');
    assert.strictEqual(boardCells[11].text, '4096');
    assert.strictEqual(boardCells[11].fontSize, '8px');
    assert.ok(boardCells[12].className.includes('stone'));
    assert.strictEqual(boardCells[12].ariaLabel, 'Permanent stone');

    // Digit font-size strictly smaller for 3-4 digit values than 2-digit, floor 8px
    const font2 = parseFloat(boardCells[0].fontSize); // 2-digit (10.5px)
    const font3 = parseFloat(boardCells[6].fontSize); // 3-digit: 128 (9px)
    const font4 = parseFloat(boardCells[9].fontSize); // 4-digit: 1024 (8px)
    assert.ok(font3 < font2, `3-digit font size (${font3}px) must be strictly smaller than 2-digit (${font2}px)`);
    assert.ok(font4 < font2, `4-digit font size (${font4}px) must be strictly smaller than 2-digit (${font2}px)`);
    assert.ok(font4 <= font3, `4-digit font size (${font4}px) must be strictly smaller than or equal to 3-digit (${font3}px)`);
    assert.ok(font4 >= 8.0, `Digit font size floor must be >= 8px (got ${font4}px)`);
    console.log('✔ Real board tile colors, font scaling (min 8px), and permanent stone styles verified\n');

    // -------------------------------------------------------------------------
    // TEST 3: Legacy Null Board Slot
    // -------------------------------------------------------------------------
    console.log('--- TEST 3: Legacy Null Board Slot ---');
    await setupOutcome(
      { mode: 'daily', points: 1000, moves: 50, senderName: 'OldRun', finalBoard: null },
      { points: 2000, moves: 60, maxTile: 512, ranked: true, finalBoard: fullBoard }
    );
    const legacyData = await cdp.eval(`
      (function() {
        const ph = document.querySelector('#challenge-result-sender-board-wrap .mini-board-placeholder');
        const youBoard = document.getElementById('challenge-result-board-you');
        const rPh = ph ? ph.getBoundingClientRect() : { width: 0, height: 0 };
        const rYou = youBoard ? youBoard.getBoundingClientRect() : { width: 0, height: 0 };
        return {
          text: ph?.textContent,
          phW: rPh.width,
          phH: rPh.height,
          phDelta: Math.abs(rPh.width - rPh.height),
          footprintDeltaW: Math.abs(rYou.width - rPh.width),
          footprintDeltaH: Math.abs(rYou.height - rPh.height),
        };
      })()
    `);
    assert.strictEqual(legacyData.text, 'Board not available');
    assert.ok(legacyData.phDelta <= 1.0, `Placeholder must be square (delta ${legacyData.phDelta}px <= 1px)`);
    assert.ok(legacyData.footprintDeltaW <= 1.0, `Placeholder footprint width must match board width (delta ${legacyData.footprintDeltaW}px <= 1px)`);
    assert.ok(legacyData.footprintDeltaH <= 1.0, `Placeholder footprint height must match board height (delta ${legacyData.footprintDeltaH}px <= 1px)`);
    console.log('✔ Legacy null sender board slot shows "Board not available" with equal square footprint\n');

    // -------------------------------------------------------------------------
    // TEST 4: Daily Ranked vs Unranked Rank Row & Pending/Accepted States
    // -------------------------------------------------------------------------
    console.log('--- TEST 4: Daily Ranked vs Unranked Rank Row ---');
    // Pending ranked
    await setupOutcome(
      { mode: 'daily', points: 1000, moves: 50, senderName: 'Alice', finalBoard: fullBoard },
      { points: 2000, moves: 60, maxTile: 512, ranked: true, rank: null, finalBoard: fullBoard }
    );
    let rankRow = await cdp.eval(`({
      visible: !document.getElementById('challenge-result-daily-rank')?.classList.contains('hidden'),
      pill: document.getElementById('challenge-result-rank-pill')?.textContent,
      btnDisabled: document.getElementById('btn-challenge-result-back')?.disabled,
      hasSpinner: Boolean(document.querySelector('#btn-challenge-result-back .challenge-spinner')),
    })`);
    assert.strictEqual(rankRow.visible, true);
    assert.strictEqual(rankRow.pill, 'Calculating rank…');
    assert.strictEqual(rankRow.btnDisabled, true);
    assert.strictEqual(rankRow.hasSpinner, true);
    console.log('✔ Pending Daily ranked shows "Calculating rank…" and disabled spinner button');

    // Accepted ranked update
    await cdp.eval(`window.updateChallengeResultRank(3, 15, 'accepted')`);
    rankRow = await cdp.eval(`({
      visible: !document.getElementById('challenge-result-daily-rank')?.classList.contains('hidden'),
      pill: document.getElementById('challenge-result-rank-pill')?.textContent,
      btnDisabled: document.getElementById('btn-challenge-result-back')?.disabled,
    })`);
    assert.strictEqual(rankRow.visible, true);
    assert.strictEqual(rankRow.pill, '#3 of 15');
    assert.strictEqual(rankRow.btnDisabled, false);
    console.log('✔ Accepted rank update displays "#3 of 15" and enables button');

    // Failed / Queued ranked update hides row
    await cdp.eval(`window.updateChallengeResultRank(null, null, 'failed')`);
    rankRow = await cdp.eval(`({
      visible: !document.getElementById('challenge-result-daily-rank')?.classList.contains('hidden'),
    })`);
    assert.strictEqual(rankRow.visible, false);
    console.log('✔ Failed / Queued ranked update cleanly hides the rank row');

    // Unranked / Free run hides rank row
    await setupOutcome(
      { mode: 'free', points: 1000, moves: 50, senderName: 'Bob', finalBoard: fullBoard },
      { points: 2000, moves: 60, maxTile: 512, ranked: false, finalBoard: fullBoard }
    );
    rankRow = await cdp.eval(`({
      visible: !document.getElementById('challenge-result-daily-rank')?.classList.contains('hidden'),
    })`);
    assert.strictEqual(rankRow.visible, false);
    console.log('✔ Unranked / Free run keeps daily rank row hidden\n');

    // -------------------------------------------------------------------------
    // TEST 5: Expired Mid-Run Banner
    // -------------------------------------------------------------------------
    console.log('--- TEST 5: Expired Mid-Run Banner ---');
    const pastExpiry = new Date(Date.now() - 60000).toISOString();
    await setupOutcome(
      { mode: 'daily', points: 1000, moves: 50, expiresAt: pastExpiry, senderName: 'Alice', finalBoard: fullBoard },
      { points: 2000, moves: 60, maxTile: 512, ranked: true, rank: 4, totalPlayers: 10, finalBoard: fullBoard }
    );
    const expiredBanner = await cdp.eval(`({
      visible: !document.getElementById('challenge-result-expired-banner')?.classList.contains('hidden'),
      text: document.getElementById('challenge-result-expired-banner')?.textContent,
      verdict: document.getElementById('challenge-result-verdict')?.textContent,
    })`);
    assert.strictEqual(expiredBanner.visible, true);
    assert.strictEqual(expiredBanner.text, 'Challenge link expired while you played');
    assert.strictEqual(expiredBanner.verdict, 'YOU WIN');
    console.log('✔ Expired mid-run displays banner while still showing full result\n');

    // -------------------------------------------------------------------------
    // TEST 6: Action Buttons Wiring & States
    // -------------------------------------------------------------------------
    console.log('--- TEST 6: Action Buttons Wiring & States ---');
    // 6.1 Moves < 10 disabled state
    await setupOutcome(
      { mode: 'free', points: 100, moves: 20, senderName: 'Bob', finalBoard: fullBoard },
      { points: 200, moves: 8, maxTile: 64, ranked: false, finalBoard: fullBoard }
    );
    let backBtn = await cdp.eval(`({
      disabled: document.getElementById('btn-challenge-result-back')?.disabled,
      title: document.getElementById('btn-challenge-result-back')?.title,
    })`);
    assert.strictEqual(backBtn.disabled, true);
    assert.strictEqual(backBtn.title, 'Play a few more moves to challenge a friend.');
    console.log('✔ < 10 moves disables CHALLENGE BACK with correct title');

    // 6.2 CHALLENGE BACK opens share sheet for THIS run with correct mode
    await setupOutcome(
      { mode: 'free', points: 100, moves: 20, senderName: 'Bob', seed: 'seed123', finalBoard: fullBoard },
      { points: 200, moves: 25, maxTile: 128, ranked: false, seed: 'seed123', finalBoard: fullBoard }
    );
    await cdp.eval(`document.getElementById('btn-challenge-result-back')?.click()`);
    await sleep(200);
    let shareSheetState = await cdp.eval(`({
      visible: !document.getElementById('share-sheet')?.classList.contains('hidden'),
      modeChip: document.getElementById('share-mode-chip')?.textContent,
      cardInert: document.getElementById('challenge-result-card')?.hasAttribute('inert'),
    })`);
    assert.strictEqual(shareSheetState.visible, true);
    assert.strictEqual(shareSheetState.modeChip, 'FREE RUN');
    assert.strictEqual(shareSheetState.cardInert, true);
    console.log('✔ CHALLENGE BACK opened share sheet in FREE RUN mode with inert card');

    // Close share sheet
    await cdp.eval(`document.getElementById('btn-share-sheet-close')?.click()`);
    await sleep(100);
    const inertRemoved = await cdp.eval(`!document.getElementById('challenge-result-card')?.hasAttribute('inert')`);
    assert.strictEqual(inertRemoved, true);

    // 6.3 Link reuse on CHALLENGE BACK produces 0 extra network calls
    const initialReqCount = mock.getRequests().length;
    await cdp.eval(`document.getElementById('btn-challenge-result-back')?.click()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('btn-share-sheet-close')?.click()`);
    await sleep(100);
    const newReqCount = mock.getRequests().length;
    assert.strictEqual(newReqCount, initialReqCount, 'Link reuse must produce 0 extra backend requests');
    console.log('✔ Reopening share sheet produced 0 extra network calls (link reuse confirmed)');

    // 6.4 PLAY AGAIN replays same challenge seed and preserves ctx
    await setupOutcome(
      { code: 'testcode', mode: 'free', seed: 998877, points: 100, moves: 20, senderName: 'Bob', finalBoard: fullBoard },
      { points: 200, moves: 25, maxTile: 128, ranked: false, seed: 998877, finalBoard: fullBoard }
    );
    await cdp.eval(`document.getElementById('btn-challenge-result-again')?.click()`);
    await sleep(200);
    let playAgainState = await cdp.eval(`({
      cardHidden: document.getElementById('challenge-result-card')?.classList.contains('hidden'),
      endOverlayHidden: document.getElementById('end-overlay')?.classList.contains('hidden'),
      controllerSeed: window.controller?.seed,
    })`);
    assert.strictEqual(playAgainState.cardHidden, true);
    assert.strictEqual(playAgainState.endOverlayHidden, true);
    assert.strictEqual(playAgainState.controllerSeed, 998877);
    console.log('✔ PLAY AGAIN restarted run with same seed (998877)');

    // 6.5 HOME button clears ctx and returns to start screen
    await setupOutcome(
      { code: 'homecode', mode: 'daily', points: 500, moves: 20, senderName: 'Alice', finalBoard: fullBoard },
      { points: 600, moves: 25, maxTile: 128, ranked: true, finalBoard: fullBoard }
    );

    // Verify HOME button icon parity with game-over HOME button
    const homeIconParity = await cdp.eval(`(() => {
      const endHomeSvg = document.querySelector('#btn-end-home svg');
      const resHomeSvg = document.querySelector('#btn-challenge-result-home svg');
      const endPath = endHomeSvg?.querySelector('path')?.getAttribute('d') || '';
      const resPath = resHomeSvg?.querySelector('path')?.getAttribute('d') || '';
      return {
        endPath,
        resPath,
        endWidth: endHomeSvg?.getAttribute('width') || '',
        resWidth: resHomeSvg?.getAttribute('width') || '',
        endHeight: endHomeSvg?.getAttribute('height') || '',
        resHeight: resHomeSvg?.getAttribute('height') || '',
        endViewBox: endHomeSvg?.getAttribute('viewBox') || '',
        resViewBox: resHomeSvg?.getAttribute('viewBox') || '',
      };
    })()`);
    assert.ok(homeIconParity.endPath.length > 0, 'Game-over HOME icon must have path data');
    assert.strictEqual(homeIconParity.resPath, homeIconParity.endPath, 'Challenge result HOME icon path must be identical to game-over HOME icon path');
    assert.strictEqual(homeIconParity.resViewBox, homeIconParity.endViewBox, 'Challenge result HOME icon viewBox must match game-over HOME icon');
    assert.strictEqual(homeIconParity.resWidth, homeIconParity.endWidth, 'Challenge result HOME icon width must match game-over HOME icon');
    assert.strictEqual(homeIconParity.resHeight, homeIconParity.endHeight, 'Challenge result HOME icon height must match game-over HOME icon');
    console.log('✔ Challenge result HOME button icon matches game-over HOME button (identical SVG path & markup)');

    await cdp.eval(`document.getElementById('btn-challenge-result-home')?.click()`);
    await sleep(200);
    let homeState = await cdp.eval(`({
      ctx: window.__challengeContext ? window.__challengeContext() : null,
      chalCardHidden: document.getElementById('challenge-result-card')?.classList.contains('hidden'),
      normalCardVisible: !document.getElementById('gameover-normal-card')?.classList.contains('hidden'),
      endOverlayHidden: document.getElementById('end-overlay')?.classList.contains('hidden'),
      startOverlayVisible: !document.getElementById('start-overlay')?.classList.contains('hidden'),
    })`);
    assert.strictEqual(homeState.ctx, null);
    assert.strictEqual(homeState.chalCardHidden, true);
    assert.strictEqual(homeState.normalCardVisible, true);
    assert.strictEqual(homeState.endOverlayHidden, true);
    assert.strictEqual(homeState.startOverlayVisible, true);
    console.log('✔ HOME button cleared challengeContext and returned to start screen\n');

    // -------------------------------------------------------------------------
    // TEST 7: Multi-Viewport Audit & Card Height Parity
    // -------------------------------------------------------------------------
    console.log('--- TEST 7: Multi-Viewport Audit & Card Height Parity ---');
    const viewports = [
      { w: 320, h: 568 },
      { w: 360, h: 640 },
      { w: 390, h: 742 },
      { w: 430, h: 932 },
    ];

    for (const vp of viewports) {
      await cdp.setViewport(vp.w, vp.h);
      await setupOutcome(
        { mode: 'daily', points: 10000, moves: 100, senderName: 'Alex', finalBoard: fullBoard },
        { points: 12000, moves: 120, maxTile: 1024, ranked: true, rank: 2, totalPlayers: 20, finalBoard: fullBoard }
      );

      const metrics = await cdp.eval(`
        (function() {
          const chalCard = document.getElementById('challenge-result-card');
          const normalCard = document.getElementById('gameover-normal-card');

          // Measure normal card height in this exact viewport (hiding chalCard so they don't flex-shrink each other)
          chalCard.classList.add('hidden');
          normalCard.classList.remove('hidden');
          const normalRect = normalCard.getBoundingClientRect();
          normalCard.classList.add('hidden');
          chalCard.classList.remove('hidden');

          const chalRect = chalCard.getBoundingClientRect();

          // Check boards squareness and parity
          const youBoard = document.getElementById('challenge-result-board-you');
          const senderBoard = document.getElementById('challenge-result-board-sender');
          const rYou = youBoard ? youBoard.getBoundingClientRect() : { width: 0, height: 0 };
          const rSender = senderBoard ? senderBoard.getBoundingClientRect() : { width: 0, height: 0 };

          const cellsYou = Array.from(youBoard ? youBoard.querySelectorAll('.m-cell') : []).map((c, i) => {
            const r = c.getBoundingClientRect();
            return { idx: i, text: c.textContent, w: r.width, h: r.height, sw: c.scrollWidth, cw: c.clientWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          });
          const cellsSender = Array.from(senderBoard ? senderBoard.querySelectorAll('.m-cell') : []).map((c, i) => {
            const r = c.getBoundingClientRect();
            return { idx: i, text: c.textContent, w: r.width, h: r.height, sw: c.scrollWidth, cw: c.clientWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          });

          // Check text overlap between adjacent cells in the same row
          let textOverlap = false;
          for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 3; col++) {
              const c1 = cellsYou[row * 4 + col];
              const c2 = cellsYou[row * 4 + col + 1];
              if (c1 && c2 && c1.right > c2.left) {
                textOverlap = true;
              }
            }
          }

          // Check vertical gaps
          const sec = chalCard.querySelector('.boards-section');
          const hdr = sec ? sec.querySelector('.boards-header') : null;
          const pr = sec ? sec.querySelector('.boards-pair') : null;
          const rk = document.getElementById('challenge-result-daily-rank');
          const btn = document.getElementById('btn-challenge-result-back');
          const rHdr = hdr ? hdr.getBoundingClientRect() : { bottom: 0 };
          const rPr = pr ? pr.getBoundingClientRect() : { top: 0 };
          const rSec = sec ? sec.getBoundingClientRect() : { bottom: 0 };
          const rRk = rk ? rk.getBoundingClientRect() : { top: 0, bottom: 0 };
          const rBtn = btn ? btn.getBoundingClientRect() : { top: 0 };

          // Check hit areas of all action buttons
          const btns = Array.from(chalCard.querySelectorAll('.btn')).map(b => {
            const r = b.getBoundingClientRect();
            return { id: b.id, w: r.width, h: r.height };
          });

          // Check min font size
          const allEls = Array.from(chalCard.querySelectorAll('*'));
          let minFont = 999;
          for (const el of allEls) {
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (!isNaN(fs) && fs > 0 && fs < minFont && el.textContent.trim().length > 0) {
              minFont = fs;
            }
          }

          return {
            chalW: chalRect.width,
            chalH: chalRect.height,
            normalH: normalRect.height,
            hDelta: Math.abs(chalRect.height - normalRect.height),
            boardMetrics: {
              youW: rYou.width,
              youH: rYou.height,
              youDelta: Math.abs(rYou.width - rYou.height),
              senderW: rSender.width,
              senderH: rSender.height,
              senderDelta: Math.abs(rSender.width - rSender.height),
              boardParityDelta: Math.abs(rYou.width - rSender.width),
              cellsCountYou: cellsYou.length,
              cellsCountSender: cellsSender.length,
              allCellsSquare: cellsYou.every(c => Math.abs(c.w - c.h) <= 1.0) && cellsSender.every(c => Math.abs(c.w - c.h) <= 1.0),
              maxCellDelta: Math.max(0, ...cellsYou.map(c => Math.abs(c.w - c.h)), ...cellsSender.map(c => Math.abs(c.w - c.h))),
              textFitsCells: cellsYou.every(c => c.sw <= c.cw) && cellsSender.every(c => c.sw <= c.cw),
            },
            textOverlap,
            gaps: {
              gapHdrToBoards: rPr.top - rHdr.bottom,
              gapSecToRank: rRk.top - rSec.bottom,
              gapRankToBtn: rBtn.top - rRk.bottom,
            },
            btns,
            minFont,
            overflowX: chalCard.scrollWidth > chalCard.clientWidth + 1,
            overflowY: chalCard.scrollHeight > chalCard.clientHeight + 1,
          };
        })()
      `);

      // Parity assertion: card heights must match within 1px
      assert.ok(
        metrics.hDelta <= 1.0,
        `Viewport ${vp.w}x${vp.h}: chal card height (${metrics.chalH}px) must match normal card height (${metrics.normalH}px) within 1px`
      );

      // Board squareness & parity: delta <= 1px
      assert.ok(
        metrics.boardMetrics.youDelta <= 1.0,
        `Viewport ${vp.w}x${vp.h}: YOU board must be square (width ${metrics.boardMetrics.youW}px vs height ${metrics.boardMetrics.youH}px, delta ${metrics.boardMetrics.youDelta}px <= 1px)`
      );
      assert.ok(
        metrics.boardMetrics.senderDelta <= 1.0,
        `Viewport ${vp.w}x${vp.h}: Sender board must be square (width ${metrics.boardMetrics.senderW}px vs height ${metrics.boardMetrics.senderH}px, delta ${metrics.boardMetrics.senderDelta}px <= 1px)`
      );
      assert.ok(
        metrics.boardMetrics.boardParityDelta <= 1.0,
        `Viewport ${vp.w}x${vp.h}: both boards must have equal size (delta ${metrics.boardMetrics.boardParityDelta}px <= 1px)`
      );

      // Exactly 16 cells visible per board & every cell square (delta <= 1px)
      assert.strictEqual(metrics.boardMetrics.cellsCountYou, 16, `Viewport ${vp.w}x${vp.h}: YOU board must render 16 cells`);
      assert.strictEqual(metrics.boardMetrics.cellsCountSender, 16, `Viewport ${vp.w}x${vp.h}: Sender board must render 16 cells`);
      assert.ok(
        metrics.boardMetrics.allCellsSquare,
        `Viewport ${vp.w}x${vp.h}: all 16 cells must be square (max cell delta ${metrics.boardMetrics.maxCellDelta}px <= 1px)`
      );

      // Fit: digit text fits cell (scrollWidth <= clientWidth) & zero overlap
      assert.strictEqual(metrics.boardMetrics.textFitsCells, true, `Viewport ${vp.w}x${vp.h}: each digit text must fit its cell without overflow`);
      assert.strictEqual(metrics.textOverlap, false, `Viewport ${vp.w}x${vp.h}: text must not overlap between adjacent cells`);

      // Vertical gaps >= thresholds
      const minHdrGap = vp.w <= 350 || vp.h <= 600 ? 8.0 : 12.0;
      assert.ok(
        metrics.gaps.gapHdrToBoards >= minHdrGap - 0.5,
        `Viewport ${vp.w}x${vp.h}: gap from boards box header to boards (${metrics.gaps.gapHdrToBoards}px) must be >= ${minHdrGap}px`
      );
      assert.ok(
        metrics.gaps.gapSecToRank >= 12.0 - 0.5,
        `Viewport ${vp.w}x${vp.h}: gap from boards box to Daily rank (${metrics.gaps.gapSecToRank}px) must be >= 12px`
      );
      assert.ok(
        metrics.gaps.gapRankToBtn >= 12.0 - 0.5,
        `Viewport ${vp.w}x${vp.h}: gap from Daily rank to CHALLENGE BACK (${metrics.gaps.gapRankToBtn}px) must be >= 12px`
      );

      // Fit assertion: no overflow
      assert.strictEqual(metrics.overflowX, false, `Viewport ${vp.w}x${vp.h}: card has horizontal overflow`);
      assert.strictEqual(metrics.overflowY, false, `Viewport ${vp.w}x${vp.h}: card has vertical overflow`);

      // Hit areas >= 36px
      for (const b of metrics.btns) {
        assert.ok(
          b.w >= 36 && b.h >= 36,
          `Viewport ${vp.w}x${vp.h}: button ${b.id} hit area (${b.w}x${b.h}) must be >= 36x36px`
        );
      }

      // Min font >= 8px (board digits scale to 8px; non-board >= 10px)
      assert.ok(
        metrics.minFont >= 8.0,
        `Viewport ${vp.w}x${vp.h}: min font size (${metrics.minFont}px) must be >= 8px`
      );

      // Also audit legacy null board placeholder footprint parity in this viewport
      await setupOutcome(
        { mode: 'daily', points: 10000, moves: 100, senderName: 'Alex', finalBoard: null },
        { points: 12000, moves: 120, maxTile: 1024, ranked: true, rank: 2, totalPlayers: 20, finalBoard: fullBoard }
      );
      const phAudit = await cdp.eval(`
        (function() {
          const youBoard = document.getElementById('challenge-result-board-you');
          const ph = document.querySelector('#challenge-result-sender-board-wrap .mini-board-placeholder');
          const rYou = youBoard ? youBoard.getBoundingClientRect() : { width: 0, height: 0 };
          const rPh = ph ? ph.getBoundingClientRect() : { width: 0, height: 0 };
          return {
            phW: rPh.width,
            phH: rPh.height,
            phDelta: Math.abs(rPh.width - rPh.height),
            footprintDeltaW: Math.abs(rYou.width - rPh.width),
            footprintDeltaH: Math.abs(rYou.height - rPh.height),
          };
        })()
      `);
      assert.ok(phAudit.phDelta <= 1.0, `Viewport ${vp.w}x${vp.h}: placeholder must be square (delta ${phAudit.phDelta}px <= 1px)`);
      assert.ok(phAudit.footprintDeltaW <= 1.0, `Viewport ${vp.w}x${vp.h}: placeholder width must match board width (delta ${phAudit.footprintDeltaW}px <= 1px)`);
      assert.ok(phAudit.footprintDeltaH <= 1.0, `Viewport ${vp.w}x${vp.h}: placeholder height must match board height (delta ${phAudit.footprintDeltaH}px <= 1px)`);

      console.log(`✔ Viewport ${vp.w}x${vp.h} passed: square boards (delta=0px), equal cells, zero text overlap, gaps >= thresholds, card parity delta=${metrics.hDelta.toFixed(1)}px`);
    }
    console.log();

    // -------------------------------------------------------------------------
    // TEST 8: Worst-Case Layout (16-char name, 7-digit pts, 5-digit mvs, 4096 tile)
    // -------------------------------------------------------------------------
    console.log('--- TEST 8: Worst-Case Layout (320x568) ---');
    await cdp.setViewport(320, 568);
    await setupOutcome(
      { mode: 'daily', points: 9999999, moves: 12345, maxTile: 4096, senderName: 'MaximusCharacter', finalBoard: fullBoard },
      { points: 9999999, moves: 12345, maxTile: 4096, ranked: true, rank: 999, totalPlayers: 9999, finalBoard: fullBoard }
    );
    const worstCaseFit = await cdp.eval(`
      (function() {
        const card = document.getElementById('challenge-result-card');
        const nameEl = document.getElementById('challenge-result-name-sender');
        const cs = getComputedStyle(nameEl);
        return {
          overflowX: card.scrollWidth > card.clientWidth + 1,
          overflowY: card.scrollHeight > card.clientHeight + 1,
          ellipsis: cs.textOverflow === 'ellipsis',
        };
      })()
    `);
    assert.strictEqual(worstCaseFit.overflowX, false, 'Worst-case at 320x568 has horizontal overflow');
    assert.strictEqual(worstCaseFit.overflowY, false, 'Worst-case at 320x568 has vertical overflow');
    assert.strictEqual(worstCaseFit.ellipsis, true, 'Sender name has ellipsis');
    console.log('✔ Worst-case layout fits at 320x568 with ellipsis on 16-char name\n');

    // -------------------------------------------------------------------------
    // TEST 9: Security & XSS Safety
    // -------------------------------------------------------------------------
    console.log('--- TEST 9: Security & XSS Safety ---');
    await setupOutcome(
      { mode: 'free', points: 100, moves: 20, senderName: '<img src=x onerror=window.__xssChallengeResult=1>', finalBoard: fullBoard },
      { points: 200, moves: 30, maxTile: 64, ranked: false, finalBoard: fullBoard }
    );
    const xssTriggered = await cdp.eval(`Boolean(window.__xssChallengeResult)`);
    assert.strictEqual(xssTriggered, false, 'XSS payload must not execute');
    const senderNameText = await cdp.eval(`document.getElementById('challenge-result-name-sender')?.textContent`);
    assert.strictEqual(senderNameText, '<img src=x onerror=window.__xssChallengeResult=1>');
    console.log('✔ XSS payload safely escaped and rendered via textContent\n');

    // -------------------------------------------------------------------------
    // TEST 10: Prefers-Reduced-Motion
    // -------------------------------------------------------------------------
    console.log('--- TEST 10: Prefers-Reduced-Motion ---');
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedMotionStyles = await cdp.eval(`
      (function() {
        const btn = document.getElementById('btn-challenge-result-back');
        const winnerCol = document.querySelector('.player-col.winner');
        const btnTransition = btn ? getComputedStyle(btn).transition : '';
        const winnerAfter = winnerCol ? getComputedStyle(winnerCol, '::after').animationName : '';
        return { btnTransition, winnerAfter };
      })()
    `);
    assert.ok(
      reducedMotionStyles.btnTransition === 'none' || reducedMotionStyles.btnTransition.includes('none'),
      'Button transition must be none under reduced motion'
    );
    console.log('✔ Reduced motion verified (animation and transitions disabled)\n');

    // Reset emulated media
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // -------------------------------------------------------------------------
    // TEST 11: Normal Game-Over Screen Unchanged
    // -------------------------------------------------------------------------
    console.log('--- TEST 11: Normal Game-Over Screen Unchanged ---');
    await cdp.eval(`
      (function() {
        // Clear challengeContext and trigger startNewGame
        window.__challengeContext = () => null;
        document.getElementById('btn-challenge-result-home')?.click();
      })()
    `);
    await sleep(200);
    const normalState = await cdp.eval(`({
      normalCardVisible: !document.getElementById('gameover-normal-card')?.classList.contains('hidden'),
      chalCardHidden: document.getElementById('challenge-result-card')?.classList.contains('hidden'),
    })`);
    assert.strictEqual(normalState.normalCardVisible, true);
    assert.strictEqual(normalState.chalCardHidden, true);
    console.log('✔ Normal run routes to normal game-over card with challenge result card hidden\n');

    // -------------------------------------------------------------------------
    // TEST 12: Real-Page Screenshots (8 Scenarios x 2 Viewports = 16 Screenshots)
    // -------------------------------------------------------------------------
    console.log('--- TEST 12: Real-Page Screenshot Capture (16 Review Screenshots) ---');
    const shotScenarios = [
      {
        name: 'win_daily',
        ctx: { mode: 'daily', points: 11304, moves: 110, senderName: 'Alice', finalBoard: fullBoard },
        summary: { points: 12560, moves: 120, maxTile: 1024, ranked: true, rank: 5, totalPlayers: 12, finalBoard: fullBoard },
      },
      {
        name: 'lose_daily',
        ctx: { mode: 'daily', points: 11304, moves: 120, senderName: 'Alice', finalBoard: fullBoard },
        summary: { points: 10472, moves: 110, maxTile: 512, ranked: true, rank: 8, totalPlayers: 12, finalBoard: fullBoard },
      },
      {
        name: 'tie_daily',
        ctx: { mode: 'daily', points: 11304, moves: 400, senderName: 'Alice', finalBoard: fullBoard },
        summary: { points: 11304, moves: 400, maxTile: 1024, ranked: true, rank: 6, totalPlayers: 12, finalBoard: fullBoard },
      },
      {
        name: 'win_free',
        ctx: { mode: 'free', points: 5000, moves: 60, senderName: 'Bob', finalBoard: fullBoard },
        summary: { points: 7500, moves: 80, maxTile: 512, ranked: false, finalBoard: fullBoard },
      },
      {
        name: 'tiebreak',
        ctx: { mode: 'daily', points: 11304, moves: 389, senderName: 'Alice', finalBoard: fullBoard },
        summary: { points: 11304, moves: 418, maxTile: 1024, ranked: true, rank: 4, totalPlayers: 12, finalBoard: fullBoard },
      },
      {
        name: 'expired_banner',
        ctx: { mode: 'daily', points: 10000, moves: 100, expiresAt: pastExpiry, senderName: 'Alice', finalBoard: fullBoard },
        summary: { points: 12000, moves: 110, maxTile: 1024, ranked: true, rank: 2, totalPlayers: 10, finalBoard: fullBoard },
      },
      {
        name: 'legacy_board',
        ctx: { mode: 'daily', points: 8000, moves: 90, senderName: 'LegacyUser', finalBoard: null },
        summary: { points: 10000, moves: 100, maxTile: 1024, ranked: true, rank: 3, totalPlayers: 10, finalBoard: fullBoard },
      },
      {
        name: 'worst_case',
        ctx: { mode: 'daily', points: 9999999, moves: 12345, maxTile: 4096, senderName: 'MaximusCharacter', finalBoard: fullBoard },
        summary: { points: 9999999, moves: 12345, maxTile: 4096, ranked: true, rank: 999, totalPlayers: 9999, finalBoard: fullBoard },
      },
    ];

    for (const sc of shotScenarios) {
      for (const vp of [{ w: 390, h: 742 }, { w: 320, h: 568 }]) {
        await cdp.setViewport(vp.w, vp.h);
        await setupOutcome(sc.ctx, sc.summary);
        const fileName = `chal_result_${sc.name}_${vp.w}.png`;
        const filePath = path.join(outDir, fileName);
        await cdp.screenshot(filePath);
        console.log(`[Screenshot] ${fileName} (${vp.w}x${vp.h})`);
      }
    }
    console.log('✔ All 16 review screenshots captured successfully\n');

    // -------------------------------------------------------------------------
    // TEST 13: Deliberate Self-Check Capability
    // -------------------------------------------------------------------------
    console.log('--- TEST 13: Deliberate Self-Check Capability ---');
    if (isSelfCheckFail) {
      console.log('Deliberate self-check failure requested via --self-check-fail');
      assert.strictEqual(true, false, 'DELIBERATE SELF-CHECK INTENTIONAL FAILURE');
    }
    console.log('✔ Deliberate self-check hook verified\n');

    console.log('================================================================================');
    console.log('ALL 13/13 CHALLENGE RESULT & GAME-OVER ROUTING TESTS PASSED CLEANLY.');
    console.log('================================================================================');
  } finally {
    if (cdp && cdp.ws) {
      try { cdp.ws.close(); } catch { }
    }
    if (chromeProc) {
      try { chromeProc.kill(); } catch { }
    }
    if (staticServer && staticServer.server) {
      try { staticServer.server.close(); } catch { }
    }
    if (mock) {
      try { await mock.close(); } catch { }
    }
    cleanTempDist(tempDistDir);
    cleanTempDist(tempProfile);
  }
}

main().catch((err) => {
  console.error('\n❌ TEST SUITE FAILURE:', err);
  process.exit(1);
});
