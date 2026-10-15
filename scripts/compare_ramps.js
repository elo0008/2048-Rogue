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

const CHROME_PATH = findChrome();
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

function parseRgb(colorStr) {
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10)
  };
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

async function measureRamp(cdp, url) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 742,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send('Page.navigate', { url });
  await sleep(400);

  // Dismiss start overlay and set up reproducible board with stone
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-play-start');
      if (btn) btn.click();
      window.controller.state.over = false;
      window.controller.state.board = [
        2,    4,    8,    16,
        32,   64,   128,  256,
        512,  1024, 2048, 'S',
        0,    2,    4,    8
      ];
      window.controller.state.score = 15840;
      window.controller.state.moveCount = 48;
      window.controller.state.highestTile = 2048;
      window.syncBoard(window.controller.getBoard(), 'setup');
      window.updateHeader();
    })()
  `);
  await sleep(200);

  // Read targeting colors and tile colors
  const raw = await cdp.eval(`
    (() => {
      const vals = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
      const emptyCell = document.querySelector('.cell');
      const emptyBg = emptyCell ? window.getComputedStyle(emptyCell).backgroundColor : 'rgb(42, 38, 40)';

      // Real targeting colours: gold accent from candidate and eraser red from erasable
      const candEl = document.createElement('div');
      candEl.className = 'tile candidate';
      document.body.appendChild(candEl);
      const candBefore = window.getComputedStyle(candEl, '::before');
      const goldColor = candBefore.borderTopColor || candBefore.borderColor;
      candEl.remove();

      const erasableEl = document.createElement('div');
      erasableEl.className = 'tile erasable';
      document.body.appendChild(erasableEl);
      const erasableBefore = window.getComputedStyle(erasableEl, '::before');
      const eraserColor = erasableBefore.borderTopColor || erasableBefore.borderColor;
      erasableEl.remove();

      const tilesData = [];
      for (const v of vals) {
        const el = document.createElement('div');
        el.className = 'tile v' + v + ' tile-' + v;
        el.setAttribute('data-val', String(v));
        const face = document.createElement('div');
        face.className = 'tile-face v' + v + ' tile-' + v;
        face.textContent = String(v);
        el.appendChild(face);
        document.body.appendChild(el);

        const faceStyle = window.getComputedStyle(face);
        const bg = faceStyle.backgroundColor;
        const color = faceStyle.color;
        const boxShadow = faceStyle.boxShadow;

        tilesData.push({
          val: v,
          bg,
          color,
          boxShadow
        });
        el.remove();
      }

      return {
        emptyBg,
        goldColor,
        eraserColor,
        tiles: tilesData
      };
    })()
  `);

  // Measure "stone vs tile 2" from REAL rendered pixels (mean colour of screenshot crop of stone cell)
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const stoneCrop = await cdp.eval(`
    (async () => {
      const stoneEl = document.querySelector('.tile.stone') || document.querySelector('.stone');
      if (!stoneEl) return { r: 29, g: 26, b: 28 };
      const r = stoneEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const img = new Image();
      img.src = 'data:image/png;base64,' + "${screenshot.data}";
      await new Promise(res => { img.onload = res; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const pad = 4;
      const cropX = Math.round((r.left + pad) * dpr);
      const cropY = Math.round((r.top + pad) * dpr);
      const cropW = Math.round((r.width - pad * 2) * dpr);
      const cropH = Math.round((r.height - pad * 2) * dpr);
      const data = ctx.getImageData(cropX, cropY, cropW, cropH).data;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
        count++;
      }
      return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count),
      };
    })()
  `);

  const emptyRgb = parseRgb(raw.emptyBg);
  const emptyLum = relLuminance(emptyRgb.r, emptyRgb.g, emptyRgb.b);
  const emptyHex = toHex(emptyRgb.r, emptyRgb.g, emptyRgb.b);

  const stoneRgb = stoneCrop;
  const stoneLum = relLuminance(stoneRgb.r, stoneRgb.g, stoneRgb.b);
  const stoneHex = toHex(stoneRgb.r, stoneRgb.g, stoneRgb.b);

  const goldRgb = parseRgb(raw.goldColor);
  const goldLum = relLuminance(goldRgb.r, goldRgb.g, goldRgb.b);
  const goldHex = toHex(goldRgb.r, goldRgb.g, goldRgb.b);

  const eraserRgb = parseRgb(raw.eraserColor);
  const eraserLum = relLuminance(eraserRgb.r, eraserRgb.g, eraserRgb.b);
  const eraserHex = toHex(eraserRgb.r, eraserRgb.g, eraserRgb.b);

  const tiles = [];
  let prevLum = null;
  for (const t of raw.tiles) {
    const bgRgb = parseRgb(t.bg);
    const textRgb = parseRgb(t.color);
    const bgLum = relLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
    const textLum = relLuminance(textRgb.r, textRgb.g, textRgb.b);

    const prevRatio = prevLum !== null ? contrastRatio(bgLum, prevLum) : null;
    const emptyRatio = contrastRatio(bgLum, emptyLum);
    const textRatio = contrastRatio(textLum, bgLum);

    // Contrast with REAL targeting colours (gold accent and Eraser red)
    const goldRatio = contrastRatio(goldLum, bgLum);
    const eraserRatio = contrastRatio(eraserLum, bgLum);

    tiles.push({
      val: t.val,
      hex: toHex(bgRgb.r, bgRgb.g, bgRgb.b),
      lum: bgLum,
      prevRatio,
      emptyRatio,
      textRatio,
      goldRatio,
      eraserRatio,
      boxShadow: t.boxShadow
    });
    prevLum = bgLum;
  }

  const stoneVsTile2 = contrastRatio(stoneLum, tiles[0].lum);

  return {
    emptyHex,
    emptyLum,
    stoneHex,
    stoneRgb,
    stoneLum,
    stoneVsTile2,
    goldHex,
    goldLum,
    eraserHex,
    eraserLum,
    tiles,
    screenshotData: screenshot.data
  };
}

async function run() {
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

    console.log('Measuring default ramp...');
    const defaultRamp = await measureRamp(cdp, `http://localhost:${PORT}/`);

    console.log('Measuring v2 ramp (?ramp=v2)...');
    const v2Ramp = await measureRamp(cdp, `http://localhost:${PORT}/?ramp=v2`);

    // Save screenshots
    fs.writeFileSync(path.join(outDir, 'ramp_default.png'), Buffer.from(defaultRamp.screenshotData, 'base64'));
    fs.writeFileSync(path.join(outDir, 'ramp_v2.png'), Buffer.from(v2Ramp.screenshotData, 'base64'));

    cdp.close();

    const weakPairs = [];

    // Check default ramp weak pairs
    if (defaultRamp.stoneVsTile2 < 1.5) {
      weakPairs.push(`Default Stone vs Tile 2 (${defaultRamp.stoneVsTile2.toFixed(2)}:1)`);
    }
    for (const t of defaultRamp.tiles) {
      if (t.goldRatio < 1.5) weakPairs.push(`Default Gold vs Tile ${t.val} (${t.goldRatio.toFixed(2)}:1)`);
      if (t.eraserRatio < 1.5) weakPairs.push(`Default Eraser vs Tile ${t.val} (${t.eraserRatio.toFixed(2)}:1)`);
    }

    // Check v2 ramp weak pairs
    if (v2Ramp.stoneVsTile2 < 1.5) {
      weakPairs.push(`v2 Stone vs Tile 2 (${v2Ramp.stoneVsTile2.toFixed(2)}:1)`);
    }
    for (const t of v2Ramp.tiles) {
      if (t.goldRatio < 1.5) weakPairs.push(`v2 Gold vs Tile ${t.val} (${t.goldRatio.toFixed(2)}:1)`);
      if (t.eraserRatio < 1.5) weakPairs.push(`v2 Eraser vs Tile ${t.val} (${t.eraserRatio.toFixed(2)}:1)`);
    }

    // Generate ramp_compare.txt
    let output = '';
    output += '========================================================================================================\n';
    output += '                                  TILE RAMP COMPARISON: DEFAULT vs V2                                   \n';
    output += '========================================================================================================\n';
    output += `Switch location in code: game/app.js (parseUrlOptions: ramp === 'v2' sets root.classList.add('ramp-v2'))\n`;
    output += `Targeting colors: Gold Accent = ${defaultRamp.goldHex} (Lum: ${defaultRamp.goldLum.toFixed(4)}) | Eraser Red = ${defaultRamp.eraserHex} (Lum: ${defaultRamp.eraserLum.toFixed(4)})\n`;
    output += `Empty Cell: Default = ${defaultRamp.emptyHex} (Lum: ${defaultRamp.emptyLum.toFixed(4)}) | v2 = ${v2Ramp.emptyHex} (Lum: ${v2Ramp.emptyLum.toFixed(4)})\n`;
    output += `Stone (pixel mean): Default = rgb(${defaultRamp.stoneRgb.r},${defaultRamp.stoneRgb.g},${defaultRamp.stoneRgb.b}) -> ${defaultRamp.stoneHex} (Lum: ${defaultRamp.stoneLum.toFixed(4)}) | v2 = rgb(${v2Ramp.stoneRgb.r},${v2Ramp.stoneRgb.g},${v2Ramp.stoneRgb.b}) -> ${v2Ramp.stoneHex} (Lum: ${v2Ramp.stoneLum.toFixed(4)})\n`;
    output += `Stone vs Tile 2 contrast: Default = ${defaultRamp.stoneVsTile2.toFixed(2)}:1${defaultRamp.stoneVsTile2 < 1.5 ? ' [WEAK]' : ''} | v2 = ${v2Ramp.stoneVsTile2.toFixed(2)}:1${v2Ramp.stoneVsTile2 < 1.5 ? ' [WEAK]' : ''} (req >= 1.5:1)\n`;
    output += `Tile 2 vs Empty contrast: Default = ${defaultRamp.tiles[0].emptyRatio.toFixed(2)}:1 | v2 = ${v2Ramp.tiles[0].emptyRatio.toFixed(2)}:1 (req >= 1.5:1)\n\n`;

    output += '------------------------------------------------ DEFAULT RAMP ------------------------------------------\n';
    output += 'Value | Hex     | Rel Lum | Prev Ratio | Empty Ratio | Text Contrast | Targeting: Gold Accent | Eraser Red\n';
    output += '--------------------------------------------------------------------------------------------------------\n';
    for (const t of defaultRamp.tiles) {
      const v = `${t.val}`.padEnd(5);
      const h = `${t.hex}`.padEnd(7);
      const l = `${t.lum.toFixed(4)}`.padEnd(7);
      const pr = t.prevRatio !== null ? `${t.prevRatio.toFixed(2)}:1`.padEnd(10) : 'N/A       ';
      const er = `${t.emptyRatio.toFixed(2)}:1`.padEnd(11);
      const tr = `${t.textRatio.toFixed(2)}:1`.padEnd(13);
      const gWeak = t.goldRatio < 1.5 ? ' (WEAK)' : '       ';
      const eWeak = t.eraserRatio < 1.5 ? ' (WEAK)' : '';
      const gc = `${t.goldRatio.toFixed(2)}:1${gWeak}`.padEnd(22);
      const ec = `${t.eraserRatio.toFixed(2)}:1${eWeak}`;
      output += `${v} | ${h} | ${l} | ${pr} | ${er} | ${tr} | ${gc} | ${ec}\n`;
    }

    output += '\n-------------------------------------------------- V2 RAMP ---------------------------------------------\n';
    output += 'Value | Hex     | Rel Lum | Prev Ratio | Empty Ratio | Text Contrast | Targeting: Gold Accent | Eraser Red\n';
    output += '--------------------------------------------------------------------------------------------------------\n';
    let v2Monotonic = true;
    let v2AllAdjacentPass = true;
    let v2AllTextPass = true;
    let prevL = null;

    for (const t of v2Ramp.tiles) {
      const v = `${t.val}`.padEnd(5);
      const h = `${t.hex}`.padEnd(7);
      const l = `${t.lum.toFixed(4)}`.padEnd(7);
      const pr = t.prevRatio !== null ? `${t.prevRatio.toFixed(2)}:1`.padEnd(10) : 'N/A       ';
      const er = `${t.emptyRatio.toFixed(2)}:1`.padEnd(11);
      const tr = `${t.textRatio.toFixed(2)}:1`.padEnd(13);
      const gWeak = t.goldRatio < 1.5 ? ' (WEAK)' : '       ';
      const eWeak = t.eraserRatio < 1.5 ? ' (WEAK)' : '';
      const gc = `${t.goldRatio.toFixed(2)}:1${gWeak}`.padEnd(22);
      const ec = `${t.eraserRatio.toFixed(2)}:1${eWeak}`;
      output += `${v} | ${h} | ${l} | ${pr} | ${er} | ${tr} | ${gc} | ${ec}\n`;

      if (prevL !== null && t.lum <= prevL) v2Monotonic = false;
      if (t.prevRatio !== null && t.prevRatio < 1.15) v2AllAdjacentPass = false;
      if (t.textRatio < 4.5) v2AllTextPass = false;
      prevL = t.lum;
    }

    output += '--------------------------------------------------------------------------------------------------------\n';
    output += `V2 Luminance strictly increasing: ${v2Monotonic ? 'PASS' : 'FAIL'}\n`;
    output += `V2 All adjacent pairs >= 1.15:    ${v2AllAdjacentPass ? 'PASS' : 'FAIL'}\n`;
    output += `V2 Tile 2 vs empty cell >= 1.5:   ${v2Ramp.tiles[0].emptyRatio >= 1.5 ? 'PASS' : 'FAIL'} (${v2Ramp.tiles[0].emptyRatio.toFixed(2)}:1)\n`;
    output += `V2 Stone vs tile 2 >= 1.5:        ${v2Ramp.stoneVsTile2 >= 1.5 ? 'PASS' : 'FAIL'} (${v2Ramp.stoneVsTile2.toFixed(2)}:1)\n`;
    output += `V2 Number text vs tile >= 4.5:    ${v2AllTextPass ? 'PASS' : 'FAIL'}\n\n`;

    output += 'WEAK TARGETING / CONTRAST PAIRS (< 1.5:1):\n';
    if (weakPairs.length === 0) {
      output += 'None. All pairs >= 1.5:1.\n';
    } else {
      for (const w of weakPairs) {
        output += ` - ${w} < 1.5:1 [WEAK]\n`;
      }
    }
    output += '========================================================================================================\n';

    fs.writeFileSync(path.join(outDir, 'ramp_compare.txt'), output, 'utf8');
    console.log(output);
    console.log('✔ ramp_compare.txt and screenshots generated successfully!');

  } finally {
    chromeProcess.kill();
    server.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
