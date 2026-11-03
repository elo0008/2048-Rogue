// names.ts: Display name validation and sanitization for Rogue 2048
// Implements G1 tokenisation, short token matching, allowlist skeleton stripping,
// short substring matching, long substring matching, and affix-aware reserved names.
// Web-standard / Node-importable TypeScript, zero Deno-specific globals.

import {
  TOKEN_BLOCKLIST_SHORT,
  SHORT_SUBSTRING,
  BLOCKLIST_LONG,
} from './names_blocklist.ts';
import { ALLOWLIST } from './names_allowlist.ts';

export type ValidateNameResult =
  | { ok: true; name: string; norm: string }
  | { ok: false; error: 'NAME_NOT_ALLOWED' };

export type ValidateNameDetailedResult =
  | { ok: true; name: string; norm: string }
  | { ok: false; error: 'NAME_NOT_ALLOWED'; ruleNumber: number; ruleDescription: string };

const RESERVED_WORDS = new Set([
  'admin',
  'administrator',
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

const RESERVED_AFFIXES = [
  'the',
  'real',
  'official',
  'bot',
  'team',
  'staff',
  'mod',
  'support',
  'im',
];

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '9': 'q',
  '@': 'a',
  '$': 's',
};

// Sort allowlist by length descending so longer compounds are stripped first
const SORTED_ALLOWLIST_SKELS = Array.from(new Set(
  ALLOWLIST.map(w => toSkeleton(w.toLowerCase().trim())).filter(s => s.length >= 3)
)).sort((a, b) => b.length - a.length);

export function toSkeleton(str: string): string {
  let mapped = '';
  const lower = str.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    mapped += LEET_MAP[ch] || ch;
  }
  // Collapse repeated characters: 2+ identical adjacent characters -> 1 character
  return mapped.replace(/(.)\1+/g, '$1');
}

/**
 * Tokenise input into discrete tokens split by:
 * - spaces, underscores, hyphens
 * - digit/letter boundaries
 * - lower->Upper camelCase boundaries
 */
export function tokeniseInput(input: string): string[] {
  const tokens: string[] = [];
  // 1. Split on spaces, underscores, hyphens
  const baseChunks = input.trim().split(/[\s_\-]+/);

  for (const chunk of baseChunks) {
    if (!chunk) continue;
    // 2. Split on camelCase (lower to Upper)
    const camelParts = chunk.split(/(?<=[a-z])(?=[A-Z])/);
    for (const cp of camelParts) {
      if (!cp) continue;
      tokens.push(cp);

      // 3. Sub-split on digit/letter boundaries if present
      const digitParts = cp.split(/(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/);
      if (digitParts.length > 1) {
        for (const dp of digitParts) {
          if (dp && dp !== cp) {
            tokens.push(dp);
          }
        }
      }
    }
  }

  return tokens;
}

/**
 * Strip allowlisted harmless words from skeleton before substring matching.
 * Replaces allowlisted substrings with a space delimiter to prevent accidental character fusion.
 */
export function stripAllowlistFromSkeleton(skel: string): string {
  let res = skel;
  for (const allowSkel of SORTED_ALLOWLIST_SKELS) {
    if (res.includes(allowSkel)) {
      res = res.replaceAll(allowSkel, ' ');
    }
  }
  return res;
}

export function validateNameDetailed(input: unknown): ValidateNameDetailedResult {
  // Rule 1: Must be string
  if (typeof input !== 'string') {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 1, ruleDescription: 'Non-string input' };
  }

  // Rule 2: Trim and collapse internal whitespace to single space
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 3 || trimmed.length > 16) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 2, ruleDescription: 'Length out of 3..16 range' };
  }

  // Rule 3: ONLY ASCII letters, digits, space, underscore, hyphen
  if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 3, ruleDescription: 'Forbidden characters' };
  }

  // Rule 4: Must start and end with letter or digit
  if (!/^[a-zA-Z0-9]/.test(trimmed) || !/[a-zA-Z0-9]$/.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 4, ruleDescription: 'Invalid start/end boundary' };
  }

  // Rule 5: At most 4 digit characters in total
  const digitMatches = trimmed.match(/\d/g);
  if (digitMatches && digitMatches.length > 4) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 5, ruleDescription: 'Exceeded 4 digits' };
  }

  // Rule 6: No run of 4+ identical characters (case-insensitive)
  if (/(.)\1{3,}/i.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 6, ruleDescription: 'Run of 4+ identical characters' };
  }

  // Compute normalised form: lowercase with spaces, underscores, hyphens removed
  const norm = trimmed.toLowerCase().replace(/[\s_\-]+/g, '');
  if (!norm) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 2, ruleDescription: 'Empty norm' };
  }

  const skeleton = toSkeleton(norm);

  // Rule 7: Reserved names / impersonation check
  // Check equality on norm AND skeleton, ignoring leading/trailing digits,
  // and check reserved words with affixes: the, real, official, bot, team, staff, mod, support, im.
  const normNoDigits = norm.replace(/^\d+/, '').replace(/\d+$/, '');
  const skelNoDigits = skeleton.replace(/^\d+/, '').replace(/\d+$/, '');

  for (const reserved of RESERVED_WORDS) {
    const resSkel = toSkeleton(reserved);
    if (
      norm === reserved ||
      normNoDigits === reserved ||
      skeleton === resSkel ||
      skelNoDigits === resSkel
    ) {
      return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 7, ruleDescription: 'Reserved name' };
    }

    for (const affix of RESERVED_AFFIXES) {
      const affixSkel = toSkeleton(affix);
      // Prefix match
      if (
        norm === affix + reserved ||
        normNoDigits === affix + reserved ||
        skeleton === affixSkel + resSkel ||
        skelNoDigits === affixSkel + resSkel
      ) {
        return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 7, ruleDescription: 'Reserved name with prefix' };
      }
      // Suffix match
      if (
        norm === reserved + affix ||
        normNoDigits === reserved + affix ||
        skeleton === resSkel + affixSkel ||
        skelNoDigits === resSkel + affixSkel
      ) {
        return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 7, ruleDescription: 'Reserved name with suffix' };
      }
    }
  }

  // System anonymous placeholder check
  if (/^anon(?:\d+|_.*|$)/.test(norm) || /^anon(?:[\d_]+|$)/i.test(trimmed)) {
    return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 7, ruleDescription: 'Reserved anon prefix' };
  }

  // Rule 8: Short Token Matching (<= 4 letters)
  // Blocked when the entry's skeleton EQUALS a token skeleton
  const tokens = tokeniseInput(trimmed);
  const tokenSkels = tokens.map(t => toSkeleton(t));
  // Include whole norm skeleton (for spaced-out whole names like 'Z z q')
  tokenSkels.push(skeleton);

  for (const entry of TOKEN_BLOCKLIST_SHORT) {
    const entrySkel = toSkeleton(entry);
    for (const tSkel of tokenSkels) {
      if (tSkel === entrySkel) {
        return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 8, ruleDescription: 'Short token blocklist match' };
      }
    }
  }

  // Prepare clean skeleton with allowlisted words stripped
  const cleanSkeleton = stripAllowlistFromSkeleton(skeleton);

  // Rule 9: Short Substring Matching (unambiguous short entries)
  for (const entry of SHORT_SUBSTRING) {
    const entrySkel = toSkeleton(entry);
    if (cleanSkeleton.includes(entrySkel)) {
      return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 9, ruleDescription: 'Short substring blocklist match' };
    }
  }

  // Rule 10: Long Substring Matching (5+ letters)
  for (const entry of BLOCKLIST_LONG) {
    const entrySkel = toSkeleton(entry);
    if (cleanSkeleton.includes(entrySkel)) {
      return { ok: false, error: 'NAME_NOT_ALLOWED', ruleNumber: 10, ruleDescription: 'Long substring blocklist match' };
    }
  }

  return { ok: true, name: trimmed, norm };
}

export function validateName(input: unknown): ValidateNameResult {
  const res = validateNameDetailed(input);
  if (!res.ok) {
    return { ok: false, error: 'NAME_NOT_ALLOWED' };
  }
  return { ok: true, name: res.name, norm: res.norm };
}
