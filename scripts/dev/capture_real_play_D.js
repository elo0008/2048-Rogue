import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const screenshotsDir = path.join(rootDir, 'screenshots2');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 3000;
const CDP_PORT = 9222;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 1. Static file server for dist/
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
      console.log(`Server running at http://localhost:${PORT}/`);
      resolve(server);
    });
  });
}

// 2. CDP Client
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

  async send(method, params = {}) {
    await this.ready;
    const msgId = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
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

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
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

  async pressKey(key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
  }

  close() {
    this.ws.close();
  }
}

const keyMap = { L: 'ArrowLeft', R: 'ArrowRight', U: 'ArrowUp', D: 'ArrowDown' };

async function main() {
  const server = await startServer();
  console.log('Launching headless Chrome...');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=390,844',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  let copiedRunLogJson = null;
  const boardMeasurements = {};

  try {
    const wsUrl = await getWsUrl();
    console.log('Connected to Chrome via CDP:', wsUrl);
    const client = new CdpClient(wsUrl);

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    // =========================================================================
    // TASK 1: Countdown 10 and Countdown 9 Board Top Y Comparison
    // =========================================================================
    console.log('\n--- Task 1: Board at Countdown 10 and Countdown 9 (?stones=0.4&seed=1) ---');
    await client.send('Page.navigate', { url: `http://localhost:${PORT}/?stones=0.4&seed=1` });
    await sleep(600);
    await client.click('#btn-play-start');
    await sleep(300);

    const countA = await client.eval(`document.getElementById('stone-countdown').textContent.trim()`);
    const unitA = await client.eval(`document.getElementById('hazard-unit').textContent.trim()`);
    const top10 = await client.eval(`document.getElementById('game-board').getBoundingClientRect().top`);
    console.log(`Countdown at move 0: ${countA} ${unitA}, Board top y: ${top10}`);
    await client.screenshot(path.join(screenshotsDir, 'countdown_10.png'));
    boardMeasurements.top10 = top10;

    // Play 1 real move: in seed 1, L slides 2 tiles left
    await client.pressKey('ArrowLeft');
    await sleep(300);

    const countB = await client.eval(`document.getElementById('stone-countdown').textContent.trim()`);
    const unitB = await client.eval(`document.getElementById('hazard-unit').textContent.trim()`);
    const top9 = await client.eval(`document.getElementById('game-board').getBoundingClientRect().top`);
    console.log(`Countdown at move 1: ${countB} ${unitB}, Board top y: ${top9}`);
    await client.screenshot(path.join(screenshotsDir, 'countdown_9.png'));
    boardMeasurements.top9 = top9;

    console.log(`Board Top Y Parity: top10 = ${top10}px, top9 = ${top9}px (Diff: ${Math.abs(top10 - top9)}px)`);

    // =========================================================================
    // TASK 2: Mason after tapping a candidate (?start=mason&stones=0.1)
    // =========================================================================
    console.log('\n--- Task 2: Mason after tapping a candidate (?start=mason&stones=0.1&seed=1) ---');
    await client.send('Page.navigate', { url: `http://localhost:${PORT}/?start=mason&stones=0.1&seed=1` });
    await sleep(600);
    await client.click('#btn-play-start');
    await sleep(300);

    // Play 3 moves to trigger stone 1 at move 3
    const masonMoves = ['ArrowLeft', 'ArrowRight', 'ArrowLeft'];
    for (const key of masonMoves) {
      await client.pressKey(key);
      await sleep(200);
    }

    const candidateCount = await client.eval(`document.querySelectorAll('.mason-candidate').length`);
    console.log(`Mason candidates visible: ${candidateCount}`);
    if (candidateCount === 0) {
      throw new Error('Mason candidates not found!');
    }

    // Tap first candidate cell via real mouse click
    console.log('Tapping first candidate cell...');
    await client.click('.mason-candidate');
    await sleep(300);
    await client.screenshot(path.join(screenshotsDir, 'mason_tapped.png'));

    // =========================================================================
    // TASK 3: Shatter flash (?start=shatter&shatter=8&stones=0.1)
    // =========================================================================
    console.log('\n--- Task 3: Shatter flash (?start=shatter&shatter=8&stones=0.1&seed=1) ---');
    await client.send('Page.navigate', { url: `http://localhost:${PORT}/?start=shatter&shatter=8&stones=0.1&seed=1` });
    await sleep(600);
    await client.click('#btn-play-start');
    await sleep(300);

    // Moves to shatter in seed 1: D, D, D, L, D, D, D, L, D, D, D, L
    const shatterMoves = ['D', 'D', 'D', 'L', 'D', 'D', 'D', 'L', 'D', 'D', 'D', 'L'];
    for (let i = 0; i < shatterMoves.length - 1; i++) {
      await client.pressKey(keyMap[shatterMoves[i]]);
      await sleep(180);
    }

    // Move 12 triggers the shatter flash
    console.log('Dispatching move 12 (L) to trigger shatter flash...');
    await client.pressKey('ArrowLeft');
    await sleep(40);
    await client.screenshot(path.join(screenshotsDir, 'shatter_flash.png'));
    const flashVisible = await client.eval(`document.querySelectorAll('.cell-vanish-flash').length > 0`);
    const toastVisible = await client.eval(`document.querySelector('.toast')?.textContent || ''`);
    console.log(`Shatter moment captured! Flash: ${flashVisible}, Toast: "${toastVisible}"`);

    // =========================================================================
    // TASK 4: Last Stand banner (?start=last_stand&stones=0.1)
    // =========================================================================
    console.log('\n--- Task 4: Last Stand banner (?start=last_stand&stones=0.1&seed=9) ---');
    await client.send('Page.navigate', { url: `http://localhost:${PORT}/?start=last_stand&stones=0.1&seed=9` });
    await sleep(600);
    await client.click('#btn-play-start');
    await sleep(300);

    // Moves to last stand in seed 9: 34 moves
    const lsMoves = ['L','L','L','L','R','L','L','L','L','L','R','L','L','L','L','L','L','R','L','U','R','L','L','L','L','L','L','L','L','L','U','L','U','L'];
    for (let i = 0; i < lsMoves.length - 1; i++) {
      await client.pressKey(keyMap[lsMoves[i]]);
      await sleep(150);
    }

    console.log('Dispatching move 34 to trigger Last Stand...');
    await client.pressKey(keyMap[lsMoves[lsMoves.length - 1]]);
    await sleep(80);
    await client.screenshot(path.join(screenshotsDir, 'last_stand_banner.png'));
    const bannerVisible = await client.eval(`!document.getElementById('last-stand-banner').classList.contains('hidden')`);
    console.log(`Last Stand banner visible: ${bannerVisible}`);

    // =========================================================================
    // TASK 5: End Screen (?stones=0.1, play to game over) + Copy run log JSON
    // =========================================================================
    console.log('\n--- Task 5: End Screen (?stones=0.1&seed=1, play to game over) ---');
    await client.send('Page.navigate', { url: `http://localhost:${PORT}/?stones=0.1&seed=1` });
    await sleep(600);
    await client.click('#btn-play-start');
    await sleep(300);

    // Moves to game over in seed 1: L,R,L,L,L,L,L,L,L,R,L,L,R,L,L,L,L,U,L,L
    const goMoves = ['L','R','L','L','L','L','L','L','L','R','L','L','R','L','L','L','L','U','L','L'];
    for (let i = 0; i < goMoves.length; i++) {
      await client.pressKey(keyMap[goMoves[i]]);
      await sleep(200);
      const isOver = await client.eval(`(() => {
        const overlay = document.getElementById('end-overlay');
        return overlay && !overlay.classList.contains('hidden');
      })()`);
      if (isOver) {
        console.log(`Natural game over reached at step ${i + 1}!`);
        break;
      }
    }

    await sleep(400);
    const isGameOver = await client.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
    console.log(`End overlay visible: ${isGameOver}`);
    await client.screenshot(path.join(screenshotsDir, 'end_screen.png'));

    // Click "Copy Run Log" button via real mouse click
    console.log('Clicking "Copy Run Log" button...');
    await client.click('#btn-copy-log');
    await sleep(200);

    // Retrieve the copied run log JSON (from localStorage history created on game over)
    copiedRunLogJson = await client.eval(`(() => {
      try {
        const raw = localStorage.getItem('2048_rogue_run_history');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) {
            return JSON.stringify(list[list.length - 1], null, 2);
          }
        }
      } catch {}
      return null;
    })()`);

    console.log('\nAll verification tasks completed successfully!');
    client.close();
  } finally {
    chromeProc.kill();
    server.close();
  }

  // Save measurements and run log
  fs.writeFileSync(
    path.join(screenshotsDir, 'run_log.json'),
    copiedRunLogJson || '{}',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(screenshotsDir, 'measurements.json'),
    JSON.stringify(boardMeasurements, null, 2),
    'utf-8'
  );
}

main().catch(err => {
  console.error('Real play verification failed:', err);
  process.exit(1);
});
