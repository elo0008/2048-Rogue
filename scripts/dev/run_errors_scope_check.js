import { findChrome } from '../find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

const CHROME_PATH = findChrome();
if (!CHROME_PATH) {
  console.error('Chrome not found!');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));

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
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runErrorsScopeCheck() {
  console.log('[Errors Scope Check] Starting server & headless Chrome...');
  const { server, port } = await startStaticServer();
  const cdpPort = await getFreePort();
  const userDataDir = path.join(outDir, `errors_chrome_${Date.now()}`);

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl;
  try {
    wsUrl = await getWsUrl(cdpPort);
  } catch (err) {
    chromeProc.kill();
    server.close();
    throw err;
  }

  const client = new CdpClient(wsUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/?seed=9999` });
  await sleep(300);

  // Clear any existing localStorage errors before test
  await client.eval(`localStorage.removeItem('2048_rogue_errors')`);

  // Start Run A
  await client.eval(`
    (() => {
      const btn = document.getElementById('btn-start') || document.querySelector('.start-btn');
      if (btn) btn.click();
    })()
  `);
  await sleep(150);

  // 1. In Run A: trigger one real uncaught error
  console.log('[Errors Scope Check] Triggering real uncaught error in Run A...');
  await client.eval(`
    (() => {
      setTimeout(() => {
        throw new Error('Simulated uncaught exception in Run A: test-error-A');
      }, 0);
    })()
  `);
  await sleep(100);

  // Make a move in Run A
  await client.eval(`window.handleMove('L', 'swipe')`);
  await sleep(150);

  // Finish Run A (trigger game over)
  console.log('[Errors Scope Check] Finishing Run A...');
  const runLogA = await client.eval(`
    (() => {
      controller.state.board = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 2, 4, 8, 16];
      controller.submitMove('U');
      const meta = window.getDiagnosticMetadata ? window.getDiagnosticMetadata() : {};
      return controller.getRunLog(meta);
    })()
  `);
  await sleep(150);

  // 2. Between runs: trigger another real uncaught error
  console.log('[Errors Scope Check] Triggering real uncaught error between runs...');
  await client.eval(`
    (() => {
      setTimeout(() => {
        throw new Error('Simulated uncaught exception between runs: test-error-between');
      }, 0);
    })()
  `);
  await sleep(150);

  // 3. Start Run B
  console.log('[Errors Scope Check] Starting and playing Run B...');
  await client.eval(`
    (() => {
      const playAgain = document.getElementById('btn-play-again');
      if (playAgain) playAgain.click();
      else controller.newRun(8888);
    })()
  `);
  await sleep(150);

  // Make moves in Run B (zero errors)
  await client.eval(`window.handleMove('L', 'swipe')`);
  await sleep(100);
  await client.eval(`window.handleMove('D', 'swipe')`);
  await sleep(100);

  // Finish Run B
  console.log('[Errors Scope Check] Finishing Run B...');
  const runLogB = await client.eval(`
    (() => {
      controller.state.board = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 2, 4, 8, 16];
      controller.submitMove('U');
      const meta = window.getDiagnosticMetadata ? window.getDiagnosticMetadata() : {};
      return controller.getRunLog(meta);
    })()
  `);
  await sleep(100);

  client.close();
  chromeProc.kill();
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

  // Format report
  let report = '=== W2 ERRORS SCOPE CHECK REPORT ===\n';
  report += `Generated: ${new Date().toISOString()}\n\n`;

  report += `--- RUN A ---\n`;
  report += `Run ID: ${runLogA.runId}\n`;
  report += `Time Window: [${runLogA.startTimestamp}, ${runLogA.endTimestamp}] (duration: ${runLogA.endTimestamp - runLogA.startTimestamp} ms)\n`;
  report += `errorCount: ${runLogA.errorCount}\n`;
  report += `errors in run window: ${runLogA.errors?.length || 0}\n`;
  for (let i = 0; i < (runLogA.errors || []).length; i++) {
    const err = runLogA.errors[i];
    report += `  Error [${i + 1}]: "${err.message}" at ${err.file}:${err.line}:${err.col} (ts: ${err.ts})\n`;
    report += `    Stack length: ${err.stack ? err.stack.length : 0} chars (<= 300: ${err.stack && err.stack.length <= 300})\n`;
    report += `    Stack excerpt: ${err.stack ? err.stack.slice(0, 120).replace(/\\n/g, ' ') : 'none'}...\n`;
  }
  report += `diagnostics.recentErrors count: ${runLogA.diagnostics?.recentErrors?.length || 0}\n`;
  for (let i = 0; i < (runLogA.diagnostics?.recentErrors || []).length; i++) {
    const err = runLogA.diagnostics.recentErrors[i];
    report += `  Recent [${i + 1}]: "${err.message}" (ts: ${err.ts})\n`;
  }

  report += `\n--- RUN B ---\n`;
  report += `Run ID: ${runLogB.runId}\n`;
  report += `Time Window: [${runLogB.startTimestamp}, ${runLogB.endTimestamp}] (duration: ${runLogB.endTimestamp - runLogB.startTimestamp} ms)\n`;
  report += `errorCount: ${runLogB.errorCount || 0}\n`;
  report += `errors in run window: ${runLogB.errors?.length || 0} (must NOT include Run A or between-runs error)\n`;
  if ((runLogB.errors || []).length === 0) {
    report += `  ✔ Run B errors list is cleanly empty (0 errors in run window).\n`;
  } else {
    for (const err of runLogB.errors) {
      report += `  ❌ Leaked Error: "${err.message}" (ts: ${err.ts})\n`;
    }
  }
  report += `diagnostics.recentErrors count: ${runLogB.diagnostics?.recentErrors?.length || 0} (must contain both)\n`;
  for (let i = 0; i < (runLogB.diagnostics?.recentErrors || []).length; i++) {
    const err = runLogB.diagnostics.recentErrors[i];
    report += `  Recent [${i + 1}]: "${err.message}" (ts: ${err.ts})\n`;
  }

  const bothInB = (runLogB.diagnostics?.recentErrors || []).length >= 2;
  const zeroInB = (runLogB.errors || []).length === 0;
  const oneInA = (runLogA.errors || []).length === 1;
  const stackLenOk = (runLogA.errors || []).every(e => !e.stack || e.stack.length <= 300);

  report += `\n--- VERIFICATION SUMMARY ---\n`;
  report += `Run A scoped errors strictly within window: ${oneInA ? 'PASS' : 'FAIL'}\n`;
  report += `Run A errorCount uncapped counter: ${runLogA.errorCount === 1 ? 'PASS' : 'FAIL'}\n`;
  report += `Run A error stack length <= 300: ${stackLenOk ? 'PASS' : 'FAIL'}\n`;
  report += `Run B scoped errors contains 0 (no leaks from Run A or between-runs): ${zeroInB ? 'PASS' : 'FAIL'}\n`;
  report += `Run B diagnostics.recentErrors contains both errors: ${bothInB ? 'PASS' : 'FAIL'}\n`;
  report += `Overall Result: ${oneInA && zeroInB && bothInB && stackLenOk ? 'PASS' : 'FAIL'}\n`;

  const outFile = path.join(outDir, 'errors_scope_check.txt');
  fs.writeFileSync(outFile, report, 'utf8');
  console.log(`Saved ${outFile}`);
  console.log(report);
}

runErrorsScopeCheck().catch(err => {
  console.error(err);
  process.exit(1);
});
