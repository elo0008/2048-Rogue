import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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

  close() {
    this.ws.close();
  }
}

async function main() {
  const PORT = 3099;
  const CDP_PORT = 9299;
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

    console.log('Testing Scenario F with ghost_fuzz WAIT_IDLE_SCRIPT...');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=606&draft=5&debug=1` });
    await sleep(400);

    await client.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const DIRS = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
    const capturedFTimeouts = [];

    for (let i = 0; i < 15; i++) {
      await client.eval(`
        (() => {
          const draftOverlay = document.getElementById('draft-overlay');
          if (draftOverlay && !draftOverlay.classList.contains('hidden')) {
            const card = draftOverlay.querySelector('.draftcard, .draft-card');
            if (card) card.click();
          }
        })()
      `);
      const dir = DIRS[i % 4];
      await client.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);

      const idleRes = await client.eval(`
        new Promise((resolve) => {
          let idleStart = null;
          const startTime = performance.now();
          const allSeenAnims = new Map();
          function check() {
            const now = performance.now();
            const anims = document.getAnimations().filter(a => {
              if (a.playState === 'finished' || a.playState === 'idle') return false;
              const timing = a.effect ? a.effect.getTiming() : null;
              return !timing || timing.iterations !== Infinity;
            });
            for (const a of anims) {
              const name = a.animationName || a.id || 'unnamed';
              const t = a.effect && a.effect.target;
              const cls = t ? (t.className || t.tagName) : 'no-target';
              const timing = a.effect ? a.effect.getTiming() : null;
              const key = name + '::' + cls;
              if (!allSeenAnims.has(key)) {
                allSeenAnims.set(key, {
                  name,
                  targetClass: cls,
                  duration: timing ? timing.duration : null,
                  iterations: timing ? timing.iterations : null,
                  firstSeen: now - startTime,
                });
              }
            }
            if (now - startTime > 500) {
              resolve({
                timeout: true,
                allSeen: Array.from(allSeenAnims.values())
              });
              return;
            }
            if (anims.length === 0) {
              if (!idleStart) idleStart = now;
              if (now - idleStart >= 25) {
                resolve({ timeout: false, allSeen: Array.from(allSeenAnims.values()) });
                return;
              }
            } else {
              idleStart = null;
            }
            requestAnimationFrame(check);
          }
          check();
        })
      `);

      if (idleRes.timeout) {
        capturedFTimeouts.push({ i, allSeen: idleRes.allSeen });
      }
    }

    console.log(`Captured ${capturedFTimeouts.length} timeouts in Scenario F.`);
    if (capturedFTimeouts.length > 0) {
      console.log('Details Scenario F:', JSON.stringify(capturedFTimeouts[0], null, 2));
    }

    client.close();
  } finally {
    chromeProc.kill();
    server.close();
  }
}

main().catch(console.error);
