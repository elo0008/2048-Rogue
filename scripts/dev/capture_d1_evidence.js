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
const screenshotsDir = path.join(rootDir, 'screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const CHROME_PATH = findChrome();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer(port) {
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
    server.listen(port, '127.0.0.1', () => {
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

  async send(method, params = {}) {
    await this.ready;
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

  async screenshot(filePath, clip = null) {
    const params = { format: 'png' };
    if (clip) params.clip = clip;
    const res = await this.send('Page.captureScreenshot', params);
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(filePath, buf);
    console.log(`[Screenshot Saved] ${filePath} (${buf.length} bytes)`);
  }

  async click(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector('${selector}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error('Element not found for click: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const PORT = 3055;
  const CDP_PORT = 9265;
  const server = await startServer(PORT);

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=390,742',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl(CDP_PORT);
    const client = new CdpClient(wsUrl);

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 1,
      mobile: true,
    });

    console.log('Navigating to game with diagonal_merge ability...');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=diagonal_charge&seed=42&debug=1` });
    await sleep(600);

    const startVisible = await client.eval(`Boolean(document.getElementById('start-screen') && !document.getElementById('start-screen').classList.contains('hidden'))`);
    console.log('Start screen visible:', startVisible);
    if (startVisible) {
      await client.click('#btn-play-start');
      await sleep(300);
    }

    const stateInfo = await client.eval(`(() => {
      return {
        board: window.controller ? window.controller.getBoard() : null,
        tiles: Array.from(document.querySelectorAll('.tile')).map(t => ({ cls: t.className, val: t.getAttribute('data-val'), idx: t.getAttribute('data-index') })),
        abilities: Array.from(document.querySelectorAll('button.ability-btn')).map(b => b.getAttribute('data-relic'))
      };
    })()`);
    console.log('Game state info:', JSON.stringify(stateInfo, null, 2));

    // Setup board with diagonal pair (2 at 0, 2 at 5) and dimmed tiles 128 and 256
    await client.eval(`(() => {
      // Set up board in real controller
      window.controller.state.board = [2, 0, 0, 0, 0, 2, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0];
      window.syncBoard(window.controller.getBoard());
      window.renderAbilityBar();
      window.startTargeting('diagonal_charge');
    })()`);
    await sleep(200);

    const step1Info = await client.eval(`(() => {
      return {
        activeTargeting: window.activeTargeting || null,
        tiles: Array.from(document.querySelectorAll('.tile')).map(t => ({ cls: t.className, idx: t.getAttribute('data-index'), val: t.getAttribute('data-val') }))
      };
    })()`);
    console.log('Step 1 info:', JSON.stringify(step1Info, null, 2));

    // Screenshot Step 1 at 390x742
    const step1Path = path.join(screenshotsDir, 'd1_step1_390x742.png');
    await client.screenshot(step1Path);

    // Click candidate tile at index 0 to enter Step 2
    console.log('Selecting tile 0 to activate Diagonal Step 2...');
    await client.click('.tile[data-index="0"]');
    await sleep(300);

    const step2Info = await client.eval(`(() => {
      return {
        activeTargeting: window.activeTargeting || null,
        tiles: Array.from(document.querySelectorAll('.tile')).map(t => ({ cls: t.className, idx: t.getAttribute('data-index'), val: t.getAttribute('data-val') }))
      };
    })()`);
    console.log('Step 2 info:', JSON.stringify(step2Info, null, 2));

    // Screenshot Step 2 at 390x742
    const step2Path = path.join(screenshotsDir, 'd1_step2_390x742.png');
    await client.screenshot(step2Path);

    // Inspect computed styles of dimmed 128 and 256 tiles
    const styles = await client.eval(`(() => {
      const tile128 = document.querySelector('.tile.dim[data-index="6"]');
      const tile256 = document.querySelector('.tile.dim[data-index="7"]');
      const cs128 = window.getComputedStyle(tile128);
      const csFace128 = window.getComputedStyle(tile128.querySelector('.tile-face'));
      const cs256 = window.getComputedStyle(tile256);
      const csFace256 = window.getComputedStyle(tile256.querySelector('.tile-face'));

      return {
        tile128: {
          bg: cs128.backgroundColor,
          border: cs128.border,
          borderColor: cs128.borderColor,
          boxShadow: cs128.boxShadow,
          opacity: cs128.opacity,
          faceBg: csFace128.backgroundColor,
          faceColor: csFace128.color,
          faceBorder: csFace128.border,
          faceBorderColor: csFace128.borderColor,
          faceBoxShadow: csFace128.boxShadow,
        },
        tile256: {
          bg: cs256.backgroundColor,
          border: cs256.border,
          boxShadow: cs256.boxShadow,
          faceBg: csFace256.backgroundColor,
          faceColor: csFace256.color,
          faceBorder: csFace256.border,
          faceBoxShadow: csFace256.boxShadow,
        }
      };
    })()`);

    console.log('\n--- Computed Styles of Dimmed Gold Tiles (Step 2) ---');
    console.log(JSON.stringify(styles, null, 2));

    // Get bounding box of dimmed 128 tile for zoomed crop
    const tile128Box = await client.eval(`(() => {
      const el = document.querySelector('.tile.dim[data-index="6"]');
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);

    console.log('Tile 128 Box:', tile128Box);

    // Zoomed crop with Device Scale Factor 3
    console.log('Switching to DSF 3 for zoomed edge crop (after)...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await sleep(200);

    // Capture zoomed crop of tile 128 (after)
    const cropPathAfter = path.join(screenshotsDir, 'd1_tile128_edge_crop_dsf3_after.png');
    await client.screenshot(cropPathAfter, {
      x: tile128Box.x - 4,
      y: tile128Box.y - 4,
      width: tile128Box.width + 8,
      height: tile128Box.height + 8,
      scale: 1,
    });
    // Also save as standard filename
    fs.copyFileSync(cropPathAfter, path.join(screenshotsDir, 'd1_tile128_edge_crop_dsf3.png'));

    // Recreate old "before" styles temporarily to capture "before" crop
    console.log('Capturing zoomed edge crop (before)...');
    await client.eval(`(() => {
      const s = document.createElement('style');
      s.id = 'temp-before-style';
      s.textContent = \`
        .tile.dim.v128 { background: var(--t128) !important; }
        .tile.dim.v128 .tile-face {
          background: var(--t128) !important;
          color: #2a2116 !important;
          border: 1px solid #ffffff12 !important;
          box-shadow: inset 0 0 0 1px #0000000a, 0 2px 4px #0002 !important;
        }
        .tile.dim.v128 .tile-face::before {
          display: block !important;
          content: "" !important;
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: rgba(16, 15, 17, 0.60);
          z-index: 0;
        }
      \`;
      document.head.appendChild(s);
    })()`);
    await sleep(200);

    const cropPathBefore = path.join(screenshotsDir, 'd1_tile128_edge_crop_dsf3_before.png');
    await client.screenshot(cropPathBefore, {
      x: tile128Box.x - 4,
      y: tile128Box.y - 4,
      width: tile128Box.width + 8,
      height: tile128Box.height + 8,
      scale: 1,
    });

    console.log('Finished capturing D1 evidence!');
    client.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

main().catch(err => {
  console.error('Error capturing D1 evidence:', err);
  process.exit(1);
});
