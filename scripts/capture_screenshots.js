import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

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
    '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(distDir, relPath === '' ? 'index.html' : relPath);

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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function getFreePort() {
  const s = http.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
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
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome CDP');
}

async function main() {
  console.log('Starting screenshot captures (E10)...');
  const server = await startStaticServer();
  const serverPort = server.address().port;

  const cdpPort = await getFreePort();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=390,742',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const callbacks = new Map();
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const msgId = id++;
      callbacks.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true
    });

    const url = `http://127.0.0.1:${serverPort}/?start=diagonal_charge,eraser,rewind&seed=1000&rewind=1&debug=1`;
    await send('Page.navigate', { url });
    await sleep(500);

    // Dismiss start modal if present
    await send('Runtime.evaluate', {
      expression: `(() => {
        const b = document.getElementById('btn-play-start');
        if (b && !b.closest('.hidden')) b.click();
      })()`
    });
    await sleep(200);

    // Ensure all 3 cards are active in DOM
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.controller.state.relics = new Set(['diagonal_charge', 'eraser', 'rewind']);
        window.renderAbilityBar();
      })()`
    });
    await sleep(100);

    // 1. Capture Idle Cards
    console.log('Capturing Idle Cards...');
    const cardsInfo = await send('Runtime.evaluate', {
      expression: `(() => {
        const cards = ['diagonal_charge', 'eraser', 'rewind'];
        const res = {};
        for (const c of cards) {
          const el = document.querySelector(\`.ability-btn[data-relic="\${c}"]\`);
          if (el) {
            const r = el.getBoundingClientRect();
            res[c] = { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        return res;
      })()`,
      returnByValue: true
    });

    const cardBoxes = cardsInfo.result.value;
    for (const [cardId, box] of Object.entries(cardBoxes)) {
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
      });
      fs.writeFileSync(path.join(outDir, `card_${cardId}_idle.png`), Buffer.from(shot.data, 'base64'));
      console.log(`Saved card_${cardId}_idle.png`);
    }

    // Full ability bar idle
    const abilityBarBox = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.getElementById('ability-bar');
        const r = el ? el.getBoundingClientRect() : { x: 0, y: 600, width: 390, height: 100 };
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true
    });
    const barShot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: abilityBarBox.result.value.x, y: abilityBarBox.result.value.y, width: abilityBarBox.result.value.width, height: abilityBarBox.result.value.height, scale: 2 }
    });
    fs.writeFileSync(path.join(outDir, 'cards_bar_idle.png'), Buffer.from(barShot.data, 'base64'));

    // 2. Capture Mid-Sweep for each card
    console.log('Capturing Mid-Sweep Cards...');
    for (const [cardId, box] of Object.entries(cardBoxes)) {
      await send('Runtime.evaluate', {
        expression: `window.triggerCardShimmer('${cardId}')`
      });
      await sleep(350); // Mid-sweep of 700ms animation
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
      });
      fs.writeFileSync(path.join(outDir, `card_${cardId}_sweep.png`), Buffer.from(shot.data, 'base64'));
      console.log(`Saved card_${cardId}_sweep.png`);
      await sleep(400); // Let animation finish
    }

    // 3. Setup full board for Wave progression screenshots
    console.log('Setting up full board for Wave screenshots...');
    const domLog = [];

    // Progression fractions: 0.15, 0.30, 0.45, 0.60, 0.75, 0.90
    const fractions = [0.15, 0.30, 0.45, 0.60, 0.75, 0.90];
    const totalMs = 830;

    for (const frac of fractions) {
      // Re-setup the board, abilities and move
      await send('Runtime.evaluate', {
        expression: `(() => {
          window.controller.state.board = [
            2, 4, 8, 16,
            32, 64, 128, 256,
            512, 1024, 2, 4,
            2, 2, 4, 8
          ];
          if (!window.controller.state.abilities) window.controller.state.abilities = {};
          window.controller.state.abilities.rewind = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
          if (window.controller.state.relics) window.controller.state.relics.add('rewind');
          window.syncBoard(window.controller.getBoard(), 'shot-setup');
        })()`
      });
      await sleep(60);
      await send('Runtime.evaluate', {
        expression: `window.handleMove('L', 'swipe')`
      });
      await sleep(350);

      const targetDelay = Math.round(frac * totalMs);
      await send('Runtime.evaluate', {
        expression: `window.executeRewind()`
      });
      await sleep(targetDelay);

      const domQuery = (await send('Runtime.evaluate', {
        expression: `(() => {
          function getCellInfo(idx) {
            const el = document.querySelector('#tiles-layer .tile[data-index="' + idx + '"], #tiles-layer .stone[data-index="' + idx + '"]');
            const face = el ? el.querySelector('.tile-face, .stone-face') : null;
            const cs = face ? window.getComputedStyle(face) : null;
            return {
              val: el ? el.getAttribute('data-val') : 'none',
              op: cs ? cs.opacity : 'none',
              tr: cs ? cs.transform : 'none'
            };
          }
          return {
            c0: getCellInfo(0),
            c6: getCellInfo(6),
            c15: getCellInfo(15)
          };
        })()`,
        returnByValue: true
      })).result.value;

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const filename = `wave_t_${frac.toFixed(2)}.png`;
      fs.writeFileSync(path.join(outDir, filename), Buffer.from(shot.data, 'base64'));
      console.log(`Saved ${filename} at delay ${targetDelay}ms (${frac * 100}%)`);

      domLog.push({
        file: filename,
        desc: `Wave progression at ${Math.round(frac * 100)}% (${targetDelay}ms)`,
        c0: domQuery.c0,
        c6: domQuery.c6,
        c15: domQuery.c15
      });

      // Wait for rewind to finish before next iteration
      await send('Runtime.evaluate', {
        expression: `new Promise(r => {
          function wait() {
            if (!window.rewindDirector.isActive() && !window.isAnimating) r();
            else setTimeout(wait, 20);
          }
          wait();
        })`,
        awaitPromise: true
      });
      await sleep(100);
    }

    fs.writeFileSync(path.join(outDir, 'screenshot_dom_queries.json'), JSON.stringify(domLog, null, 2), 'utf-8');

    console.log('All screenshots captured successfully.');
    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
