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
const outDir = path.join(rootDir, 'screenshots_restyle');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();

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
      throw new Error('Eval error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result?.value;
  }

  async captureScreenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
    console.log(`[Captured] ${path.basename(outputPath)} (${(res.data.length * 0.75 / 1024).toFixed(1)} KB)`);
  }

  close() {
    this.ws.close();
  }
}

async function runCapture() {
  const server = await startStaticServer();
  const serverPort = server.address().port;
  console.log(`Static server running on port ${serverPort}`);

  const cdpPort = 9225;
  const chromeProcess = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `http://127.0.0.1:${serverPort}/`,
    ],
    { stdio: 'ignore' }
  );

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const widths = [320, 390, 430];

    for (const w of widths) {
      console.log(`\n=== Capturing real play UI at ${w}px ===`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 750,
        deviceScaleFactor: 1,
        mobile: true,
      });

      // 1. START Screen
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
      await sleep(400);
      await cdp.captureScreenshot(path.join(outDir, `start_${w}.png`));

      // Click START to start real game
      await cdp.eval(`document.getElementById('btn-play-start').click()`);
      await sleep(250);

      // 2. Game with 4 passives + 3 abilities
      await cdp.eval(`
        (() => {
          const s = window.controller.getState();
          s.relics = new Set(['fault_line', 'mason', 'siphon', 'shatter', 'diagonal_charge', 'eraser', 'rewind']);
          s.charges = { diagonal_charge: 1, eraser: 1, rewind: 1 };
          s.chargeCounters = { diagonal_charge: 0, eraser: 0, rewind: 0 };
          s.points = 1840;
          s.highestTile = 256;
          s.moveCount = 42;
          s.movesSinceLastStone = 5;
          s.board = [
            2, 4, 8, 16,
            32, 64, 128, 256,
            4, 8, 16, 32,
            0, 2, 4, 8
          ];
          window.renderBoard(window.controller.getBoard());
          window.updateHeader();
          window.renderAbilityBar();
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `game_4p_3a_${w}.png`));

      // 3. Hazard warning (movesLeft <= 5)
      await cdp.eval(`
        (() => {
          const s = window.controller.getState();
          const info = window.controller.getNextStoneInfo();
          s.movesSinceLastStone = info.interval - 3; // 3 moves left! (<= 5)
          window.updateHeader();
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `hazard_warning_${w}.png`));

      // 4. Diagonal targeting with a selected tile >= 128
      await cdp.eval(`
        (() => {
          const s = window.controller.getState();
          s.movesSinceLastStone = 5;
          s.board = [
            2, 4, 8, 16,
            32, 128, 16, 256,
            4, 8, 128, 32,
            0, 2, 4, 8
          ];
          window.renderBoard(window.controller.getBoard());
          window.updateHeader();
          window.renderAbilityBar();
          // Trigger diagonal targeting
          const btn = document.querySelector('button.ability-btn[data-relic="diagonal_charge"]');
          btn.click();
        })()
      `);
      await sleep(150);
      // Select the 128 tile at index 5
      await cdp.eval(`
        (() => {
          const tile = document.querySelector('.tile[data-index="5"]');
          if (tile) tile.click();
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `diagonal_targeting_${w}.png`));

      // 5. Eraser targeting
      await cdp.eval(`
        (() => {
          window.cancelTargeting();
          const s = window.controller.getState();
          s.board[3] = -1; // place a stone
          s.board[12] = 64;
          window.renderBoard(window.controller.getBoard());
          const btn = document.querySelector('button.ability-btn[data-relic="eraser"]');
          btn.click();
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `eraser_targeting_${w}.png`));

      // 6. Draft screen
      await cdp.eval(`
        (() => {
          window.cancelTargeting();
          window.showDraftModal({
            type: 'draft',
            moveNumber: 60,
            offers: ['diagonal_charge', 'fault_line', 'siphon']
          });
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `draft_${w}.png`));

      // 7. Stuck banner
      await cdp.eval(`
        (() => {
          document.getElementById('draft-overlay').classList.add('hidden');
          const s = window.controller.getState();
          s.board = [
            2, 4, 8, 16,
            32, 64, 128, 256,
            512, 1024, 2048, 4,
            8, 16, 32, 64
          ];
          s.charges = { diagonal_charge: 1, eraser: 0, rewind: 0 };
          window.renderBoard(window.controller.getBoard());
          window.updateHeader();
          window.renderAbilityBar();
          const banner = document.getElementById('stuck-banner');
          if (banner) banner.classList.remove('hidden');
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `stuck_banner_${w}.png`));

      // 8. Game over screen
      await cdp.eval(`
        (() => {
          const banner = document.getElementById('stuck-banner');
          if (banner) banner.classList.add('hidden');
          const s = window.controller.getState();
          s.score = 14280;
          s.points = 14280;
          s.highestTile = 2048;
          s.moveCount = 284;
          s.draftsSeen = 4;
          window.handleGameOver();
        })()
      `);
      await sleep(200);
      await cdp.captureScreenshot(path.join(outDir, `game_over_${w}.png`));
    }

    cdp.close();
    console.log('\n✔ Successfully captured all screenshots in screenshots_restyle/\n');
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

runCapture().catch(err => {
  console.error(err);
  process.exit(1);
});
