import { findChrome } from '../find_chrome.js';
import { getSlideSetup, getDiagonalSetup } from './find_setups.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const CHROME_PATH = findChrome();
const PORT = 3016;
const CDP_PORT = 9236;

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
    '.woff2': 'font/woff2',
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
    server.listen(PORT, () => resolve(server));
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
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
    this.ws.onclose = () => {
      for (const [id, { reject }] of this.callbacks) reject(new Error('WebSocket closed'));
      this.callbacks.clear();
    };
    this.ws.onerror = (err) => {
      for (const [id, { reject }] of this.callbacks) reject(err);
      this.callbacks.clear();
    };
  }

  send(method, params = {}, timeoutMs = 25000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP method ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.callbacks.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
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

async function main() {
  const server = await startServer();
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_eff'),
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    });

    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=100&start=shatter,diagonal_charge,eraser&debug=1` });
    await sleep(800);

    // Warm up rAF in Chrome headless
    await cdp.eval(`
      new Promise(resolve => {
        let frames = 0;
        function warm() {
          frames++;
          if (frames >= 30) resolve();
          else requestAnimationFrame(warm);
        }
        requestAnimationFrame(warm);
      })
    `);

    // Warm up move handling, audio, layout, and animations
    await cdp.eval(`
      new Promise(resolve => {
        window.controller.state.over = false;
        window.handleMove('L', 'swipe');
        setTimeout(() => {
          if (window.finishCurrentAnimationImmediately) window.finishCurrentAnimationImmediately();
          document.querySelectorAll('.shatter-shard, .shatter-pulse, .shatter-flash, .eraser-dust, .stone-dust-speck, .stone-impact-ring').forEach(el => el.remove());
          resolve();
        }, 500);
      })
    `);

    console.log('Measuring effect positioning across all 16 cells...');

    // Function to run a single case inside browser and collect rAF frames 0-500ms
    const measureCaseInBrowser = async (type, cell, setupData) => {
      return await cdp.eval(`
        new Promise((resolve) => {
          const type = ${JSON.stringify(type)};
          const cell = ${cell};
          const setup = ${JSON.stringify(setupData)};

          const layer = document.getElementById('tiles-layer');
          const metrics = window.getGridMetrics();

          // Finish any in-flight animation and clean up old effects from previous case
          if (window.finishCurrentAnimationImmediately) {
            window.finishCurrentAnimationImmediately();
          }
          document.querySelectorAll('.shatter-shard, .shatter-pulse, .shatter-flash, .eraser-dust, .stone-dust-speck, .stone-impact-ring').forEach(el => el.remove());

          // Prepare board
          if (type === 'slide') {
            window.controller.state.over = false;
            window.controller.state.board = [...setup.board];
            window.syncBoard(window.controller.getBoard(), 'resync');
          } else if (type === 'diagonal') {
            window.controller.state.over = false;
            window.controller.state.board = [...setup.board];
            window.controller.state.abilities.diagonal_charge = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
            window.syncBoard(window.controller.getBoard(), 'resync');
          } else if (type === 'stone_drop') {
            window.controller.state.over = false;
            const b = new Array(16).fill(0);
            b[cell] = 'S';
            window.controller.state.board = b;
            window.syncBoard(window.controller.getBoard(), 'resync');
          } else if (type === 'erase') {
            window.controller.state.over = false;
            const b = new Array(16).fill(0);
            b[cell] = 64;
            const other = (cell === 0) ? 15 : 0;
            b[other] = 2;
            window.controller.state.board = b;
            window.controller.state.abilities.eraser = { charges: 3, maxCharges: 3, swipesAtMax: 0, counter: 0, swipesPerCharge: 10 };
            window.syncBoard(window.controller.getBoard(), 'resync');
          }

          const stoneCenter = window.getCellCenter(cell, metrics);
          const destCell = (setup && setup.dest !== undefined) ? setup.dest : cell;
          const destCenter = window.getCellCenter(destCell, metrics);

          const layerRect = layer.getBoundingClientRect();
          // Expected centers relative to tilesLayer
          const expStone = { x: stoneCenter.cx, y: stoneCenter.cy };
          const expDest = { x: destCenter.cx, y: destCenter.cy };

          const frames = [];
          let startTs = null;

          function recordFrame(now) {
            if (!startTs) startTs = now;
            const elapsed = now - startTs;

            // Measure shards
            const shardEls = Array.from(document.querySelectorAll('.shatter-shard'));
            let shardCentroid = null;
            if (shardEls.length > 0) {
              let sumX = 0, sumY = 0;
              for (const el of shardEls) {
                const r = el.getBoundingClientRect();
                sumX += (r.left - layerRect.left + r.width / 2);
                sumY += (r.top - layerRect.top + r.height / 2);
              }
              shardCentroid = {
                x: Math.round((sumX / shardEls.length) * 10) / 10,
                y: Math.round((sumY / shardEls.length) * 10) / 10,
                count: shardEls.length
              };
            }

            // Measure flash
            const flashEl = document.querySelector('.shatter-flash');
            let flashCenter = null;
            if (flashEl) {
              const r = flashEl.getBoundingClientRect();
              flashCenter = {
                x: Math.round((r.left - layerRect.left + r.width / 2) * 10) / 10,
                y: Math.round((r.top - layerRect.top + r.height / 2) * 10) / 10
              };
            }

            // Measure ring
            const pulseEl = document.querySelector('.shatter-pulse, .stone-impact-ring');
            let ringCenter = null;
            if (pulseEl) {
              const r = pulseEl.getBoundingClientRect();
              ringCenter = {
                x: Math.round((r.left - layerRect.left + r.width / 2) * 10) / 10,
                y: Math.round((r.top - layerRect.top + r.height / 2) * 10) / 10
              };
            }

            // Measure dust (erase dust or stone dust)
            const dustEls = Array.from(document.querySelectorAll('.eraser-dust, .stone-dust-speck'));
            let dustCentroid = null;
            if (dustEls.length > 0) {
              let sumX = 0, sumY = 0;
              for (const el of dustEls) {
                const r = el.getBoundingClientRect();
                sumX += (r.left - layerRect.left + r.width / 2);
                sumY += (r.top - layerRect.top + r.height / 2);
              }
              dustCentroid = {
                x: Math.round((sumX / dustEls.length) * 10) / 10,
                y: Math.round((sumY / dustEls.length) * 10) / 10,
                count: dustEls.length
              };
            }

            frames.push({
              t: Math.round(elapsed * 100) / 100,
              now,
              shardCentroid,
              flashCenter,
              ringCenter,
              dustCentroid
            });

            if (elapsed < 650) {
              requestAnimationFrame(recordFrame);
            } else {
              resolve({
                cell,
                destCell,
                expStone,
                expDest,
                frames
              });
            }
          }

          // Trigger action
          if (type === 'slide') {
            window.handleMove(setup.dir, 'swipe');
          } else if (type === 'diagonal') {
            window.executeAbility('diagonal_charge', { from: setup.from, to: setup.to });
          } else if (type === 'stone_drop') {
            window.animateStoneSpawn(cell);
          } else if (type === 'erase') {
            window.executeEraserAbility(cell);
          }

          requestAnimationFrame(recordFrame);
        })
      `);
    };

    const results = [];

    // 1. Shatter Slide for all 16 cells
    for (let c = 0; c < 16; c++) {
      const setup = getSlideSetup(c);
      const data = await measureCaseInBrowser('slide', c, setup);
      console.log(`Measured slide cell ${c}: frames=${data.frames.length}, shards=${data.frames.filter(f => f.shardCentroid).length}, flash=${data.frames.filter(f => f.flashCenter).length}, ring=${data.frames.filter(f => f.ringCenter).length}`);
      results.push({ type: 'slide', ...data });
      await sleep(400);
    }

    // 2. Shatter Diagonal for all 16 cells
    for (let c = 0; c < 16; c++) {
      const setup = getDiagonalSetup(c);
      const data = await measureCaseInBrowser('diagonal', c, setup);
      results.push({ type: 'diagonal', ...data });
      await sleep(400);
    }

    // 3. Stone-drop for all 16 cells
    for (let c = 0; c < 16; c++) {
      const data = await measureCaseInBrowser('stone_drop', c, {});
      results.push({ type: 'stone_drop', ...data });
      await sleep(400);
    }

    // 4. Erase for all 16 cells
    for (let c = 0; c < 16; c++) {
      const data = await measureCaseInBrowser('erase', c, {});
      results.push({ type: 'erase', ...data });
      await sleep(400);
    }

    // Process rows for effects_position.txt
    const outputRows = [];
    outputRows.push('# EFFECTS POSITION AUDIT & MEASUREMENT TABLE');
    outputRows.push('# Measured via real rAF every frame for 0-500 ms in headless Chrome');
    outputRows.push('# Viewport: 390x844 mobile, deviceScaleFactor 3');
    outputRows.push('# Pass condition: distance <= 12 px at first shard / effect frame');
    outputRows.push('');
    outputRows.push('Case       | Cell | Dest | Effect Element | Expected Centre (px) | Measured Centre (px) | First Frame t(ms) | Dist (px) | Status');
    outputRows.push('-----------+------+------+----------------+----------------------+----------------------+-------------------+-----------+-------');

    let allPass = true;
    let maxDistObserved = 0;
    let totalChecks = 0;

    for (const r of results) {
      if (r.type === 'slide' || r.type === 'diagonal') {
        // Find first frame with shards
        const shardFrame = r.frames.find(f => f.shardCentroid !== null);
        // Find first frame with flash
        const flashFrame = r.frames.find(f => f.flashCenter !== null);
        // Find first frame with ring
        const ringFrame = r.frames.find(f => f.ringCenter !== null);

        // Shard row
        if (shardFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(shardFrame.shardCentroid.x - r.expStone.x, shardFrame.shardCentroid.y - r.expStone.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `${r.type.padEnd(10)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.destCell).padStart(4)} | ` +
            `shatter-shards  | ` +
            `(${String(r.expStone.x).padStart(5)}, ${String(r.expStone.y).padStart(5)}) | ` +
            `(${String(shardFrame.shardCentroid.x).padStart(5)}, ${String(shardFrame.shardCentroid.y).padStart(5)}) | ` +
            `${String(shardFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }

        // Flash row
        if (flashFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(flashFrame.flashCenter.x - r.expStone.x, flashFrame.flashCenter.y - r.expStone.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `${r.type.padEnd(10)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.destCell).padStart(4)} | ` +
            `shatter-flash   | ` +
            `(${String(r.expStone.x).padStart(5)}, ${String(r.expStone.y).padStart(5)}) | ` +
            `(${String(flashFrame.flashCenter.x).padStart(5)}, ${String(flashFrame.flashCenter.y).padStart(5)}) | ` +
            `${String(flashFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }

        // Ring row (at merge destination)
        if (ringFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(ringFrame.ringCenter.x - r.expDest.x, ringFrame.ringCenter.y - r.expDest.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `${r.type.padEnd(10)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.destCell).padStart(4)} | ` +
            `shatter-ring    | ` +
            `(${String(r.expDest.x).padStart(5)}, ${String(r.expDest.y).padStart(5)}) | ` +
            `(${String(ringFrame.ringCenter.x).padStart(5)}, ${String(ringFrame.ringCenter.y).padStart(5)}) | ` +
            `${String(ringFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }
      } else if (r.type === 'stone_drop') {
        // Ring and dust
        const ringFrame = r.frames.find(f => f.ringCenter !== null);
        const dustFrame = r.frames.find(f => f.dustCentroid !== null);

        if (ringFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(ringFrame.ringCenter.x - r.expStone.x, ringFrame.ringCenter.y - r.expStone.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `stone_drop | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `impact-ring     | ` +
            `(${String(r.expStone.x).padStart(5)}, ${String(r.expStone.y).padStart(5)}) | ` +
            `(${String(ringFrame.ringCenter.x).padStart(5)}, ${String(ringFrame.ringCenter.y).padStart(5)}) | ` +
            `${String(ringFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }

        if (dustFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(dustFrame.dustCentroid.x - r.expStone.x, dustFrame.dustCentroid.y - r.expStone.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `stone_drop | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `stone-dust      | ` +
            `(${String(r.expStone.x).padStart(5)}, ${String(r.expStone.y).padStart(5)}) | ` +
            `(${String(dustFrame.dustCentroid.x).padStart(5)}, ${String(dustFrame.dustCentroid.y).padStart(5)}) | ` +
            `${String(dustFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }
      } else if (r.type === 'erase') {
        const dustFrame = r.frames.find(f => f.dustCentroid !== null);
        if (dustFrame) {
          totalChecks++;
          const dist = Math.round(Math.hypot(dustFrame.dustCentroid.x - r.expStone.x, dustFrame.dustCentroid.y - r.expStone.y) * 100) / 100;
          if (dist > maxDistObserved) maxDistObserved = dist;
          const pass = dist <= 12.0;
          if (!pass) allPass = false;
          outputRows.push(
            `erase      | ` +
            `${String(r.cell).padStart(4)} | ` +
            `${String(r.cell).padStart(4)} | ` +
            `eraser-dust     | ` +
            `(${String(r.expStone.x).padStart(5)}, ${String(r.expStone.y).padStart(5)}) | ` +
            `(${String(dustFrame.dustCentroid.x).padStart(5)}, ${String(dustFrame.dustCentroid.y).padStart(5)}) | ` +
            `${String(dustFrame.t).padStart(17)} | ` +
            `${String(dist.toFixed(2)).padStart(9)} | ` +
            `${pass ? 'PASS' : 'FAIL'}`
          );
        }
      }
    }

    outputRows.push('-----------+------+------+----------------+----------------------+----------------------+-------------------+-----------+-------');
    outputRows.push(`Total measurements: ${totalChecks}`);
    outputRows.push(`Max distance at first frame: ${maxDistObserved.toFixed(2)} px (threshold: <= 12.00 px)`);
    outputRows.push(`Overall Result: ${allPass ? 'PASS' : 'FAIL'}`);

    const outFile = path.join(outDir, 'effects_position.txt');
    fs.writeFileSync(outFile, outputRows.join('\n') + '\n', 'utf8');
    console.log(`Wrote ${outFile} successfully!`);
    console.log(`Total checks: ${totalChecks}, Max dist: ${maxDistObserved}px, Result: ${allPass ? 'PASS' : 'FAIL'}`);

    cdp.close();
  } finally {
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(path.join(rootDir, '.temp_chrome_eff'), { recursive: true, force: true });
    } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
