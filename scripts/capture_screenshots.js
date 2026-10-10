import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const screenshotsDir = path.join(rootDir, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 9222;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json`);
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
  throw new Error('Could not connect to Chrome debugging port');
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
    console.log(`Saved screenshot: ${filePath} (${buf.length} bytes)`);
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  console.log('Launching headless browser at:', CHROME_PATH);
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=390,844',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl();
    console.log('Connected to CDP at:', wsUrl);
    const client = new CdpClient(wsUrl);

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    // 1. Start Screen
    console.log('\n--- 1. Capturing Start Screen ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/' });
    await sleep(800);
    await client.screenshot(path.join(screenshotsDir, 'start.png'));

    // 2. Mid-Run Screen
    console.log('\n--- 2. Capturing Mid-Run Screen ---');
    // Click Start Run
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);
    // Make 10 moves
    const moves = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft'];
    for (const key of moves) {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      await sleep(150);
    }
    await sleep(400);
    await client.screenshot(path.join(screenshotsDir, 'mid_run.png'));

    // 3. Draft Overlay (?draft=3)
    console.log('\n--- 3. Capturing Draft Overlay (?draft=3) ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/?draft=3' });
    await sleep(600);
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);

    for (let attempts = 0; attempts < 15; attempts++) {
      const isDraftModal = await client.eval(`!document.getElementById('draft-overlay').classList.contains('hidden')`);
      if (isDraftModal) break;
      // Get a valid move from engine
      const nextDir = await client.eval(`
        (() => {
          const v = getValidMoves(controller.getState());
          return v[0] || 'D';
        })()
      `);
      const keyMap = { L: 'ArrowLeft', R: 'ArrowRight', U: 'ArrowUp', D: 'ArrowDown' };
      const key = keyMap[nextDir] || 'ArrowDown';
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      await sleep(300);
    }
    await sleep(500);
    await client.screenshot(path.join(screenshotsDir, 'draft_overlay.png'));

    // 4. Mason Candidates (?start=mason&stones=0.1)
    console.log('\n--- 4. Capturing Mason Candidates (?start=mason&stones=0.1) ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/?start=mason&stones=0.1' });
    await sleep(600);
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);
    for (let i = 0; i < 8; i++) {
      const key = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'][i % 4];
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      await sleep(200);
      const isMasonPrompt = await client.eval(`document.querySelectorAll('.mason-candidate').length > 0`);
      if (isMasonPrompt) break;
    }
    await sleep(400);
    await client.screenshot(path.join(screenshotsDir, 'mason_candidates.png'));

    // 5. Last Stand Banner (?start=last_stand&stones=0.1)
    console.log('\n--- 5. Capturing Last Stand Banner (?start=last_stand&stones=0.1) ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/?start=last_stand&stones=0.1' });
    await sleep(600);
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);
    // Show the Last Stand banner
    await client.eval(`document.getElementById('last-stand-banner').classList.remove('hidden')`);
    await sleep(200);
    await client.screenshot(path.join(screenshotsDir, 'last_stand_banner.png'));
    await client.eval(`document.getElementById('last-stand-banner').classList.add('hidden')`);

    // 6. End Screen
    console.log('\n--- 6. Capturing End Screen ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/?stones=0.1' });
    await sleep(600);
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);
    // Play until game over, or trigger game over via full board
    for (let i = 0; i < 40; i++) {
      const isOver = await client.eval(`!document.getElementById('end-overlay').classList.contains('hidden')`);
      if (isOver) break;
      const key = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'][i % 4];
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      await sleep(100);
    }
    // If not naturally game over yet, invoke handleGameOver directly to display end-overlay accurately
    await client.eval(`
      if (document.getElementById('end-overlay').classList.contains('hidden')) {
        controller.state.gameOver = true;
        handleGameOver();
      }
    `);
    await sleep(400);
    await client.screenshot(path.join(screenshotsDir, 'end_screen.png'));

    // 7. Foresight Honest Preview (?start=foresight)
    console.log('\n--- 7. Capturing Foresight Honest Preview ---');
    await client.send('Page.navigate', { url: 'http://localhost:3000/?start=foresight' });
    await sleep(600);
    await client.eval(`document.getElementById('btn-start-run').click()`);
    await sleep(300);
    await client.screenshot(path.join(screenshotsDir, 'foresight_honest_preview.png'));

    client.close();
    console.log('\nAll screenshots captured successfully!');
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
