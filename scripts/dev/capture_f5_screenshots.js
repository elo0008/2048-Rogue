import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'screenshots');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 30; i++) {
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
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async screenshot(fileName) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    console.log(`Saved screenshot: ${filePath} (${fs.statSync(filePath).size} bytes)`);
    return filePath;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function run() {
  const server = await startServer();
  const serverPort = server.address().port;

  const cdpPort = 9229;
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });

    // 1. Screenshot: Start Screen
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await sleep(600);
    await cdp.screenshot('01_start_screen.png');

    // 2. Screenshot: Game with 4 Passives + 3 Abilities
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/?seed=1` });
    await sleep(500);
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
        if (window.controller) {
          window.controller.state.relics = new Set([
            'fault_line', 'mason', 'siphon', 'shatter',
            'diagonal_charge', 'eraser', 'rewind'
          ]);
          window.controller.state.board = [2, 0, 4, 0, 0, 8, 0, 2, 4, 0, 16, 0, 0, 0, 2, 0];
          window.renderBoard(window.controller.getBoard());
          window.renderAbilityBar();
          window.updateHeader();
        }
      })()
    `);
    await sleep(300);
    await cdp.screenshot('02_game_loaded_relics.png');

    // 3. Screenshot: Mid-slide capture
    // Set tile 2 at cell 1, trigger left swipe and capture mid-slide at ~70ms
    await cdp.eval(`
      (() => {
        window.controller.state.board = [0, 2, 0, 0, 0, 4, 0, 0, 0, 8, 0, 0, 0, 16, 0, 0];
        window.renderBoard(window.controller.getBoard());
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
      })()
    `);
    await sleep(75);
    await cdp.screenshot('03_mid_slide.png');
    await sleep(300);

    // 4. Screenshot: Diagonal targeting mode (step 2)
    await cdp.eval(`
      (() => {
        window.controller.state.board = [2, 0, 4, 0, 0, 2, 0, 4, 2, 0, 8, 0, 0, 8, 0, 2];
        if (window.controller.state.abilities?.diagonal_charge) {
          window.controller.state.abilities.diagonal_charge.charges = 2;
        }
        window.renderBoard(window.controller.getBoard());
        window.renderAbilityBar();
        const diagBtn = document.querySelector('.ability[data-ability="diagonal_charge"]');
        if (diagBtn) diagBtn.click();
        // Click candidate tile at cell 0
        const tile0 = document.querySelector('.cell[data-index="0"] .tile');
        if (tile0) tile0.click();
      })()
    `);
    await sleep(250);
    await cdp.screenshot('04_diagonal_targeting.png');

    // 5. Screenshot: Game Over screen
    await cdp.eval(`
      (() => {
        window.cancelTargeting();
        window.handleGameOver();
      })()
    `);
    await sleep(300);
    await cdp.screenshot('05_game_over.png');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

run().catch(console.error);
