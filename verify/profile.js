/**
 * verify/profile.js
 *
 * Pure canonical profile definitions and utilities.
 * Environment: Pure ES module without Node-specific APIs (no fs, path, crypto, process).
 */

import { createGame, buildHazardSchedule } from '../sim/engine.js';

export const DEFAULT_UI_CONFIG_OVERRIDES = {
  hazardSchedule: buildHazardSchedule(3),
  draftEveryMoves: 60,
  draftThresholds: [],
  draftPool: [
    'diagonal_charge',
    'eraser',
    'rewind',
    'fault_line',
    'mason',
    'siphon',
    'shatter',
    'last_stand',
  ],
  enableDraft: true,
  stoneLifetime: null,
  stoneGroupCap: 2,
  forcedRelics: [],
  forceAtMove: 0,
  rewindEvery: 10,
  ascensionAt: 2048,
};

/**
 * The resolved engine config of a default UI run (no URL params).
 * Derived via createGame with DEFAULT_UI_CONFIG_OVERRIDES (identical to GameController).
 */
export const CANONICAL_CONFIG = createGame(0, DEFAULT_UI_CONFIG_OVERRIDES).config;

/**
 * 32-bit FNV-1a hash over 'rogue2048-daily-v1:' + date
 *
 * @param {string} dayUTC - ISO date string 'YYYY-MM-DD'
 * @returns {number} Unsigned 32-bit integer (0 <= n <= 4294967295)
 */
export function dailySeed(dayUTC) {
  if (typeof dayUTC !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayUTC)) {
    throw new Error(`Invalid dayUTC format: expected 'YYYY-MM-DD', got ${dayUTC}`);
  }
  const input = 'rogue2048-daily-v1:' + dayUTC;
  let hash = 0x811c9dc5; // FNV offset basis 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime 16777619
  }
  return hash >>> 0;
}

/**
 * Recursively normalizes a serialized config object, restoring "Infinity" and "-Infinity"
 * strings back into numeric Infinity / -Infinity as serialized by the UI.
 *
 * @param {object} logConfig
 * @returns {object}
 */
export function normalizeConfig(logConfig) {
  if (!logConfig || typeof logConfig !== 'object') return {};
  function walk(val) {
    if (val === 'Infinity') return Infinity;
    if (val === '-Infinity') return -Infinity;
    if (Array.isArray(val)) return val.map(walk);
    if (val !== null && typeof val === 'object') {
      const res = {};
      for (const k of Object.keys(val)) {
        res[k] = walk(val[k]);
      }
      return res;
    }
    return val;
  }
  return walk(logConfig);
}

/**
 * Asserts that a normalized config matches CANONICAL_CONFIG exactly.
 *
 * @param {object} config - Normalized config
 * @returns {{ ok: boolean, key: string|null, reason: string|null }}
 */
export function checkCanonicalConfig(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, key: 'config', reason: 'CONFIG_NOT_CANONICAL: config is not an object' };
  }

  // 1. Extra keys
  for (const k of Object.keys(config)) {
    if (!(k in CANONICAL_CONFIG)) {
      return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: unexpected key "${k}"` };
    }
  }

  // 2. Missing keys
  for (const k of Object.keys(CANONICAL_CONFIG)) {
    if (!(k in config)) {
      return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: missing key "${k}"` };
    }
  }

  // 3. Compare values
  for (const k of Object.keys(CANONICAL_CONFIG)) {
    const cVal = CANONICAL_CONFIG[k];
    const uVal = config[k];

    if (Array.isArray(cVal)) {
      if (!Array.isArray(uVal)) {
        return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" expected array` };
      }
      if (cVal.length !== uVal.length) {
        return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" length mismatch (claimed ${uVal.length}, expected ${cVal.length})` };
      }
      for (let i = 0; i < cVal.length; i++) {
        const ce = cVal[i];
        const ue = uVal[i];
        if (ce !== null && typeof ce === 'object') {
          if (ue === null || typeof ue !== 'object') {
            return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" element ${i} expected object` };
          }
          for (const ek of Object.keys(ce)) {
            if (ce[ek] !== ue[ek]) {
              return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" element ${i}.${ek} mismatch (claimed ${ue[ek]}, expected ${ce[ek]})` };
            }
          }
          for (const ek of Object.keys(ue)) {
            if (!(ek in ce)) {
              return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" element ${i} has unexpected field "${ek}"` };
            }
          }
        } else if (ce !== ue) {
          return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" element ${i} mismatch (claimed ${ue}, expected ${ce})` };
        }
      }
    } else if (cVal !== null && typeof cVal === 'object') {
      if (uVal === null || typeof uVal !== 'object' || Array.isArray(uVal)) {
        return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" expected object` };
      }
      for (const ok of Object.keys(cVal)) {
        if (cVal[ok] !== uVal[ok]) {
          return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}.${ok}" mismatch (claimed ${uVal[ok]}, expected ${cVal[ok]})` };
        }
      }
      for (const ok of Object.keys(uVal)) {
        if (!(ok in cVal)) {
          return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" unexpected field "${ok}"` };
        }
      }
    } else {
      if (cVal !== uVal) {
        return { ok: false, key: k, reason: `CONFIG_NOT_CANONICAL: key "${k}" mismatch (claimed ${JSON.stringify(uVal)}, expected ${JSON.stringify(cVal)})` };
      }
    }
  }

  return { ok: true, key: null, reason: null };
}
