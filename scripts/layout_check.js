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
  const stuckResults = [];
  let allPassed = true;

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Matrix: widths 320/360/390/430 x countdown 75/9/1 x passives 0/4/5 x abilities 0/3
    const widths = [320, 360, 390, 430];
    const countdowns = [75, 9, 1];
    const passivesList = [0, 4, 5];
    const abilitiesList = [0, 3];

    for (const w of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 800,
        deviceScaleFactor: 1,
        mobile: true,
      });

      await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
      await sleep(350);

      // Dismiss start overlay
      await cdp.eval(`
        (() => {
          const btn = document.getElementById('btn-play-start');
          if (btn) btn.click();
        })()
      `);
      await sleep(150);

      // Setup 5-digit score and 4-digit MOVES
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

      for (const pCount of passivesList) {
        for (const aCount of abilitiesList) {
          // Configure passive icons
          await cdp.eval(`
            (() => {
              const passiveContainer = document.getElementById('passive-relics-container');
              passiveContainer.innerHTML = '';
              const allPassives = ['fault_line', 'mason', 'siphon', 'shatter', 'last_stand'];
              for (let i = 0; i < ${pCount}; i++) {
                const rid = allPassives[i];
                const btn = document.createElement('button');
                btn.className = 'relic-mini relic-passive-item';
                btn.setAttribute('data-relic', rid);
                const img = document.createElement('img');
                img.src = 'icons/' + rid + '.svg';
                img.className = 'relic-svg relic-icon-img';
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
                  { id: 'eraser', file: 'eraser.svg', name: 'Eraser', cd: '+1 in 20' },
                  { id: 'rewind', file: 'rewind.svg', name: 'Rewind', cd: 'MAX' }
                ];
                for (let i = 0; i < ${aCount}; i++) {
                  const ab = activeRelics[i];
                  const btn = document.createElement('button');
                  btn.className = 'ability ability-btn';
                  btn.setAttribute('data-relic', ab.id);
                  const iconWrap = document.createElement('div');
                  iconWrap.className = 'icon ability-btn-icon-wrap';
                  const img = document.createElement('img');
                  img.src = 'icons/' + ab.file;
                  img.className = 'relic-svg relic-icon-img';
                  iconWrap.appendChild(img);

                  const nameEl = document.createElement('span');
                  nameEl.className = 'name';
                  nameEl.textContent = ab.name.toUpperCase();

                  const pips = document.createElement('div');
                  pips.className = 'pips ability-pips';
                  pips.innerHTML = '<span class="pip charge-pip on filled"></span><span class="pip charge-pip on filled"></span><span class="pip charge-pip"></span>';
                  const cd = document.createElement('span');
                  cd.className = 'refill ability-btn-cooldown';
                  cd.textContent = ab.cd;

                  btn.appendChild(iconWrap);
                  btn.appendChild(nameEl);
                  btn.appendChild(pips);
                  btn.appendChild(cd);
                  abilityBar.appendChild(btn);
                }
              }
            })()
          `);

          for (const cd of countdowns) {
            await cdp.eval(`
              (() => {
                const countEl = document.getElementById('stone-countdown');
                const unitEl = document.getElementById('hazard-unit');
                const statusEl = document.getElementById('hazard-status');
                const telegraph = document.getElementById('hazard-telegraph');
                const fillEl = document.getElementById('hazard-fill');

                if (countEl) countEl.textContent = '${cd}';
                if (unitEl) unitEl.textContent = ${cd} === 1 ? 'move' : 'moves';
                if (statusEl) {
                  statusEl.innerHTML = ${cd} === 1
                    ? 'Stone arrives after this move!'
                    : 'Next stone in <strong id=\"stone-countdown\">${cd}</strong> <span id=\"hazard-unit\">' + (${cd} === 1 ? 'move' : 'moves') + '</span>';
                }
                if (telegraph) {
                  if (${cd} <= 5) telegraph.classList.add('warning');
                  else telegraph.classList.remove('warning');
                }
                if (fillEl) {
                  const pct = Math.max(4, Math.min(100, Math.round((1 - (${cd} - 1) / 15) * 100)));
                  fillEl.style.width = pct + '%';
                }
              })()
            `);
            await sleep(80);

            const metrics = await cdp.eval(`
              (() => {
                const docWidth = document.documentElement.scrollWidth;
                const innerWidth = window.innerWidth;
                const titleEl = document.querySelector('.brand') || document.querySelector('.game-title');
                const titleRect = titleEl.getBoundingClientRect();
                const passivesRect = document.getElementById('passive-relics-container').getBoundingClientRect();
                const hazardRect = document.getElementById('hazard-telegraph').getBoundingClientRect();
                const statsRect = document.querySelector('.stats').getBoundingClientRect();
                const header = document.getElementById('header') || document.querySelector('.game-header');
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

                const contentBottom = Math.round(statsRect.bottom);
                const headerTop = Math.round(header.getBoundingClientRect().top);
                const contentHeight = contentBottom - headerTop;
                const slack = header.clientHeight - contentHeight;

                return {
                  docWidth,
                  innerWidth,
                  noDocScroll: docWidth <= innerWidth,
                  noOverlaps,
                  headerScrollHeight: header.scrollHeight,
                  headerClientHeight: header.clientHeight,
                  headerNoClip: header.scrollHeight <= header.clientHeight,
                  slack,
                  boardTop: Math.round(boardRect.top * 100) / 100,
                };
              })()
            `);

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
              slack: metrics.slack,
              headerOk: metrics.headerNoClip && metrics.slack >= 4,
              boardTop: metrics.boardTop,
            };
            results.push(row);

            if (!row.scrollOk) { console.error('FAIL scrollOk at', w, pCount, aCount, cd); allPassed = false; }
            if (!row.overlapOk) { console.error('FAIL overlapOk at', w, pCount, aCount, cd); allPassed = false; }
            if (!row.headerOk) { console.error('FAIL headerOk at', w, pCount, aCount, cd, 'slack:', metrics.slack, 'noClip:', metrics.headerNoClip); allPassed = false; }
          }
        }
      }
    }

    // Check board top identical across all rows for each width
    for (const w of widths) {
      const rowsW = results.filter(r => r.width === w);
      const b0 = rowsW[0].boardTop;
      for (const r of rowsW) {
        r.boardTopIdentical = Math.abs(r.boardTop - b0) < 0.5;
        if (!r.boardTopIdentical) {
          console.error('FAIL boardTopIdentical at width', w, 'boardTop:', r.boardTop, 'baseline:', b0);
          allPassed = false;
        }
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
        const passiveContainer = document.getElementById('passive-relics-container');
        passiveContainer.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'relic-mini relic-passive-item';
        btn.setAttribute('data-relic', 'fault_line');
        const img = document.createElement('img');
        img.src = 'icons/fault_line.svg';
        img.className = 'relic-svg relic-icon-img';
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

    // Test stuck-state rows at 390x742, 360x640, and 430x844
    const stuckViewports = [
      { width: 390, height: 742 },
      { width: 360, height: 640 },
      { width: 430, height: 844 },
    ];

    for (const vp of stuckViewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/` });
      await sleep(350);

      // Dismiss start overlay
      await cdp.eval(`
        (() => {
          const btn = document.getElementById('btn-play-start');
          if (btn) btn.click();
        })()
      `);
      await sleep(150);

      const stuckMetrics = await cdp.eval(`
        (() => {
          // Set up 3 abilities in ability bar
          const abilityBar = document.getElementById('ability-bar');
          abilityBar.classList.remove('hidden');
          abilityBar.innerHTML = '';
          const activeRelics = [
            { id: 'diagonal_charge', file: 'diagonal_merge.svg', name: 'Diagonal Merge', cd: '+1 in 10' },
            { id: 'eraser', file: 'eraser.svg', name: 'Eraser', cd: '+1 in 20' },
            { id: 'rewind', file: 'rewind.svg', name: 'Rewind', cd: 'MAX' }
          ];
          for (let i = 0; i < 3; i++) {
            const ab = activeRelics[i];
            const btn = document.createElement('button');
            btn.className = 'ability ability-btn';
            btn.setAttribute('data-relic', ab.id);
            const iconWrap = document.createElement('div');
            iconWrap.className = 'icon ability-btn-icon-wrap';
            const img = document.createElement('img');
            img.src = 'icons/' + ab.file;
            img.className = 'relic-svg relic-icon-img';
            iconWrap.appendChild(img);
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = ab.name.toUpperCase();
            const pips = document.createElement('div');
            pips.className = 'pips ability-pips';
            pips.innerHTML = '<span class="pip charge-pip on filled"></span>';
            btn.appendChild(iconWrap);
            btn.appendChild(nameEl);
            btn.appendChild(pips);
            abilityBar.appendChild(btn);
          }

          const board = document.getElementById('game-board');
          const nonStuckTop = board.getBoundingClientRect().top;

          // Enter stuck state
          const statusHintBar = document.getElementById('status-hint-bar');
          const statusHintText = document.getElementById('status-hint-text');
          if (statusHintBar) {
            statusHintBar.classList.add('stuck-warning');
            if (statusHintText) statusHintText.textContent = 'No moves left — use an ability!';
          }
          const stuckBanner = document.getElementById('stuck-banner');
          if (stuckBanner) stuckBanner.classList.add('hidden');

          const stuckTop = board.getBoundingClientRect().top;
          const abRect = abilityBar.getBoundingClientRect();
          const scrollH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          const innerH = window.innerHeight;

          // Check 1: Stuck Normal
          const normalMetrics = {
            mode: 'Stuck (Normal)',
            vp: '${vp.width}x${vp.height}',
            width: ${vp.width},
            height: ${vp.height},
            nonStuckTop: Math.round(nonStuckTop * 10) / 10,
            stuckTop: Math.round(stuckTop * 10) / 10,
            boardTopEqual: Math.abs(stuckTop - nonStuckTop) < 0.5,
            abBottom: Math.round(abRect.bottom),
            innerH,
            abilityBarFits: abRect.bottom <= innerH,
            cancelInsideSlot: true,
            scrollH,
            noScroll: scrollH <= innerH,
          };

          // Check 2: Stuck + Eraser targeting
          const btnCancel = document.getElementById('btn-cancel-targeting');
          if (btnCancel) btnCancel.classList.remove('hidden');
          if (statusHintBar) {
            statusHintBar.classList.remove('stuck-warning');
            if (statusHintText) statusHintText.textContent = 'Tap a number tile to erase it.';
          }
          if (board) board.classList.add('targeting-dim');

          const eraserTop = board.getBoundingClientRect().top;
          const eraserAbRect = abilityBar.getBoundingClientRect();
          const eraserCancelRect = btnCancel ? btnCancel.getBoundingClientRect() : null;
          const slotRect = statusHintBar ? statusHintBar.getBoundingClientRect() : null;
          const eraserCancelInside = eraserCancelRect && slotRect &&
            eraserCancelRect.top >= slotRect.top - 0.5 &&
            eraserCancelRect.bottom <= slotRect.bottom + 0.5;

          const eraserMetrics = {
            mode: 'Stuck + Eraser',
            vp: '${vp.width}x${vp.height}',
            width: ${vp.width},
            height: ${vp.height},
            nonStuckTop: Math.round(nonStuckTop * 10) / 10,
            stuckTop: Math.round(eraserTop * 10) / 10,
            boardTopEqual: Math.abs(eraserTop - nonStuckTop) < 0.5,
            abBottom: Math.round(eraserAbRect.bottom),
            innerH,
            abilityBarFits: eraserAbRect.bottom <= innerH,
            cancelInsideSlot: Boolean(eraserCancelInside),
            scrollH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
            noScroll: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) <= innerH,
          };

          // Check 3: Stuck + Diagonal targeting
          if (statusHintText) statusHintText.textContent = 'Tap a tile to move, then an equal diagonal tile.';
          const diagTop = board.getBoundingClientRect().top;
          const diagAbRect = abilityBar.getBoundingClientRect();
          const diagCancelRect = btnCancel ? btnCancel.getBoundingClientRect() : null;
          const diagSlotRect = statusHintBar ? statusHintBar.getBoundingClientRect() : null;
          const diagCancelInside = diagCancelRect && diagSlotRect &&
            diagCancelRect.top >= diagSlotRect.top - 0.5 &&
            diagCancelRect.bottom <= diagSlotRect.bottom + 0.5;

          const diagMetrics = {
            mode: 'Stuck + Diagonal',
            vp: '${vp.width}x${vp.height}',
            width: ${vp.width},
            height: ${vp.height},
            nonStuckTop: Math.round(nonStuckTop * 10) / 10,
            stuckTop: Math.round(diagTop * 10) / 10,
            boardTopEqual: Math.abs(diagTop - nonStuckTop) < 0.5,
            abBottom: Math.round(diagAbRect.bottom),
            innerH,
            abilityBarFits: diagAbRect.bottom <= innerH,
            cancelInsideSlot: Boolean(diagCancelInside),
            scrollH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
            noScroll: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) <= innerH,
          };

          return [normalMetrics, eraserMetrics, diagMetrics];
        })()
      `);

      for (const m of stuckMetrics) {
        stuckResults.push(m);
        if (!m.boardTopEqual) {
          console.error(`FAIL stuck boardTopEqual for ${m.mode} at ${vp.width}x${vp.height}: stuckTop=${m.stuckTop}, nonStuck=${m.nonStuckTop}`);
          allPassed = false;
        }
        if (!m.abilityBarFits) {
          console.error(`FAIL stuck abilityBarFits for ${m.mode} at ${vp.width}x${vp.height}: abBottom=${m.abBottom}, innerH=${m.innerH}`);
          allPassed = false;
        }
        if (!m.cancelInsideSlot) {
          console.error(`FAIL cancelInsideSlot for ${m.mode} at ${vp.width}x${vp.height}`);
          allPassed = false;
        }
        if (!m.noScroll) {
          console.error(`FAIL stuck noScroll for ${m.mode} at ${vp.width}x${vp.height}: scrollH=${m.scrollH}, innerH=${m.innerH}`);
          allPassed = false;
        }
      }
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

  console.log('============================================== STUCK-STATE & TARGETING LAYOUT RESULTS ==============================================');
  console.log('Viewport | State Mode       | Non-Stuck Top | State Top | Board Top Equal | Ab Bar Bottom | Fits Height | Cancel In Slot | No Scroll');
  console.log('-------------------------------------------------------------------------------------------------------------------------------------');
  for (const s of stuckResults) {
    const vp = `${s.vp}`.padEnd(8);
    const mod = `${s.mode}`.padEnd(16);
    const nst = `${s.nonStuckTop}px`.padEnd(13);
    const st = `${s.stuckTop}px`.padEnd(9);
    const bte = (s.boardTopEqual ? 'PASS' : 'FAIL').padEnd(15);
    const abb = `${s.abBottom}px`.padEnd(13);
    const abf = (s.abilityBarFits ? 'PASS' : 'FAIL').padEnd(11);
    const cis = (s.cancelInsideSlot ? 'PASS' : 'FAIL').padEnd(14);
    const nos = s.noScroll ? 'PASS' : 'FAIL';
    console.log(`${vp} | ${mod} | ${nst} | ${st} | ${bte} | ${abb} | ${abf} | ${cis} | ${nos}`);
  }
  console.log('=====================================================================================================================================\n');

  if (!allPassed) {
    console.error('❌ Layout check assertions failed!');
    process.exit(1);
  } else {
    console.log('✔ All layout assertions passed across all widths, countdowns, passive icons, and ability states.');
    console.log('✔ Tooltip popover confirmed within 320px viewport with role="tooltip".');
    console.log('✔ Stuck-state layout invariant confirmed across 390x742, 360x640, and 430x844.\n');
  }
}

runLayoutCheck().catch(err => {
  console.error(err);
  process.exit(1);
});
