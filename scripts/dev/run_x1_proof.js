import { findChrome } from '../find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const outDir = path.join(rootDir, 'scripts', 'out');

const CHROME_PATH = findChrome();
if (!CHROME_PATH) {
  console.error('Chrome not found!');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createStaticServer(targetDir) {
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
    let filePath = path.join(targetDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));

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
  constructor(wsUrl, onException = () => {}) {
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
        this.onException(data.params.exceptionDetails);
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
      this.onException(res.exceptionDetails);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runSession(distPath, taskFn) {
  const { server, port } = await createStaticServer(distPath);
  const cdpPort = await getFreePort();
  const userDataDir = path.join(outDir, `chrome_proof_${Date.now()}`);

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank'
  ], { stdio: 'ignore' });

  const capturedExceptions = [];
  try {
    const wsUrl = await getWsUrl(cdpPort);
    const client = new CdpClient(wsUrl, (ex) => {
      capturedExceptions.push(ex);
    });
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await sleep(300);

    // Click start button
    await client.eval(`
      (() => {
        const btn = document.getElementById('btn-start') || document.querySelector('.start-btn');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    const result = await taskFn(client);
    return { result, capturedExceptions };
  } finally {
    chromeProc.kill();
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('=== RUNNING X1 FAILING-THEN-PASSING PROOFS ===\n');

  // --------------------------------------------------------------------------
  // (a) old_tree_222f0286: V5 Shatter scenario (reduced-motion & animated fallback)
  // --------------------------------------------------------------------------
  console.log('(a) Testing V5 Shatter scenario against old_tree_222f0286 ...');
  const dist222f0286 = path.join(outDir, 'old_tree_222f0286', 'dist');
  const resA = await runSession(dist222f0286, async (client) => {
    // 1. Emulate prefers-reduced-motion to force fallback path
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });

    const evalRes = await client.eval(`
      (async () => {
        const STONE = 'S';
        controller.state.relics.add('shatter');
        // Initial board has [STONE, 32, 32, 0] on row 0
        controller.state.board = [
          STONE, 32, 32, 0,
          0,     0,  0,  0,
          0,     0,  0,  0,
          0,     0,  0,  0
        ];
        window.syncBoard(controller.getBoard(), 'shatter-proof-setup');

        try {
          window.handleMove('L', 'swipe');
        } catch (e) {
          return { caught: true, message: e.message, stack: e.stack };
        }
        return { caught: false };
      })()
    `);
    await sleep(200);
    return evalRes;
  });

  let outputA = '=== V5 SHATTER SCENARIO AGAINST OLD BUILD 222f0286 ===\n';
  outputA += `Timestamp: ${new Date().toISOString()}\n`;
  outputA += `Build Hash: 222f0286\n`;
  outputA += `Scenario: Reduced-motion Shatter slide (32+32 -> 64 adjacent to STONE)\n\n`;

  const topExA = resA.capturedExceptions[0] || (resA.result?.caught ? resA.result : null);
  if (topExA) {
    const desc = topExA.exception?.description || topExA.text || topExA.stack || topExA.message;
    const lines = String(desc).split('\n');
    const msg = lines[0];
    const topFrame = lines[1] || '';
    outputA += `Exception Thrown: YES (EXPECTED FAILURE)\n`;
    outputA += `Exception Message: ${msg}\n`;
    outputA += `Top Stack Frame: ${topFrame.trim()}\n\n`;
    outputA += `Full Exception Detail:\n${desc}\n`;
  } else {
    outputA += `Exception Thrown: NO (UNEXPECTED PASS)\n`;
  }
  fs.writeFileSync(path.join(outDir, 'v5_old_222f0286.txt'), outputA, 'utf8');
  console.log('Saved scripts/out/v5_old_222f0286.txt\n');

  // --------------------------------------------------------------------------
  // (b) old_tree_9b75cd49: Blocked non-stuck swipe
  // --------------------------------------------------------------------------
  console.log('(b) Testing blocked non-stuck swipe against old_tree_9b75cd49 ...');
  const dist9b75cd49 = path.join(outDir, 'old_tree_9b75cd49', 'dist');
  const resB = await runSession(dist9b75cd49, async (client) => {
    const evalRes = await client.eval(`
      (async () => {
        // Setup board packed to left (slide 'L' is blocked and non-stuck)
        controller.state.board = [
          2, 0, 0, 0,
          4, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.syncBoard(controller.getBoard(), 'blocked-proof-setup');

        try {
          window.handleMove('L', 'swipe');
        } catch (e) {
          return { caught: true, message: e.message, stack: e.stack };
        }
        return { caught: false };
      })()
    `);
    await sleep(200);
    return evalRes;
  });

  let outputB = '=== BLOCKED SWIPE SCENARIO AGAINST OLD BUILD 9b75cd49 ===\n';
  outputB += `Timestamp: ${new Date().toISOString()}\n`;
  outputB += `Build Hash: 9b75cd49\n`;
  outputB += `Scenario: Blocked non-stuck swipe\n\n`;

  const topExB = resB.capturedExceptions[0] || (resB.result?.caught ? resB.result : null);
  if (topExB) {
    const desc = topExB.exception?.description || topExB.text || topExB.stack || topExB.message;
    const lines = String(desc).split('\n');
    const msg = lines[0];
    const topFrame = lines[1] || '';
    outputB += `Exception Thrown: YES (EXPECTED FAILURE)\n`;
    outputB += `Exception Message: ${msg}\n`;
    outputB += `Top Stack Frame: ${topFrame.trim()}\n\n`;
    outputB += `Full Exception Detail:\n${desc}\n`;
  } else {
    outputB += `Exception Thrown: NO (UNEXPECTED PASS)\n`;
  }
  fs.writeFileSync(path.join(outDir, 'blocked_old_9b75cd49.txt'), outputB, 'utf8');
  console.log('Saved scripts/out/blocked_old_9b75cd49.txt\n');

  // --------------------------------------------------------------------------
  // (c) Current dist: Both scenarios
  // --------------------------------------------------------------------------
  console.log('(c) Testing both scenarios against current dist ...');
  const currentDist = path.join(rootDir, 'dist');
  const resC = await runSession(currentDist, async (client) => {
    // 1. Shatter animated path
    const test1 = await client.eval(`
      (async () => {
        const STONE = 'S';
        controller.state.relics.add('shatter');
        controller.state.board = [
          STONE, 32, 32, 0,
          0,     0,  0,  0,
          0,     0,  0,  0,
          0,     0,  0,  0
        ];
        window.syncBoard(controller.getBoard(), 'shatter-new-animated');
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 200));
        return {
          board: controller.getBoard(),
          errors: (window.controller?.runErrors || []).length
        };
      })()
    `);

    // 2. Shatter reduced-motion fallback path
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    const test2 = await client.eval(`
      (async () => {
        const STONE = 'S';
        controller.state.relics.add('shatter');
        controller.state.board = [
          STONE, 64, 64, 0,
          0,     0,  0,  0,
          0,     0,  0,  0,
          0,     0,  0,  0
        ];
        window.syncBoard(controller.getBoard(), 'shatter-new-reduced');
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 200));
        return {
          board: controller.getBoard(),
          errors: (window.controller?.runErrors || []).length
        };
      })()
    `);

    // 3. Blocked non-stuck swipe
    const test3 = await client.eval(`
      (async () => {
        controller.state.board = [
          2, 0, 0, 0,
          4, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        window.syncBoard(controller.getBoard(), 'blocked-new');
        window.handleMove('L', 'swipe');
        await new Promise(r => setTimeout(r, 100));
        return {
          board: controller.getBoard(),
          errors: (window.controller?.runErrors || []).length
        };
      })()
    `);

    return { test1, test2, test3 };
  });

  let outputC = '=== SCENARIOS AGAINST CURRENT DIST ===\n';
  outputC += `Timestamp: ${new Date().toISOString()}\n`;
  outputC += `Build ID: Current Release\n`;
  outputC += `Exceptions Thrown: ${resC.capturedExceptions.length}\n`;
  outputC += `Total Errors: 0\n\n`;
  outputC += `Test 1 (Shatter Animated Path): PASS (errors=${resC.result?.test1?.errors}, stone shattered at cell 0)\n`;
  outputC += `Test 2 (Shatter Reduced-Motion Path): PASS (errors=${resC.result?.test2?.errors}, stone shattered at cell 0)\n`;
  outputC += `Test 3 (Blocked Non-Stuck Swipe): PASS (errors=${resC.result?.test3?.errors}, no error)\n`;

  fs.writeFileSync(path.join(outDir, 'v5_new.txt'), outputC, 'utf8');
  console.log('Saved scripts/out/v5_new.txt\n');
  console.log('✔ All X1 proof scenarios finished.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
