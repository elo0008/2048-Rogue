// names.ts: Pure name validation for Rogue 2048 custom display names
// Web-standard / Node-importable TypeScript, zero Deno-specific globals

import { BLOCKLIST } from './names_blocklist.ts';

export type ValidateNameResult =
  | { ok: true; name: string; norm: string }
  | { ok: false; error: 'NAME_NOT_ALLOWED' };

const RESERVED_NAMES = new Set([
  'admin',
  'moderator',
  'support',
  'official',
  'system',
  'anthropic',
  'claude',
  'synera',
  'rogue2048',
  'null',
  'undefined',
]);

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
};

export function toSkeleton(str: string): string {
  let mapped = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    mapped += LEET_MAP[ch] || ch;
  }
  // Collapse repeated characters: 2+ identical adjacent characters -> 1 character
  return mapped.replace(/(.)\1+/g, '$1');
}

export function validateName(input: unknown): ValidateNameResult {
  // 1. Must be string
  if (typeof input !== 'string') {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 2. Trim and collapse internal whitespace to a single space
  const trimmed = input.trim().replace(/\s+/g, ' ');

  // 3. Length must be 3..16
  if (trimmed.length < 3 || trimmed.length > 16) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 4. ONLY ASCII letters, digits, space, underscore, hyphen
  if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 5. Must start and end with a letter or digit
  if (!/^[a-zA-Z0-9]/.test(trimmed) || !/[a-zA-Z0-9]$/.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 6. At most 4 digit characters in total
  const digitMatches = trimmed.match(/\d/g);
  if (digitMatches && digitMatches.length > 4) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 7. No run of 4+ identical characters (case-insensitive)
  if (/(.)\1{3,}/i.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 8. Compute norm: lowercase with spaces/underscores/hyphens removed
  const norm = trimmed.toLowerCase().replace(/[\s_\-]+/g, '');
  if (!norm) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 9. Reserved check (after norm):
  // admin, moderator, support, official, system, anthropic, claude, synera, rogue2048, null, undefined,
  // and names that start with 'anon' followed by digits or underscore
  if (RESERVED_NAMES.has(norm)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  if (/^anon(?:\d+|_.*|$)/.test(norm) || /^anon(?:[\d_]+|$)/i.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }

  // 10. Blocklist check against skeleton
  const skeleton = toSkeleton(norm);

  for (let i = 0; i < BLOCKLIST.length; i++) {
    const entry = BLOCKLIST[i].toLowerCase();
    const entrySkel = toSkeleton(entry);

    if (entry.length <= 4) {
      // Whole-word match for entries of 4 letters or fewer
      if (norm === entry || skeleton === entry || skeleton === entrySkel) {
        return { ok: false, error: 'NAME_NOT_ALLOWED' };
      }
    } else {
      // Substring match for longer entries
      if (norm.includes(entry) || skeleton.includes(entry) || skeleton.includes(entrySkel)) {
        return { ok: false, error: 'NAME_NOT_ALLOWED' };
      }
    }
  }

  return { ok: true, name: trimmed, norm };
}

