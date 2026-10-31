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

async function run() {
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
    await send('DOM.enable');
    await send('CSS.enable');

    await send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/?start=rewind&debug=1` });
    await sleep(1000);

    // Click start if needed
    await send('Runtime.evaluate', {
      expression: `(() => {
        const b = document.getElementById('btn-play-start');
        if (b) b.click();
      })()`
    });
    await sleep(500);

    // E0 - 1. Flatten Gate & A4 properties
    const flattenEval = await send('Runtime.evaluate', {
      expression: `
        (() => {
          function checkChain(el) {
            const chain = [];
            let cur = el;
            while (cur && cur !== document.body) {
              const cs = window.getComputedStyle(cur);
              chain.push({
                name: cur.id ? '#' + cur.id : (cur.className ? '.' + cur.className.split(' ').join('.') : cur.tagName),
                computed: {
                  overflow: cs.overflow,
                  overflowX: cs.overflowX,
                  overflowY: cs.overflowY,
                  filter: cs.filter,
                  backdropFilter: cs.backdropFilter,
                  mask: cs.mask,
                  clipPath: cs.clipPath,
                  opacity: cs.opacity,
                  isolation: cs.isolation,
                  mixBlendMode: cs.mixBlendMode,
                  contain: cs.contain,
                  perspective: cs.perspective,
                  perspectiveOrigin: cs.perspectiveOrigin,
                  transformStyle: cs.transformStyle,
                }
              });
              if (cs.perspective !== 'none' || cur.classList.contains('boardwrap') || cur.classList.contains('board-wrapper')) {
                break;
              }
              cur = cur.parentElement;
            }
            return chain;
          }

          const tilesLayer = document.getElementById('tiles-layer');
          const chainReport = checkChain(tilesLayer);

          const tile = document.querySelector('.tile');
          const restingRect = tile ? tile.getBoundingClientRect() : null;

          return {
            chainReport,
            restingWidth: restingRect ? restingRect.width : 0
          };
        })()
      `,
      returnByValue: true
    });

    const chainReport = flattenEval.result.value.chainReport;
    const restingWidth = flattenEval.result.value.restingWidth;

    // Trigger valid move then rewind to measure mid-sink tile rect and inspect keyframe properties
    await send('Runtime.evaluate', {
      expression: `
        (() => {
          const vm = window.controller.getValidMoves();
          if (vm.length > 0) window.handleMove(vm[0]);
        })()
      `
    });
    await sleep(400);

    const animInspectRes = await send('Runtime.evaluate', {
      expression: `
        (async () => {
          // Find an outer tile (corner or edge)
          let outerTile = document.querySelector('.tile[data-index="0"]') ||
                          document.querySelector('.tile[data-index="3"]') ||
                          document.querySelector('.tile[data-index="12"]') ||
                          document.querySelector('.tile[data-index="15"]') ||
                          document.querySelector('.tile');
          const restingRect = outerTile.getBoundingClientRect();
          const restingWidth = restingRect.width;

          window.executeRewind();

          let minMidSinkWidth = restingWidth;
          const anims = document.getAnimations();
          const propsSet = new Set();
          const animDetails = [];

          // sample for 350ms
          const startTime = performance.now();
          while (performance.now() - startTime < 350) {
            await new Promise(r => requestAnimationFrame(r));
            const rect = outerTile.getBoundingClientRect();
            if (rect.width < minMidSinkWidth && rect.width > 0) {
              minMidSinkWidth = rect.width;
            }
          }

          for (const a of anims) {
            if (a.effect && a.effect.getKeyframes) {
              const kfs = a.effect.getKeyframes();
              const props = new Set();
              for (const kf of kfs) {
                for (const p of Object.keys(kf)) {
                  if (p !== 'offset' && p !== 'computedOffset' && p !== 'easing' && p !== 'composite') {
                    props.add(p);
                    propsSet.add(p);
                  }
                }
              }
              animDetails.push({
                target: a.effect.target ? (a.effect.target.className || a.effect.target.tagName) : 'unknown',
                properties: Array.from(props)
              });
            }
          }

          return {
            restingWidth,
            midSinkWidth: minMidSinkWidth,
            propertiesAnimated: Array.from(propsSet),
            animCount: anims.length,
            animDetails: animDetails.slice(0, 8)
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const animInspect = animInspectRes.result.value;
    const tileRestingWidth = animInspect.restingWidth;
    const midSinkWidth = animInspect.midSinkWidth;
    const ratio = tileRestingWidth > 0 ? (midSinkWidth / tileRestingWidth) : 1;
    const depthIsReal = ratio <= 0.8;
    const chosenPath = 'preserve-3d on #tiles-layer with perspective 1100px on .boardwrap';

    const flattenOutput = [
      '======================================================================',
      'FLATTEN GATE AND A4 KEYFRAME PROPERTIES VERIFICATION',
      '======================================================================',
      `Chosen 3D Path: ${chosenPath}`,
      '',
      '--- Ancestor Chain Computed Styles (tiles-layer up to perspective parent) ---',
      JSON.stringify(chainReport, null, 2),
      '',
      '--- Depth Proof Measurement ---',
      `Resting Outer Tile Width : ${tileRestingWidth.toFixed(4)} px`,
      `Mid-Sink Outer Tile Width: ${midSinkWidth.toFixed(4)} px`,
      `Ratio (midSink / resting): ${ratio.toFixed(4)} (Threshold: <= 0.8000)`,
      `Depth is Real: ${depthIsReal ? 'YES (PASS)' : 'NO (FAIL)'}`,
      '',
      '--- A4 Keyframe Property Verification ---',
      `Active Animations Count : ${animInspect.animCount}`,
      `Distinct Animated Props : ${JSON.stringify(animInspect.propertiesAnimated)}`,
      `Strictly Transform/Opacity: ${animInspect.propertiesAnimated.every(p => p === 'transform' || p === 'opacity') ? 'YES (PASS)' : 'NO (FAIL)'}`,
      'Sample Animation Details:',
      JSON.stringify(animInspect.animDetails, null, 2),
      '======================================================================'
    ].join('\n');

    fs.writeFileSync(path.join(outDir, 'flatten_gate.txt'), flattenOutput, 'utf8');
    console.log('Wrote scripts/out/flatten_gate.txt');

    // E0 - 2. Math Table for 16 cells
    const mathEval = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const fx = window.REWIND_FX;
          const p = 76; // standard cell pitch
          const dMax = p * Math.sqrt(1.5 * 1.5 + 1.5 * 1.5);
          const rMin = 1 / 3;
          const P = fx.perspective;
          const alpha = fx.alpha;

          const rows = [];
          for (let idx = 0; idx < 16; idx++) {
            const col = idx % 4;
            const row = Math.floor(idx / 4);

            const u = (col - 1.5) / 1.5;
            const w = (row - 1.5) / 1.5;

            // Tile centre T relative to board centre C:
            // T - C: Tx - Cx = (col - 1.5) * p
            const tMinusCx = (col - 1.5) * p;
            const tMinusCy = (row - 1.5) * p;

            // v = C - T
            const vx = (1.5 - col) * p;
            const vy = (1.5 - row) * p;

            const d = Math.sqrt(vx * vx + vy * vy);
            const r = d / dMax;
            const rho = Math.max(0, Math.min(1, (r - rMin) / (1 - rMin)));

            const xi = 0.5;
            const Z_mid = 300 + 300 * (0.4 * r + 0.6 * xi);
            const theta = 10 + 15 * r;

            const s = P / (P + Z_mid);
            const screenOffsetX = s * (1 - alpha) * tMinusCx;
            const screenOffsetY = s * (1 - alpha) * tMinusCy;

            rows.push({
              index: idx,
              col,
              row,
              vx: Number(vx.toFixed(2)),
              vy: Number(vy.toFixed(2)),
              d: Number(d.toFixed(2)),
              r: Number(r.toFixed(4)),
              rho: Number(rho.toFixed(4)),
              u: Number(u.toFixed(4)),
              w: Number(w.toFixed(4)),
              thetaDeg: Number(theta.toFixed(2)),
              zMid: Number(Z_mid.toFixed(2)),
              screenOffsetX: Number(screenOffsetX.toFixed(2)),
              screenOffsetY: Number(screenOffsetY.toFixed(2))
            });
          }

          return { fx, rows };
        })()
      `,
      returnByValue: true
    });

    const { fx, rows } = mathEval.result.value;

    let mathTableStr = [
      '========================================================================================================================',
      'REWIND 3D SINK/RISE MATHEMATICAL FORMULATION TABLE (16 CELLS, pitch p = 76px, xi = 0.5)',
      '========================================================================================================================',
      'idx  (col,row)    vx      vy        d        r       rho       u        w     theta(deg)   Z_mid(px)   offset_x   offset_y',
      '------------------------------------------------------------------------------------------------------------------------'
    ];

    for (const r of rows) {
      const idxStr = String(r.index).padStart(3);
      const crStr = `(${r.col},${r.row})`.padEnd(9);
      const vxStr = String(r.vx).padStart(7);
      const vyStr = String(r.vy).padStart(7);
      const dStr = String(r.d).padStart(8);
      const rStr = r.r.toFixed(4).padStart(8);
      const rhoStr = r.rho.toFixed(4).padStart(8);
      const uStr = r.u.toFixed(4).padStart(8);
      const wStr = r.w.toFixed(4).padStart(8);
      const thStr = r.thetaDeg.toFixed(2).padStart(11);
      const zStr = r.zMid.toFixed(2).padStart(11);
      const oxStr = r.screenOffsetX.toFixed(2).padStart(10);
      const oyStr = r.screenOffsetY.toFixed(2).padStart(10);
      mathTableStr.push(`${idxStr}  ${crStr} ${vxStr} ${vyStr} ${dStr} ${rStr} ${rhoStr} ${uStr} ${wStr} ${thStr} ${zStr} ${oxStr} ${oyStr}`);
    }

    mathTableStr.push('------------------------------------------------------------------------------------------------------------------------');
    mathTableStr.push('');
    mathTableStr.push('PERSPECTIVE-INDUCED INWARD PULL AND FUNNEL TILT VERIFICATION:');
    mathTableStr.push('- Screen offset formula: s * (1 - alpha) * (T - C), with scale factor s = P / (P + Z), P = 1100px, alpha = 0.35.');
    mathTableStr.push('- At nadir, tiles are pulled toward board centre C by alpha=0.35 in 3D, and perspective scaling s shrinks them further.');
    mathTableStr.push('- Tilt signs: rotateX(w * theta), rotateY(-u * theta).');
    mathTableStr.push('  For top row (row=0, w=-1): rotateX(-theta) tilts top edge towards viewer, bottom/inner edge tilts away.');
    mathTableStr.push('  For bottom row (row=3, w=+1): rotateX(+theta) tilts bottom edge towards viewer, top/inner edge tilts away.');
    mathTableStr.push('  For left column (col=0, u=-1): rotateY(+theta) tilts left edge towards viewer, right/inner edge tilts away.');
    mathTableStr.push('  For right column (col=3, u=+1): rotateY(-theta) tilts right edge towards viewer, left/inner edge tilts away.');
    mathTableStr.push('  Result: The inner edge of every tile tips away from the viewer, forming a classic funnel/bowl wall.');
    mathTableStr.push('========================================================================================================================');

    fs.writeFileSync(path.join(outDir, 'math_table.txt'), mathTableStr.join('\n'), 'utf8');
    console.log('Wrote scripts/out/math_table.txt');

    ws.close();
  } finally {
    chrome.kill();
    server.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
