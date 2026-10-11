import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const screenshotsDir = path.join(rootDir, 'screenshots3');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 3002;
const CDP_PORT = 9224;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer() {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
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

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(screenshotsDir, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function captureAll() {
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

    // 1. Ability bar at 1 charge & Diagonal Targeting Step 1 & Step 2 & 0 charges
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    // Start with diagonal_charge and seed 42
    await cdp.send('Page.navigate', {
      url: `http://localhost:${PORT}/?seed=5&start=diagonal_charge`,
    });
    await sleep(400);

    // Screenshot 1: Ability bar at 1 charge
    await cdp.screenshot('ability_bar_1_charge.png');

    // Click Diagonal Merge ability button
    await cdp.eval(`
      (() => {
        const btn = document.querySelector('.ability-btn[data-relic="diagonal_charge"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    // Screenshot 2: Diagonal targeting step 1
    await cdp.screenshot('diagonal_targeting_step1.png');

    // Click the first candidate tile (cell 9 on seed 5)
    await cdp.eval(`
      (() => {
        const targets = controller.getLegalTargets('diagonal_charge');
        const firstCell = targets[0].a;
        const tile = document.querySelector('#game-board .tile[data-index="' + firstCell + '"], .tiles-layer .tile[data-index="' + firstCell + '"]');
        if (tile) tile.click();
      })()
    `);
    await sleep(200);

    // Screenshot 3: Diagonal targeting step 2
    await cdp.screenshot('diagonal_targeting_step2.png');

    // Click partner tile (cell 12 on seed 5) to execute merge
    await cdp.eval(`
      (() => {
        const partnerTile = document.querySelector('#game-board .tile.target-partner, #game-board .tile.valid, .tiles-layer .tile.target-partner');
        if (partnerTile) partnerTile.click();
      })()
    `);
    await sleep(350);

    // Screenshot 4: Ability bar at 0 charges
    await cdp.screenshot('ability_bar_0_charges.png');

    // 2. Ability bar at 3 charges (recharge via 30 valid swipes)
    // Cooldown is 10 moves. 30 moves => charges reach 3 (max).
    await cdp.eval(`
      (() => {
        let swipesDone = 0;
        for (let i = 0; i < 50 && swipesDone < 30; i++) {
          const valids = controller.getValidMoves();
          if (valids.length === 0) break;
          const d = valids.includes('D') ? 'D' : valids.includes('L') ? 'L' : valids[0];
          const res = controller.submitMove(d);
          if (res.success) {
            swipesDone++;
          }
        }
        renderBoard(controller.getBoard());
        updateHeader();
        renderAbilityBar();
      })()
    `);
    await sleep(300);

    // Screenshot 5: Ability bar at 3 charges
    await cdp.screenshot('ability_bar_3_charges.png');

    // 3. Eraser Confirm
    await cdp.send('Page.navigate', {
      url: `http://localhost:${PORT}/?seed=42&start=eraser`,
    });
    await sleep(400);

    // Click Eraser ability button
    await cdp.eval(`
      (() => {
        const btn = document.querySelector('.ability-btn[data-relic="eraser"], .ability[data-ability="eraser"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    // Click a number tile to trigger confirm step
    await cdp.eval(`
      (() => {
        const tile = document.querySelector('#game-board .tile.target-candidate, #game-board .tile.candidate, #game-board .tile.erasable, .tiles-layer .tile.target-candidate');
        if (tile) tile.click();
      })()
    `);
    await sleep(200);

    // Screenshot 6: Eraser confirm
    await cdp.screenshot('eraser_confirm.png');

    // 4. Stuck Banner
    await cdp.send('Page.navigate', {
      url: `http://localhost:${PORT}/?seed=7&start=eraser`,
    });
    await sleep(400);

    // Play the sequence: LLLRLRLLLLLRLLLLLLLLLRLLLRLLLLLLLLRL
    await cdp.eval(`
      (() => {
        const moves = 'LLLRLRLLLLLRLLLLLLLLLRLLLRLLLLLLLLRL'.split('');
        for (const dir of moves) {
          controller.submitMove(dir);
        }
        renderBoard(controller.getBoard());
        updateHeader();
        renderAbilityBar();
      })()
    `);
    await sleep(300);

    // Screenshot 7: Stuck banner
    await cdp.screenshot('stuck_banner.png');

    // 5. 6 chips + ability bar at 360px wide
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Page.navigate', {
      url: `http://localhost:${PORT}/?seed=42&start=diagonal_charge,eraser,fault_line,mason,siphon,shatter`,
    });
    await sleep(400);

    // Screenshot 8: 6 chips at 360px
    await cdp.screenshot('relics_6_chips_360px.png');

    // 6. 6 chips + ability bar at 320px wide
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Page.navigate', {
      url: `http://localhost:${PORT}/?seed=42&start=diagonal_charge,eraser,fault_line,mason,siphon,shatter`,
    });
    await sleep(400);

    // Screenshot 9: 6 chips at 320px
    await cdp.screenshot('relics_6_chips_320px.png');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

captureAll().catch(err => {
  console.error(err);
  process.exit(1);
});
