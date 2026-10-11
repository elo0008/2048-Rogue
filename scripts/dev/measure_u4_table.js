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

const PORT = 3005;
const CDP_PORT = 9225;

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

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function measureU4() {
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

    const widths = [320, 360, 390, 430];
    const results = [];

    for (const count of [4, 5]) {
      for (const w of widths) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: 800,
          deviceScaleFactor: 1,
          mobile: true,
        });

        await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
        await sleep(350);

        // Dismiss start overlay and set up passives
        await cdp.eval(`
          (() => {
            const btn = document.getElementById('btn-play-start');
            if (btn) btn.click();

            const passiveContainer = document.getElementById('passive-relics-container');
            passiveContainer.innerHTML = '';
            const allPassives = ['fault_line', 'mason', 'siphon', 'shatter', 'last_stand'];
            for (let i = 0; i < ${count}; i++) {
              const rid = allPassives[i];
              const b = document.createElement('button');
              b.className = 'relic-mini relic-passive-item';
              b.setAttribute('data-relic', rid);
              const img = document.createElement('img');
              img.src = 'icons/' + rid + '.svg';
              img.className = 'relic-svg relic-icon-img';
              b.appendChild(img);
              passiveContainer.appendChild(b);
            }
          })()
        `);
        await sleep(100);

        const m = await cdp.eval(`
          (() => {
            const title = document.querySelector('.brand') || document.querySelector('.game-title');
            const row = document.querySelector('.headrow') || document.querySelector('.title-row');
            const right = document.querySelector('.right');
            const passives = document.getElementById('passive-relics-container');
            const menu = document.getElementById('btn-pause-menu');

            const titleRect = title.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const passivesRect = passives.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            const titleStyle = window.getComputedStyle(title);

            const freeWidth = rowRect.width - (titleRect.width + rightRect.width);

            return {
              titleFontSize: titleStyle.fontSize,
              titleWidth: Math.round(titleRect.width * 10) / 10,
              menuWidth: Math.round(menuRect.width * 10) / 10,
              passivesWidth: Math.round(passivesRect.width * 10) / 10,
              rightWidth: Math.round(rightRect.width * 10) / 10,
              rowWidth: Math.round(rowRect.width * 10) / 10,
              freeWidth: Math.round(freeWidth * 10) / 10,
              fits: freeWidth >= 0
            };
          })()
        `);

        results.push({ passivesCount: count, width: w, ...m });
      }
    }

    cdp.close();

    console.log('\n==================================== HEADER-FIT TABLE (4 & 5 PASSIVES) ====================================');
    console.log('Passives | Viewport | Title Font | Title Width | Right Block (Passives + Menu) | Row Width | Free Width | Fits?');
    console.log('-----------------------------------------------------------------------------------------------------------');
    for (const r of results) {
      console.log(
        `${r.passivesCount} passives`.padEnd(8) + ' | ' +
        `${r.width}px`.padEnd(8) + ' | ' +
        `${r.titleFontSize}`.padEnd(10) + ' | ' +
        `${r.titleWidth}px`.padEnd(11) + ' | ' +
        `${r.rightWidth}px (${r.passivesWidth}px + ${r.menuWidth}px)`.padEnd(29) + ' | ' +
        `${r.rowWidth}px`.padEnd(9) + ' | ' +
        `${r.freeWidth}px`.padEnd(10) + ' | ' +
        (r.fits ? 'PASS' : 'OVERFLOW')
      );
    }
    console.log('===========================================================================================================\n');
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

measureU4().catch(err => {
  console.error(err);
  process.exit(1);
});
