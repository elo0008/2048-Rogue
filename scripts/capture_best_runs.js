import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT = 3006;
const CDP_PORT = 9228;

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

async function capture() {
  console.log('[Capture] Starting server...');
  const server = await startServer();

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_cap_' + Date.now()),
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const wsUrl = await getWsUrl();
    client = new CdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    console.log('[Capture] Injecting documented debug best runs records...');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(400);

    // Documented debug injection of several real entries
    await client.eval(`
      (() => {
        const sampleRuns = [
          {
            runId: 'run_seed42_1',
            points: 12480,
            moves: 142,
            maxTile: 1024,
            relics: ['siphon', 'shatter', 'fault_line'],
            endedAt: '2026-10-14T18:22:10.000Z'
          },
          {
            runId: 'run_seed99_2',
            points: 8320,
            moves: 98,
            maxTile: 512,
            relics: ['diagonal_charge', 'eraser'],
            endedAt: '2026-10-14T20:15:30.000Z'
          },
          {
            runId: 'run_seed777_3',
            points: 5120,
            moves: 75,
            maxTile: 256,
            relics: ['siphon', 'rewind'],
            endedAt: '2026-10-15T08:04:12.000Z'
          },
          {
            runId: 'run_seed1337_4',
            points: 3640,
            moves: 58,
            maxTile: 128,
            relics: ['mason'],
            endedAt: '2026-10-15T11:45:00.000Z'
          },
          {
            runId: 'run_seed101_5',
            points: 1820,
            moves: 34,
            maxTile: 64,
            relics: [],
            endedAt: '2026-10-15T13:10:00.000Z'
          }
        ];
        localStorage.setItem('2048_rogue_top_runs', JSON.stringify(sampleRuns));
      })()
    `);

    // Viewport 1: 390x742
    console.log('[Capture] Capturing at 390x742...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(400);

    // Open best runs overlay
    await client.eval(`(() => {
      const btn = document.getElementById('btn-start-trophy');
      if (btn) btn.click();
    })()`);
    await sleep(250);

    const shot390 = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'best_runs_390x742.png'), Buffer.from(shot390.data, 'base64'));
    console.log('[Capture] Saved scripts/out/best_runs_390x742.png');

    // Viewport 2: 320x568
    console.log('[Capture] Capturing at 320x568...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 568,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(400);

    // Open best runs overlay
    await client.eval(`(() => {
      const btn = document.getElementById('btn-start-trophy');
      if (btn) btn.click();
    })()`);
    await sleep(250);

    const shot320 = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'best_runs_320x568.png'), Buffer.from(shot320.data, 'base64'));
    console.log('[Capture] Saved scripts/out/best_runs_320x568.png');

  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

capture().catch(err => {
  console.error('Capture error:', err);
  process.exit(1);
});
