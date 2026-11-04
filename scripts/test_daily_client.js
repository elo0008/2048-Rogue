/**
 * scripts/test_daily_client.js
 *
 * Full headless Chrome end-to-end and unit test suite for Rogue 2048 Daily Leaderboard Client.
 * Covers all 14 scenarios (T1 - T14) specified in C6.
 *
 * Usage:
 *   node scripts/test_daily_client.js
 *   node scripts/test_daily_client.js --self-check-fail
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findChrome } from './find_chrome.js';
import { createMockLeaderboardServer } from './mock_leaderboard.js';
import { SecurityDatabaseEngine } from './lib/inmemory_db.js';
import { dailySeed, utcDateString } from '../game/daily.js';
import { dailySeed as verifyDailySeed } from '../verify/profile.js';
import {
  submitRun,
  loadQueue,
  saveQueue,
  enqueueSubmission,
  flushQueue,
  STORAGE_KEY_QUEUE,
  STORAGE_KEY_BEST,
  SUBMIT_BACKOFFS_MS,
  VERSION_BACKOFF_MS,
} from '../game/leaderboard.js';
import { build, validateLeaderboardConfig } from './build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const isSelfCheckFail = process.argv.includes('--self-check-fail');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
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
    } catch {}
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
    this.consoleErrors = [];

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
        this.events.push(data);
        if (data.method === 'Runtime.consoleAPICalled') {
          if (data.params.type === 'error') {
            this.consoleErrors.push(data.params.args.map(a => a.value || a.description).join(' '));
          }
        }
        if (data.method === 'Runtime.exceptionThrown') {
          this.consoleErrors.push(data.params.exceptionDetails?.text || 'Uncaught Exception');
        }
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

  async close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function main() {
  console.log('================================================================================');
  console.log('ROGUE 2048 DAILY LEADERBOARD CLIENT TEST SUITE (T1 - T14)');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  let passedCount = 0;
  let totalCount = 14;

  // ---------------------------------------------------------------------------
  // T1. SEED PARITY
  // ---------------------------------------------------------------------------
  console.log('[T1] Testing Daily Seed Parity against verify/profile.js...');
  const testDates = [
    '2026-01-01', '2026-02-28', '2026-03-01', '2026-11-03', '2026-12-31',
    '2028-02-29', '2030-05-15', '2035-12-30', '2035-12-31',
  ];

  if (isSelfCheckFail) {
    console.log('Deliberately triggering T1 failure under --self-check-fail...');
    assert.strictEqual(dailySeed('2026-11-03'), 999999999, 'Self-check failure triggered as expected');
  }

  let t1Matches = 0;
  for (const d of testDates) {
    const s1 = dailySeed(d);
    const s2 = verifyDailySeed(d);
    assert.strictEqual(s1, s2, `Seed mismatch on ${d}: client=${s1}, verify=${s2}`);
    assert.strictEqual(typeof s1, 'number', 'Seed must be a number');
    assert.strictEqual(s1 >= 0 && s1 <= 4294967295, true, 'Seed must be unsigned 32-bit int');
    t1Matches++;
  }
  assert.strictEqual(t1Matches, testDates.length, 'Vacuity guard: all dates verified');
  console.log(`✔ T1 PASSED: ${t1Matches}/${testDates.length} dates matched verify/profile.js exactly.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T2. BUILD WITHOUT CONFIG: Daily button absent, 0 requests
  // ---------------------------------------------------------------------------
  console.log('[T2] Testing Build without Leaderboard Config...');
  // Build dist with empty env (no leaderboard)
  delete process.env.LEADERBOARD_URL;
  delete process.env.LEADERBOARD_ANON_KEY;
  build('prod');

  const t2Server = await startStaticServer(distDir);
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome binary not found');

  const cdpPort = await getFreePort();
  const chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-sandbox',
    'about:blank',
  ]);

  const wsUrl = await getWsUrl(cdpPort);
  const cdp = new CdpSession(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const t2NetworkRequests = [];
  cdp.ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.method === 'Network.requestWillBeSent') {
      t2NetworkRequests.push(d.params.request.url);
    }
  });

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${t2Server.port}/` });
  await sleep(400);

  const t2DailyHidden = await cdp.eval(`
    (() => {
      const b = document.getElementById('btn-play-daily');
      const d = document.getElementById('daily-disclosure-container');
      return {
        dailyHidden: !b || b.classList.contains('hidden'),
        disclosureHidden: !d || d.classList.contains('hidden'),
        windowLb: window.__LB,
      };
    })()
  `);

  assert.strictEqual(t2DailyHidden.dailyHidden, true, 'Daily button must be hidden when window.__LB is null');
  assert.strictEqual(t2DailyHidden.disclosureHidden, true, 'Disclosure container must be hidden when window.__LB is null');
  assert.strictEqual(t2DailyHidden.windowLb, null, 'window.__LB must be null');

  // Verify external requests: ZERO external requests
  const t2ExternalRequests = t2NetworkRequests.filter(u => !u.startsWith(`http://127.0.0.1:${t2Server.port}/`) && !u.startsWith(`http://localhost:${t2Server.port}/`) && !u.startsWith('data:'));
  assert.strictEqual(t2ExternalRequests.length, 0, `Expected 0 external requests, got: ${t2ExternalRequests.join(', ')}`);
  assert.strictEqual(t2NetworkRequests.length > 0, true, 'Vacuity guard: static requests were recorded');

  t2Server.server.close();
  console.log(`✔ T2 PASSED: Daily button hidden, window.__LB is null, 0 external requests.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // SETUP MOCK LEADERBOARD & BUILD WITH CONFIG FOR T3 - T14
  // ---------------------------------------------------------------------------
  const mockDb = new SecurityDatabaseEngine();
  const mock = createMockLeaderboardServer(mockDb);
  const mockPort = await mock.listen(0);

  const mockUrl = `http://localhost:${mockPort}`;
  const mockAnonKey = 'sb_publishable_test_key_for_client_suite';

  process.env.LEADERBOARD_URL = mockUrl;
  process.env.LEADERBOARD_ANON_KEY = mockAnonKey;
  build('prod');

  const mainServer = await startStaticServer(distDir);
  const baseUrl = `http://127.0.0.1:${mainServer.port}/`;

  // ---------------------------------------------------------------------------
  // T3. FREE RUN: ZERO requests to mock
  // ---------------------------------------------------------------------------
  console.log('[T3] Testing Free Run (must produce 0 requests to mock server)...');
  mock.clearRequests();

  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(400);

  // Click Start Free Run
  await cdp.eval(`document.getElementById('btn-play-start')?.click()`);
  await sleep(100);

  // Make 5 moves
  const km = {
    'U': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'D': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'L': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'R': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  };

  // Make at least 5 valid moves
  for (let i = 0; i < 20; i++) {
    const curMoves = await cdp.eval(`window.controller ? window.controller.state.moveCount : 0`);
    if (curMoves >= 5) break;
    const validMoves = await cdp.eval(`window.controller ? window.controller.getValidMoves() : []`);
    const dir = validMoves[0] || 'D';
    const k = km[dir] || km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(40);
  }

  // End run via pause menu
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) {
        endBtn.click();
        await new Promise(r => setTimeout(r, 60));
        endBtn.click();
      }
    })()
  `);
  await sleep(300);

  const t3Moves = await cdp.eval(`window.controller ? window.controller.state.moveCount : 0`);
  assert.strictEqual(t3Moves >= 5, true, `Vacuity guard: moves made >= 5 (got ${t3Moves})`);
  assert.strictEqual(mock.getRequests().length, 0, 'Free run must send 0 requests to mock');

  console.log(`✔ T3 PASSED: Free run (${t3Moves} moves) sent 0 requests to mock leaderboard.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T4. DAILY RUN: 70+ moves, draft, ability -> 1 POST -> ACCEPTED -> rank #1 of 1
  // ---------------------------------------------------------------------------
  console.log('[T4] Testing Daily Run (70+ moves, draft, ability, 1 POST, real verifyRun ACCEPTED)...');
  mock.clearRequests();
  mock.getDb().dailyRuns = [];

  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(400);

  // Click PLAY DAILY
  await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
  await sleep(150);

  const t4DailyActive = await cdp.eval(`Boolean(window.controller)`);
  assert.strictEqual(t4DailyActive, true, 'Controller must be initialized');

  let t4Moves = 0;
  let draftHandled = false;
  let abilityUsed = false;

  for (let step = 0; step < 160; step++) {
    const s = await cdp.eval(`
      (() => {
        if (!window.controller) return { over: true };
        const c = window.controller;
        const draftOpen = !document.getElementById('draft-overlay')?.classList.contains('hidden');
        const abilityBtn = document.querySelector('.ability-btn:not(.is-empty)');
        return {
          over: c.isGameOver(),
          moveCount: c.state.moveCount,
          score: c.state.score,
          draftOpen,
          hasAbilityCharge: Boolean(abilityBtn),
          valid: c.getValidMoves(),
        };
      })()
    `);

    if (s.over) break;

    // Handle draft modal
    if (s.draftOpen) {
      await cdp.eval(`
        (() => {
          const cards = document.querySelectorAll('#draft-offers-row .draft-card');
          if (cards && cards.length > 0) cards[0].click();
        })()
      `);
      draftHandled = true;
      await sleep(100);
      continue;
    }

    // Use ability if charged and not yet used
    if (!abilityUsed && s.hasAbilityCharge && s.moveCount > 20) {
      await cdp.eval(`
        (() => {
          const btn = document.querySelector('.ability-btn:not(.is-empty)');
          if (btn) btn.click();
        })()
      `);
      abilityUsed = true;
      await sleep(100);
      // Cancel targeting if opened
      await cdp.eval(`document.getElementById('btn-cancel-targeting')?.click()`);
      await sleep(50);
    }

    if (s.moveCount >= 72 && draftHandled && abilityUsed) {
      t4Moves = s.moveCount;
      break;
    }

    let dir = 'D';
    if (s.valid && s.valid.length > 0) {
      if (s.valid.includes('D')) dir = 'D';
      else if (s.valid.includes('L')) dir = 'L';
      else if (s.valid.includes('R')) dir = 'R';
      else dir = s.valid[0];
    }

    const k = km[dir] || km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  // End run via pause menu
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) {
        endBtn.click();
        await new Promise(r => setTimeout(r, 60));
        endBtn.click();
      }
    })()
  `);

  // Wait for submission request and UI update
  await sleep(1000);

  const t4RunLog = await cdp.eval(`window.controller ? window.controller.getRunLog() : null`);

  const t4Submits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
  assert.strictEqual(t4Submits.length, 1, `Expected exactly 1 submit POST, got ${t4Submits.length}`);

  assert.strictEqual(mock.getDb().dailyRuns.length, 1, 'Mock DB must have exactly 1 run record');
  const storedRun = mock.getDb().dailyRuns[0];

  const clientStats = await cdp.eval(`
    (() => {
      const c = window.controller;
      const statusEl = document.getElementById('end-leaderboard-status');
      return {
        points: c.state.points,
        moves: c.state.moveCount,
        statusText: statusEl ? statusEl.textContent.trim() : '',
      };
    })()
  `);

  assert.strictEqual(storedRun.points, clientStats.points, 'Stored points must match client points');
  assert.strictEqual(storedRun.totalMoves, clientStats.moves, 'Stored moves must match client moves');
  assert.strictEqual(clientStats.statusText, 'Submitted · Daily rank #1 of 1', `Expected 'Submitted · Daily rank #1 of 1', got '${clientStats.statusText}'`);
  assert.strictEqual(t4Moves >= 70, true, `Vacuity guard: moves >= 70 (got ${t4Moves})`);
  assert.strictEqual(draftHandled, true, 'Vacuity guard: draft pick occurred');

  console.log(`✔ T4 PASSED: Daily run (${t4Moves} moves) submitted successfully: '${clientStats.statusText}'\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T5. MOCK OFFLINE -> Saved · will retry -> reload -> online -> flushed 1 row
  // ---------------------------------------------------------------------------
  console.log('[T5] Testing Mock Offline, Queue Persistence & Online Flush...');
  mock.setBehaviour('offline');
  mock.clearRequests();

  // Clear daily best and queue in storage to simulate a fresh run
  await cdp.eval(`
    localStorage.removeItem('${STORAGE_KEY_BEST}');
    localStorage.removeItem('${STORAGE_KEY_QUEUE}');
  `);

  // Start daily run and end it while offline
  await cdp.eval(`document.getElementById('btn-play-daily-again')?.click()`);
  await sleep(100);

  // 2 moves
  for (let i = 0; i < 2; i++) {
    const k = km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  // End run
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
    })()
  `);
  await sleep(400);

  const t5Status = await cdp.eval(`document.getElementById('end-leaderboard-status')?.textContent.trim()`);
  assert.strictEqual(t5Status, 'Saved · will retry', `Expected 'Saved · will retry', got '${t5Status}'`);

  const t5RunLog = await cdp.eval(`window.controller ? window.controller.getRunLog() : null`);
  const t5QueueBefore = await cdp.eval(`JSON.parse(localStorage.getItem('${STORAGE_KEY_QUEUE}') || '[]')`);
  assert.strictEqual(t5QueueBefore.length, 1, 'Queue must contain 1 entry');

  // Reload page
  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(300);

  const t5QueueAfterReload = await cdp.eval(`JSON.parse(localStorage.getItem('${STORAGE_KEY_QUEUE}') || '[]')`);
  assert.strictEqual(t5QueueAfterReload.length, 1, 'Queue must persist across reload');

  // Restore mock to ok and trigger online event
  mock.setBehaviour('ok');
  mock.getDb().dailyRuns = []; // reset db to verify exactly 1 row is added

  await cdp.eval(`
    window.dispatchEvent(new Event('online'));
  `);
  await sleep(500);

  const t5QueueAfterOnline = await cdp.eval(`JSON.parse(localStorage.getItem('${STORAGE_KEY_QUEUE}') || '[]')`);
  assert.strictEqual(t5QueueAfterOnline.length, 0, 'Queue must be empty after successful online flush');
  assert.strictEqual(mock.getDb().dailyRuns.length, 1, 'Mock DB must have exactly 1 flushed row');

  console.log(`✔ T5 PASSED: Offline queued run persisted across reload and flushed exactly 1 row on online event.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T6. RESUBMIT SAME RUN: ALREADY_SUBMITTED -> still 1 row
  // ---------------------------------------------------------------------------
  console.log('[T6] Testing Idempotent Resubmission (ALREADY_SUBMITTED)...');
  const t6DeviceId = await cdp.eval(`localStorage.getItem('2048_rogue_player_id')`);

  const t6Res = await submitRun({
    url: mockUrl,
    anonKey: mockAnonKey,
    deviceId: t6DeviceId,
    runLog: t5RunLog,
  });

  assert.strictEqual(t6Res.status, 'ACCEPTED', 'submitRun classifies ALREADY_SUBMITTED as ACCEPTED');
  assert.strictEqual(t6Res.body?.status, 'ALREADY_SUBMITTED', 'Server returned ALREADY_SUBMITTED');
  assert.strictEqual(mock.getDb().dailyRuns.length, 1, 'DB must still contain exactly 1 row (no duplicate)');

  console.log(`✔ T6 PASSED: Resubmitting identical run returned ALREADY_SUBMITTED without duplicating rows.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T7. SEND-ONLY-IF-BETTER: Worse run causes NO POST, better causes 1 POST
  // ---------------------------------------------------------------------------
  console.log('[T7] Testing Send-Only-If-Better (worse = 0 POSTs, better = 1 POST)...');
  // Record current best
  await cdp.eval(`
    localStorage.setItem('${STORAGE_KEY_BEST}', JSON.stringify({
      day: '${utcDateString(new Date())}',
      points: 5000,
      moves: 100
    }));
  `);

  mock.clearRequests();

  // Start daily run and end it with a score lower than 5000 (e.g. 8 points)
  await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
  await sleep(100);

  for (let i = 0; i < 2; i++) {
    const k = km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  // End run
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
    })()
  `);
  await sleep(300);

  const t7WorseSubmits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
  assert.strictEqual(t7WorseSubmits.length, 0, 'Worse daily run must cause ZERO submit POSTs');

  // Now set daily best lower (e.g. 2 points) so the next run is better
  await cdp.eval(`
    localStorage.setItem('${STORAGE_KEY_BEST}', JSON.stringify({
      day: '${utcDateString(new Date())}',
      points: 2,
      moves: 1
    }));
  `);

  mock.clearRequests();
  await cdp.eval(`document.getElementById('btn-play-daily-again')?.click()`);
  await sleep(100);

  for (let i = 0; i < 5; i++) {
    const k = km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
    })()
  `);
  await sleep(400);

  const t7BetterSubmits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
  assert.strictEqual(t7BetterSubmits.length, 1, 'Better daily run must cause exactly ONE submit POST');

  console.log(`✔ T7 PASSED: Worse run caused 0 POSTs, better run caused exactly 1 POST.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T8. 429 & 500: Stays queued, backoff unit-tested, zero console errors
  // ---------------------------------------------------------------------------
  console.log('[T8] Testing 429 & 500 Backoffs, Queue Retention & Clean Console...');
  // 1. Unit test backoff with injected clock and fetch
  const testStorage = new Map();
  const mockStorage = {
    getItem: (k) => testStorage.get(k) || null,
    setItem: (k, v) => testStorage.set(k, String(v)),
    removeItem: (k) => testStorage.delete(k),
  };

  let simulatedNow = 1000000;
  const mockClock = () => simulatedNow;

  // Enqueue test item
  const dummyLog = {
    seed: 12345,
    rulesVersion: 'rules',
    replayVersion: 'replay',
    points: 100,
    totalMoves: 10,
    events: ['s:D', 's:D'],
  };

  enqueueSubmission({ runId: 'run_429', day: '2026-11-03', runLog: dummyLog }, mockStorage, true, mockClock);

  // Simulate 429 with Retry-After: 45
  const fetch429 = async () => new Response(JSON.stringify({ error: 'RATE_LIMIT' }), {
    status: 429,
    headers: { 'retry-after': '45', 'content-type': 'application/json' },
  });

  await flushQueue({
    url: 'http://localhost',
    anonKey: 'anon',
    deviceId: 'anon_12345678',
    storage: mockStorage,
    fetchFn: fetch429,
    clockFn: mockClock,
  });

  let q = loadQueue(mockStorage, mockClock);
  assert.strictEqual(q.length, 1, 'Item must stay in queue on 429');
  assert.strictEqual(q[0].nextAt, simulatedNow + 45000, '429 with Retry-After: 45 must set nextAt to now + 45s');
  assert.strictEqual(q[0].attempts, 1, 'Attempts incremented to 1');

  // Advance clock and simulate 500
  simulatedNow += 50000;
  const fetch500 = async () => new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });

  await flushQueue({
    url: 'http://localhost',
    anonKey: 'anon',
    deviceId: 'anon_12345678',
    storage: mockStorage,
    fetchFn: fetch500,
    clockFn: mockClock,
  });

  q = loadQueue(mockStorage, mockClock);
  assert.strictEqual(q.length, 1, 'Item must stay in queue on 500');
  assert.strictEqual(q[0].nextAt, simulatedNow + SUBMIT_BACKOFFS_MS[1], '500 on 2nd attempt uses second backoff');
  assert.strictEqual(q[0].attempts, 2, 'Attempts incremented to 2');

  // Browser check: verify zero console errors recorded during run
  assert.strictEqual(cdp.consoleErrors.length, 0, `Expected 0 console errors, got: ${cdp.consoleErrors.join('; ')}`);

  console.log(`✔ T8 PASSED: 429 and 500 correctly back off without item loss, console is completely clean.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T9. 422 DEFINITIVE vs 422 VERSION MISMATCH
  // ---------------------------------------------------------------------------
  console.log('[T9] Testing 422 Definitive Rejection vs 422 Version Mismatch...');
  // 1. Definitive 422
  testStorage.clear();
  enqueueSubmission({ runId: 'run_422_def', day: '2026-11-03', runLog: dummyLog }, mockStorage, true, mockClock);
  const fetch422Def = async () => new Response(JSON.stringify({ status: 'REJECT', reason: 'Illegal move' }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });

  let t9DefStatus = null;
  await flushQueue({
    url: 'http://localhost',
    anonKey: 'anon',
    deviceId: 'anon_12345678',
    storage: mockStorage,
    fetchFn: fetch422Def,
    clockFn: mockClock,
    onItemProcessed: ({ status }) => { t9DefStatus = status; },
  });

  assert.strictEqual(t9DefStatus, 'REJECTED', 'Definitive 422 must be classified as REJECTED');
  assert.strictEqual(loadQueue(mockStorage, mockClock).length, 0, 'Definitive 422 must be removed from queue');

  // 2. 422 with VERSION in reason
  enqueueSubmission({ runId: 'run_422_ver', day: '2026-11-03', runLog: dummyLog }, mockStorage, true, mockClock);
  const fetch422Ver = async () => new Response(JSON.stringify({ status: 'REJECT', reason: 'Rules version mismatch' }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });

  let t9VerStatus = null;
  await flushQueue({
    url: 'http://localhost',
    anonKey: 'anon',
    deviceId: 'anon_12345678',
    storage: mockStorage,
    fetchFn: fetch422Ver,
    clockFn: mockClock,
    onItemProcessed: ({ status }) => { t9VerStatus = status; },
  });

  assert.strictEqual(t9VerStatus, 'VERSION_MISMATCH', '422 version must be classified as VERSION_MISMATCH');
  const qVer = loadQueue(mockStorage, mockClock);
  assert.strictEqual(qVer.length, 1, 'Version mismatch must stay in queue');
  assert.strictEqual(qVer[0].nextAt, simulatedNow + VERSION_BACKOFF_MS, 'Version mismatch must use 1h backoff');

  console.log(`✔ T9 PASSED: Definitive 422 removed without retry; 422 version retained with 1h backoff.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T10. DEV BUILD WITH ?lab=1: Daily action sends nothing
  // ---------------------------------------------------------------------------
  console.log('[T10] Testing Dev Build with ?lab=1 (Daily sends nothing)...');
  mock.clearRequests();

  await cdp.send('Page.navigate', { url: `${baseUrl}?lab=1` });
  await sleep(400);

  const t10DailyHidden = await cdp.eval(`
    (() => {
      const b = document.getElementById('btn-play-daily');
      return !b || b.classList.contains('hidden');
    })()
  `);
  assert.strictEqual(t10DailyHidden, true, 'Daily button must be hidden when ?lab=1');

  // Attempt daily action programmatically
  await cdp.eval(`
    (async () => {
      if (typeof window.startNewGame === 'function') {
        window.startNewGame(12345, true);
        if (window.controller) window.controller.endRun();
        if (typeof window.handleGameOver === 'function') window.handleGameOver();
      }
    })()
  `);
  await sleep(300);

  const t10Submits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
  assert.strictEqual(t10Submits.length, 0, '?lab=1 run must NEVER submit to leaderboard');

  console.log(`✔ T10 PASSED: ?lab=1 hid Daily button and sent 0 submissions.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T11. URL WITH ?stones=0.1: No Daily button
  // ---------------------------------------------------------------------------
  console.log('[T11] Testing URL with ?stones=0.1 (No Daily button)...');
  await cdp.send('Page.navigate', { url: `${baseUrl}?stones=0.1` });
  await sleep(300);

  const t11Hidden = await cdp.eval(`
    (() => {
      const b = document.getElementById('btn-play-daily');
      const d = document.getElementById('daily-disclosure-container');
      return {
        dailyHidden: !b || b.classList.contains('hidden'),
        disclosureHidden: !d || d.classList.contains('hidden'),
      };
    })()
  `);
  assert.strictEqual(t11Hidden.dailyHidden, true, 'Daily button must be hidden with ?stones=0.1');
  assert.strictEqual(t11Hidden.disclosureHidden, true, 'Disclosure must be hidden with ?stones=0.1');

  console.log(`✔ T11 PASSED: ?stones=0.1 properly suppressed Daily button and disclosure.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T12. localStorage.setItem THROWING: Game works, console clean
  // ---------------------------------------------------------------------------
  console.log('[T12] Testing localStorage.setItem Throwing (Robustness)...');
  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(300);

  // Override setItem to throw
  await cdp.eval(`
    window.localStorage.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  `);

  cdp.consoleErrors.length = 0;

  // Start daily run and play
  await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
  await sleep(100);

  for (let i = 0; i < 4; i++) {
    const k = km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  // End run
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
    })()
  `);
  await sleep(300);

  const t12GameOver = await cdp.eval(`Boolean(window.controller && window.controller.isGameOver())`);
  assert.strictEqual(t12GameOver, true, 'Game must complete normally despite throwing storage');
  assert.strictEqual(cdp.consoleErrors.length, 0, `Expected clean console, got: ${cdp.consoleErrors.join('; ')}`);

  console.log(`✔ T12 PASSED: Storage quota throw handled gracefully without crashing or logging errors.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T13. LAYOUT AT 320, 360, 390: Fits, board top Y 178 (170 at 320)
  // ---------------------------------------------------------------------------
  console.log('[T13] Testing Layout & Invariants at Viewports 320, 360, 390...');
  const viewports = [
    { width: 320, height: 568, expectedTop: 170, file: 'layout_320.png' },
    { width: 360, height: 640, expectedTop: 178, file: 'layout_360.png' },
    { width: 390, height: 742, expectedTop: 178, file: 'layout_390.png' },
  ];

  for (const vp of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: true,
    });

    await cdp.send('Page.navigate', { url: baseUrl });
    await sleep(300);

    // Measure start overlay fit and no overlaps
    const layoutMetrics = await cdp.eval(`
      (() => {
        const card = document.querySelector('#start-overlay .start-card');
        const cardRect = card ? card.getBoundingClientRect() : null;
        const dailyBtn = document.getElementById('btn-play-daily');
        const startBtn = document.getElementById('btn-play-start');
        const disc = document.getElementById('daily-disclosure-container');

        const rDaily = dailyBtn ? dailyBtn.getBoundingClientRect() : null;
        const rStart = startBtn ? startBtn.getBoundingClientRect() : null;
        const rDisc = disc ? disc.getBoundingClientRect() : null;

        function overlaps(r1, r2) {
          if (!r1 || !r2) return false;
          return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
        }

        return {
          cardWidth: cardRect ? cardRect.width : 0,
          windowWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          overlapDailyDisc: overlaps(rDaily, rDisc),
          overlapDiscStart: overlaps(rDisc, rStart),
        };
      })()
    `);

    assert.strictEqual(layoutMetrics.scrollWidth <= layoutMetrics.windowWidth, true, `No horizontal overflow at ${vp.width}`);
    assert.strictEqual(layoutMetrics.overlapDailyDisc, false, `No overlap between Daily and Disclosure at ${vp.width}`);
    assert.strictEqual(layoutMetrics.overlapDiscStart, false, `No overlap between Disclosure and Start at ${vp.width}`);

    // Capture screenshot of start screen
    const scrData = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, vp.file), Buffer.from(scrData.data, 'base64'));

    // Dismiss start overlay and measure board top Y
    await cdp.eval(`document.getElementById('btn-play-start')?.click()`);
    await sleep(150);

    const boardTop = await cdp.eval(`
      (() => {
        const b = document.getElementById('game-board');
        return b ? Math.round(b.getBoundingClientRect().top) : null;
      })()
    `);

    assert.strictEqual(boardTop, vp.expectedTop, `Board top at ${vp.width} must be ${vp.expectedTop}, got ${boardTop}`);
    console.log(`  - Viewport ${vp.width}x${vp.height}: Card width=${layoutMetrics.cardWidth}px, Board Top Y=${boardTop}px (expected ${vp.expectedTop}px), Screenshot=${vp.file}`);
  }

  console.log(`✔ T13 PASSED: Layout verified at 320/360/390 with exact board top Y invariants.\n`);
  passedCount++;

  // ---------------------------------------------------------------------------
  // T14. TAMPERED BODY: Server logic rejects 422 -> UI shows 'Not accepted'
  // ---------------------------------------------------------------------------
  console.log('[T14] Testing Tampered Body Rejection (422 -> "Not accepted")...');
  mock.clearRequests();
  mock.setBehaviour('ok');
  const prevDbRuns = mock.getDb().dailyRuns.length;

  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(300);

  // Clear daily best so this run is eligible for submission
  await cdp.eval(`
    localStorage.removeItem('${STORAGE_KEY_BEST}');
    localStorage.removeItem('${STORAGE_KEY_QUEUE}');
  `);

  // Hook window.fetch in the browser to tamper with events[0]
  await cdp.eval(`
    (() => {
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        if (init && typeof init.body === 'string' && input.includes('submit-run')) {
          try {
            const data = JSON.parse(init.body);
            if (data.runLog && Array.isArray(data.runLog.events) && data.runLog.events.length > 0) {
              data.runLog.events[0] = 's:INVALID_DIRECTION_TAMPER';
              init.body = JSON.stringify(data);
            }
          } catch {}
        }
        return origFetch.apply(this, arguments);
      };
    })()
  `);

  // Start daily run
  await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
  await sleep(100);

  for (let i = 0; i < 4; i++) {
    const k = km['D'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await sleep(20);
  }

  // End run
  await cdp.eval(`
    (async () => {
      document.getElementById('btn-pause-menu')?.click();
      await new Promise(r => setTimeout(r, 60));
      const endBtn = document.getElementById('btn-pause-end-run');
      if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
    })()
  `);
  await sleep(500);

  const t14Status = await cdp.eval(`document.getElementById('end-leaderboard-status')?.textContent.trim()`);
  assert.strictEqual(t14Status, 'Not accepted', `Expected 'Not accepted', got '${t14Status}'`);

  const t14Reqs = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
  assert.strictEqual(t14Reqs.length, 1, 'Tampered request was sent to server');
  assert.strictEqual(mock.getDb().dailyRuns.length, prevDbRuns, 'Tampered run was NOT accepted into DB');

  console.log(`✔ T14 PASSED: Tampered payload caught by server verification and displayed as 'Not accepted'.\n`);
  passedCount++;

  // Cleanup
  await cdp.close();
  chromeProcess.kill();
  mainServer.server.close();
  await mock.close();

  console.log('================================================================================');
  console.log(`ALL TESTS PASSED: ${passedCount}/${totalCount} scenarios successful.`);
  console.log('================================================================================');
  process.exitCode = 0;
}

main().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:');
  console.error(err.message || err);
  process.exit(1);
});
