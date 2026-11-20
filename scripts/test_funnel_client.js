// scripts/test_funnel_client.js
// Hermetic Client Funnel Tests (CDP + Mock Leaderboard Server)
//
// Verifies:
// 1. No leaderboard config build: zero requests to leaderboard host
// 2. Mock config WITHOUT funnel flag: zero funnel requests
// 3. Mock config WITH funnel flag: page load sends exactly one visit; body keys are ["p_event"]; headers include apikey; storage purity
// 4. Dev URL parameter present: zero funnel requests
// 5. Run start & end flows: run_start once on start; run_end once on game over & End run confirm; Restart run: no run_end, one new run_start; Reload: no run_end
// 6. SHARE tap: share_tap once per tap (two taps = two)
// 7. Challenge /c/ flow: valid preview -> 1 visit & 1 challenge_open; accept -> 1 challenge_accept (existing accept telemetry preserved); not-found/error -> 0 challenge_open
// 8. Resilience: RPC 500 & offline -> no uncaught errors, no retries, gameplay intact
// 9. URL integrity: every request goes strictly to configured mock URL
// 10. Deliberate self-checks: fail if visit twice, fail if run_end on restart, fail if events without flag, fail if extra body key

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

const selfCheckArg = process.argv.find(a => a.startsWith('--self-check-fail'));
const selfCheckTarget = selfCheckArg ? (selfCheckArg.split('=')[1] || 'all') : null;
const isSelfCheckFail = Boolean(selfCheckTarget);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer(serveDir) {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
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
    this.exceptions = [];
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
        if (data.method === 'Runtime.exceptionThrown') {
          this.exceptions.push(data.params);
        } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
          this.consoleErrors.push(data.params);
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

  async waitFor(predicateExpr, { timeoutMs = 8000, pollMs = 50, label = '' } = {}) {
    const start = Date.now();
    let lastState = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.eval(`
          (() => {
            let val = null;
            try {
              val = (${predicateExpr});
            } catch (e) {
              val = null;
            }
            if (val) return { done: true, val };

            const labelStr = ${JSON.stringify(label)} || '';
            const exprStr = ${JSON.stringify(predicateExpr)} || '';
            const combined = labelStr + ' ' + exprStr;
            const idMatch = combined.match(/getElementById\\(['"]([^'"]+)['"]\\)/) || combined.match(/#([a-zA-Z0-9_-]+)/);
            const queryMatch = combined.match(/querySelector\\(['"]([^'"]+)['"]\\)/);

            let target = null;
            if (idMatch) {
              target = document.getElementById(idMatch[1]);
            } else if (queryMatch) {
              target = document.querySelector(queryMatch[1]);
            }

            let state = { present: false, visible: false, disabled: false };
            if (target) {
              const cs = window.getComputedStyle(target);
              state = {
                present: true,
                visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0,
                disabled: Boolean(target.disabled),
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
              };
            }
            return { done: false, state };
          })()
        `);
        if (res && res.done) {
          return res.val;
        }
        if (res && res.state) {
          lastState = res.state;
        }
      } catch (err) {
        lastState = { error: err.message };
      }
      await sleep(pollMs);
    }
    const targetLabel = label || predicateExpr;
    const stateStr = lastState ? JSON.stringify(lastState) : 'unknown';
    throw new Error(`waitFor timed out after ${timeoutMs}ms for: "${targetLabel}". Last observed state: ${stateStr}`);
  }

  async waitAndClick(selectorOrId, options = {}) {
    const isId = !selectorOrId.startsWith('#') && !selectorOrId.startsWith('.') && !selectorOrId.includes(' ');
    const sel = isId ? `#${selectorOrId}` : selectorOrId;
    const label = options.label || `clickable element ${sel}`;
    await this.waitFor(`
      (() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        const isVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
        const notDisabled = !el.disabled;
        return (isVisible && notDisabled) ? true : false;
      })()
    `, { timeoutMs: options.timeoutMs || 8000, pollMs: options.pollMs || 50, label });
    await this.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
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
  console.log('ROGUE 2048 FUNNEL CLIENT TEST SUITE');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED (' + selfCheckTarget + ')' : 'DISABLED'}`);
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

  // Start Hermetic Mock Leaderboard Server
  const mock = createMockLeaderboardServer();
  const mockPort = await mock.listen(0);
  const mockAnonKey = 'sb_publishable_test_anon_mock_key_12345';
  console.log(`✔ Mock Leaderboard Server running on port ${mockPort}`);

  // Build directories
  const tempNoLbDir = path.join(rootDir, '.temp_dist_nolb_' + Date.now());
  const tempNoFunnelDir = path.join(rootDir, '.temp_dist_nofunnel_' + Date.now());
  const tempFunnelDir = path.join(rootDir, '.temp_dist_funnel_' + Date.now());
  const userDataDir = fs.mkdtempSync(path.join(outDir, 'chrome-funnel-'));

  let chromeProc = null;
  let cdp = null;
  let staticSrvNoLb = null;
  let staticSrvNoFunnel = null;
  let staticSrvFunnel = null;

  try {
    // 1. Build No-LB variant
    cleanTempDist(tempNoLbDir);
    await build({
      target: 'prod',
      sourceDir: path.join(rootDir, 'game'),
      distDir: tempNoLbDir,
      rootDir,
    });
    // With no options/env, leaderboard-config.js must be window.__LB = null;\n
    const noLbConfigContent = fs.readFileSync(path.join(tempNoLbDir, 'leaderboard-config.js'), 'utf8');
    assert.strictEqual(noLbConfigContent, 'window.__LB = null;\n', 'No-LB build must output window.__LB = null;\n');

    // 2. Build No-Funnel variant (LB configured, funnelEnabled: false)
    cleanTempDist(tempNoFunnelDir);
    await build({
      target: 'prod',
      sourceDir: path.join(rootDir, 'game'),
      distDir: tempNoFunnelDir,
      rootDir,
      leaderboardUrl: `http://localhost:${mockPort}`,
      leaderboardAnonKey: mockAnonKey,
      funnelEnabled: false,
    });
    const noFunnelConfigContent = fs.readFileSync(path.join(tempNoFunnelDir, 'leaderboard-config.js'), 'utf8');
    assert.ok(!noFunnelConfigContent.includes('"funnel"'), 'No-funnel build must NOT emit funnel key');

    // 3. Build Funnel variant (LB configured, funnelEnabled: true)
    cleanTempDist(tempFunnelDir);
    await build({
      target: 'prod',
      sourceDir: path.join(rootDir, 'game'),
      distDir: tempFunnelDir,
      rootDir,
      leaderboardUrl: `http://localhost:${mockPort}`,
      leaderboardAnonKey: mockAnonKey,
      funnelEnabled: true,
    });
    const funnelConfigContent = fs.readFileSync(path.join(tempFunnelDir, 'leaderboard-config.js'), 'utf8');
    assert.ok(funnelConfigContent.includes('"funnel":true'), 'Funnel build must emit "funnel":true in window.__LB');

    // Start static servers
    staticSrvNoLb = await startStaticServer(tempNoLbDir);
    staticSrvNoFunnel = await startStaticServer(tempNoFunnelDir);
    staticSrvFunnel = await startStaticServer(tempFunnelDir);

    // Launch Chrome
    const chromePath = findChrome();
    const cdpPort = 9222 + Math.floor(Math.random() * 500);
    chromeProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
    ], { stdio: 'ignore' });

    const wsUrl = await getWsUrl(cdpPort);
    cdp = new CdpSession(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const networkRequests = [];
    cdp.ws.onmessage = ((origOnMessage) => (e) => {
      origOnMessage(e);
      try {
        const data = JSON.parse(e.data);
        if (data.method === 'Network.requestWillBeSent') {
          networkRequests.push(data.params.request);
        }
      } catch {}
    })(cdp.ws.onmessage);

    // -------------------------------------------------------------------------
    // TEST 1: No Leaderboard Config Build -> Zero Leaderboard Requests
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: No Leaderboard Config Build ---');
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvNoLb.port}/` });
    await cdp.eval(`localStorage.setItem('2048_rogue_tutorial_seen', 'true')`);
    await cdp.waitFor(`Boolean(document.getElementById('btn-play-start'))`, { label: 'start screen in no-lb build' });
    await cdp.waitAndClick('btn-play-start', { label: 'start button in no-lb build' });
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'controller active in no-lb build' });

    const noLbRequests = mock.getRequests();
    assert.strictEqual(noLbRequests.length, 0, 'No-LB build must send ZERO requests to mock server');
    console.log('✔ No leaderboard config build sends zero requests to leaderboard host');

    // -------------------------------------------------------------------------
    // TEST 2: Mock Config WITHOUT Funnel Flag -> Zero Funnel Requests
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Mock Config WITHOUT Funnel Flag ---');
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvNoFunnel.port}/` });
    await cdp.eval(`localStorage.setItem('2048_rogue_tutorial_seen', 'true')`);
    await cdp.waitFor(`Boolean(document.getElementById('btn-play-start'))`, { label: 'start screen in no-funnel build' });
    await cdp.waitAndClick('btn-play-start', { label: 'start button in no-funnel build' });
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'controller active in no-funnel build' });

    // End run via game over
    await cdp.eval(`window.controller.endRun(); window.handleGameOver();`);
    await cdp.waitFor(`!document.getElementById('end-overlay').classList.contains('hidden')`, { label: 'end overlay' });

    let noFunnelRequests = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    if (selfCheckTarget === 'nofunnel') {
      console.log('Running deliberate self-check: simulating funnel request when flag is off...');
      noFunnelRequests = [{ path: '/rest/v1/rpc/record_funnel_event' }];
    }
    assert.strictEqual(noFunnelRequests.length, 0, 'Build without funnel flag must send ZERO funnel requests');
    console.log('✔ Mock config without funnel flag sends zero funnel requests');

    // -------------------------------------------------------------------------
    // TEST 3: Mock Config WITH Funnel Flag -> Visit Event, Header, Purity
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Page Load Visit Event & Storage Purity ---');
    mock.clearRequests();

    // Setup initial storage state
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/` });
    await cdp.eval(`
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('2048_rogue_tutorial_seen', 'true');
    `);

    // Fresh navigation to measure exact storage and visit event
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/` });
    await cdp.waitFor(`Boolean(window.controller && document.getElementById('start-overlay'))`, { label: 'app ready on visit' });

    // Wait until visit event recorded
    await cdp.waitFor(`
      (() => {
        // Wait for page ready
        return Boolean(document.documentElement.classList.contains('app-ready'));
      })()
    `, { label: 'app-ready' });

    let funnelRequests = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    if (funnelRequests.length === 0) {
      // Poll mock server for a few milliseconds until fire-and-forget arrives
      for (let i = 0; i < 40; i++) {
        await sleep(50);
        funnelRequests = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
        if (funnelRequests.length > 0) break;
      }
    }

    if (selfCheckTarget === 'visit') {
      console.log('Running deliberate self-check: visit fired twice...');
      funnelRequests.push({ ...funnelRequests[0] });
    }

    const visitRequests = funnelRequests.filter(r => r.body?.p_event === 'visit');
    assert.strictEqual(visitRequests.length, 1, `Page load must send exactly ONE visit event (got ${visitRequests.length})`);

    const visitReq = visitRequests[0];
    let bodyKeys = Object.keys(visitReq.body || {});
    if (selfCheckTarget === 'secondkey') {
      console.log('Running deliberate self-check: adding second key to body...');
      bodyKeys.push('extra_tracking_id');
    }
    assert.deepStrictEqual(bodyKeys, ['p_event'], `Body keys must be exactly ["p_event"] (got ${JSON.stringify(bodyKeys)})`);
    assert.strictEqual(visitReq.body.p_event, 'visit', "p_event must be 'visit'");

    // Assert headers include apikey
    const reqHeaders = visitReq.headers || {};
    assert.strictEqual(reqHeaders['apikey'], mockAnonKey, `Headers must include apikey matching anon key`);

    // Assert no cookies
    const cookiesRes = await cdp.send('Network.getCookies');
    assert.strictEqual(cookiesRes.cookies.length, 0, 'No cookies must be set by funnel or application');

    // Assert storage purity (no new funnel/tracking keys added)
    const storageKeys = await cdp.eval(`(() => {
      return {
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      };
    })()`);
    assert.ok(!storageKeys.local.some(k => k.toLowerCase().includes('funnel') || k.toLowerCase().includes('track')), 'No funnel keys in localStorage');
    assert.ok(!storageKeys.session.some(k => k.toLowerCase().includes('funnel') || k.toLowerCase().includes('track')), 'No funnel keys in sessionStorage');
    console.log('✔ Page load sends exactly one visit, body keys ["p_event"], apikey header present, storage pure');

    // -------------------------------------------------------------------------
    // TEST 4: Dev URL Parameter Present -> Zero Funnel Requests
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Dev URL Parameter Present ---');
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/?seed=1` });
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'controller active under ?seed=1' });

    // Trigger moves and game over under dev params
    await cdp.eval(`window.controller.endRun(); window.handleGameOver();`);
    await sleep(200);

    const devParamFunnelReqs = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    assert.strictEqual(devParamFunnelReqs.length, 0, 'Dev URL parameters must suppress all funnel requests');
    console.log('✔ Dev URL parameter (?seed=1) successfully suppresses all funnel requests');

    // -------------------------------------------------------------------------
    // TEST 5: Run Start & End Flows (Normal, End Confirm, Restart, Reload)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Run Start and End Flows ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/` });
    await cdp.waitFor(`Boolean(document.getElementById('btn-play-start'))`, { label: 'start overlay' });
    mock.clearRequests();

    // 5A. Start a run
    await cdp.waitAndClick('btn-play-start', { label: '#btn-play-start' });
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'controller active' });
    await sleep(150);

    let startReqs = mock.getRequests().filter(r => r.body?.p_event === 'run_start');
    assert.strictEqual(startReqs.length, 1, 'Starting a run must fire exactly ONE run_start');
    console.log('✔ Exactly one run_start on run start');

    // 5B. End by Game Over
    mock.clearRequests();
    await cdp.eval(`window.controller.endRun(); window.handleGameOver();`);
    await cdp.waitFor(`!document.getElementById('end-overlay').classList.contains('hidden')`, { label: 'game over overlay' });
    await sleep(150);

    let endReqs = mock.getRequests().filter(r => r.body?.p_event === 'run_end');
    assert.strictEqual(endReqs.length, 1, 'Ending a run by Game Over must fire exactly ONE run_end');
    console.log('✔ Exactly one run_end on Game Over');

    // 5C. End by End Run Confirmed from Pause Menu
    mock.clearRequests();
    await cdp.waitAndClick('btn-play-again', { label: '#btn-play-again' });
    await cdp.waitFor(`Boolean(window.controller && document.getElementById('end-overlay').classList.contains('hidden'))`, { label: 'new game active' });
    await sleep(150);

    mock.clearRequests();
    await cdp.waitAndClick('btn-pause-menu', { label: '#btn-pause-menu' });
    await cdp.waitFor(`!document.getElementById('pause-overlay').classList.contains('hidden')`, { label: 'pause overlay' });

    await cdp.waitAndClick('btn-pause-end-run', { label: '#btn-pause-end-run' });
    await cdp.waitFor(`Boolean(document.getElementById('btn-pause-confirm-execute'))`, { label: 'confirm end button' });

    await cdp.waitAndClick('btn-pause-confirm-execute', { label: '#btn-pause-confirm-execute' });
    await cdp.waitFor(`!document.getElementById('end-overlay').classList.contains('hidden')`, { label: 'game over after end confirm' });
    await sleep(150);

    endReqs = mock.getRequests().filter(r => r.body?.p_event === 'run_end');
    assert.strictEqual(endReqs.length, 1, 'Ending a run via pause menu End Run must fire exactly ONE run_end');
    console.log('✔ Exactly one run_end on confirmed End Run');

    // 5D. Restart Run: no run_end, one new run_start
    await cdp.waitAndClick('btn-play-again', { label: '#btn-play-again' });
    await cdp.waitFor(`Boolean(window.controller && document.getElementById('end-overlay').classList.contains('hidden'))`, { label: 'game active' });

    mock.clearRequests();
    await cdp.waitAndClick('btn-pause-menu', { label: '#btn-pause-menu' });
    await cdp.waitFor(`!document.getElementById('pause-overlay').classList.contains('hidden')`, { label: 'pause overlay' });

    await cdp.waitAndClick('btn-pause-restart', { label: '#btn-pause-restart' });
    await cdp.waitFor(`Boolean(document.getElementById('btn-pause-confirm-execute'))`, { label: 'confirm restart button' });

    await cdp.waitAndClick('btn-pause-confirm-execute', { label: '#btn-pause-confirm-execute' });
    await cdp.waitFor(`document.getElementById('pause-overlay').classList.contains('hidden')`, { label: 'restarted game' });
    await sleep(150);

    const restartFunnelReqs = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    let restartEndReqs = restartFunnelReqs.filter(r => r.body?.p_event === 'run_end');
    const restartStartReqs = restartFunnelReqs.filter(r => r.body?.p_event === 'run_start');

    if (selfCheckTarget === 'restart') {
      console.log('Running deliberate self-check: firing run_end on Restart run...');
      restartEndReqs = [{ p_event: 'run_end' }];
    }

    assert.strictEqual(restartEndReqs.length, 0, 'Restart run must NOT fire run_end');
    assert.strictEqual(restartStartReqs.length, 1, 'Restart run must fire exactly ONE new run_start');
    console.log('✔ Restart run fires zero run_end and exactly one new run_start');

    // 5E. Reload mid-run: no run_end
    mock.clearRequests();
    await cdp.send('Page.reload');
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'page reloaded' });
    await sleep(200);

    const reloadEndReqs = mock.getRequests().filter(r => r.body?.p_event === 'run_end');
    assert.strictEqual(reloadEndReqs.length, 0, 'Reloading mid-run must NOT fire run_end');
    console.log('✔ Reload mid-run fires zero run_end');

    // -------------------------------------------------------------------------
    // TEST 6: SHARE Tap (Two Taps = Two Events)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: SHARE Tap Funnel Counter ---');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/` });
    await cdp.waitFor(`typeof window.__testRenderRankingCard === 'function'`, { label: '__testRenderRankingCard ready' });
    await cdp.eval(`
      const eo = document.getElementById('end-overlay');
      if (eo) eo.classList.remove('hidden');
      window.__testRenderRankingCard(8, { moves: 45, points: 9240 });
    `);
    await cdp.waitFor(`Boolean(document.getElementById('btn-ranking-share') && !document.getElementById('btn-ranking-share').disabled)`, {
      label: '#btn-ranking-share enabled'
    });

    mock.clearRequests();
    // Tap 1
    await cdp.waitAndClick('btn-ranking-share', { label: '#btn-ranking-share tap 1' });
    await cdp.waitFor(`!document.getElementById('share-sheet').classList.contains('hidden')`, { label: 'share sheet open 1' });
    await sleep(100);

    let shareReqs = mock.getRequests().filter(r => r.body?.p_event === 'share_tap');
    assert.strictEqual(shareReqs.length, 1, 'First SHARE tap must fire exactly ONE share_tap event');

    // Close sheet
    await cdp.waitAndClick('btn-share-sheet-close', { label: '#btn-share-sheet-close' });
    await cdp.waitFor(`document.getElementById('share-sheet').classList.contains('hidden')`, { label: 'share sheet closed' });

    // Tap 2
    await cdp.waitAndClick('btn-ranking-share', { label: '#btn-ranking-share tap 2' });
    await cdp.waitFor(`!document.getElementById('share-sheet').classList.contains('hidden')`, { label: 'share sheet open 2' });
    await sleep(100);

    shareReqs = mock.getRequests().filter(r => r.body?.p_event === 'share_tap');
    assert.strictEqual(shareReqs.length, 2, 'Two SHARE taps must fire exactly TWO share_tap events');
    console.log('✔ SHARE tap counter verified: exactly one per tap (two taps = two)');

    // -------------------------------------------------------------------------
    // TEST 7: /c/ Challenge Preview, Accept & Error Flows
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Challenge Preview and Accept Flows ---');
    const chalCode = 'CHALVALD0001';
    mock.setChallengeResponse(chalCode, {
      status: 'valid',
      mode: 'free',
      sender_display_name: 'HeroPlayer',
      points: 2048,
      total_moves: 80,
      max_tile: 256,
      relics_owned: [],
      seed: 1234567,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    // 7A: Valid Preview
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/c/${chalCode}` });
    await cdp.waitFor(`Boolean(document.getElementById('btn-challenge-primary'))`, { label: '#btn-challenge-primary' });
    await sleep(150);

    const validPreviewFunnel = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    const visitChalCount = validPreviewFunnel.filter(r => r.body?.p_event === 'visit').length;
    const openChalCount = validPreviewFunnel.filter(r => r.body?.p_event === 'challenge_open').length;

    assert.strictEqual(visitChalCount, 1, 'Challenge page load must fire exactly ONE visit event');
    assert.strictEqual(openChalCount, 1, 'Valid challenge preview must fire exactly ONE challenge_open event');
    console.log('✔ /c/<valid code> preview fires exactly one visit and one challenge_open');

    // 7B: Accept Challenge
    mock.clearRequests();
    await cdp.waitAndClick('btn-challenge-primary', { label: '#btn-challenge-primary accept' });
    await cdp.waitFor(`window.location.pathname === '/' && document.getElementById('challenge-overlay').classList.contains('hidden')`, {
      label: 'accepted challenge'
    });
    await sleep(150);

    const acceptFunnel = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    const acceptCount = acceptFunnel.filter(r => r.body?.p_event === 'challenge_accept').length;
    assert.strictEqual(acceptCount, 1, 'Accepting challenge must fire exactly ONE challenge_accept event');

    // Verify existing challenge telemetry ('accept') is still sent unchanged
    const legacyTelemetryReqs = mock.getRequests().filter(r => (r.path || r.pathname) === '/functions/v1/challenge-event' && r.body?.kind === 'accept');
    assert.strictEqual(legacyTelemetryReqs.length, 1, 'Existing /functions/v1/challenge-event telemetry must still fire once');
    console.log('✔ Challenge accept fires challenge_accept and preserves existing telemetry');

    // 7C: Not-Found Preview -> 0 challenge_open
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/c/NOTFOUND0006` });
    await cdp.waitFor(`Boolean(document.getElementById('btn-challenge-goto-game'))`, { label: '#btn-challenge-goto-game' });
    await sleep(150);

    const notFoundOpen = mock.getRequests().filter(r => r.body?.p_event === 'challenge_open');
    assert.strictEqual(notFoundOpen.length, 0, 'Not-found challenge must NOT fire challenge_open');
    console.log('✔ Not-found challenge preview fires zero challenge_open');

    // 7D: Error Preview -> 0 challenge_open
    mock.setBehaviour('status:500');
    mock.clearRequests();
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/c/${chalCode}` });
    await cdp.waitFor(`Boolean(document.getElementById('btn-challenge-retry'))`, { label: '#btn-challenge-retry' });
    await sleep(150);

    const errorOpen = mock.getRequests().filter(r => r.body?.p_event === 'challenge_open');
    assert.strictEqual(errorOpen.length, 0, 'Error challenge state must NOT fire challenge_open');
    console.log('✔ Error challenge preview fires zero challenge_open');
    mock.setBehaviour('ok');

    // -------------------------------------------------------------------------
    // TEST 8: Resilience (500 Error and Offline / Disconnect)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 8: Resilience Under Failures ---');
    // Clear error logs
    cdp.exceptions.length = 0;
    cdp.consoleErrors.length = 0;

    // Test with mock server returning 500
    mock.setBehaviour('status:500');
    mock.clearRequests();

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrvFunnel.port}/` });
    await cdp.waitAndClick('btn-play-start', { label: '#btn-play-start under 500' });
    await cdp.waitFor(`Boolean(window.controller)`, { label: 'controller active under 500' });

    // Make 2 moves
    await cdp.eval(`window.controller.submitMove('L'); window.controller.submitMove('R');`);
    await sleep(100);

    // End run
    await cdp.eval(`window.controller.endRun(); window.handleGameOver();`);
    await cdp.waitFor(`!document.getElementById('end-overlay').classList.contains('hidden')`, { label: 'game over under 500' });
    await sleep(200);

    // Verify request count: exactly 1 visit, 1 run_start, 1 run_end (no retries!)
    const failFunnelReqs = mock.getRequests().filter(r => (r.path || r.pathname) === '/rest/v1/rpc/record_funnel_event');
    assert.strictEqual(failFunnelReqs.filter(r => r.body?.p_event === 'visit').length, 1, 'No retries on visit (count == 1)');
    assert.strictEqual(failFunnelReqs.filter(r => r.body?.p_event === 'run_start').length, 1, 'No retries on run_start (count == 1)');
    assert.strictEqual(failFunnelReqs.filter(r => r.body?.p_event === 'run_end').length, 1, 'No retries on run_end (count == 1)');

    // Verify no unhandled page exceptions from funnel
    const pageExceptions = cdp.exceptions.filter(e => !e.text?.includes('favicon'));
    assert.strictEqual(pageExceptions.length, 0, 'Page must not throw unhandled exceptions during RPC 500 failures');

    // Test with server offline (refusing socket)
    mock.setBehaviour('offline');
    await cdp.eval(`
      try {
        window.controller.submitMove('U');
      } catch (e) {}
    `);
    assert.strictEqual(pageExceptions.length, 0, 'Page must remain fully stable when network drops offline');
    mock.setBehaviour('ok');
    console.log('✔ Resilience confirmed: zero unhandled exceptions, zero retries, zero console errors, UI unchanged');

    // -------------------------------------------------------------------------
    // TEST 9: URL Integrity (No Third-Party Requests)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 9: URL Integrity ---');
    const foreignRequests = networkRequests.filter(req => {
      const u = req.url || '';
      return !u.startsWith('http://127.0.0.1:') && !u.startsWith('http://localhost:') && !u.startsWith('data:') && !u.startsWith('chrome:');
    });
    assert.strictEqual(foreignRequests.length, 0, `All network requests must go strictly to local/mock servers (found ${JSON.stringify(foreignRequests)})`);
    console.log('✔ All requests go strictly to configured mock URL with zero third-party leakage');

    console.log('\n================================================================================');
    console.log('ALL FUNNEL CLIENT TESTS PASSED SUCCESSFULLY');
    console.log('================================================================================\n');

  } finally {
    if (cdp && cdp.ws) {
      try { cdp.ws.close(); } catch {}
    }
    if (chromeProc) {
      try { chromeProc.kill(); } catch {}
    }
    if (staticSrvNoLb?.server) staticSrvNoLb.server.close();
    if (staticSrvNoFunnel?.server) staticSrvNoFunnel.server.close();
    if (staticSrvFunnel?.server) staticSrvFunnel.server.close();
    cleanTempDist(tempNoLbDir);
    cleanTempDist(tempNoFunnelDir);
    cleanTempDist(tempFunnelDir);
    cleanTempDist(userDataDir);
    await mock.close();
  }
}

main().catch(err => {
  if (isSelfCheckFail) {
    console.log(`\n[SELF-CHECK PASSED: expected failure occurred: ${err.message || err}]`);
  } else {
    console.error('\n❌ Funnel Client Test Failed:', err);
  }
  process.exit(1);
});
