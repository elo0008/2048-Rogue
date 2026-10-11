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
const artifactDir = path.resolve(rootDir, 'artifacts');

const CHROME_PATH = findChrome();

const PORT = 3008;
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
    server.listen(PORT, () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
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
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async screenshot(filepath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filepath, Buffer.from(res.data, 'base64'));
    console.log(`Saved screenshot: ${filepath}`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function captureScreenshots() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
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

    // 1. Game with stones on the board
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
    await sleep(400);

    // Dismiss start overlay
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    // Populate board with numbers and stones
    await cdp.eval(`
      (() => {
        const STONE = 'S';
        const b = [
          2, 4, 8, STONE,
          16, STONE, 32, 64,
          128, 256, 512, STONE,
          2, 4, 8, 16
        ];
        window.controller.state.board = [...b];
        window.renderBoard(b);
      })()
    `);
    await sleep(300);

    const stonesPath = path.join(artifactDir, 'screenshot_stones.png');
    await cdp.screenshot(stonesPath);

    // 2. Pause sheet with the sound toggle
    await cdp.eval(`
      (() => {
        const menuBtn = document.getElementById('btn-pause-menu');
        if (menuBtn) menuBtn.click();
      })()
    `);
    await sleep(300);

    const pausePath = path.join(artifactDir, 'screenshot_pause.png');
    await cdp.screenshot(pausePath);

    // Close pause sheet and trigger game over
    await cdp.eval(`
      (() => {
        const pauseOverlay = document.getElementById('pause-overlay');
        if (pauseOverlay) pauseOverlay.classList.add('hidden');

        // Setup board and swipe to trigger natural game over
        window.controller.state.board = [
          8, 16, 32, 64,
          128, 256, 512, 1024,
          8, 16, 32, 64,
          128, 0, 256, 1024
        ];
        window.controller.state.points = 14820;
        window.controller.state.score = 247;
        window.controller.state.highestTile = 1024;
        window.renderBoard(window.controller.getBoard());
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
      })()
    `);
    await sleep(400);

    // 3. Game over screen
    const gameoverPath = path.join(artifactDir, 'screenshot_gameover.png');
    await cdp.screenshot(gameoverPath);

    cdp.close();
    console.log('✔ All 3 screenshots captured successfully.');
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

captureScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});
