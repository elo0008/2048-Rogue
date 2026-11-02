/**
 * 2048 Rogue - Developer Animation Lab (dev-only module)
 * Pure client-side ES module loaded only in development when ?lab=1 or sessionStorage flag is set.
 */

let labApi = null;
let currentPresetId = 1;
let customTargetValue = 2048;
let loopCount = 1;
let holdPhase = 'none';
let currentSpeed = 1.0;
let isHolding = false;
let pausedTimers = [];
let autoHideSheet = true;

// Presets registry
const PRESETS = {
  1: {
    id: 1,
    name: '1 Crowded',
    desc: 'Crowded board: 2x 1024 + 512 + 256 + 3 stones + small tiles (>= 14 destroyed).',
    isCleanSlate: true,
    spec: {
      board: [
        1024, 1024, 512, 256,
        128, 64, 32, 16,
        8, 4, 2, 'S',
        'S', 'S', 4, 8
      ],
      relics: [],
      charges: {},
      moveCount: 15,
      movesSinceLastStone: 3,
    },
    action: () => labApi.triggerSwipe('L')
  },
  2: {
    id: 2,
    name: '2 Sparse',
    desc: 'Sparse board: two 1024 tiles and nothing else.',
    isCleanSlate: true,
    spec: {
      board: [
        1024, 1024, null, null,
        null, null, null, null,
        null, null, null, null,
        null, null, null, null
      ],
      relics: [],
      charges: {},
      moveCount: 15,
      movesSinceLastStone: 3,
    },
    action: () => labApi.triggerSwipe('L')
  },
  3: {
    id: 3,
    name: '3 4096',
    desc: '4096 merger: expects banner "4096" + "Touch Grass".',
    isCleanSlate: true,
    spec: {
      board: [
        2048, 2048, 128, 64,
        32, 16, null, null,
        null, null, null, null,
        null, null, null, null
      ],
      relics: [],
      charges: {},
      moveCount: 50,
      movesSinceLastStone: 3,
    },
    action: () => labApi.triggerSwipe('L')
  },
  4: {
    id: 4,
    name: '4 2048',
    desc: '2048 merger: expects banner "2048" + "We Won".',
    isCleanSlate: true,
    spec: {
      board: [
        1024, 1024, 64, null,
        null, null, null, null,
        null, null, null, null,
        null, null, null, null
      ],
      relics: [],
      charges: {},
      moveCount: 30,
      movesSinceLastStone: 3,
    },
    action: () => labApi.triggerSwipe('L')
  },
  5: {
    id: 5,
    name: '5 Diagonal',
    desc: 'Diagonal trigger: two diagonal 1024 + Diagonal charge.',
    isCleanSlate: true,
    spec: {
      board: [
        1024, null, 128, 64,
        null, 1024, null, null,
        null, null, null, null,
        null, null, null, null
      ],
      relics: ['diagonal_charge'],
      charges: { 'diagonal_charge': 1 },
      moveCount: 20,
      movesSinceLastStone: 3,
    },
    action: () => labApi.triggerAbility('diagonal_charge', { from: 0, to: 5 })
  },
  6: {
    id: 6,
    name: '6 Stuck',
    desc: 'Stuck trigger: board full & stuck; Diagonal 1024 pair is rescue.',
    isCleanSlate: true,
    spec: {
      board: [
        1024, 2, 4, 8,
        16, 1024, 32, 64,
        2, 4, 8, 16,
        32, 64, 128, 256
      ],
      relics: ['diagonal_charge'],
      charges: { 'diagonal_charge': 1 },
      moveCount: 40,
      movesSinceLastStone: 5,
    },
    action: () => labApi.triggerAbility('diagonal_charge', { from: 0, to: 5 })
  },
  7: {
    id: 7,
    name: '7 Draft',
    desc: 'Draft collision: trigger on move where draft is due (draft waits for ceremony).',
    isCleanSlate: true,
    spec: {
      board: [
        1024, 1024, 128, null,
        null, null, null, null,
        null, null, null, null,
        null, null, null, null
      ],
      relics: [],
      charges: {},
      moveCount: 59,
      movesSinceLastStone: 3,
      draftDue: true,
    },
    action: () => {
      const c = labApi.getController();
      if (c) {
        c.config.enableDraft = true;
        c.config.draftEveryMoves = 60;
        c.moveCount = 59;
      }
      labApi.triggerSwipe('L');
    }
  },
  8: {
    id: 8,
    name: '8 Rewind',
    desc: 'Rewind wave preview: move then rewind with diagonal wave animation.',
    isCleanSlate: false,
    spec: {
      board: [
        null, null, null, null,
        null, null, null, null,
        4, 4, null, null,
        8, 8, null, null
      ],
      relics: ['rewind'],
      charges: { 'rewind': 3 },
      moveCount: 5,
      movesSinceLastStone: 2,
    },
    action: async () => {
      labApi.triggerSwipe('U');
      await new Promise(r => setTimeout(r, 260));
      labApi.triggerRewind();
    }
  },
  9: {
    id: 9,
    name: '9 Custom',
    desc: 'Custom value merger: pick target value and merge.',
    isCleanSlate: true,
    spec: null, // dynamic
    action: () => labApi.triggerSwipe('L')
  }
};

function getCustomSpec(val) {
  const half = val / 2;
  return {
    board: [
      half, half, 128, 64,
      null, null, null, null,
      null, null, null, null,
      null, null, null, null
    ],
    ascensionAt: val,
    relics: [],
    charges: {},
    moveCount: 40,
    movesSinceLastStone: 3,
  };
}

// WAAPI slow-motion hook
let origAnimate = null;
function setupAnimationHook() {
  if (origAnimate) return;
  origAnimate = Element.prototype.animate;
  Element.prototype.animate = function(keyframes, options) {
    const anim = origAnimate.call(this, keyframes, options);
    if (currentSpeed !== 1.0 && currentPresetId === 8) {
      try {
        anim.playbackRate = currentSpeed;
      } catch {}
    }
    return anim;
  };
}

// Media Query hook for reduced motion
let origMatchMedia = null;
let reducedMotionOverride = false;
function setupMatchMediaHook() {
  if (origMatchMedia) return;
  origMatchMedia = window.matchMedia;
  window.matchMedia = function(query) {
    if (query === '(prefers-reduced-motion: reduce)' && reducedMotionOverride) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    }
    return origMatchMedia.call(window, query);
  };
}

export function initLab(api) {
  labApi = api;
  window.__ROGUE_LAB__ = {
    handlePhase,
    stagePreset,
    triggerCurrent,
    getState: () => ({ currentPresetId, holdPhase, currentSpeed, isHolding })
  };

  setupAnimationHook();
  setupMatchMediaHook();

  // Inject stylesheet
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './dev/lab.css';
  document.head.appendChild(link);

  // Mount UI elements
  mountUI();

  // Stage default preset 1
  stagePreset(1);
}

function mountUI() {
  // 1. Collapsed handle at bottom-left
  const handle = document.createElement('button');
  handle.id = 'rogue-lab-handle';
  handle.setAttribute('type', 'button');
  handle.setAttribute('aria-label', 'Open Developer Animation Lab');
  handle.textContent = 'LAB';
  document.body.appendChild(handle);

  // 2. Bottom sheet
  const sheet = document.createElement('div');
  sheet.id = 'rogue-lab-sheet';
  sheet.className = 'collapsed';
  sheet.innerHTML = `
    <div class="lab-header">
      <div class="lab-title">
        <span>⚡ ANIMATION LAB</span>
      </div>
      <div class="lab-header-actions">
        <button type="button" class="lab-btn-exit" id="lab-exit-btn">Exit Lab</button>
        <button type="button" class="lab-btn-close" id="lab-close-btn" aria-label="Close">✕</button>
      </div>
    </div>

    <div class="lab-section-title">Presets</div>
    <div class="lab-presets-grid" id="lab-presets-grid"></div>

    <div class="lab-custom-picker" id="lab-custom-picker" style="display:none;">
      <button type="button" class="lab-custom-btn" data-val="1024">1024</button>
      <button type="button" class="lab-custom-btn active" data-val="2048">2048</button>
      <button type="button" class="lab-custom-btn" data-val="4096">4096</button>
      <button type="button" class="lab-custom-btn" data-val="8192">8192</button>
    </div>

    <div class="lab-preset-desc" id="lab-preset-desc"></div>

    <div class="lab-actions-row">
      <button type="button" class="lab-btn-trigger" id="lab-trigger-btn">TRIGGER</button>
      <button type="button" class="lab-btn-replay" id="lab-replay-btn">REPLAY</button>
      <div class="lab-loop-wrap">
        <span>Loop</span>
        <select class="lab-loop-select" id="lab-loop-select">
          <option value="1">x1</option>
          <option value="2">x2</option>
          <option value="3">x3</option>
          <option value="5">x5</option>
          <option value="10">x10</option>
        </select>
      </div>
    </div>

    <div class="lab-controls-row">
      <div class="lab-control-group">
        <label for="lab-hold-select">Hold at Phase</label>
        <select class="lab-select" id="lab-hold-select">
          <option value="none">None</option>
          <option value="banner">Banner (T=0)</option>
          <option value="charge">Charge (T=2000)</option>
          <option value="ring">Ring (T=2450)</option>
          <option value="breaks">Breaks</option>
          <option value="payout">Payout</option>
        </select>
        <button type="button" class="lab-resume-btn" id="lab-resume-btn" style="display:none;">RESUME ▶</button>
      </div>

      <div class="lab-control-group">
        <label for="lab-speed-select">Speed (Slow-Mo)</label>
        <select class="lab-select" id="lab-speed-select">
          <option value="1">1x Normal</option>
          <option value="0.5">0.5x</option>
          <option value="0.25">0.25x (4x slow)</option>
          <option value="0.1">0.1x (10x slow)</option>
        </select>
      </div>
    </div>

    <div class="lab-warning-note" id="lab-timer-warning" style="display:none;">
      ⚠ Clean Slate phase starts depend on setTimeout (app.js:1311, 1327, 1333, 1343, 1402, 1429, 1451). Slow-motion is disabled for Clean Slate presets. Hold-at-phase remains active.
    </div>

    <div class="lab-toggles-row">
      <label class="lab-checkbox-label">
        <input type="checkbox" id="lab-reduced-motion-cb"> Reduced Motion
      </label>
      <label class="lab-checkbox-label">
        <input type="checkbox" id="lab-autohide-cb" checked> Auto-hide sheet
      </label>
    </div>
  `;
  document.body.appendChild(sheet);

  // Populate presets grid
  const grid = sheet.querySelector('#lab-presets-grid');
  for (let id = 1; id <= 9; id++) {
    const p = PRESETS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lab-preset-btn ${id === 1 ? 'active' : ''}`;
    btn.textContent = p.name;
    btn.dataset.presetId = id;
    btn.addEventListener('click', () => {
      stagePreset(id);
    });
    grid.appendChild(btn);
  }

  // Handle open/close
  handle.addEventListener('click', () => {
    sheet.classList.toggle('collapsed');
  });

  const closeBtn = sheet.querySelector('#lab-close-btn');
  closeBtn.addEventListener('click', () => {
    sheet.classList.add('collapsed');
  });

  // Exit lab
  const exitBtn = sheet.querySelector('#lab-exit-btn');
  exitBtn.addEventListener('click', () => {
    try {
      window.sessionStorage.removeItem('2048_rogue_lab');
    } catch {}
    window.location.href = window.location.pathname;
  });

  // Custom picker buttons
  const customBtns = sheet.querySelectorAll('.lab-custom-btn');
  customBtns.forEach(b => {
    b.addEventListener('click', () => {
      customBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      customTargetValue = parseInt(b.dataset.val, 10);
      stagePreset(9);
    });
  });

  // Trigger button
  const triggerBtn = sheet.querySelector('#lab-trigger-btn');
  triggerBtn.addEventListener('click', () => {
    triggerCurrent();
  });

  // Replay button
  const replayBtn = sheet.querySelector('#lab-replay-btn');
  replayBtn.addEventListener('click', () => {
    stagePreset(currentPresetId);
    setTimeout(() => triggerCurrent(), 60);
  });

  // Loop select
  const loopSelect = sheet.querySelector('#lab-loop-select');
  loopSelect.addEventListener('change', (e) => {
    loopCount = parseInt(e.target.value, 10);
  });

  // Hold select
  const holdSelect = sheet.querySelector('#lab-hold-select');
  holdSelect.addEventListener('change', (e) => {
    holdPhase = e.target.value;
    if (holdPhase === 'none' && isHolding) {
      resumeHeldPhase();
    }
  });

  // Resume button
  const resumeBtn = sheet.querySelector('#lab-resume-btn');
  resumeBtn.addEventListener('click', () => {
    resumeHeldPhase();
  });

  // Speed select
  const speedSelect = sheet.querySelector('#lab-speed-select');
  const timerWarning = sheet.querySelector('#lab-timer-warning');
  speedSelect.addEventListener('change', (e) => {
    currentSpeed = parseFloat(e.target.value);
    updateWarningDisplay();
  });

  // Reduced motion
  const reducedMotionCb = sheet.querySelector('#lab-reduced-motion-cb');
  reducedMotionCb.addEventListener('change', (e) => {
    reducedMotionOverride = e.target.checked;
    if (labApi.setReducedMotionOverride) {
      labApi.setReducedMotionOverride(reducedMotionOverride);
    }
  });

  // Auto-hide
  const autoHideCb = sheet.querySelector('#lab-autohide-cb');
  autoHideCb.addEventListener('change', (e) => {
    autoHideSheet = e.target.checked;
  });
}

function updateWarningDisplay() {
  const sheet = document.getElementById('rogue-lab-sheet');
  if (!sheet) return;
  const timerWarning = sheet.querySelector('#lab-timer-warning');
  const p = PRESETS[currentPresetId];
  if (currentSpeed !== 1.0 && p && p.isCleanSlate) {
    timerWarning.style.display = 'block';
  } else {
    timerWarning.style.display = 'none';
  }
}

export function stagePreset(id) {
  currentPresetId = id;
  const p = PRESETS[id];
  if (!p) return;

  const sheet = document.getElementById('rogue-lab-sheet');
  if (sheet) {
    sheet.querySelectorAll('.lab-preset-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.presetId, 10) === id);
    });
    const descEl = sheet.querySelector('#lab-preset-desc');
    if (descEl) descEl.textContent = p.desc;

    const customPicker = sheet.querySelector('#lab-custom-picker');
    if (customPicker) {
      customPicker.style.display = id === 9 ? 'flex' : 'none';
    }
  }

  updateWarningDisplay();

  const spec = id === 9 ? getCustomSpec(customTargetValue) : p.spec;
  labApi.stage(spec);
}

let isRunningSequence = false;
export async function triggerCurrent() {
  if (isRunningSequence) return;
  isRunningSequence = true;

  const sheet = document.getElementById('rogue-lab-sheet');
  if (autoHideSheet && sheet) {
    sheet.classList.add('collapsed');
  }

  const iterations = loopCount || 1;
  for (let i = 0; i < iterations; i++) {
    if (i > 0) {
      stagePreset(currentPresetId);
      await new Promise(r => setTimeout(r, 100));
    }

    const p = PRESETS[currentPresetId];
    await p.action();

    // Wait for ceremony or animation to complete
    await waitForSequenceCompletion();
  }

  isRunningSequence = false;
  if (autoHideSheet && sheet) {
    sheet.classList.remove('collapsed');
  }
}

async function waitForSequenceCompletion() {
  await new Promise(r => setTimeout(r, 300));
  return new Promise((resolve) => {
    let checkInterval = setInterval(() => {
      const cs = labApi.getCleanSlateState();
      const rd = window.rewindDirector && window.rewindDirector.isActive();
      const anims = document.getAnimations();
      const hasRunningAnims = anims.some(a => a.playState === 'running');
      if (!cs && !rd && !hasRunningAnims && !isHolding) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 50);
  });
}

function handlePhase(phaseName, data) {
  if (holdPhase === phaseName && !isHolding) {
    isHolding = true;

    // Pause all WAAPI animations
    const runningAnims = document.getAnimations().filter(a => a.playState === 'running');
    runningAnims.forEach(a => a.pause());

    // Freeze pending timers in cleanSlateSequenceState
    const state = data?.state || labApi.getCleanSlateState();
    if (state && Array.isArray(state.timers)) {
      const now = performance.now();
      pausedTimers = [...state.timers];
    }

    // Show Resume button in sheet
    const sheet = document.getElementById('rogue-lab-sheet');
    if (sheet) {
      const resumeBtn = sheet.querySelector('#lab-resume-btn');
      if (resumeBtn) resumeBtn.style.display = 'block';
      // If auto-hide was on, reveal sheet so user can inspect and resume
      sheet.classList.remove('collapsed');
    }
  }

  if (phaseName === 'end') {
    isHolding = false;
    const sheet = document.getElementById('rogue-lab-sheet');
    if (sheet) {
      const resumeBtn = sheet.querySelector('#lab-resume-btn');
      if (resumeBtn) resumeBtn.style.display = 'none';
    }
  }
}

function resumeHeldPhase() {
  if (!isHolding) return;
  isHolding = false;

  // Resume all paused WAAPI animations
  const pausedAnims = document.getAnimations().filter(a => a.playState === 'paused');
  pausedAnims.forEach(a => a.play());

  // Hide Resume button
  const sheet = document.getElementById('rogue-lab-sheet');
  if (sheet) {
    const resumeBtn = sheet.querySelector('#lab-resume-btn');
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (autoHideSheet && isRunningSequence) {
      sheet.classList.add('collapsed');
    }
  }
}
