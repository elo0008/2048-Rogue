import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const iconsDir = path.join(rootDir, 'game', 'icons');
const outFile = path.join(iconsDir, 'icon_metrics.json');

const CHROME_PATH = findChrome();

const CDP_PORT = 9255;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

export async function computeIconMetrics(perceptualBias = 0) {
  if (!CHROME_PATH) {
    throw new Error('Chrome/Chromium executable not found. Set CHROME_PATH or install Chrome.');
  }

  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=600,600',
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const svgFiles = fs.readdirSync(iconsDir)
      .filter(f => f.endsWith('.svg'))
      .sort();

    // Prepare HTML page with canvas
    await cdp.eval(`
      document.body.innerHTML = '<canvas id="c" width="512" height="512"></canvas>';
    `);

    const rawMetrics = [];

    for (const file of svgFiles) {
      const relic = file.replace('.svg', '');
      const svgPath = path.join(iconsDir, file);
      const svgBuffer = fs.readFileSync(svgPath);
      const svgSha256 = crypto.createHash('sha256').update(svgBuffer).digest('hex');
      const base64 = svgBuffer.toString('base64');
      const dataUrl = `data:image/svg+xml;base64,${base64}`;

      const res = await cdp.eval(`
        new Promise((resolve) => {
          const canvas = document.getElementById('c');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.clearRect(0, 0, 512, 512);

          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, 512, 512);
            const imgData = ctx.getImageData(0, 0, 512, 512);
            const data = imgData.data;

            let minX = 512, maxX = -1, minY = 512, maxY = -1;
            let inkCount = 0;

            for (let y = 0; y < 512; y++) {
              for (let x = 0; x < 512; x++) {
                const idx = (y * 512 + x) * 4;
                const alpha = data[idx + 3];
                if (alpha > 8) {
                  inkCount++;
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
            }

            const rawW = maxX >= minX ? (maxX - minX + 1) : 0;
            const rawH = maxY >= minY ? (maxY - minY + 1) : 0;
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const inkCoverage = inkCount / (512 * 512);

            resolve({
              relic: '${relic}',
              sha256: '${svgSha256}',
              minX, maxX, minY, maxY,
              rawW, rawH, cx, cy,
              inkCoverage
            });
          };
          img.src = '${dataUrl}';
        })
      `);

      rawMetrics.push(res);
    }

    cdp.close();

    // Compute median ink coverage
    const sortedInk = [...rawMetrics.map(m => m.inkCoverage)].sort((a, b) => a - b);
    const medianInk = sortedInk[Math.floor(sortedInk.length / 2)];

    const TARGET_SIZE = 512 * 0.88; // 88% = 450.56px
    const finalMetrics = {};
    const tableRows = [];

    for (const m of rawMetrics) {
      const rawLongSide = Math.max(m.rawW, m.rawH);
      const rawPct = (rawLongSide / 512) * 100;
      let scale = TARGET_SIZE / rawLongSide;

      if (perceptualBias !== 0 && m.inkCoverage > 0) {
        const biasFactor = Math.pow(medianInk / m.inkCoverage, perceptualBias);
        scale *= biasFactor;
      }

      // Center offset in percentage of the icon container
      // If container center is 50%, shift needed is (256 - cx) / 512 * 100%
      const offsetXPercent = ((256 - m.cx) / 512) * 100;
      const offsetYPercent = ((256 - m.cy) / 512) * 100;
      const finalBboxPct = (rawLongSide * scale / 512) * 100;

      finalMetrics[m.relic] = {
        sha256: m.sha256,
        scale: Math.round(scale * 1000) / 1000,
        xPercent: Math.round(offsetXPercent * 100) / 100,
        yPercent: Math.round(offsetYPercent * 100) / 100,
        rawBboxPct: Math.round(rawPct * 10) / 10,
        finalBboxPct: Math.round(finalBboxPct * 10) / 10,
        inkCoveragePct: Math.round(m.inkCoverage * 1000) / 10,
      };

      tableRows.push({
        relic: m.relic,
        rawPct: `${finalMetrics[m.relic].rawBboxPct}%`,
        scale: finalMetrics[m.relic].scale.toFixed(3),
        finalPct: `${finalMetrics[m.relic].finalBboxPct}%`,
        inkPct: `${finalMetrics[m.relic].inkCoveragePct}%`,
      });
    }

    // Save metrics JSON
    fs.writeFileSync(outFile, JSON.stringify(finalMetrics, null, 2), 'utf-8');
    console.log(`Saved icon metrics to: ${outFile}`);

    // Print table
    console.log('\n================================== T7 ICON SIZE NORMALIZATION TABLE ==================================');
    console.log('Relic                | Raw BBox % | Scale | Final BBox % | Ink Coverage %');
    console.log('-------------------------------------------------------------------------');
    for (const r of tableRows) {
      console.log(
        `${r.relic}`.padEnd(20) + ' | ' +
        `${r.rawPct}`.padEnd(10) + ' | ' +
        `${r.scale}`.padEnd(5) + ' | ' +
        `${r.finalPct}`.padEnd(12) + ' | ' +
        `${r.inkPct}`
      );
    }
    console.log('======================================================================================================\n');

    return finalMetrics;
  } finally {
    chromeProcess.kill();
  }
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const bias = parseFloat(process.argv[2] || '0') || 0;
  computeIconMetrics(bias).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[1] && process.argv[1].includes('icon_metrics.js')) {
  const bias = parseFloat(process.argv[2] || '0') || 0;
  computeIconMetrics(bias).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
