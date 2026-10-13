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
  await cdp.send('Page.navigate', { url });
  await sleep(400);

  // Dismiss start overlay
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-play-start');
      if (btn) btn.click();
    })()
  `);
  await sleep(150);

  const raw = await cdp.eval(`
    (() => {
      const vals = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
      const emptyCell = document.querySelector('.cell');
      const emptyBg = emptyCell ? window.getComputedStyle(emptyCell).backgroundColor : 'rgb(42, 38, 40)';

      // Stone
      const stoneEl = document.createElement('div');
      stoneEl.className = 'tile stone tile-stone';
      stoneEl.setAttribute('data-val', 'S');
      const stoneFace = document.createElement('div');
      stoneFace.className = 'tile-face stone-face';
      stoneFace.textContent = 'S';
      stoneEl.appendChild(stoneFace);
      document.body.appendChild(stoneEl);
      const stoneBg = window.getComputedStyle(stoneFace).backgroundColor;
      const stoneColor = window.getComputedStyle(stoneFace).color;
      stoneEl.remove();

      // Read targeting ring colors
      const rootStyles = window.getComputedStyle(document.documentElement);
      const ringLight = rootStyles.getPropertyValue('--ring-light').trim() || '#ffffff';
      const ringDark = rootStyles.getPropertyValue('--ring-dark').trim() || '#141315';

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
        stoneBg,
        stoneColor,
        ringLight,
        ringDark,
        tiles: tilesData
      };
    })()
  `);

  const emptyRgb = parseRgb(raw.emptyBg);
  const emptyLum = relLuminance(emptyRgb.r, emptyRgb.g, emptyRgb.b);
  const emptyHex = toHex(emptyRgb.r, emptyRgb.g, emptyRgb.b);

  const stoneRgb = parseRgb(raw.stoneBg);
  const stoneLum = relLuminance(stoneRgb.r, stoneRgb.g, stoneRgb.b);
  const stoneHex = toHex(stoneRgb.r, stoneRgb.g, stoneRgb.b);

  // Parse ring colors
  const ringLightRgb = raw.ringLight.startsWith('#')
    ? { r: parseInt(raw.ringLight.slice(1, 3), 16), g: parseInt(raw.ringLight.slice(3, 5), 16), b: parseInt(raw.ringLight.slice(5, 7), 16) }
    : parseRgb(raw.ringLight);
  const ringDarkRgb = raw.ringDark.startsWith('#')
    ? { r: parseInt(raw.ringDark.slice(1, 3), 16), g: parseInt(raw.ringDark.slice(3, 5), 16), b: parseInt(raw.ringDark.slice(5, 7), 16) }
    : parseRgb(raw.ringDark);

  const ringLightLum = relLuminance(ringLightRgb.r, ringLightRgb.g, ringLightRgb.b);
  const ringDarkLum = relLuminance(ringDarkRgb.r, ringDarkRgb.g, ringDarkRgb.b);

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

    // Contrast with ring highlights (light ring and dark ring)
    const ringLightRatio = contrastRatio(ringLightLum, bgLum);
    const ringDarkRatio = contrastRatio(ringDarkLum, bgLum);
    const bestRingRatio = Math.max(ringLightRatio, ringDarkRatio);

    tiles.push({
      val: t.val,
      hex: toHex(bgRgb.r, bgRgb.g, bgRgb.b),
      lum: bgLum,
      prevRatio,
      emptyRatio,
      textRatio,
      ringLightRatio,
      ringDarkRatio,
      bestRingRatio,
      boxShadow: t.boxShadow
    });
    prevLum = bgLum;
  }

  const stoneVsTile2 = contrastRatio(stoneLum, tiles[0].lum);

  return {
    emptyHex,
    emptyLum,
    stoneHex,
    stoneLum,
    stoneVsTile2,
    tiles
  };
}

async function captureBoardScreenshot(cdp, url, outPath) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 742,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send('Page.navigate', { url });
  await sleep(400);

  // Dismiss start overlay and set up reproducible board
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
  await sleep(300);

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
  });

  fs.writeFileSync(outPath, Buffer.from(screenshot.data, 'base64'));
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

    // Capture screenshots
    console.log('Capturing screenshots at 390x742...');
    await captureBoardScreenshot(cdp, `http://localhost:${PORT}/`, path.join(outDir, 'ramp_default.png'));
    await captureBoardScreenshot(cdp, `http://localhost:${PORT}/?ramp=v2`, path.join(outDir, 'ramp_v2.png'));

    cdp.close();

    // Generate ramp_compare.txt
    let output = '';
    output += '========================================================================================================\n';
    output += '                                  TILE RAMP COMPARISON: DEFAULT vs V2                                   \n';
    output += '========================================================================================================\n';
    output += `Switch location in code: game/app.js (parseUrlOptions: ramp === 'v2' sets root.classList.add('ramp-v2'))\n`;
    output += `Empty Cell: Default = ${defaultRamp.emptyHex} (Lum: ${defaultRamp.emptyLum.toFixed(4)}) | v2 = ${v2Ramp.emptyHex} (Lum: ${v2Ramp.emptyLum.toFixed(4)})\n`;
    output += `Stone:      Default = ${defaultRamp.stoneHex} (Lum: ${defaultRamp.stoneLum.toFixed(4)}) | v2 = ${v2Ramp.stoneHex} (Lum: ${v2Ramp.stoneLum.toFixed(4)})\n`;
    output += `Stone vs Tile 2 contrast: Default = ${defaultRamp.stoneVsTile2.toFixed(2)}:1 | v2 = ${v2Ramp.stoneVsTile2.toFixed(2)}:1 (req >= 1.5:1)\n`;
    output += `Tile 2 vs Empty contrast: Default = ${defaultRamp.tiles[0].emptyRatio.toFixed(2)}:1 | v2 = ${v2Ramp.tiles[0].emptyRatio.toFixed(2)}:1 (req >= 1.5:1)\n\n`;

    output += '------------------------------------------------ DEFAULT RAMP ------------------------------------------\n';
    output += 'Value | Hex     | Rel Lum | Prev Ratio | Empty Ratio | Text Contrast | Ring Contrast (Light / Dark -> Best)\n';
    output += '--------------------------------------------------------------------------------------------------------\n';
    for (const t of defaultRamp.tiles) {
      const v = `${t.val}`.padEnd(5);
      const h = `${t.hex}`.padEnd(7);
      const l = `${t.lum.toFixed(4)}`.padEnd(7);
      const pr = t.prevRatio !== null ? `${t.prevRatio.toFixed(2)}:1`.padEnd(10) : 'N/A       ';
      const er = `${t.emptyRatio.toFixed(2)}:1`.padEnd(11);
      const tr = `${t.textRatio.toFixed(2)}:1`.padEnd(13);
      const rc = `${t.ringLightRatio.toFixed(2)}:1 / ${t.ringDarkRatio.toFixed(2)}:1 -> ${t.bestRingRatio.toFixed(2)}:1`;
      output += `${v} | ${h} | ${l} | ${pr} | ${er} | ${tr} | ${rc}\n`;
    }

    output += '\n-------------------------------------------------- V2 RAMP ---------------------------------------------\n';
    output += 'Value | Hex     | Rel Lum | Prev Ratio | Empty Ratio | Text Contrast | Ring Contrast (Light / Dark -> Best)\n';
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
      const rc = `${t.ringLightRatio.toFixed(2)}:1 / ${t.ringDarkRatio.toFixed(2)}:1 -> ${t.bestRingRatio.toFixed(2)}:1`;
      output += `${v} | ${h} | ${l} | ${pr} | ${er} | ${tr} | ${rc}\n`;

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
    output += `V2 Number text vs tile >= 4.5:    ${v2AllTextPass ? 'PASS' : 'FAIL'}\n`;
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
