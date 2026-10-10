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

const PORT = 3001;
const CDP_PORT = 9223;

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

function rectsOverlap(r1, r2) {
  return !(
    r1.right <= r2.left ||
    r1.left >= r2.right ||
    r1.bottom <= r2.top ||
    r1.top >= r2.bottom
  );
}

async function runLayoutCheck() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  const results = [];
  let allPassed = true;

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const widths = [320, 360, 390, 430];
    const countdowns = [75, 9];

    for (const w of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 800,
        deviceScaleFactor: 1,
        mobile: true,
      });

      await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
      await sleep(350);

      // Setup 5-digit score
      await cdp.eval(`
        (() => {
          const scoreEl = document.getElementById('stat-score');
          if (scoreEl) scoreEl.textContent = '12345';
          const movesEl = document.getElementById('stat-moves');
          if (movesEl) movesEl.textContent = '1234';
          const maxEl = document.getElementById('stat-max-tile');
          if (maxEl) maxEl.textContent = '2048';
        })()
      `);

      const passivesList = (w === 320) ? [0, 4] : [4];
      const abilitiesList = (w === 320) ? [0, 3] : [3];

      for (const pCount of passivesList) {
        for (const aCount of abilitiesList) {
          // Configure passive icons
          await cdp.eval(`
            (() => {
              const passiveContainer = document.getElementById('passive-relics-container');
              passiveContainer.innerHTML = '';
              const allPassives = ['fault_line', 'mason', 'siphon', 'shatter'];
              for (let i = 0; i < ${pCount}; i++) {
                const rid = allPassives[i];
                const btn = document.createElement('button');
                btn.className = 'relic-passive-item';
                btn.setAttribute('data-relic', rid);
                const img = document.createElement('img');
                img.src = 'icons/' + rid + '.svg';
                img.className = 'relic-passive-img';
                btn.appendChild(img);
                passiveContainer.appendChild(btn);
              }

              const abilityBar = document.getElementById('ability-bar');
              if (${aCount} === 0) {
                abilityBar.classList.add('hidden');
                abilityBar.innerHTML = '';
              } else {
                abilityBar.classList.remove('hidden');
                abilityBar.innerHTML = '';
                const activeRelics = [
                  { id: 'diagonal_charge', file: 'diagonal_merge.svg', name: 'Diagonal Merge', cd: '+1 in 10' },
                  { id: 'eraser', file: null, name: 'Eraser', cd: '+1 in 20' },
                  { id: 'rewind', file: 'rewind.svg', name: 'Rewind', cd: 'MAX' }
                ];
                for (let i = 0; i < ${aCount}; i++) {
                  const ab = activeRelics[i];
                  const btn = document.createElement('button');
                  btn.className = 'ability-btn';
                  btn.setAttribute('data-relic', ab.id);
                  const iconWrap = document.createElement('div');
                  iconWrap.className = 'ability-btn-icon-wrap';
                  if (ab.file) {
                    const img = document.createElement('img');
                    img.src = 'icons/' + ab.file;
                    img.className = 'ability-btn-img';
                    iconWrap.appendChild(img);
                  } else {
                    const mono = document.createElement('div');
                    mono.className = 'relic-monogram';
                    mono.textContent = 'ER';
                    iconWrap.appendChild(mono);
                  }
                  const pips = document.createElement('div');
                  pips.className = 'ability-pips';
                  pips.innerHTML = '<span class="charge-pip filled"></span><span class="charge-pip filled"></span><span class="charge-pip"></span>';
                  const cd = document.createElement('div');
                  cd.className = 'ability-btn-cooldown';
                  cd.textContent = ab.cd;
                  btn.appendChild(iconWrap);
                  btn.appendChild(pips);
                  btn.appendChild(cd);
                  abilityBar.appendChild(btn);
                }
              }
            })()
          `);

          let boardTopByCd = {};

          for (const cd of countdowns) {
            await cdp.eval(`
              (() => {
                const countEl = document.getElementById('stone-countdown');
                const unitEl = document.getElementById('hazard-unit');
                countEl.textContent = '${cd}';
                unitEl.textContent = ${cd} === 1 ? 'move' : 'moves';
              })()
            `);
            await sleep(100);

            const metrics = await cdp.eval(`
              (() => {
                const docWidth = document.documentElement.scrollWidth;
                const innerWidth = window.innerWidth;
                const titleRect = document.querySelector('.game-title').getBoundingClientRect();
                const passivesRect = document.getElementById('passive-relics-container').getBoundingClientRect();
                const hazardRect = document.getElementById('hazard-telegraph').getBoundingClientRect();
                const statsRect = document.querySelector('.stats-row').getBoundingClientRect();
                const header = document.querySelector('.game-header');
                const board = document.getElementById('game-board');
                const boardRect = board.getBoundingClientRect();

                function rectsOverlap(r1, r2) {
                  return !(
                    r1.right <= r2.left ||
                    r1.left >= r2.right ||
                    r1.bottom <= r2.top ||
                    r1.top >= r2.bottom
                  );
                }

                const overlapTitlePassive = passivesRect.width > 0 && rectsOverlap(titleRect, passivesRect);
                const overlapTitleHazard = rectsOverlap(titleRect, hazardRect);
                const overlapHazardStats = rectsOverlap(hazardRect, statsRect);
                const noOverlaps = !overlapTitlePassive && !overlapTitleHazard && !overlapHazardStats;

                return {
                  docWidth,
                  innerWidth,
                  noDocScroll: docWidth <= innerWidth,
                  noOverlaps,
                  headerScrollHeight: header.scrollHeight,
                  headerClientHeight: header.clientHeight,
                  headerNoClip: header.scrollHeight <= header.clientHeight,
                  boardTop: Math.round(boardRect.top * 100) / 100,
                };
              })()
            `);

            boardTopByCd[cd] = metrics.boardTop;

            const row = {
              width: w,
              passives: pCount,
              abilities: aCount,
              countdown: cd,
              docScrollWidth: metrics.docWidth,
              innerWidth: metrics.innerWidth,
              scrollOk: metrics.noDocScroll,
              overlapOk: metrics.noOverlaps,
              headerScrollHeight: metrics.headerScrollHeight,
              headerClientHeight: metrics.headerClientHeight,
              slack: metrics.headerClientHeight - metrics.headerScrollHeight,
              headerOk: metrics.headerNoClip,
              boardTop: metrics.boardTop,
            };
            results.push(row);

            if (!row.scrollOk || !row.overlapOk || !row.headerOk) {
              allPassed = false;
            }
          }
        }
      }
    }

    // Check board top identical across all rows for 320px
    const rows320 = results.filter(r => r.width === 320);
    const baselineTop320 = rows320[0].boardTop;
    for (const r of rows320) {
      if (Math.abs(r.boardTop - baselineTop320) >= 0.5) {
        allPassed = false;
        r.boardTopIdentical = false;
      } else {
        r.boardTopIdentical = true;
      }
    }
    for (const w of [360, 390, 430]) {
      const rowsW = results.filter(r => r.width === w);
      const b0 = rowsW[0].boardTop;
      for (const r of rowsW) {
        r.boardTopIdentical = Math.abs(r.boardTop - b0) < 0.5;
        if (!r.boardTopIdentical) allPassed = false;
      }
    }

    // Test tooltip popover stays inside viewport at 320px
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(200);

    const tooltipCheck = await cdp.eval(`
      (() => {
        // Ensure at least 1 passive item exists to click
        const passiveContainer = document.getElementById('passive-relics-container');
        passiveContainer.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'relic-passive-item';
        btn.setAttribute('data-relic', 'fault_line');
        const img = document.createElement('img');
        img.src = 'icons/fault_line.svg';
        img.className = 'relic-passive-img';
        btn.appendChild(img);
        passiveContainer.appendChild(btn);

        btn.click();

        const popover = document.getElementById('relic-popover');
        if (!popover || popover.classList.contains('hidden')) {
          if (typeof window.showRelicPopover === 'function') {
            window.showRelicPopover('fault_line', btn);
          }
        }

        const rect = popover.getBoundingClientRect();
        const fitsHorizontally = rect.left >= 0 && rect.right <= 320;
        const fitsVertically = rect.top >= 0 && rect.bottom <= 800;
        const hasRoleTooltip = popover.getAttribute('role') === 'tooltip';

        return {
          ok: fitsHorizontally && fitsVertically && hasRoleTooltip,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          fitsHorizontally,
          fitsVertically,
          hasRoleTooltip
        };
      })()
    `);

    if (!tooltipCheck.ok) {
      allPassed = false;
      console.warn('Tooltip check warning:', tooltipCheck);
    }

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }

  // Print as formatted table
  console.log('\n================================================= LAYOUT CHECK RESULTS =================================================');
  console.log(
    'Width | Passives | Abilities | CD | Board Top Y | Header scrollH | Header clientH | Slack (px) | Overlaps | Scroll OK | Invariant'
  );
  console.log('------------------------------------------------------------------------------------------------------------------------');
  for (const r of results) {
    const w = `${r.width}`.padEnd(5);
    const p = `${r.passives}`.padEnd(8);
    const a = `${r.abilities}`.padEnd(9);
    const cd = `${r.countdown}`.padEnd(2);
    const by = `${r.boardTop}`.padEnd(11);
    const sh = `${r.headerScrollHeight}`.padEnd(14);
    const ch = `${r.headerClientHeight}`.padEnd(14);
    const sl = `${r.slack}px`.padEnd(10);
    const ov = (r.overlapOk ? 'PASS' : 'FAIL').padEnd(8);
    const sc = (r.scrollOk ? 'PASS' : 'FAIL').padEnd(9);
    const bi = r.boardTopIdentical ? 'PASS' : 'FAIL';
    console.log(
      `${w} | ${p} | ${a} | ${cd} | ${by} | ${sh} | ${ch} | ${sl} | ${ov} | ${sc} | ${bi}`
    );
  }
  console.log('========================================================================================================================\n');

  if (!allPassed) {
    console.error('❌ Layout check assertions failed!');
    process.exit(1);
  } else {
    console.log('✔ All layout assertions passed across all widths, countdowns, passive icons, and ability states.');
    console.log('✔ Tooltip popover confirmed within 320px viewport with role="tooltip".\n');
  }
}

runLayoutCheck().catch(err => {
  console.error(err);
  process.exit(1);
});
