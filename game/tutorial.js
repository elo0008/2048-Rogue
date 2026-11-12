/**
 * Rogue 2048 — Interactive Tutorial
 * Plain script, zero dependencies.
 */
(function() {
  'use strict';

  const STORAGE_KEY_SEEN = '2048_rogue_tutorial_seen';

  const TUTORIAL_STEPS = [
    {
      step: 1,
      title: 'SWIPE AND MERGE',
      caption: 'Swipe to slide tiles. Equal tiles merge.',
      counter: 'STEP 1 OF 3'
    },
    {
      step: 2,
      title: 'WATCH OUT FOR STONES',
      caption: "Stones don't move or merge. They're the clock. Survive as long as you can.",
      counter: 'STEP 2 OF 3'
    },
    {
      step: 3,
      title: 'RELICS AND ABILITIES',
      caption: 'Every 60 moves, pick a relic. Abilities are free actions.',
      counter: 'STEP 3 OF 3'
    }
  ];

  // Fallback relic data if app.js is not yet initialized
  let relicProvider = {
    RELIC_NAMES: {
      diagonal_charge: 'Diagonal Merge',
      eraser: 'Eraser',
      rewind: 'Rewind',
      shatter: 'Shatter',
      last_stand: 'Last Stand',
      diagonal_merge: 'Diagonal Merge'
    },
    getRelicOneLiner: function(id) {
      if (id === 'shatter') return 'A merge that creates a 64+ tile destroys every stone touching it.';
      if (id === 'diagonal_charge' || id === 'diagonal_merge') return 'Charge: merge two equal tiles touching diagonally (you pick). Holds up to 3; +1 every 10 moves. Costs no move.';
      if (id === 'last_stand') return "Once per run, when you'd lose, all tiles of 16 or less vanish and you play on.";
      if (id === 'eraser') return 'Charge: remove any one tile. Holds up to 3; +1 every 20 moves. Costs no move.';
      if (id === 'rewind') return 'Charge: undo your last swipe. Holds up to 3; +1 every 10 moves. Costs no move.';
      return '';
    },
    ICON_MAP: {
      shatter: 'icons/shatter.svg',
      diagonal_charge: 'icons/diagonal_merge.svg',
      diagonal_merge: 'icons/diagonal_merge.svg',
      last_stand: 'icons/last_stand.svg',
      eraser: 'icons/eraser.svg',
      rewind: 'icons/rewind.svg'
    },
    isAbility: function(id) {
      return id === 'diagonal_charge' || id === 'diagonal_merge' || id === 'eraser' || id === 'rewind';
    }
  };

  let currentStep = 0;
  let activeOrigin = 'start'; // 'first-visit' | 'start' | 'pause'
  let isReducedMotion = false;
  let previousActiveElement = null;
  let activeTimers = [];

  // Step 2 internal state
  let step2CurrentMove = 0;
  let step2AutoplayActive = true;
  let isStep2Animating = false;
  let isStep2Resetting = false;

  function safeGetStorage(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function safeSetStorage(key, val) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(key, val);
      }
    } catch {}
  }

  function isTutorialSeen() {
    return safeGetStorage(STORAGE_KEY_SEEN) === 'true';
  }

  function markTutorialSeen() {
    safeSetStorage(STORAGE_KEY_SEEN, 'true');
  }

  function clearAllTimers() {
    for (let i = 0; i < activeTimers.length; i++) {
      clearTimeout(activeTimers[i]);
    }
    activeTimers = [];
  }

  function addTimer(fn, delay) {
    const id = setTimeout(fn, delay);
    activeTimers.push(id);
    return id;
  }

  function getCellMetric(gridId, row, col) {
    const grid = document.getElementById(gridId);
    if (grid) {
      const cells = grid.querySelectorAll('.mini-cell');
      const cellIdx = row * 4 + col;
      const cell = cells[cellIdx];
      const layer = grid.querySelector('.tiles-overlay-layer');
      if (cell && layer) {
        const cr = cell.getBoundingClientRect();
        const lr = layer.getBoundingClientRect();
        if (cr.width > 0 && lr.width > 0) {
          const left = Math.round((cr.left - lr.left) * 10) / 10;
          const top = Math.round((cr.top - lr.top) * 10) / 10;
          const width = Math.round(cr.width * 10) / 10;
          const height = Math.round(cr.height * 10) / 10;
          return {
            left,
            top,
            width,
            height,
            css: `left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px;`
          };
        }
      }
    }
    const leftPct = col * 25;
    const topPct = row * 25;
    return {
      left: `calc(${leftPct}% + ${col * 1.5}px)`,
      top: `calc(${topPct}% + ${row * 1.5}px)`,
      width: 'calc((100% - 18px)/4)',
      height: 'calc((100% - 18px)/4)',
      css: `left: calc(${leftPct}% + ${col * 1.5}px); top: calc(${topPct}% + ${row * 1.5}px); width: calc((100% - 18px)/4); height: calc((100% - 18px)/4);`
    };
  }

  function positionElementFromCell(el, gridId, row, col, immediate) {
    if (!el) return;
    el.dataset.row = String(row);
    el.dataset.col = String(col);
    const m = getCellMetric(gridId, row, col);
    if (immediate) {
      el.style.transition = 'none';
    }
    if (typeof m.left === 'number') {
      el.style.left = `${m.left}px`;
      el.style.top = `${m.top}px`;
      el.style.width = `${m.width}px`;
      el.style.height = `${m.height}px`;
    } else {
      el.style.left = m.left;
      el.style.top = m.top;
      el.style.width = m.width;
      el.style.height = m.height;
    }
    if (immediate) {
      void el.offsetWidth;
      el.style.transition = '';
    }
  }

  function repositionTutorialElements() {
    const pairs = [
      { layerId: 'step1-tiles-layer', gridId: 'grid-step-1' },
      { layerId: 'step2-tiles-layer', gridId: 'grid-step-2' }
    ];
    for (let i = 0; i < pairs.length; i++) {
      const layer = document.getElementById(pairs[i].layerId);
      if (!layer) continue;
      const items = layer.querySelectorAll('.tut-demo-tile, .tut-demo-stone, .tut-stone-landing-ring');
      for (let j = 0; j < items.length; j++) {
        const el = items[j];
        const r = parseInt(el.dataset.row, 10);
        const c = parseInt(el.dataset.col, 10);
        if (Number.isInteger(r) && Number.isInteger(c)) {
          positionElementFromCell(el, pairs[i].gridId, r, c, true);
        }
      }
    }
  }

  // --- STEP 1: 2+2 SWIPE AND MERGE LOOP ---
  function runStep1Sequence() {
    clearAllTimers();
    const layer = document.getElementById('step1-tiles-layer');
    const pointer = document.getElementById('step1-pointer-indicator');
    if (!layer || !pointer) return;

    layer.classList.remove('tut-layer-fading-out', 'tut-layer-fading-in');
    layer.textContent = '';
    pointer.classList.remove('visible');
    pointer.style.opacity = '0';
    pointer.style.transform = 'translate(-70px, -50%)';

    const m23 = getCellMetric('grid-step-1', 2, 3);
    const m31 = getCellMetric('grid-step-1', 3, 1);

    if (isReducedMotion) {
      const tileMerged = document.createElement('div');
      tileMerged.className = 'tut-demo-tile tile-4';
      tileMerged.dataset.row = '2';
      tileMerged.dataset.col = '3';
      tileMerged.style.cssText = m23.css;
      tileMerged.textContent = '4';
      layer.appendChild(tileMerged);

      const tileSpawned = document.createElement('div');
      tileSpawned.className = 'tut-demo-tile tile-2';
      tileSpawned.dataset.row = '3';
      tileSpawned.dataset.col = '1';
      tileSpawned.style.cssText = m31.css;
      tileSpawned.textContent = '2';
      layer.appendChild(tileSpawned);
      return;
    }

    // Initial setup: two 2 tiles at (2,0) and (2,2)
    const m20 = getCellMetric('grid-step-1', 2, 0);
    const m22 = getCellMetric('grid-step-1', 2, 2);

    const tileA = document.createElement('div');
    tileA.className = 'tut-demo-tile tile-2';
    tileA.dataset.row = '2';
    tileA.dataset.col = '0';
    tileA.style.cssText = m20.css;
    tileA.textContent = '2';

    const tileB = document.createElement('div');
    tileB.className = 'tut-demo-tile tile-2';
    tileB.dataset.row = '2';
    tileB.dataset.col = '2';
    tileB.style.cssText = m22.css;
    tileB.textContent = '2';

    layer.appendChild(tileA);
    layer.appendChild(tileB);

    // 0.4s: Pointer appears at center-left
    addTimer(() => {
      pointer.style.transform = 'translate(-70px, -50%)';
      pointer.classList.add('visible');
      pointer.style.opacity = '1';
    }, 400);

    // 0.8s: Pointer slides smoothly to right
    addTimer(() => {
      pointer.style.transform = 'translate(60px, -50%)';
    }, 800);

    // 1.35s: Pointer fades out as tiles slide with crisp curve
    addTimer(() => {
      pointer.classList.remove('visible');
      pointer.style.opacity = '0';
      const curM23 = getCellMetric('grid-step-1', 2, 3);
      const destLeft = typeof curM23.left === 'number' ? `${curM23.left}px` : curM23.left;
      tileA.dataset.col = '3';
      tileB.dataset.col = '3';
      tileA.style.left = destLeft;
      tileB.style.left = destLeft;
      tileA.style.opacity = '0.85';
    }, 1350);

    // 1.6s: Convergence pop into 4, instant appearance of new 2 (no spawn animation)
    addTimer(() => {
      const curM23 = getCellMetric('grid-step-1', 2, 3);
      const curM31 = getCellMetric('grid-step-1', 3, 1);
      layer.textContent = '';
      const tileMerged = document.createElement('div');
      tileMerged.className = 'tut-demo-tile tile-4 tut-tile-merge-pop';
      tileMerged.dataset.row = '2';
      tileMerged.dataset.col = '3';
      tileMerged.style.cssText = curM23.css;
      tileMerged.textContent = '4';
      layer.appendChild(tileMerged);

      const tileSpawned = document.createElement('div');
      tileSpawned.className = 'tut-demo-tile tile-2';
      tileSpawned.dataset.row = '3';
      tileSpawned.dataset.col = '1';
      tileSpawned.style.cssText = curM31.css;
      tileSpawned.textContent = '2';
      layer.appendChild(tileSpawned);
    }, 1600);

    // 3.2s: Smooth dissolve back to initial state
    addTimer(() => {
      layer.classList.add('tut-layer-fading-out');
      addTimer(() => {
        runStep1Sequence();
      }, 240);
    }, 3200);
  }

  // --- STEP 2: STONES AS HAZARDS & CLOCK ---
  const STEP2_BOARD_STATES = [
    // Move 0: Initial clean state (8 tiles, movesLeft 3)
    {
      movesLeft: 3,
      fill: '25%',
      warning: false,
      tiles: [
        { id: 't1', val: 2, row: 0, col: 0 },
        { id: 't2', val: 2, row: 0, col: 1 },
        { id: 't3', val: 4, row: 0, col: 2 },
        { id: 't4', val: 8, row: 0, col: 3 },
        { id: 't5', val: 4, row: 1, col: 0 },
        { id: 't6', val: 16, row: 1, col: 1 },
        { id: 't7', val: 32, row: 2, col: 0 },
        { id: 't8', val: 64, row: 3, col: 0 }
      ],
      hasStone: false
    },
    // Move 1: Swipe LEFT (two 2s merge into 4 at 0,0, new 2 spawns at 0,3)
    {
      movesLeft: 2,
      fill: '50%',
      warning: false,
      tiles: [
        { id: 't1_merge', val: 4, row: 0, col: 0, merged: true, prevIds: ['t1', 't2'] },
        { id: 't3', val: 4, row: 0, col: 1 },
        { id: 't4', val: 8, row: 0, col: 2 },
        { id: 't_spawn1', val: 2, row: 0, col: 3, spawned: true },
        { id: 't5', val: 4, row: 1, col: 0 },
        { id: 't6', val: 16, row: 1, col: 1 },
        { id: 't7', val: 32, row: 2, col: 0 },
        { id: 't8', val: 64, row: 3, col: 0 }
      ],
      hasStone: false
    },
    // Move 2: Swipe UP (two 4s in col 0 merge into 8 at 0,0, new 4 spawns at 3,3)
    {
      movesLeft: 1,
      fill: '75%',
      warning: true,
      tiles: [
        { id: 't2_merge', val: 8, row: 0, col: 0, merged: true, prevIds: ['t1_merge', 't5'] },
        { id: 't3', val: 4, row: 0, col: 1 },
        { id: 't4', val: 8, row: 0, col: 2 },
        { id: 't_spawn1', val: 2, row: 0, col: 3 },
        { id: 't7', val: 32, row: 1, col: 0 },
        { id: 't6', val: 16, row: 1, col: 1 },
        { id: 't8', val: 64, row: 2, col: 0 },
        { id: 't_spawn2', val: 4, row: 3, col: 3, spawned: true }
      ],
      hasStone: false
    },
    // Move 3: Swipe RIGHT (tiles compress rightward, tile spawns at 2,0, Stone drops into 1,1)
    {
      movesLeft: 0,
      fill: '100%',
      warning: true,
      tiles: [
        { id: 't2_merge', val: 8, row: 0, col: 0 },
        { id: 't3', val: 4, row: 0, col: 1 },
        { id: 't4', val: 8, row: 0, col: 2 },
        { id: 't_spawn1', val: 2, row: 0, col: 3 },
        { id: 't7', val: 32, row: 1, col: 2 },
        { id: 't6', val: 16, row: 1, col: 3 },
        { id: 't8', val: 64, row: 2, col: 3 },
        { id: 't_spawn2', val: 4, row: 3, col: 3 },
        { id: 't_spawn3', val: 2, row: 2, col: 0, spawned: true }
      ],
      hasStone: true,
      stoneRow: 1,
      stoneCol: 1
    }
  ];

  function updateStep2Telegraph(movesLeft, fillPercent, isWarning) {
    const countEl = document.getElementById('step2-stone-count');
    const unitEl = document.getElementById('step2-stone-unit');
    const fillEl = document.getElementById('step2-fill');
    const teleEl = document.getElementById('step2-telegraph');

    if (countEl) countEl.textContent = String(movesLeft);
    if (unitEl) unitEl.textContent = (movesLeft === 1) ? 'move' : 'moves';
    if (fillEl) fillEl.style.width = fillPercent;
    if (teleEl) teleEl.classList.toggle('warning', Boolean(isWarning));
  }

  function createStep2TileEl(t, allowMergePop) {
    const tile = document.createElement('div');
    let classNames = `tut-demo-tile tile-${t.val}`;
    if (allowMergePop && t.merged) classNames += ' tut-tile-merge-pop';
    tile.className = classNames;
    tile.id = `step2-tile-${t.id}`;
    tile.dataset.row = String(t.row);
    tile.dataset.col = String(t.col);
    tile.style.cssText = getCellMetric('grid-step-2', t.row, t.col).css;
    tile.textContent = String(t.val);
    return tile;
  }

  function appendStep2StoneAndRing(s, layer) {
    if (!s.hasStone || !layer || document.getElementById('step2-stone')) return;
    const sm = getCellMetric('grid-step-2', s.stoneRow, s.stoneCol);
    const stone = document.createElement('div');
    stone.className = 'tut-demo-stone';
    stone.id = 'step2-stone';
    stone.dataset.row = String(s.stoneRow);
    stone.dataset.col = String(s.stoneCol);
    stone.style.cssText = sm.css;
    layer.appendChild(stone);

    if (!isReducedMotion && s.movesLeft === 0) {
      const ring = document.createElement('div');
      ring.className = 'tut-stone-landing-ring';
      ring.dataset.row = String(s.stoneRow);
      ring.dataset.col = String(s.stoneCol);
      ring.style.cssText = sm.css;
      layer.appendChild(ring);
    }
  }

  function renderStep2State(stateIndex) {
    step2CurrentMove = stateIndex;
    const s = STEP2_BOARD_STATES[stateIndex];
    const layer = document.getElementById('step2-tiles-layer');
    if (!layer) return;

    updateStep2Telegraph(s.movesLeft, s.fill, s.warning);

    if (isReducedMotion || layer.children.length === 0 || stateIndex === 0) {
      isStep2Animating = false;
      layer.style.opacity = '1';
      layer.textContent = '';
      s.tiles.forEach(t => {
        layer.appendChild(createStep2TileEl(t, !isReducedMotion));
      });
      appendStep2StoneAndRing(s, layer);
      return;
    }

    // Smooth sliding animation
    isStep2Animating = true;
    const newTiles = [];
    const animatingTiles = [];

    s.tiles.forEach(t => {
      const tm = getCellMetric('grid-step-2', t.row, t.col);
      const destLeft = typeof tm.left === 'number' ? `${tm.left}px` : tm.left;
      const destTop = typeof tm.top === 'number' ? `${tm.top}px` : tm.top;

      if (t.merged && t.prevIds) {
        t.prevIds.forEach((pid, pidx) => {
          const el = document.getElementById(`step2-tile-${pid}`);
          if (el) {
            el.dataset.row = String(t.row);
            el.dataset.col = String(t.col);
            el.style.left = destLeft;
            el.style.top = destTop;
            if (pidx > 0) el.style.opacity = '0.75';
            animatingTiles.push(el);
          }
        });
        newTiles.push(t);
      } else {
        const el = document.getElementById(`step2-tile-${t.id}`);
        if (el) {
          el.dataset.row = String(t.row);
          el.dataset.col = String(t.col);
          el.style.left = destLeft;
          el.style.top = destTop;
        } else {
          newTiles.push(t);
        }
      }
    });

    // After tiles finish smooth glide, pop merged result & add new tiles
    addTimer(() => {
      for (let i = 0; i < animatingTiles.length; i++) {
        animatingTiles[i].remove();
      }

      newTiles.forEach(t => {
        const existing = document.getElementById(`step2-tile-${t.id}`);
        if (!existing) {
          layer.appendChild(createStep2TileEl(t, true));
        }
      });
      isStep2Animating = false;
    }, 240);

    // Stone drop when moves reach 0
    if (s.hasStone && !document.getElementById('step2-stone')) {
      addTimer(() => {
        appendStep2StoneAndRing(s, layer);
      }, 260);
    }
  }

  function transitionStep2ToInitial() {
    if (isReducedMotion) {
      renderStep2State(0);
      return;
    }

    isStep2Resetting = true;
    const layer = document.getElementById('step2-tiles-layer');
    if (!layer) return;

    layer.classList.remove('tut-layer-fading-in');
    layer.classList.add('tut-layer-fading-out');

    addTimer(() => {
      step2CurrentMove = 0;
      const s0 = STEP2_BOARD_STATES[0];
      updateStep2Telegraph(s0.movesLeft, s0.fill, s0.warning);

      layer.textContent = '';
      s0.tiles.forEach(t => {
        layer.appendChild(createStep2TileEl(t, false));
      });

      layer.classList.remove('tut-layer-fading-out');
      layer.classList.add('tut-layer-fading-in');
      isStep2Resetting = false;
      isStep2Animating = false;

      if (step2AutoplayActive) {
        scheduleNextStep2Autoplay();
      }
    }, 220);
  }

  function advanceStep2Move() {
    if (isStep2Animating || isStep2Resetting) return;

    const nextIdx = step2CurrentMove + 1;
    if (nextIdx >= STEP2_BOARD_STATES.length) {
      transitionStep2ToInitial();
    } else {
      renderStep2State(nextIdx);
      if (step2AutoplayActive) {
        scheduleNextStep2Autoplay();
      }
    }
  }

  function scheduleNextStep2Autoplay() {
    if (!step2AutoplayActive || isReducedMotion) return;
    const delay = (step2CurrentMove === 3) ? 3200 : 2000;
    addTimer(() => {
      if (currentStep === 1 && step2AutoplayActive) {
        advanceStep2Move();
      }
    }, delay);
  }

  function runStep2Sequence() {
    clearAllTimers();
    step2CurrentMove = 0;
    step2AutoplayActive = true;
    isStep2Animating = false;
    isStep2Resetting = false;

    const cue = document.getElementById('step2-interactive-cue');
    if (cue) cue.textContent = '▶ Auto-playing moves · Tap board to step';

    renderStep2State(0);

    if (!isReducedMotion) {
      scheduleNextStep2Autoplay();
    }
  }

  function handleStep2BoardClick(e) {
    if (e) e.preventDefault();
    if (isStep2Animating || isStep2Resetting) return;

    // Tap stops autoplay
    step2AutoplayActive = false;
    const cue = document.getElementById('step2-interactive-cue');
    if (cue) cue.textContent = 'Tap board to step';

    advanceStep2Move();
  }

  // --- STEP 3: RELICS AND ABILITIES ---
  function populateStep3Content() {
    const names = relicProvider.RELIC_NAMES || {};
    const oneLiner = relicProvider.getRelicOneLiner || (() => '');
    const iconMap = relicProvider.ICON_MAP || {};

    const relics = [
      { id: 'diagonal_charge', nameEl: 'draft-name-1', descEl: 'draft-desc-1', tagEl: 'draft-tag-1', iconWrapEl: 'icon-diagonal-merge', fallbackTag: 'ACTIVE' },
      { id: 'shatter', nameEl: 'draft-name-2', descEl: 'draft-desc-2', tagEl: 'draft-tag-2', iconWrapEl: 'icon-shatter', fallbackTag: 'PASSIVE' },
      { id: 'last_stand', nameEl: 'draft-name-3', descEl: 'draft-desc-3', tagEl: 'draft-tag-3', iconWrapEl: 'icon-last-stand', fallbackTag: 'PASSIVE' }
    ];

    relics.forEach(item => {
      const nEl = document.getElementById(item.nameEl);
      const dEl = document.getElementById(item.descEl);
      const tEl = document.getElementById(item.tagEl);
      const iwEl = document.getElementById(item.iconWrapEl);

      const rName = names[item.id] || item.id;
      if (nEl) nEl.textContent = rName.toUpperCase();
      if (dEl) dEl.textContent = oneLiner(item.id);

      const isAb = relicProvider.isAbility ? relicProvider.isAbility(item.id) : false;
      if (tEl) tEl.textContent = isAb ? 'ACTIVE' : 'PASSIVE';

      if (iwEl && iwEl.children.length === 0) {
        const iconSrc = iconMap[item.id] || `icons/${item.id}.svg`;
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = rName;
        img.className = 'relic-svg relic-icon-img';
        img.style.objectFit = 'contain';
        img.style.width = '100%';
        img.style.height = '100%';
        img.draggable = false;
        iwEl.appendChild(img);
      }
    });

    function parseRefillInterval(desc, fallback) {
      const m = String(desc || '').match(/\+1\s+every\s+(\d+)\s+moves?/i);
      const n = m ? parseInt(m[1], 10) : fallback;
      return (Number.isFinite(n) && n >= 1) ? n : fallback;
    }

    const abilities = [
      { id: 'diagonal_charge', nameEl: 'ability-name-1', iconWrapEl: 'icon-ability-diagonal', refillEl: 'ability-refill-1', displayName: 'DIAGONAL', defaultEvery: 10, sampleFactor: 0.4 },
      { id: 'eraser', nameEl: 'ability-name-2', iconWrapEl: 'icon-ability-eraser', refillEl: 'ability-refill-2', displayName: 'ERASER', defaultEvery: 20, sampleFactor: 0.9 },
      { id: 'rewind', nameEl: 'ability-name-3', iconWrapEl: 'icon-ability-rewind', refillEl: 'ability-refill-3', displayName: 'REWIND', defaultEvery: 10, sampleFactor: 0.7 }
    ];

    abilities.forEach(item => {
      const nEl = document.getElementById(item.nameEl);
      const iwEl = document.getElementById(item.iconWrapEl);
      const rfEl = document.getElementById(item.refillEl);

      if (nEl) nEl.textContent = item.displayName;

      if (rfEl) {
        const cardEl = rfEl.closest('.demo-ability-card');
        const totalPips = cardEl ? cardEl.querySelectorAll('.demo-pip').length : 3;
        const onPips = cardEl ? cardEl.querySelectorAll('.demo-pip.on').length : 0;
        if (totalPips > 0 && onPips >= totalPips) {
          rfEl.textContent = 'MAX';
        } else {
          const interval = parseRefillInterval(oneLiner(item.id), item.defaultEvery);
          const rem = Math.max(1, Math.min(interval, Math.round(interval * item.sampleFactor)));
          rfEl.textContent = `+1 in ${rem}`;
        }
      }

      if (iwEl && iwEl.children.length === 0) {
        const iconSrc = iconMap[item.id] || `icons/${item.id}.svg`;
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = item.displayName;
        img.className = 'relic-svg relic-icon-img';
        img.style.objectFit = 'contain';
        img.style.width = '100%';
        img.style.height = '100%';
        img.draggable = false;
        iwEl.appendChild(img);
      }
    });
  }

  function runStep3Sequence() {
    clearAllTimers();
    populateStep3Content();

    const label1 = document.getElementById('step3-label-1');
    const label2 = document.getElementById('step3-label-2');
    const draftCards = [
      document.getElementById('draft-card-1'),
      document.getElementById('draft-card-2'),
      document.getElementById('draft-card-3')
    ];
    const abilitiesBox = document.getElementById('demo-abilities-box');
    const abilityCards = [
      document.getElementById('demo-ability-1'),
      document.getElementById('demo-ability-2'),
      document.getElementById('demo-ability-3')
    ];

    if (label1) label1.classList.remove('unfolded');
    if (label2) label2.classList.remove('unfolded');
    draftCards.forEach(c => {
      if (c) c.classList.remove('visible', 'selected', 'highlight', 'tut-glass-shimmer');
    });
    if (abilitiesBox) abilitiesBox.classList.remove('visible');
    abilityCards.forEach(a => {
      if (a) a.classList.remove('highlight', 'tut-glass-shimmer');
    });

    if (isReducedMotion) {
      if (label1) label1.classList.add('unfolded');
      draftCards.forEach(c => { if (c) c.classList.add('visible'); });
      if (draftCards[0]) draftCards[0].classList.add('selected', 'highlight');
      if (label2) label2.classList.add('unfolded');
      if (abilitiesBox) abilitiesBox.classList.add('visible');
      if (abilityCards[0]) abilityCards[0].classList.add('highlight');
      return;
    }

    // 1. Relic draft section label unfolds
    addTimer(() => {
      if (label1) label1.classList.add('unfolded');
    }, 200);

    // 2. Draft cards appear sequentially
    addTimer(() => {
      if (draftCards[0]) {
        draftCards[0].classList.add('visible', 'selected', 'highlight', 'tut-glass-shimmer');
      }
    }, 650);
    addTimer(() => { if (draftCards[1]) draftCards[1].classList.add('visible'); }, 950);
    addTimer(() => { if (draftCards[2]) draftCards[2].classList.add('visible'); }, 1250);

    // 3. Free actions section label unfolds
    addTimer(() => {
      if (label2) label2.classList.add('unfolded');
    }, 1800);

    // 4. Abilities container reveals with ability card highlight and single shine
    addTimer(() => {
      if (abilitiesBox) abilitiesBox.classList.add('visible');
      if (abilityCards[0]) abilityCards[0].classList.add('highlight', 'tut-glass-shimmer');
    }, 2200);
  }

  // --- STEP NAVIGATION & FOCUS TRAPPING ---
  function goToStep(index) {
    if (index < 0 || index >= TUTORIAL_STEPS.length) return;
    clearAllTimers();
    currentStep = index;

    const views = [
      document.getElementById('step-view-1'),
      document.getElementById('step-view-2'),
      document.getElementById('step-view-3')
    ];
    views.forEach((v, idx) => {
      if (v) v.classList.toggle('active', idx === currentStep);
    });

    const dots = document.querySelectorAll('.progress-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === currentStep);
      dot.setAttribute('aria-selected', idx === currentStep ? 'true' : 'false');
    });

    const stepData = TUTORIAL_STEPS[currentStep];
    const titleEl = document.getElementById('step-title-text');
    const captionEl = document.getElementById('step-caption-text');
    const counterEl = document.getElementById('step-counter-text');
    if (titleEl) titleEl.textContent = stepData.title;
    if (captionEl) captionEl.textContent = stepData.caption;
    if (counterEl) counterEl.textContent = stepData.counter;

    const prevBtn = document.getElementById('btn-tutorial-prev');
    const nextBtn = document.getElementById('btn-tutorial-next');

    if (prevBtn) {
      if (currentStep === 0) {
        prevBtn.classList.add('disabled');
        prevBtn.setAttribute('aria-disabled', 'true');
      } else {
        prevBtn.classList.remove('disabled');
        prevBtn.removeAttribute('aria-disabled');
      }
    }

    if (nextBtn) {
      if (currentStep === TUTORIAL_STEPS.length - 1) {
        nextBtn.textContent = 'DONE';
      } else {
        nextBtn.textContent = 'NEXT →';
      }
    }

    if (currentStep === 0) runStep1Sequence();
    else if (currentStep === 1) runStep2Sequence();
    else if (currentStep === 2) runStep3Sequence();
  }

  function getFocusableElements(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(
      'button:not([disabled]):not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => {
      const cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
  }

  function trapFocus(e) {
    const overlay = document.getElementById('tutorial-overlay');
    if (!overlay || overlay.classList.contains('hidden')) return;

    const focusables = getFocusableElements(overlay);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function finishTutorial() {
    clearAllTimers();
    markTutorialSeen();

    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');

    document.documentElement.classList.remove('tutorial-active');

    if (activeOrigin === 'pause') {
      const pauseOverlay = document.getElementById('pause-overlay');
      if (pauseOverlay) pauseOverlay.classList.remove('hidden');
      const pauseHowBtn = document.getElementById('btn-pause-how');
      if (pauseHowBtn) pauseHowBtn.focus();
    } else if (activeOrigin === 'start') {
      const startOverlay = document.getElementById('start-overlay');
      if (startOverlay) startOverlay.classList.remove('hidden');
      const startHowBtn = document.getElementById('btn-start-how');
      if (startHowBtn) startHowBtn.focus();
    } else {
      // 'first-visit'
      const startOverlay = document.getElementById('start-overlay');
      if (startOverlay) {
        startOverlay.classList.remove('hidden');
        const card = startOverlay.querySelector('.start-card');
        if (card) {
          card.style.animation = 'none';
          void card.offsetWidth;
          card.style.animation = '';
        }
      }
      const startPlayBtn = document.getElementById('btn-play-start');
      if (startPlayBtn) startPlayBtn.focus();
    }
  }

  /**
   * Open the interactive tutorial.
   * @param {string} origin - 'first-visit' | 'start' | 'pause'
   * @param {any} pendingChallenge - Hook for future challenge invites (Variant B). Currently unused.
   */
  function openTutorial(origin = 'start', pendingChallenge = null) {
    // Variant B hook: challenges do not exist yet. Parameter pendingChallenge reserved for future challenge banner.
    void pendingChallenge;

    activeOrigin = origin;
    previousActiveElement = document.activeElement;

    const overlay = document.getElementById('tutorial-overlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');

    if (origin === 'pause') {
      const pauseOverlay = document.getElementById('pause-overlay');
      if (pauseOverlay) pauseOverlay.classList.add('hidden');
    }

    goToStep(0);

    const nextBtn = document.getElementById('btn-tutorial-next');
    if (nextBtn) {
      setTimeout(() => nextBtn.focus(), 50);
    }
  }

  function initTutorial(provider) {
    if (provider) {
      relicProvider = Object.assign({}, relicProvider, provider);
    }

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    isReducedMotion = motionQuery.matches;
    motionQuery.addEventListener('change', (e) => {
      isReducedMotion = e.matches;
      clearAllTimers();
      if (currentStep === 0) runStep1Sequence();
      else if (currentStep === 1) runStep2Sequence();
      else if (currentStep === 2) runStep3Sequence();
    });

    // Wire controls
    const nextBtn = document.getElementById('btn-tutorial-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (currentStep < TUTORIAL_STEPS.length - 1) {
          goToStep(currentStep + 1);
        } else {
          finishTutorial();
        }
      });
    }

    const prevBtn = document.getElementById('btn-tutorial-prev');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (currentStep > 0) goToStep(currentStep - 1);
      });
    }

    const skipBtn = document.getElementById('btn-skip-tutorial');
    if (skipBtn) {
      skipBtn.addEventListener('click', finishTutorial);
    }

    const dots = document.querySelectorAll('.progress-dot');
    dots.forEach(dot => {
      dot.addEventListener('click', () => {
        const stepIdx = parseInt(dot.getAttribute('data-step') || '0', 10);
        goToStep(stepIdx);
      });
    });

    const step2Wrap = document.getElementById('step2-boardwrap');
    if (step2Wrap) {
      step2Wrap.addEventListener('click', handleStep2BoardClick);
    }

    window.addEventListener('keydown', (e) => {
      const overlay = document.getElementById('tutorial-overlay');
      if (!overlay || overlay.classList.contains('hidden')) return;

      if (e.key === 'Tab') {
        trapFocus(e);
        return;
      }

      if (
        e.key === 'Escape' ||
        e.key === 'Enter' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        finishTutorial();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON' && e.target.id !== 'btn-tutorial-next') {
          e.preventDefault();
          e.target.click();
          return;
        }
        e.preventDefault();
        if (currentStep < TUTORIAL_STEPS.length - 1) goToStep(currentStep + 1);
        else finishTutorial();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentStep > 0) goToStep(currentStep - 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
      }
    }, true);

    window.addEventListener('resize', () => {
      const overlay = document.getElementById('tutorial-overlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        repositionTutorialElements();
      }
    });

    // If pre-first-paint gating script set tutorial-active on <html>, open tutorial immediately
    if (document.documentElement.classList.contains('tutorial-active')) {
      openTutorial('first-visit');
    }
  }

  // Export to window
  window.TutorialController = {
    init: initTutorial,
    open: openTutorial,
    finish: finishTutorial,
    isSeen: isTutorialSeen,
    markSeen: markTutorialSeen,
    isActive: function() {
      const overlay = document.getElementById('tutorial-overlay');
      return Boolean(overlay && !overlay.classList.contains('hidden'));
    },
    getState: function() {
      return {
        currentStep,
        step2CurrentMove
      };
    },
    setRelicProvider: function(provider) {
      relicProvider = Object.assign({}, relicProvider, provider);
      populateStep3Content();
    }
  };

  // Auto-init DOM bindings on DOMContentLoaded or immediately if ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTutorial());
  } else {
    initTutorial();
  }
})();
