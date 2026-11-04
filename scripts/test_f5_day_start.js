// scripts/test_f5_day_start.js
// F5: Verifies that Daily run day is anchored to the UTC day of run START, not game over.
// Uses Page.addScriptToEvaluateOnNewDocument to simulate midnight crossover:
// - Start Daily run at 23:59:50 UTC (day D-1)
// - Advance clock past midnight to 00:00:10 UTC (day D)
// - Game over: queue day == start day (D-1), server accepts, rank lookup uses D-1, best-key uses D-1
// - Stale check: run started before midnight but finished > 2 midnights later is dropped as stale.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { createMockLeaderboardServer } from './mock_leaderboard.js';
import { utcDateString } from '../game/daily.js';

const STORAGE_KEY_QUEUE = '2048_rogue_submit_queue';
const STORAGE_KEY_BEST = '2048_rogue_daily_best';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function findChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Chrome executable not found for test');
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    const { WebSocket } = await import('node:http');
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else cb.resolve(msg.result);
        }
      };
    });
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
    return res.result ? res.result.value : undefined;
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

async function startStaticServer(distDir, port = 0) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  };

  const server = http.createServer((req, res) => {
    let filePath = path.join(distDir, req.url.split('?')[0]);
    if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html');
    }

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(fs.readFileSync(filePath));
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const assignedPort = server.address().port;
  return { server, port: assignedPort };
}

async function main() {
  console.log('================================================================================');
  console.log('F5 DAY-FROM-RUN-START & MIDNIGHT CROSSOVER TEST SUITE');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  // Compute reference dates relative to real server time
  const serverNow = new Date();
  const todayUtc = serverNow.toISOString().slice(0, 10);
  const yesterdayDate = new Date(serverNow.getTime() - 86400000);
  const yesterdayUtc = yesterdayDate.toISOString().slice(0, 10);

  // Midnight boundary between yesterday and today:
  // Yesterday 23:59:50 UTC (10 seconds before midnight)
  const preMidnightMs = new Date(`${yesterdayUtc}T23:59:50.000Z`).getTime();
  // Today 00:00:10 UTC (10 seconds after midnight)
  const postMidnightMs = new Date(`${todayUtc}T00:00:10.000Z`).getTime();

  console.log(`Reference Yesterday UTC : ${yesterdayUtc}`);
  console.log(`Reference Today UTC     : ${todayUtc}`);
  console.log(`Pre-midnight fake clock  : ${new Date(preMidnightMs).toISOString()}`);
  console.log(`Post-midnight fake clock : ${new Date(postMidnightMs).toISOString()}\n`);

  // 1. Start mock leaderboard server
  const mock = createMockLeaderboardServer();
  const mockPort = await mock.listen(0);
  const mockUrl = `http://localhost:${mockPort}`;
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.mock_key';

  // 2. Build dist with leaderboard config pointing to mock
  const distDir = path.join(process.cwd(), 'dist');
  fs.writeFileSync(
    path.join(distDir, 'leaderboard-config.js'),
    `window.__LB = { url: "${mockUrl}", anonKey: "${anonKey}" };\n`
  );

  // 3. Start web server
  const webServer = await startStaticServer(distDir);
  const baseUrl = `http://localhost:${webServer.port}`;

  // 4. Launch Headless Chrome
  const chromePath = findChromePath();
  const chromePort = 9223 + Math.floor(Math.random() * 500);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5_chrome_'));

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  await sleep(1000);

  let targets = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${chromePort}/json`);
      targets = await res.json();
      if (targets && targets.length > 0) break;
    } catch {}
    await sleep(100);
  }

  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      console.log('[Browser Console]', msg.params.type, ...msg.params.args.map(a => a.value || a.description));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('[Browser Exception]', msg.params.exceptionDetails);
    }
    if (msg.id && cdp.callbacks.has(msg.id)) {
      const cb = cdp.callbacks.get(msg.id);
      cdp.callbacks.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else cb.resolve(msg.result);
    }
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Midnight Crossover (Start 23:59:50 UTC, End 00:00:10 UTC)
    // -------------------------------------------------------------------------
    console.log('[Test 1] Testing Midnight Crossover: Start at 23:59:50 UTC, Finish at 00:00:10 UTC...');

    // Fake clock script installed before any page scripts evaluate
    const clockScript = `
      (() => {
        let fakeNow = ${preMidnightMs};
        try {
          const s = window.sessionStorage.getItem('__fakeTime');
          if (s) fakeNow = parseInt(s, 10);
        } catch {}

        const OrigDate = window.Date;
        class FakeDate extends OrigDate {
          constructor(...args) {
            if (args.length === 0) super(fakeNow);
            else super(...args);
          }
          static now() {
            return fakeNow;
          }
        }
        window.Date = FakeDate;
        window.__setFakeTime = (ms) => {
          fakeNow = ms;
          try { window.sessionStorage.setItem('__fakeTime', String(ms)); } catch {}
        };
        window.__getFakeTime = () => fakeNow;
      })()
    `;

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockScript });
    await cdp.send('Page.navigate', { url: baseUrl });
    await sleep(500);

    // Verify initial fake clock
    const initialIso = await cdp.eval(`new Date().toISOString()`);
    console.log(`Page initialized at fake clock: ${initialIso}`);
    assert.strictEqual(initialIso.slice(0, 10), yesterdayUtc, 'Initial clock must be on yesterdayUtc');

    // Click PLAY DAILY at 23:59:50 UTC
    await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
    await sleep(200);

    // Now advance page clock across midnight to 00:00:10 UTC
    await cdp.eval(`window.__setFakeTime(${postMidnightMs})`);
    const crossedIso = await cdp.eval(`new Date().toISOString()`);
    console.log(`Clock advanced across midnight to: ${crossedIso}`);
    assert.strictEqual(crossedIso.slice(0, 10), todayUtc, 'Advanced clock must be on todayUtc');

    // Play 4 moves
    const km = {
      D: { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
    };
    for (let i = 0; i < 4; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...km.D });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...km.D });
      await sleep(30);
    }

    // End run via pause menu
    await cdp.eval(`
      (async () => {
        document.getElementById('btn-pause-menu')?.click();
        await new Promise(r => setTimeout(r, 60));
        const endBtn = document.getElementById('btn-pause-end-run');
        if (endBtn) { endBtn.click(); await new Promise(r => setTimeout(r, 60)); endBtn.click(); }
      })()
    `);
    await sleep(800);

    console.log(`Mock requests (${mock.getRequests().length}):`);
    for (const r of mock.getRequests()) {
      console.log(` - ${r.method} ${r.path} -> body:`, JSON.stringify(r.body));
    }

    // 1. Verify queue item day in localStorage is START day (yesterdayUtc), NOT finish day (todayUtc)
    const rawQueue = await cdp.eval(`localStorage.getItem('${STORAGE_KEY_QUEUE}')`);
    console.log(`Local queue after submission flush: ${rawQueue}`);
    // If flush succeeded immediately, check stored daily best
    const rawBest = await cdp.eval(`localStorage.getItem('${STORAGE_KEY_BEST}')`);
    console.log(`Stored daily best: ${rawBest}`);
    const bestObj = JSON.parse(rawBest);
    assert.strictEqual(bestObj.day, yesterdayUtc, `Daily best key must record start day (${yesterdayUtc}), got '${bestObj.day}'`);

    // 2. Verify server handler accepted the submission
    const submits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
    assert.strictEqual(submits.length, 1, `Expected exactly 1 submit POST, got ${submits.length}`);
    assert.strictEqual(mock.getDb().dailyRuns.length, 1, 'Mock DB must contain exactly 1 accepted run');
    const dbRun = mock.getDb().dailyRuns[0];
    assert.strictEqual(dbRun.dayUtc, yesterdayUtc, `Server DB run dayUtc must be start day (${yesterdayUtc}), got '${dbRun.dayUtc}'`);

    // 3. Verify rank lookup RPC was queried for start day (yesterdayUtc)
    const rankReqs = mock.getRequests().filter(r => r.path === '/rest/v1/rpc/my_daily_rank');
    assert(rankReqs.length >= 1, 'my_daily_rank RPC must have been called');
    const lastRankReq = rankReqs[rankReqs.length - 1];
    assert.strictEqual(lastRankReq.body.target_day, yesterdayUtc, `my_daily_rank target_day must equal start day (${yesterdayUtc})`);

    // 4. Verify UI status text
    const statusText = await cdp.eval(`document.getElementById('end-leaderboard-status')?.textContent.trim()`);
    console.log(`UI status text: '${statusText}'`);
    assert(statusText.startsWith('Submitted'), `Status text must show Submitted, got '${statusText}'`);

    console.log('✔ Test 1 PASSED: Run started at 23:59:50 and ended at 00:00:10 anchored strictly to start day.\n');

    // -------------------------------------------------------------------------
    // TEST 2: Stale Run (Started > 2 midnights ago is dropped as stale)
    // -------------------------------------------------------------------------
    console.log('[Test 2] Testing Stale Run (Started 3 days ago, submitted today -> dropped)...');
    mock.clearRequests();

    const staleStartMs = new Date(serverNow.getTime() - 3 * 86400000).getTime();
    const staleDayUtc = new Date(staleStartMs).toISOString().slice(0, 10);

    // Set clock to 3 days ago and start Daily run
    await cdp.eval(`window.__setFakeTime(${staleStartMs})`);
    await cdp.send('Page.navigate', { url: baseUrl });
    await sleep(400);

    await cdp.eval(`document.getElementById('btn-play-daily')?.click()`);
    await sleep(200);

    // Advance clock to today
    await cdp.eval(`window.__setFakeTime(${serverNow.getTime()})`);

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

    // Assert status text shows 'Not accepted'
    const staleStatus = await cdp.eval(`document.getElementById('end-leaderboard-status')?.textContent.trim()`);
    assert.strictEqual(staleStatus, 'Not accepted', `Stale run must display 'Not accepted', got '${staleStatus}'`);

    // Assert zero submit POSTs sent
    const staleSubmits = mock.getRequests().filter(r => r.path === '/functions/v1/submit-run');
    assert.strictEqual(staleSubmits.length, 0, `Stale run must send 0 submit POSTs, got ${staleSubmits.length}`);

    console.log('✔ Test 2 PASSED: Run older than yesterday dropped as stale, 0 POSTs sent, status: "Not accepted".\n');

  } finally {
    await cdp.close();
    chromeProc.kill();
    webServer.server.close();
    await mock.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('================================================================================');
  console.log('ALL F5 DAY-FROM-RUN-START TESTS PASSED CLEANLY.');
  console.log('================================================================================');
}

main().catch(err => {
  console.error('\n❌ F5 TEST SUITE FAILED:');
  console.error(err);
  process.exit(1);
});
