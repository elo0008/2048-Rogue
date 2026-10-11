/**
 * 2048 Rogue - Procedural WebAudio Synthesizer
 * Zero dependencies, zero external audio files.
 * Soft, tactile, low-passed (4-6 kHz), short envelopes (3ms attack).
 * Master gain 0.5 through DynamicsCompressorNode. Per-sound peak <= 0.3.
 * Max 8 concurrent voices with rate-limiting and +/- 3% pitch jitter.
 */

const STORAGE_KEY_SOUND = '2048_rogue_sound_enabled';
const MAX_VOICES = 8;
const MASTER_GAIN_VALUE = 0.5;
const MASTER_FILTER_CUTOFF = 5000; // 5 kHz lowpass

let audioCtx = null;
let masterGain = null;
let masterCompressor = null;
let masterFilter = null;
let activeVoices = 0;
const lastPlayTimes = new Map();

// Helper to check stored sound preference
export function isSoundEnabled() {
  try {
    const val = localStorage.getItem(STORAGE_KEY_SOUND);
    if (val === null) return true; // Default ON
    return val === 'true' || val === '1';
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY_SOUND, enabled ? 'true' : 'false');
  } catch (err) {
    console.warn('LocalStorage sound save failed:', err);
  }
}

export function toggleSound() {
  const next = !isSoundEnabled();
  setSoundEnabled(next);
  return next;
}

/**
 * Initializes or resumes AudioContext on the first user gesture.
 * Safe against missing, blocked, or suspended AudioContext.
 */
export function initAudio() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    if (!audioCtx) {
      audioCtx = new AudioContextClass();

      // Master Compressor
      masterCompressor = audioCtx.createDynamicsCompressor();
      masterCompressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
      masterCompressor.knee.setValueAtTime(30, audioCtx.currentTime);
      masterCompressor.ratio.setValueAtTime(12, audioCtx.currentTime);
      masterCompressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
      masterCompressor.release.setValueAtTime(0.25, audioCtx.currentTime);

      // Master Lowpass Filter (cutoff ~5 kHz)
      masterFilter = audioCtx.createBiquadFilter();
      masterFilter.type = 'lowpass';
      masterFilter.frequency.setValueAtTime(MASTER_FILTER_CUTOFF, audioCtx.currentTime);
      masterFilter.Q.setValueAtTime(0.7, audioCtx.currentTime);

      // Master Gain (0.5)
      masterGain = audioCtx.createGain();
      masterGain.gain.setValueAtTime(MASTER_GAIN_VALUE, audioCtx.currentTime);

      // Graph: Voice -> MasterFilter -> MasterCompressor -> MasterGain -> Destination
      masterFilter.connect(masterCompressor);
      masterCompressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch (err) {
    console.warn('AudioContext initialization failed:', err);
    return null;
  }
}

function jitter(freq) {
  // +/- 3% random pitch variation
  return freq * (1 + (Math.random() * 0.06 - 0.03));
}

function canPlay(type, minIntervalMs = 25) {
  if (!isSoundEnabled()) return false;
  if (!audioCtx) return false;
  if (audioCtx.state !== 'running') {
    audioCtx.resume().catch(() => {});
    if (audioCtx.state !== 'running') return false;
  }
  if (activeVoices >= MAX_VOICES) return false;

  const now = performance.now();
  const last = lastPlayTimes.get(type) || 0;
  if (now - last < minIntervalMs) return false;
  lastPlayTimes.set(type, now);

  return true;
}

function trackVoice(durationMs) {
  activeVoices++;
  setTimeout(() => {
    activeVoices = Math.max(0, activeVoices - 1);
  }, durationMs + 20);
}

// Generates a short white noise buffer
function createNoiseBuffer(durationSec) {
  if (!audioCtx) return null;
  const sampleRate = audioCtx.sampleRate;
  const bufferSize = Math.floor(sampleRate * durationSec);
  const buffer = audioCtx.createBuffer(1, bufferSize, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/* -------------------------------------------------------------
 * Procedural Sound Effects
 * ------------------------------------------------------------- */

/**
 * 1. Swipe: soft filtered-noise whoosh ~120 ms, stereo-panned by swipe direction
 */
export function playSwipe(direction = 'L') {
  if (!canPlay('swipe', 40)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.12;
    const noiseBuf = createNoiseBuffer(dur);
    if (!noiseBuf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(jitter(850), t);
    filter.frequency.exponentialRampToValueAtTime(jitter(380), t + dur);
    filter.Q.setValueAtTime(1.2, t);

    const gain = audioCtx.createGain();
    const peak = 0.2;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.003); // 3ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let panner = null;
    if (typeof audioCtx.createStereoPanner === 'function') {
      panner = audioCtx.createStereoPanner();
      let pan = 0;
      if (direction === 'L') pan = -0.55;
      else if (direction === 'R') pan = 0.55;
      panner.pan.setValueAtTime(pan, t);
    }

    src.connect(filter);
    filter.connect(gain);
    if (panner) {
      gain.connect(panner);
      panner.connect(masterFilter);
    } else {
      gain.connect(masterFilter);
    }

    src.start(t);
    src.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playSwipe error:', err);
  }
}

/**
 * 2. Tile merge: soft sine/triangle "pop" whose pitch rises with log2(value) on a pentatonic scale,
 * louder for chains.
 */
const PENTATONIC_FREQS = [
  261.63, 293.66, 329.63, 392.00, 440.00, // C4, D4, E4, G4, A4
  523.25, 587.33, 659.25, 783.99, 880.00, // C5, D5, E5, G5, A5
  1046.50, 1174.66, 1318.51, 1567.98       // C6, D6, E6, G6
];

export function playMerge(tileValue = 4, combo = 1) {
  if (!canPlay('merge', 30)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.15;
    const exponent = Math.max(0, Math.round(Math.log2(tileValue || 4)) - 1);
    const baseFreq = PENTATONIC_FREQS[exponent % PENTATONIC_FREQS.length] || 329.63;
    const f0 = jitter(baseFreq);

    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f0 * 1.25, t);
    osc.frequency.exponentialRampToValueAtTime(f0, t + 0.025);

    const gain = audioCtx.createGain();
    const chainBoost = Math.min(3, Math.max(0, combo - 1)) * 0.03;
    const peak = Math.min(0.3, 0.18 + chainBoost);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.003); // 3ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playMerge error:', err);
  }
}

/**
 * 3. New tile spawn: very quiet tick
 */
export function playSpawn() {
  if (!canPlay('spawn', 40)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.025;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(1700), t);

    const gain = audioCtx.createGain();
    const peak = 0.07;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.003); // 3ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playSpawn error:', err);
  }
}

/**
 * 4. Stone spawn: low thud (sine ~70 Hz drop + short noise burst)
 */
export function playStone() {
  if (!canPlay('stone', 100)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.16;

    // Sine drop
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(72), t);
    osc.frequency.exponentialRampToValueAtTime(32, t + dur);

    const oscGain = audioCtx.createGain();
    oscGain.gain.setValueAtTime(0.0001, t);
    oscGain.gain.linearRampToValueAtTime(0.26, t + 0.003);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(oscGain);
    oscGain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);

    // Short noise burst
    const noiseDur = 0.04;
    const noiseBuf = createNoiseBuffer(noiseDur);
    if (noiseBuf) {
      const nSrc = audioCtx.createBufferSource();
      nSrc.buffer = noiseBuf;
      const nFilt = audioCtx.createBiquadFilter();
      nFilt.type = 'lowpass';
      nFilt.frequency.setValueAtTime(220, t);
      const nGain = audioCtx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.linearRampToValueAtTime(0.18, t + 0.003);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + noiseDur);
      nSrc.connect(nFilt);
      nFilt.connect(nGain);
      nGain.connect(masterFilter);
      nSrc.start(t);
      nSrc.stop(t + noiseDur);
    }

    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playStone error:', err);
  }
}

/**
 * 5. Diagonal: two-note soft chime
 */
export function playDiagonal() {
  if (!canPlay('diagonal', 80)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.18;

    const playChimeNote = (freq, offsetSec) => {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(jitter(freq), t + offsetSec);
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.0001, t + offsetSec);
      gain.gain.linearRampToValueAtTime(0.18, t + offsetSec + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + offsetSec + 0.12);
      osc.connect(gain);
      gain.connect(masterFilter);
      osc.start(t + offsetSec);
      osc.stop(t + offsetSec + 0.12);
    };

    playChimeNote(659.25, 0);     // E5
    playChimeNote(783.99, 0.055); // G5
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playDiagonal error:', err);
  }
}

/**
 * 6. Eraser: dissolving high-passed noise shimmer
 */
export function playEraser() {
  if (!canPlay('eraser', 80)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.19;
    const noiseBuf = createNoiseBuffer(dur);
    if (!noiseBuf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(2800, t);
    filter.frequency.exponentialRampToValueAtTime(5500, t + dur);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.17, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterFilter);

    src.start(t);
    src.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playEraser error:', err);
  }
}

/**
 * 7. Rewind: reversed swoosh (rising filter sweep)
 */
export function playRewind() {
  if (!canPlay('rewind', 80)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.16;
    const noiseBuf = createNoiseBuffer(dur);
    if (!noiseBuf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(jitter(250), t);
    filter.frequency.exponentialRampToValueAtTime(jitter(2400), t + dur);
    filter.Q.setValueAtTime(1.5, t);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterFilter);

    src.start(t);
    src.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playRewind error:', err);
  }
}

/**
 * 8. Draft card pick: warm two-tone tap
 */
export function playDraftPick() {
  if (!canPlay('draftPick', 80)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.1;

    const osc1 = audioCtx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(jitter(330), t);

    const osc2 = audioCtx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(jitter(495), t + 0.015);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.2, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(masterFilter);

    osc1.start(t);
    osc1.stop(t + dur);
    osc2.start(t + 0.015);
    osc2.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playDraftPick error:', err);
  }
}

/**
 * 9. Last Stand: low swell
 */
export function playLastStand() {
  if (!canPlay('lastStand', 200)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.75;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(95), t);
    osc.frequency.exponentialRampToValueAtTime(jitter(135), t + dur);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.24, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playLastStand error:', err);
  }
}

/**
 * 10. Game over: slow descending tone
 */
export function playGameOver() {
  if (!canPlay('gameOver', 200)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.55;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(340), t);
    osc.frequency.exponentialRampToValueAtTime(110, t + dur);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playGameOver error:', err);
  }
}

/**
 * 11. UI taps: tiny click
 */
export function playClick() {
  if (!canPlay('click', 35)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.02;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(1200), t);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.1, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);
    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playClick error:', err);
  }
}

/**
 * 12. Last Stand Stamp Thud: sine ~60Hz drop + short noise burst (peak <= 0.3)
 */
export function playLastStandThud() {
  if (!canPlay('lastStandThud', 150)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.22;

    // Sine drop ~60 Hz -> 30 Hz
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(62), t);
    osc.frequency.exponentialRampToValueAtTime(30, t + dur);

    const oscGain = audioCtx.createGain();
    oscGain.gain.setValueAtTime(0.0001, t);
    oscGain.gain.linearRampToValueAtTime(0.24, t + 0.005);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(oscGain);
    oscGain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);

    // Short noise burst (impact punch)
    const bufferSize = Math.floor(audioCtx.sampleRate * 0.04);
    const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    const noiseSrc = audioCtx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(180, t);

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.22, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterFilter);

    noiseSrc.start(t);
    noiseSrc.stop(t + 0.04);

    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playLastStandThud error:', err);
  }
}

/**
 * 13. Shatter Crack: high-passed noise burst + two descending ticks (peak <= 0.3)
 */
export function playShatterCrack() {
  if (!canPlay('shatterCrack', 100)) return;
  try {
    const t = audioCtx.currentTime;

    // High-passed noise burst
    const noiseDur = 0.06;
    const bufferSize = Math.floor(audioCtx.sampleRate * noiseDur);
    const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noiseSrc = audioCtx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    const hpFilter = audioCtx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(1200, t);

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.22, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + noiseDur);

    noiseSrc.connect(hpFilter);
    hpFilter.connect(noiseGain);
    noiseGain.connect(masterFilter);
    noiseSrc.start(t);
    noiseSrc.stop(t + noiseDur);

    // Two descending ticks (t and t + 0.035)
    [0, 0.035].forEach((offset, idx) => {
      const osc = audioCtx.createOscillator();
      osc.type = 'triangle';
      const f = idx === 0 ? jitter(1400) : jitter(950);
      osc.frequency.setValueAtTime(f, t + offset);
      osc.frequency.exponentialRampToValueAtTime(f * 0.5, t + offset + 0.02);

      const tickGain = audioCtx.createGain();
      tickGain.gain.setValueAtTime(0.0001, t + offset);
      tickGain.gain.linearRampToValueAtTime(0.18, t + offset + 0.002);
      tickGain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.02);

      osc.connect(tickGain);
      tickGain.connect(masterFilter);
      osc.start(t + offset);
      osc.stop(t + offset + 0.02);
    });

    trackVoice(120);
  } catch (err) {
    console.warn('playShatterCrack error:', err);
  }
}

/**
 * 14. Stuck Thud: soft low thud (peak <= 0.25, quieter on blocked swipe)
 */
export function playStuckThud(quieter = false) {
  if (!canPlay('stuckThud', 50)) return;
  try {
    const t = audioCtx.currentTime;
    const dur = 0.12;
    const peak = quieter ? 0.12 : 0.22;

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(jitter(65), t);
    osc.frequency.exponentialRampToValueAtTime(35, t + dur);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(masterFilter);

    osc.start(t);
    osc.stop(t + dur);

    trackVoice(dur * 1000);
  } catch (err) {
    console.warn('playStuckThud error:', err);
  }
}


