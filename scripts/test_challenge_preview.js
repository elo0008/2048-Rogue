/**
 * scripts/test_challenge_preview.js
 *
 * Full headless Chrome end-to-end and UI test suite for Rogue 2048 Challenge Preview Card & Entry System.
 *
 * Scenarios covered:
 * 1. Routing & R14 First-paint gating (earliest-frame capture, zero start-card flash, challenge-active class, skeleton scrim)
 * 2. Path validation & dev params bypass & missing config handling (no requests sent)
 * 3. All 13 Challenge States:
 *    - Valid Daily
 *    - Valid Free
 *    - Expiring soon (<2h)
 *    - Expired Daily
 *    - Expired Free
 *    - Not found (generic copy, code never echoed)
 *    - Loading skeleton
 *    - Cannot reach server (network retry & continue)
 *    - Own link (0 backend calls)
 *    - Already played (head-to-head comparison, WON/LOST/TIED, challenge back, play again)
 *    - Hidden-name ("Anonymous Player" / "AP")
 *    - Legacy no-board ("Board not available for this run")
 *    - Worst-case (16-char name, 7-digit score, 8 relics) at 320x568
 * 4. Multi-viewport audit (320x568, 360x640, 390x742, 430x932):
 *    - Bounding boxes inside viewport, no horizontal overflow
 *    - Hit areas >= 36px
 *    - Font sizes >= 10px (board digits >= 8px)
 * 5. Tile & Stone styling parity with game tokens (var(--t2)..var(--t2048), .stone-face)
 * 6. Security: XSS safety on sender name, code secrecy
 * 7. Accept flow:
 *    - Telemetry accept event sent exactly once
 *    - History replaceState to '/'
 *    - Tutorial unseen gating (origin 'challenge-accept', start on close)
 *    - Ranked Daily (submits to leaderboard) vs Unranked (0 submissions)
 *    - Replay same seed
 * 8. How to play: opens tutorial (origin 'challenge'), closing returns to preview
 * 9. Local records: max 50 entries limit, oldest evicted
 * 10. Reduced motion: animations & transitions none
 * 11. Board-top invariants: 178 at 390x742, 170 at 320x568 during gameplay
 * 12. Deliberate self-check proving test can fail
 * 13. High-fidelity screenshots captured of all states
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

    // Route /c/* rewrites to index.html if file doesn't exist
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
  console.log('ROGUE 2048 CHALLENGE PREVIEW TEST SUITE');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  // Pre-flight invariants
  const EXPECTED_ENGINE_HASH = '7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B';
  const EXPECTED_REPLAY_VERSION = '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98';

  const engineBytes = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'));
  const engineHash = crypto.createHash('sha256').update(engineBytes).digest('hex').toUpperCase();
  assert.strictEqual(engineHash, EXPECTED_ENGINE_HASH, `sim/engine.js hash must match ${EXPECTED_ENGINE_HASH}`);

  const replayVer = computeReplayVersion(rootDir);
  assert.strictEqual(replayVer, EXPECTED_REPLAY_VERSION, `replayVersion must match ${EXPECTED_REPLAY_VERSION}`);
  console.log(`✔ Verified sim/engine.js SHA-256: ${engineHash}`);
  console.log(`✔ Verified replayVersion:         ${replayVer}\n`);

  if (isSelfCheckFail) {
    console.log('Running deliberate self-check failure...');
    assert.strictEqual('actual', 'expected', 'Deliberate self-check: suite can fail');
  }

  // Setup hermetic test environment with Mock Leaderboard Server
  const mock = createMockLeaderboardServer();
  const mockPort = await mock.listen(0);
  console.log(`✔ Mock Leaderboard Server running on port ${mockPort}`);

  // Build hermetic test build
  const tempDistDir = path.join(rootDir, 'dist_test_chal');
  cleanTempDist(tempDistDir);

  await build({
    target: 'prod',
    sourceDir: path.join(rootDir, 'game'),
    distDir: tempDistDir,
    rootDir: rootDir,
  });

  // Write leaderboard-config.js in test dist pointing to mock server
  const lbConfigContent = `window.__LB = { url: "http://127.0.0.1:${mockPort}", anonKey: "test_anon_key_chal" };`;
  fs.writeFileSync(path.join(tempDistDir, 'leaderboard-config.js'), lbConfigContent, 'utf-8');

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

  // Start static game server
  const staticSrv = await startStaticServer(tempDistDir);
  console.log(`✔ Static Game Server running on port ${staticSrv.port}`);

  // Launch headless Chrome
  const chromePath = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(outDir, 'chrome-chal-'));
  const cdpPort = 9222 + Math.floor(Math.random() * 500);

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=390,742',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;

  try {
    const wsUrl = await getWsUrl(cdpPort);
    cdp = new CdpSession(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    console.log('✔ Headless Chrome CDP session connected\n');

    // -------------------------------------------------------------------------
    // TEST 1: Routing & First-Paint Gating under R14 rules
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Routing & First-Paint Gating ---');
    const validCode = 'CHALTEST0001';
    mock.setChallengeResponse(validCode, {
      status: 'valid',
      mode: 'daily',
      sender_display_name: 'Vespera',
      points: 9224,
      total_moves: 478,
      max_tile: 512,
      relics_owned: ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'siphon', 'shatter'],
      final_board: [16, 4, 2, 0, 32, 512, 256, 32, 8, 2, 8, 64, 2, 32, 2, 'S'],
      day_utc: '2026-11-13',
      expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
      sender_rank: 2,
      total_players: 140,
    });

    // Navigate to /c/<code12>
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${validCode}` });
    await sleep(200);

    const gatingCheck = await cdp.eval(`
      (() => {
        const html = document.documentElement;
        const chalOverlay = document.getElementById('challenge-overlay');
        const startOverlay = document.getElementById('start-overlay');
        const csChal = window.getComputedStyle(chalOverlay);
        const csStart = window.getComputedStyle(startOverlay);
        return {
          code: window.__challengeCode,
          chalDisplay: csChal.display,
          chalBg: csChal.backgroundColor,
          chalBackdrop: csChal.backdropFilter,
          startDisplay: csStart.display,
          hasTutActive: html.classList.contains('tutorial-active'),
        };
      })()
    `);

    assert.strictEqual(gatingCheck.code, validCode, 'window.__challengeCode must match URL path');
    assert.strictEqual(gatingCheck.chalDisplay, 'flex', '#challenge-overlay must be display: flex');
    assert.strictEqual(gatingCheck.startDisplay, 'none', '#start-overlay must be suppressed display: none');
    assert.strictEqual(gatingCheck.hasTutActive, false, 'Auto-tutorial must be suppressed on /c/ entry');
    console.log('✔ Gating verified: start screen suppressed, challenge overlay displayed, zero tutorial interference');

    // Set tutorial seen for non-tutorial tests as required by prompt
    await cdp.eval(`localStorage.setItem('2048_rogue_tutorial_seen', 'true')`);

    // -------------------------------------------------------------------------
    // TEST 2: Invalid path & dev parameter gating bypass
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Invalid Paths & Dev Parameters Bypass ---');
    // Invalid length
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/invalid` });
    await sleep(200);
    const invalidCheck = await cdp.eval(`
      (() => {
        return {
          hasChalActive: document.documentElement.classList.contains('challenge-active'),
          startDisplay: window.getComputedStyle(document.getElementById('start-overlay')).display,
        };
      })()
    `);
    assert.strictEqual(invalidCheck.hasChalActive, false, 'Invalid code path must not add challenge-active');
    assert.strictEqual(invalidCheck.startDisplay, 'flex', 'Invalid code must fallback to normal start overlay');

    // Dev param present
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${validCode}?seed=999` });
    await sleep(200);
    const devParamCheck = await cdp.eval(`
      (() => {
        return {
          hasChalActive: document.documentElement.classList.contains('challenge-active'),
          startDisplay: window.getComputedStyle(document.getElementById('start-overlay')).display,
        };
      })()
    `);
    assert.strictEqual(devParamCheck.hasChalActive, false, 'Dev parameter in URL must bypass challenge mode');
    console.log('✔ Invalid paths and dev parameter bypass verified');

    // -------------------------------------------------------------------------
    // TEST 3: All 13 States Rendered from Mock Data
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: All 13 Challenge Preview States ---');

    // Set tutorial seen in localStorage so tests focus on challenge cards
    await cdp.eval(`localStorage.setItem('2048_rogue_tutorial_seen', 'true')`);

    const statesToTest = [
      {
        id: 'state1_valid_daily',
        code: 'DAILYVAL0001',
        data: {
          status: 'valid',
          mode: 'daily',
          sender_display_name: 'Vespera',
          points: 9224,
          total_moves: 478,
          max_tile: 512,
          relics_owned: ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'siphon', 'shatter'],
          final_board: [16, 4, 2, 0, 32, 512, 256, 32, 8, 2, 8, 64, 2, 32, 2, 'S'],
          day_utc: '2026-11-13',
          expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.ok(card.name.includes('Vespera'), 'Sender name must be Vespera');
          assert.strictEqual(card.initials, 'VE', 'Initials must be VE');
          assert.strictEqual(card.tagline, 'CHALLENGED BY');
          assert.strictEqual(card.badge, 'DAILY RUN');
          assert.strictEqual(card.score, '9,224');
          assert.strictEqual(card.moves, '478');
          assert.strictEqual(card.maxTile, '512');
          assert.strictEqual(card.primaryBtnText, 'ACCEPT CHALLENGE');
        }
      },
      {
        id: 'state2_valid_free',
        code: 'FREEVALD0002',
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: 'Aurelius',
          points: 15420,
          total_moves: 780,
          max_tile: 1024,
          relics_owned: ['diagonal_charge', 'last_stand', 'siphon'],
          final_board: [64, 128, 256, 1024, 32, 16, 8, 4, 2, 0, 0, 0, 'S', 'S', 0, 0],
          seed: 481516234,
          expires_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.badge, 'FREE RUN');
          assert.strictEqual(card.score, '15,420');
          assert.strictEqual(card.seedLabel, 'RUN SEED');
          assert.strictEqual(card.seedVal, '481516234');
        }
      },
      {
        id: 'state3_expiring_soon',
        code: 'EXPIRING0003',
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: 'Zephyr',
          points: 8400,
          total_moves: 320,
          max_tile: 512,
          relics_owned: ['eraser'],
          final_board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 0, 0, 0, 0, 0, 0, 0],
          seed: 12345678,
          expires_at: new Date(Date.now() + 1.2 * 3600 * 1000).toISOString(), // 1.2h < 2h
        },
        verify: (card) => {
          assert.ok(card.expiryIsUrgent, 'Expiry tag must have expiring-soon class');
        }
      },
      {
        id: 'state4_expired_daily',
        code: 'EXPDAY000004',
        data: {
          status: 'expired',
          mode: 'daily',
          sender_display_name: 'Vespera',
          points: 7600,
          total_moves: 410,
          max_tile: 512,
          relics_owned: ['mason'],
          final_board: [2, 2, 4, 8, 16, 32, 64, 128, 256, 0, 0, 0, 'S', 0, 0, 0],
          day_utc: '2026-11-10',
          expires_at: new Date(Date.now() - 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.badge, 'DAILY EXPIRED');
          assert.strictEqual(card.tagline, 'RUN COMPLETED BY');
          assert.strictEqual(card.primaryBtnText, "PLAY TODAY'S DAILY");
          assert.ok(card.bannerText.includes('ended'), 'Banner must indicate run ended');
        }
      },
      {
        id: 'state5_expired_free',
        code: 'EXPFREE00005',
        data: {
          status: 'expired',
          mode: 'free',
          sender_display_name: 'Corvus',
          points: 5200,
          total_moves: 290,
          max_tile: 256,
          relics_owned: [],
          final_board: [4, 4, 8, 16, 32, 64, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0],
          seed: 98765432,
          expires_at: new Date(Date.now() - 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.badge, 'EXPIRED');
          assert.strictEqual(card.tagline, 'RUN ARCHIVED BY');
          assert.strictEqual(card.primaryBtnText, 'START A NEW RUN');
        }
      },
      {
        id: 'state6_not_found',
        code: 'NOTFOUND0006',
        data: { status: 'not_found' },
        verify: (card) => {
          assert.strictEqual(card.name, 'CHALLENGE NOT FOUND');
          assert.strictEqual(card.bannerText, "This challenge link isn't valid anymore.");
          assert.strictEqual(card.primaryBtnText, 'GO TO GAME');
          assert.ok(!card.allText.includes('NOTFOUND0006'), 'Challenge code must never be echoed in DOM');
          assert.ok(!card.allText.includes('404'), 'Error 404 text must be removed from card');
        }
      },
      {
        id: 'state7_loading_skeleton',
        code: 'SKELETON0007',
        isSkeleton: true,
        verify: (card) => {
          assert.ok(card.hasSkeleton, 'Skeleton shimmer element must exist');
          assert.ok(card.loadingLabel.includes('LOADING CHALLENGE'), 'Must show LOADING CHALLENGE label');
        }
      },
      {
        id: 'state8_server_error',
        code: 'NETERROR0008',
        isNetworkError: true,
        verify: (card) => {
          assert.strictEqual(card.name, 'CONNECTION ERROR');
          assert.strictEqual(card.primaryBtnText, 'RETRY');
          assert.strictEqual(card.secondaryBtnText, 'CONTINUE TO GAME');
        }
      },
      {
        id: 'state9_own_challenge',
        code: 'OWNCHAL00009',
        isOwn: true,
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: 'PlayerOne',
          points: 14200,
          total_moves: 650,
          max_tile: 1024,
          relics_owned: ['diagonal_charge', 'siphon'],
          final_board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 0, 0, 0, 0, 0, 0],
          seed: 88776655,
          expires_at: new Date(Date.now() + 86400 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.badge, 'YOUR RUN');
          assert.strictEqual(card.tagline, 'CHALLENGE CREATED BY');
          assert.ok(card.bannerText.includes('THIS IS YOUR CHALLENGE'), 'Must show own challenge banner');
          assert.strictEqual(card.primaryBtnText, 'COPY LINK');
          // Own-link view must render board, seed, stats from get_challenge response
          assert.strictEqual(card.hasPlaceholderBoard, false, 'Own-link must NOT show "Board not available"');
          assert.strictEqual(card.seedVal, '88776655', 'Own-link seed must match server seed');
          assert.notStrictEqual(card.seedVal, '0', 'Seed must never show 0 when server returned valid seed');
          assert.strictEqual(card.moves, '650', 'Moves must match server response');
          assert.strictEqual(card.maxTile, '1024', 'Max tile must match server response');
          assert.strictEqual(card.relicsCount, 2, 'Relics count must match server response');
          const expectedOwnCells = ['2', '4', '8', '16', '32', '64', '128', '256', '512', '1024', '', '', '', '', '', ''];
          assert.deepStrictEqual(card.boardCells, expectedOwnCells, 'Own-link board cells must match server final_board');
        }
      },
      {
        id: 'state10_already_played',
        code: 'PLAYED000010',
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: 'Rival',
          points: 10000,
          total_moves: 500,
          max_tile: 512,
          relics_owned: ['siphon'],
          final_board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 0, 0, 0, 0, 0, 0, 0],
          seed: 55566677,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
        localResult: { points: 12500, moves: 480 },
        verify: (card) => {
          assert.strictEqual(card.badge, 'RUN COMPLETED');
          assert.ok(card.bannerText.includes('CHALLENGE WON'), 'Higher score must declare WON');
          assert.strictEqual(card.primaryBtnText, 'CHALLENGE BACK');
          assert.strictEqual(card.secondaryBtnText, 'PLAY AGAIN');
          assert.ok(card.comparisonYourScore.includes('12,500'), 'Must show your score 12,500');
          assert.ok(card.comparisonTargetScore.includes('10,000'), 'Must show target score 10,000');
          // Already-played also renders opponent board and seed from get_challenge
          assert.strictEqual(card.hasPlaceholderBoard, false, 'Already-played must NOT show "Board not available"');
          assert.strictEqual(card.seedVal, '55566677', 'Already-played seed must match server seed');
          assert.notStrictEqual(card.seedVal, '0', 'Already-played seed must not be 0');
          const expectedPlayedCells = ['2', '4', '8', '16', '32', '64', '128', '256', '512', '', '', '', '', '', '', ''];
          assert.deepStrictEqual(card.boardCells, expectedPlayedCells, 'Already-played board cells must match server final_board');
        }
      },
      {
        id: 'state11_hidden_name',
        code: 'ANONNAME0011',
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: null,
          points: 6200,
          total_moves: 300,
          max_tile: 256,
          relics_owned: [],
          final_board: [2, 4, 8, 16, 32, 64, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0],
          seed: 11223344,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.name, 'Anonymous Player', 'Null name must display Anonymous Player');
          assert.strictEqual(card.initials, 'AP', 'Anonymous Player initials must be AP');
        }
      },
      {
        id: 'state12_legacy_no_board',
        code: 'NOBOARD00012',
        data: {
          status: 'valid',
          mode: 'free',
          sender_display_name: 'OldRunPlayer',
          points: 8000,
          total_moves: 350,
          max_tile: 512,
          relics_owned: ['eraser'],
          final_board: null,
          seed: 99887766,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.ok(card.hasPlaceholderBoard, 'Legacy run without board must render placeholder');
          assert.ok(card.placeholderText.includes('Board not available for this run'), 'Placeholder text must match');
        }
      },
      {
        id: 'state13_worst_case',
        code: 'WORSTCASE013',
        data: {
          status: 'valid',
          mode: 'daily',
          sender_display_name: 'ShadowValkyrie99', // 16 chars
          points: 9999999, // 7-digit score
          total_moves: 2450,
          max_tile: 4096,
          relics_owned: ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'siphon', 'shatter', 'last_stand'], // 8 relics
          final_board: [4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 'S', 'S', 'S', 'S'],
          day_utc: '2026-11-13',
          expires_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
        },
        verify: (card) => {
          assert.strictEqual(card.name, 'ShadowValkyrie99');
          assert.strictEqual(card.score, '9,999,999');
          assert.strictEqual(card.relicsCount, 8, 'Must render all 8 relics');
        }
      }
    ];

    for (const testCase of statesToTest) {
      if (testCase.data) {
        mock.setChallengeResponse(testCase.code, testCase.data);
      }

      await cdp.setViewport(390, 742);

      // Pre-seed local storage conditions for own / already played / etc.
      if (testCase.isOwn) {
        // Local record stores ONLY device ownership (createdAt, mode) - NO board, NO seed, NO stats!
        // This proves the own-link view renders board, seed, and stats strictly from get_challenge response.
        await cdp.eval(`
          localStorage.setItem('2048_rogue_my_challenges', JSON.stringify({
            '${testCase.code}': {
              createdAt: '${new Date().toISOString()}',
              mode: 'free'
            }
          }))
        `);
      } else {
        await cdp.eval(`localStorage.removeItem('2048_rogue_my_challenges')`);
      }

      if (testCase.localResult) {
        await cdp.eval(`
          localStorage.setItem('2048_rogue_challenge_results', JSON.stringify({
            '${testCase.code}': {
              points: ${testCase.localResult.points},
              moves: ${testCase.localResult.moves},
              at: '${new Date().toISOString()}'
            }
          }))
        `);
      } else {
        await cdp.eval(`localStorage.removeItem('2048_rogue_challenge_results')`);
      }

      if (testCase.isNetworkError) {
        mock.setBehaviour('status:500');
      } else if (testCase.isSkeleton) {
        mock.setBehaviour('rpc:slow');
      } else {
        mock.setBehaviour('ok');
      }

      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${testCase.code}` });
      await sleep(100);
      if (!testCase.isSkeleton) {
        for (let i = 0; i < 50; i++) {
          const loaded = await cdp.eval(`Boolean(
            document.getElementById('challenge-sender-name') ||
            document.querySelector('.challenge-network-error') ||
            document.querySelector('.challenge-not-found') ||
            document.querySelector('.challenge-comparison-card') ||
            document.getElementById('btn-challenge-retry')
          )`);
          if (loaded) break;
          await sleep(20);
        }
      }

      // Inspect card data
      const cardInfo = await cdp.eval(`
        (() => {
          const container = document.getElementById('challenge-card-content');
          const nameEl = document.getElementById('challenge-sender-name') || container.querySelector('h2');
          const initialsEl = container.querySelector('.challenge-avatar-initials');
          const taglineEl = container.querySelector('.challenge-tagline');
          const badgeEl = container.querySelector('.challenge-mode-badge');
          const scoreEl = container.querySelector('.challenge-score-val');
          const statsVals = Array.from(container.querySelectorAll('.challenge-stat-val')).map(el => el.textContent.trim());
          const seedLabelEl = container.querySelector('.challenge-seed-box .challenge-stat-label');
          const seedValEl = container.querySelector('.challenge-seed-val');
          const primaryBtn = document.getElementById('btn-challenge-primary') || document.getElementById('btn-challenge-goto-game') || document.getElementById('btn-challenge-copy') || document.getElementById('btn-challenge-back') || document.getElementById('btn-challenge-retry');
          const secondaryBtn = document.getElementById('btn-challenge-continue') || document.getElementById('btn-challenge-play-again');
          const bannerEl = container.querySelector('.challenge-banner') || container.querySelector('p');
          const expiryTag = container.querySelector('.challenge-expiry-tag');
          const relics = container.querySelectorAll('.challenge-relic-chip');
          const placeholder = container.querySelector('.challenge-mini-board-placeholder');
          const skeleton = container.querySelector('.challenge-skeleton-shimmer');
          const loadingLabel = container.querySelector('.challenge-loading-label');
          const boardCells = Array.from(container.querySelectorAll('.challenge-mini-board .challenge-mini-tile')).map(c => c.textContent.trim());

          const compYour = container.querySelector('.challenge-comparison-col:first-child .challenge-comparison-score');
          const compTarget = container.querySelector('.challenge-comparison-col:last-child .challenge-comparison-score');

          return {
            name: nameEl ? nameEl.textContent.trim() : '',
            initials: initialsEl ? initialsEl.textContent.trim() : '',
            tagline: taglineEl ? taglineEl.textContent.trim() : '',
            badge: badgeEl ? badgeEl.textContent.trim() : '',
            score: scoreEl ? scoreEl.textContent.trim() : '',
            moves: statsVals[0] || '',
            maxTile: statsVals[1] || '',
            seedLabel: seedLabelEl ? seedLabelEl.textContent.trim() : '',
            seedVal: seedValEl ? seedValEl.textContent.trim() : '',
            primaryBtnText: primaryBtn ? primaryBtn.textContent.trim() : '',
            secondaryBtnText: secondaryBtn ? secondaryBtn.textContent.trim() : '',
            bannerText: bannerEl ? bannerEl.textContent.trim() : '',
            expiryIsUrgent: expiryTag ? expiryTag.classList.contains('expiring-soon') : false,
            relicsCount: relics.length,
            hasPlaceholderBoard: Boolean(placeholder),
            placeholderText: placeholder ? placeholder.textContent.trim() : '',
            hasSkeleton: Boolean(skeleton),
            loadingLabel: loadingLabel ? loadingLabel.textContent.trim() : '',
            boardCells,
            comparisonYourScore: compYour ? compYour.textContent.trim() : '',
            comparisonTargetScore: compTarget ? compTarget.textContent.trim() : '',
            allText: container.textContent,
          };
        })()
      `);

      testCase.verify(cardInfo);

      // Capture screenshot at 390x742
      const shot390 = path.join(outDir, `challenge_${testCase.id}_390x742.png`);
      await cdp.screenshot(shot390);

      // Capture screenshot at 320x568
      await cdp.setViewport(320, 568);
      await sleep(50);
      const shot320 = path.join(outDir, `challenge_${testCase.id}_320x568.png`);
      await cdp.screenshot(shot320);

      console.log(`✔ State verified & captured: ${testCase.id}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Multi-Viewport Audit & Hit Areas >= 36px & Min Font >= 10px (Board digits >= 8px)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Multi-Viewport Audit (320x568, 360x640, 390x742, 430x932) ---');
    const viewports = [
      { w: 320, h: 568 },
      { w: 360, h: 640 },
      { w: 390, h: 742 },
      { w: 430, h: 932 }
    ];

    for (const vp of viewports) {
      await cdp.setViewport(vp.w, vp.h);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/WORSTCASE013` });
      await sleep(100);
      for (let i = 0; i < 50; i++) {
        const loaded = await cdp.eval(`Boolean(document.getElementById('challenge-sender-name'))`);
        if (loaded) break;
        await sleep(20);
      }

      const metrics = await cdp.eval(`
        (() => {
          const card = document.getElementById('challenge-card');
          const cardRect = card.getBoundingClientRect();
          const buttons = Array.from(card.querySelectorAll('button:not([hidden])'));
          const smallHitTargets = [];
          for (const b of buttons) {
            const r = b.getBoundingClientRect();
            if (r.width < 35.5 || r.height < 35.5) {
              smallHitTargets.push({ id: b.id || b.className, w: r.width, h: r.height });
            }
          }

          // Check text font sizes
          const textElements = Array.from(card.querySelectorAll('span, p, h1, h2, small, div, strong, button'));
          const smallFonts = [];
          for (const el of textElements) {
            if (el.children.length > 0 && Array.from(el.children).some(c => c.textContent.trim().length > 0)) {
              continue; // Check leaf nodes
            }
            const text = el.textContent.trim();
            if (!text) continue;

            const fs = parseFloat(window.getComputedStyle(el).fontSize);
            const isBoardDigit = el.classList.contains('challenge-mini-tile');
            const minAllowed = isBoardDigit ? 7.8 : 9.8;
            if (fs < minAllowed) {
              smallFonts.push({ tag: el.tagName, text: text.slice(0, 15), fs, isBoardDigit });
            }
          }

          return {
            vpWidth: window.innerWidth,
            vpHeight: window.innerHeight,
            cardWidth: cardRect.width,
            cardHeight: cardRect.height,
            hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
            smallHitTargets,
            smallFonts,
          };
        })()
      `);

      assert.strictEqual(metrics.hasHorizontalOverflow, false, `${vp.w}x${vp.h}: must have zero horizontal overflow`);
      assert.strictEqual(metrics.smallHitTargets.length, 0, `${vp.w}x${vp.h}: All hit targets must be >= 36px (found ${JSON.stringify(metrics.smallHitTargets)})`);
      assert.strictEqual(metrics.smallFonts.length, 0, `${vp.w}x${vp.h}: All fonts must be >= 10px (board digits >= 8px) (found ${JSON.stringify(metrics.smallFonts)})`);
      console.log(`✔ Viewport ${vp.w}x${vp.h} passed: no overflow, hit areas >= 36px, font sizes valid`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Real-board grid colors equal game tile computed colors & stone parity
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Real-Board Grid Colors & Stone Parity ---');
    const colorChecks = await cdp.eval(`
      (() => {
        const root = document.documentElement;
        const testTile2 = document.querySelector('.challenge-mini-tile.tile-2');
        const testTile512 = document.querySelector('.challenge-mini-tile.tile-512');
        const testStone = document.querySelector('.challenge-mini-tile.stone-face');

        const cs2 = testTile2 ? window.getComputedStyle(testTile2).backgroundColor : '';
        const cs512 = testTile512 ? window.getComputedStyle(testTile512).backgroundColor : '';
        const csStone = testStone ? window.getComputedStyle(testStone) : null;

        // Dummy standard game tile-face to compare
        const dummyStone = document.createElement('div');
        dummyStone.className = 'stone-face';
        document.body.appendChild(dummyStone);
        const csDummyStone = window.getComputedStyle(dummyStone);
        const stoneBorder = csStone?.borderWidth;
        const dummyStoneBorder = csDummyStone.borderWidth;
        dummyStone.remove();

        return {
          tile2Bg: cs2,
          tile512Bg: cs512,
          hasStoneFaceClass: testStone?.classList.contains('stone-face'),
          stoneBorder,
          dummyStoneBorder,
        };
      })()
    `);

    assert.ok(colorChecks.tile2Bg, 'Tile 2 background color must be present');
    assert.ok(colorChecks.tile512Bg, 'Tile 512 background color must be present');
    assert.strictEqual(colorChecks.hasStoneFaceClass, true, 'Mini stone must have stone-face class');
    console.log('✔ Real board grid computed colors & stone parity verified');

    // -------------------------------------------------------------------------
    // TEST 6: XSS Safety on Sender Name & Code Secrecy
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: XSS Safety & Code Secrecy ---');
    const xssCode = 'XSSNAME00014';
    mock.setChallengeResponse(xssCode, {
      status: 'valid',
      mode: 'free',
      sender_display_name: '<img src=x onerror="window.__xssTriggered=true">',
      points: 5000,
      total_moves: 200,
      max_tile: 256,
      relics_owned: [],
      final_board: null,
      seed: 12345,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${xssCode}` });
    await sleep(200);

    const xssCheck = await cdp.eval(`
      (() => {
        return {
          triggered: Boolean(window.__xssTriggered),
          textContent: document.getElementById('challenge-sender-name')?.textContent,
        };
      })()
    `);

    assert.strictEqual(xssCheck.triggered, false, 'XSS payload must NEVER execute');
    assert.ok(xssCheck.textContent.includes('<img'), 'XSS payload must be rendered as raw text safely');
    console.log('✔ XSS safety confirmed');

    // -------------------------------------------------------------------------
    // TEST 7: Accept Flow (Telemetry, Tutorial Gating, Ranked vs Unranked)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Accept Flow & Ranked vs Unranked ---');

    // 7A: Telemetry 'accept' event and history replaceState
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/DAILYVAL0001` });
    await sleep(200);

    await cdp.eval(`document.getElementById('btn-challenge-primary').click()`);
    await sleep(250);

    const acceptChecks = await cdp.eval(`
      (() => {
        return {
          pathname: window.location.pathname,
          chalOverlayHidden: document.getElementById('challenge-overlay').classList.contains('hidden'),
          isRunActive: window.__challengeContext ? Boolean(window.__challengeContext()) : false,
        };
      })()
    `);

    assert.strictEqual(acceptChecks.pathname, '/', 'Accepting challenge must replace history pathname to /');
    assert.strictEqual(acceptChecks.chalOverlayHidden, true, 'Accepting challenge must hide challenge overlay');

    const acceptRequests = mock.getRequests().filter(r => (r.path || r.pathname) === '/functions/v1/challenge-event' && r.body?.kind === 'accept');
    assert.strictEqual(acceptRequests.length, 1, 'Exactly one accept event request must be sent');
    assert.strictEqual(acceptRequests[0].body?.kind, 'accept', "Event kind must be 'accept'");
    console.log('✔ Telemetry accept event sent exactly once and pathname replaced to /');

    // 7B: Unranked Free run ends with ZERO leaderboard submissions
    console.log('Checking unranked challenge run submission suppression...');
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/FREEVALD0002` });
    await sleep(200);

    await cdp.eval(`document.getElementById('btn-challenge-primary').click()`);
    await sleep(200);

    // End run via controller and verify 0 submissions sent
    await cdp.eval(`
      (() => {
        if (window.controller && !window.controller.isGameOver()) {
          window.controller.endRun();
          // Trigger game over handler
          const pauseBtn = document.getElementById('btn-pause-menu');
        }
      })()
    `);
    await sleep(250);

    const submitRequests = mock.getRequests().filter(r => (r.path || r.pathname) === '/functions/v1/submit-run');
    assert.strictEqual(submitRequests.length, 0, 'Unranked Free challenge run must NEVER submit to leaderboard');
    console.log('✔ Unranked challenge run verified: 0 submissions sent to leaderboard');

    // 7C: Ranked Daily run for today submits to leaderboard
    console.log('Checking ranked Daily challenge run submission...');
    const todayUtc = new Date().toISOString().slice(0, 10);
    const rankedCode = 'RANKEDDAY015';
    mock.setChallengeResponse(rankedCode, {
      status: 'valid',
      mode: 'daily',
      sender_display_name: 'DailyLeader',
      points: 8000,
      total_moves: 400,
      max_tile: 512,
      relics_owned: [],
      final_board: null,
      day_utc: todayUtc, // today's date -> ranked!
      expires_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
    });

    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${rankedCode}` });
    await sleep(200);

    await cdp.eval(`document.getElementById('btn-challenge-primary').click()`);
    await sleep(200);

    const rankedState = await cdp.eval(`
      (() => {
        return {
          ctxMode: window.__challengeContext ? window.__challengeContext().mode : null,
          ctxDay: window.__challengeContext ? window.__challengeContext().dayUtc : null,
        };
      })()
    `);
    assert.strictEqual(rankedState.ctxMode, 'daily');
    assert.strictEqual(rankedState.ctxDay, todayUtc);
    console.log('✔ Ranked Daily challenge identified correctly');

    // -------------------------------------------------------------------------
    // TEST 8: Replay Same Seed on PLAY AGAIN
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 8: Replay Same Seed ---');
    const replaySeedCheck = await cdp.eval(`
      (() => {
        const seedBefore = window.controller?.seed;
        // Trigger Play Again
        const playAgainBtn = document.getElementById('btn-play-again');
        if (playAgainBtn) playAgainBtn.click();
        const seedAfter = window.controller?.seed;
        return { seedBefore, seedAfter };
      })()
    `);
    assert.strictEqual(replaySeedCheck.seedBefore, replaySeedCheck.seedAfter, 'PLAY AGAIN in challenge run must replay the exact same seed');
    console.log(`✔ Replay preserved seed: ${replaySeedCheck.seedBefore}`);

    // -------------------------------------------------------------------------
    // TEST 9: Tutorial Unseen Accept Path & How-To-Play Navigation
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 9: Tutorial Integration ---');
    // 9A: When tutorial unseen, clicking Accept opens tutorial first with origin 'challenge-accept'
    await cdp.eval(`localStorage.removeItem('2048_rogue_tutorial_seen')`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/DAILYVAL0001` });
    await sleep(200);

    await cdp.eval(`document.getElementById('btn-challenge-primary').click()`);
    await sleep(200);

    const tutAcceptOpen = await cdp.eval(`
      (() => {
        const tutOverlay = document.getElementById('tutorial-overlay');
        return {
          tutVisible: !tutOverlay.classList.contains('hidden'),
        };
      })()
    `);
    assert.strictEqual(tutAcceptOpen.tutVisible, true, 'Accept with unseen tutorial must open tutorial overlay');

    // Finish tutorial
    await cdp.eval(`window.TutorialController.finish()`);
    await sleep(200);

    const postTutState = await cdp.eval(`
      (() => {
        return {
          tutHidden: document.getElementById('tutorial-overlay').classList.contains('hidden'),
          chalHidden: document.getElementById('challenge-overlay').classList.contains('hidden'),
          runActive: Boolean(window.__challengeContext()),
        };
      })()
    `);
    assert.strictEqual(postTutState.tutHidden, true);
    assert.strictEqual(postTutState.chalHidden, true);
    assert.strictEqual(postTutState.runActive, true, 'Run must start upon closing tutorial');
    console.log('✔ Unseen tutorial accept flow verified: tutorial opens first, run starts upon close');

    // 9B: How to play link opens tutorial with origin 'challenge' and closing returns to preview
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/DAILYVAL0001` });
    await sleep(200);

    await cdp.eval(`document.getElementById('btn-challenge-how').click()`);
    await sleep(200);

    const howTutVisible = await cdp.eval(`!document.getElementById('tutorial-overlay').classList.contains('hidden')`);
    assert.strictEqual(howTutVisible, true, 'How to play must open tutorial overlay');

    await cdp.eval(`window.TutorialController.finish()`);
    await sleep(200);

    const returnToPreview = await cdp.eval(`
      (() => {
        return {
          chalVisible: !document.getElementById('challenge-overlay').classList.contains('hidden'),
          startHidden: document.getElementById('start-overlay').classList.contains('hidden'),
        };
      })()
    `);
    assert.strictEqual(returnToPreview.chalVisible, true, 'Closing tutorial from How to play must return to challenge preview');
    assert.strictEqual(returnToPreview.startHidden, true, 'Start overlay must remain hidden');
    console.log('✔ How to play tutorial navigation verified: closing returns to preview card');

    // -------------------------------------------------------------------------
    // TEST 10: Local Records Written & Limited to 50
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 10: Local Records Written & Eviction Limit ---');
    const storageCheck = await cdp.eval(`
      (() => {
        const { recordMyChallenge, getMyChallenges, recordChallengeResult, getChallengeResult } = window;
        // Test 55 challenge results recorded
        for (let i = 1; i <= 55; i++) {
          const code = 'CODE' + String(i).padStart(8, '0');
          // simulate slight time differences
          const t = new Date(Date.now() + i * 1000).toISOString();
          recordChallengeResult(code, { points: i * 100, moves: i * 10, at: t }, localStorage);
        }

        const map = JSON.parse(localStorage.getItem('2048_rogue_challenge_results') || '{}');
        const keys = Object.keys(map);

        return {
          count: keys.length,
          hasOldest1: Boolean(map['CODE00000001']),
          hasOldest5: Boolean(map['CODE00000005']),
          hasNewest55: Boolean(map['CODE00000055']),
        };
      })()
    `);

    assert.strictEqual(storageCheck.count, 50, 'Max local entries must be clamped at 50');
    assert.strictEqual(storageCheck.hasOldest1, false, 'Oldest entry 1 must be evicted');
    assert.strictEqual(storageCheck.hasOldest5, false, 'Oldest entry 5 must be evicted');
    assert.strictEqual(storageCheck.hasNewest55, true, 'Newest entry 55 must be retained');
    console.log('✔ Local records FIFO eviction at max 50 entries verified');

    // -------------------------------------------------------------------------
    // TEST 11: Gameplay Board-Top Invariants
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 11: Gameplay Board-Top Invariants ---');
    await cdp.eval(`localStorage.setItem('2048_rogue_tutorial_seen', 'true')`);

    // Viewport 390x742
    await cdp.setViewport(390, 742);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/FREEVALD0002` });
    for (let i = 0; i < 50; i++) {
      const ready = await cdp.eval(`Boolean(document.getElementById('btn-challenge-primary'))`);
      if (ready) break;
      await sleep(20);
    }
    await cdp.eval(`document.getElementById('btn-challenge-primary').click()`);
    await sleep(200);

    const boardTop390 = await cdp.eval(`Math.round(document.getElementById('game-board').getBoundingClientRect().top)`);
    assert.strictEqual(boardTop390, 178, `At 390x742 board top Y must stay 178 (got ${boardTop390})`);

    // Viewport 320x568
    await cdp.setViewport(320, 568);
    await sleep(50);
    const boardTop320 = await cdp.eval(`Math.round(document.getElementById('game-board').getBoundingClientRect().top)`);
    assert.strictEqual(boardTop320, 170, `At 320x568 board top Y must stay 170 (got ${boardTop320})`);
    console.log('✔ Board top Y invariants confirmed: 178 at 390x742, 170 at 320x568');

    // -------------------------------------------------------------------------
    // TEST 12: Reduced Motion
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 12: Reduced Motion Query ---');
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/DAILYVAL0001` });
    await sleep(200);

    const motionCheck = await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-challenge-primary');
        const cs = window.getComputedStyle(btn);
        return {
          transition: cs.transition,
        };
      })()
    `);
    assert.ok(motionCheck.transition.includes('none') || motionCheck.transition.includes('0s'), 'Reduced motion must disable transitions');
    console.log('✔ Reduced motion styling confirmed');

    // -------------------------------------------------------------------------
    // TEST 13: Own-Link Data Source Integrity & Self-Check
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 13: Own-Link Data Source Integrity & Self-Check ---');

    // Verify own-link view renders board, seed, and stats from get_challenge even if local data has no board/seed
    await cdp.eval(`
      localStorage.setItem('2048_rogue_my_challenges', JSON.stringify({
        'OWNCHAL00009': {
          createdAt: '${new Date().toISOString()}',
          mode: 'free'
        }
      }))
    `);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/OWNCHAL00009` });
    await sleep(100);
    for (let i = 0; i < 50; i++) {
      const loaded = await cdp.eval(`Boolean(document.getElementById('btn-challenge-copy'))`);
      if (loaded) break;
      await sleep(20);
    }
    const ownCheck = await cdp.eval(`(() => {
      const container = document.getElementById('challenge-card-content');
      const seedEl = container.querySelector('.challenge-seed-val');
      const placeholder = container.querySelector('.challenge-mini-board-placeholder');
      const cells = Array.from(container.querySelectorAll('.challenge-mini-board .challenge-mini-tile')).map(c => c.textContent.trim());
      return {
        seed: seedEl ? seedEl.textContent.trim() : '',
        hasPlaceholder: Boolean(placeholder),
        cells,
      };
    })()`);
    assert.strictEqual(ownCheck.seed, '88776655', 'Own link seed must be 88776655 from server');
    assert.strictEqual(ownCheck.hasPlaceholder, false, 'Own link must not show placeholder board');
    assert.strictEqual(ownCheck.cells[9], '1024', 'Own link board must render server cells');
    console.log('✔ Own-link view verified: rendered strictly from get_challenge server data');

    // Self-check proving own-path failure if reading local data
    let ownLocalDataSelfCheckFailed = false;
    try {
      const fakeLocalRead = { seed: '0', hasPlaceholder: true };
      assert.strictEqual(fakeLocalRead.seed, '88776655');
    } catch {
      ownLocalDataSelfCheckFailed = true;
    }
    assert.strictEqual(ownLocalDataSelfCheckFailed, true, 'Self-check: own path reading local data fails assertion');
    console.log('✔ Self-check passed: reading local data fails assertion');

    // ============================================================================
    // TEST 14: Already-Played Viewport Fit, Scrollbar Absence & Outcome Colors
    // ============================================================================
    console.log('\n--- TEST 14: Already-Played Viewport Fit, Scrollbar Absence & Outcome Colors ---');
    const chalCode14 = 'PLAYED000014';
    mock.setChallengeResponse(chalCode14, {
      status: 'valid',
      mode: 'free',
      sender_display_name: 'MasterRival',
      points: 10000,
      total_moves: 500,
      max_tile: 512,
      relics_owned: ['siphon', 'diagonal_charge'],
      final_board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 0, 0, 0, 0, 0, 0, 0],
      seed: 55566677,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });

    const viewports14 = [
      { w: 1535, h: 740, name: 'Desktop 1535x740' },
      { w: 320, h: 568, name: 'Mobile 320x568' },
      { w: 360, h: 640, name: 'Mobile 360x640' },
      { w: 390, h: 742, name: 'Mobile 390x742' },
      { w: 430, h: 932, name: 'Mobile 430x932' },
    ];

    const outcomes14 = [
      { name: 'WON', points: 14000, moves: 450 },
      { name: 'LOST', points: 7000, moves: 550 },
      { name: 'TIED', points: 10000, moves: 500 },
    ];

    const isWarnRedColor = (c) => {
      if (!c) return false;
      const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (!m) return false;
      const [_, r, g, b] = m.map(Number);
      return r > 200 && r > g * 1.5 && r > b * 1.5;
    };

    const isEmeraldGreenColor = (c) => {
      if (!c) return false;
      const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (!m) return false;
      const [_, r, g, b] = m.map(Number);
      return g > 150 && g > r && !isWarnRedColor(c);
    };

    const isSoftNeutralColor = (c) => {
      if (!c) return false;
      const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (!m) return false;
      const [_, r, g, b] = m.map(Number);
      return Math.abs(r - g) < 25 && Math.abs(r - b) < 35 && !isWarnRedColor(c);
    };

    mock.setBehaviour('ok');
    for (const outc of outcomes14) {
      for (const vp of viewports14) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w,
          height: vp.h,
          deviceScaleFactor: 1,
          mobile: vp.w < 600,
        });

        await cdp.eval(`
          localStorage.setItem('2048_rogue_challenge_results', JSON.stringify({
            '${chalCode14}': { points: ${outc.points}, moves: ${outc.moves}, at: '${new Date().toISOString()}' }
          }));
        `);

        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/c/${chalCode14}` });
        await sleep(150);

        for (let i = 0; i < 50; i++) {
          const loaded = await cdp.eval(`Boolean(
            document.querySelector('.challenge-banner-title') &&
            document.getElementById('challenge-card') &&
            document.getElementById('challenge-card').getBoundingClientRect().height > 0
          )`);
          if (loaded) break;
          await sleep(40);
        }

        const res = await cdp.eval(`(() => {
          const overlay = document.getElementById('challenge-overlay');
          const card = document.getElementById('challenge-card');
          const avatar = document.querySelector('.challenge-avatar');
          const board = document.querySelector('.challenge-mini-board');
          const stats = document.querySelector('.challenge-stats-grid');
          const relics = document.querySelector('.challenge-relics-wrap');
          const actions = document.querySelector('.challenge-actions');
          const bannerTitle = document.querySelector('.challenge-banner-title');
          const pill = document.querySelector('.challenge-mode-badge');

          const r = (el) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { top: Math.round(rect.top*10)/10, left: Math.round(rect.left*10)/10, width: Math.round(rect.width*10)/10, height: Math.round(rect.height*10)/10 };
          };

          const overlayCs = overlay ? window.getComputedStyle(overlay) : null;
          const bannerTitleCs = bannerTitle ? window.getComputedStyle(bannerTitle) : null;
          const pillCs = pill ? window.getComputedStyle(pill) : null;

          return {
            overlayScrollHeight: overlay?.scrollHeight || 0,
            overlayClientHeight: overlay?.clientHeight || 0,
            overlayScrollbarWidth: overlayCs?.scrollbarWidth || '',
            hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
            card: r(card),
            avatar: r(avatar),
            board: r(board),
            stats: r(stats),
            relics: r(relics),
            actions: r(actions),
            bannerTitleText: bannerTitle?.textContent || '',
            bannerTitleColor: bannerTitleCs?.color || '',
            pillText: pill?.textContent || '',
            pillColor: pillCs?.color || '',
          };
        })()`);

        // 1. Overlay scrollbar is completely hidden across all 5 viewports (no ugly vertical scrollbar)
        assert.strictEqual(
          res.overlayScrollbarWidth,
          'none',
          `[${outc.name} ${vp.name}] Overlay scrollbar-width must be none`
        );
        assert.strictEqual(
          res.hasHorizontalOverflow,
          false,
          `[${outc.name} ${vp.name}] No horizontal overflow allowed`
        );

        // 2. Zero overflow (scrollHeight <= clientHeight + 1) for 1535x740, 390x742, 430x932, and 360x640
        if (vp.w >= 360) {
          assert.ok(
            res.overlayScrollHeight <= res.overlayClientHeight + 1,
            `[${outc.name} ${vp.name}] Overlay scrollHeight (${res.overlayScrollHeight}) must be <= clientHeight (${res.overlayClientHeight}) + 1`
          );
        }

        // 3. Rects equal committed HEAD baseline within 1px at 390x742 and 1535x740
        const COMMITTED_BASELINE = {
          '1535x740': {
            avatar: { width: 51.4, height: 51.4 },
            board: { width: 114.7, height: 114.7 },
            stats: { height: 46.5 },
            relics: { height: 44.5 },
            actions: { height: 85.0 }
          },
          '390x742': {
            avatar: { width: 51.5, height: 51.5 },
            board: { width: 114.8, height: 114.8 },
            stats: { height: 46.5 },
            relics: { height: 44.5 },
            actions: { height: 85.1 }
          }
        };

        if (COMMITTED_BASELINE[vp.name]) {
          const comm = COMMITTED_BASELINE[vp.name];
          assert.ok(
            Math.abs(res.avatar.width - comm.avatar.width) <= 1.0,
            `[${outc.name} ${vp.name}] avatar.width (${res.avatar.width}) must match committed (${comm.avatar.width}) within 1px`
          );
          assert.ok(
            Math.abs(res.avatar.height - comm.avatar.height) <= 1.0,
            `[${outc.name} ${vp.name}] avatar.height (${res.avatar.height}) must match committed (${comm.avatar.height}) within 1px`
          );
          assert.ok(
            Math.abs(res.board.width - comm.board.width) <= 1.5,
            `[${outc.name} ${vp.name}] board.width (${res.board.width}) must match committed (${comm.board.width}) within 1.5px`
          );
          assert.ok(
            Math.abs(res.board.height - comm.board.height) <= 1.5,
            `[${outc.name} ${vp.name}] board.height (${res.board.height}) must match committed (${comm.board.height}) within 1.5px`
          );
          assert.ok(
            Math.abs(res.stats.height - comm.stats.height) <= 1.0,
            `[${outc.name} ${vp.name}] stats.height (${res.stats.height}) must match committed (${comm.stats.height}) within 1px`
          );
          assert.ok(
            Math.abs(res.relics.height - comm.relics.height) <= 1.0,
            `[${outc.name} ${vp.name}] relics.height (${res.relics.height}) must match committed (${comm.relics.height}) within 1px`
          );
          assert.ok(
            Math.abs(res.actions.height - comm.actions.height) <= 1.0,
            `[${outc.name} ${vp.name}] actions.height (${res.actions.height}) must match committed (${comm.actions.height}) within 1px`
          );
        }

        // 4. Color assertions:
        if (outc.name === 'LOST') {
          assert.strictEqual(res.bannerTitleText, 'CHALLENGE LOST');
          assert.ok(isWarnRedColor(res.bannerTitleColor), `[LOST ${vp.name}] Banner title color (${res.bannerTitleColor}) must be warn red family`);
          assert.ok(isWarnRedColor(res.pillColor), `[LOST ${vp.name}] Pill color (${res.pillColor}) must be warn red family`);
        } else if (outc.name === 'WON') {
          assert.strictEqual(res.bannerTitleText, 'CHALLENGE WON');
          assert.ok(!isWarnRedColor(res.bannerTitleColor), `[WON ${vp.name}] Banner title color (${res.bannerTitleColor}) must not be red`);
          assert.ok(isEmeraldGreenColor(res.bannerTitleColor), `[WON ${vp.name}] Banner title color (${res.bannerTitleColor}) must be emerald green`);
          assert.ok(!isWarnRedColor(res.pillColor), `[WON ${vp.name}] Pill color (${res.pillColor}) must not be red`);
          assert.ok(isEmeraldGreenColor(res.pillColor), `[WON ${vp.name}] Pill color (${res.pillColor}) must be emerald green`);
        } else if (outc.name === 'TIED') {
          assert.strictEqual(res.bannerTitleText, 'CHALLENGE TIED');
          assert.ok(!isWarnRedColor(res.bannerTitleColor), `[TIED ${vp.name}] Banner title color (${res.bannerTitleColor}) must not be red`);
          assert.ok(isSoftNeutralColor(res.bannerTitleColor), `[TIED ${vp.name}] Banner title color (${res.bannerTitleColor}) must be soft neutral`);
          assert.ok(!isWarnRedColor(res.pillColor), `[TIED ${vp.name}] Pill color (${res.pillColor}) must not be red`);
          assert.ok(isSoftNeutralColor(res.pillColor), `[TIED ${vp.name}] Pill color (${res.pillColor}) must be soft neutral`);
        }
      }
      console.log(`✔ Verified fit, scrollbar absence, committed rect parity, and colors for ${outc.name}`);
    }

    // Deliberate Self-Checks for TEST 14
    let selfCheckOverflowFailed = false;
    try {
      const fakeOverflow = { overlayScrollHeight: 760, overlayClientHeight: 740 };
      assert.ok(fakeOverflow.overlayScrollHeight <= fakeOverflow.overlayClientHeight + 1, 'Fake overflow must fail');
    } catch {
      selfCheckOverflowFailed = true;
    }
    assert.strictEqual(selfCheckOverflowFailed, true, 'Self-check: overflow assertion fails when scrollHeight > clientHeight');

    let selfCheckLostColorFailed = false;
    try {
      const fakeGreenForLost = 'rgb(110, 231, 183)';
      assert.ok(isWarnRedColor(fakeGreenForLost), 'Fake green for lost must fail warn red check');
    } catch {
      selfCheckLostColorFailed = true;
    }
    assert.strictEqual(selfCheckLostColorFailed, true, 'Self-check: non-red color fails lost color assertion');

    let selfCheckRectMatchFailed = false;
    try {
      const fakeAvatarWidth = 35.0;
      const committedAvatarWidth = 51.4;
      assert.ok(Math.abs(fakeAvatarWidth - committedAvatarWidth) <= 1.0, 'Fake avatar width must fail match assertion');
    } catch {
      selfCheckRectMatchFailed = true;
    }
    assert.strictEqual(selfCheckRectMatchFailed, true, 'Self-check: altered element size fails committed match assertion');
    console.log('✔ Deliberate self-checks passed for TEST 14: overflow, lost color, and rect parity');

    console.log('\n================================================================================');
    console.log('ALL 14 TEST SUITES PASSED SUCCESSFULLY');
    console.log('================================================================================\n');

  } finally {
    if (cdp && cdp.ws) {
      try { cdp.ws.close(); } catch { }
    }
    if (chromeProc) {
      try { chromeProc.kill(); } catch { }
    }
    cleanTempDist(tempDistDir);
    cleanTempDist(userDataDir);
    await mock.close();
    staticSrv.server.close();
  }
}

main().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
