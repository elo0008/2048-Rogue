import { findChrome } from '../find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'screenshots_real');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();

const PORT = 3045;
const CDP_PORT = 9245;

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
    server.listen(PORT, () => resolve(server));
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const fullPath = path.join(outDir, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`Saved screenshot: ${fullPath} (${buffer.length} bytes)`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function main() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=390,844',
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    console.log('Navigating to game with seed=42&stones=0.1...');
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=42&stones=0.1` });
    await sleep(500);

    // Play 15 real moves so stone spawns (interval=10)
    const DIRS = ['ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'];
    for (let i = 0; i < 15; i++) {
      const dir = DIRS[i % DIRS.length];
      await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      await sleep(100);
    }
    await sleep(400);

    // 1. Game with stones
    await cdp.screenshot('1_game_with_stones.png');

    // 2. Open pause sheet
    await cdp.eval(`document.getElementById('btn-pause-menu').click()`);
    await sleep(400);
    await cdp.screenshot('2_pause_sheet.png');

    // Resume
    await cdp.eval(`document.getElementById('btn-pause-resume').click()`);
    await sleep(300);

    // Play moves and reach real game over
    // Let's play another 20 moves then trigger game over
    for (let i = 0; i < 20; i++) {
      const dir = DIRS[i % DIRS.length];
      await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      await sleep(80);
    }
    await sleep(200);

    // End run cleanly via game over
    await cdp.eval(`window.handleGameOver()`);
    await sleep(400);

    // 3. Game over screen
    await cdp.screenshot('3_game_over.png');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

main().catch(err => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
