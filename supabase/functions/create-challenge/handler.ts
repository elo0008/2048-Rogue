// supabase/functions/create-challenge/handler.ts
// Pure HTTP request handler for Rogue 2048 Challenge Creation
// Web-standard types only (Request, Response, Headers) - zero Deno or Node specific globals

import { verifyRun, extractSubmission } from './vendor/verify/verify_run.js';
import { normalizeIp } from './ip.ts';

let defaultManifest: any = null;
try {
  const mod = await import('./vendor/manifest.json', { with: { type: 'json' } });
  defaultManifest = mod.default || mod;
} catch (_e) {
  defaultManifest = null;
}

const ADJECTIVES = [
  'Amber', 'Azure', 'Bold', 'Brave', 'Calm', 'Clever', 'Cobalt', 'Cosmic',
  'Crimson', 'Daring', 'Eager', 'Emerald', 'Fierce', 'Fleet', 'Golden', 'Grand',
  'Jade', 'Keen', 'Lunar', 'Mighty', 'Nimble', 'Noble', 'Onyx', 'Quiet',
  'Radiant', 'Rapid', 'Ruby', 'Rustic', 'Shadow', 'Silent', 'Silver', 'Solar',
  'Stellar', 'Swift', 'True', 'Valiant', 'Vivid', 'Warm', 'Wild', 'Wise'
];

const NOUNS = [
  'Badger', 'Bear', 'Bison', 'Crane', 'Dragon', 'Eagle', 'Falcon', 'Fox',
  'Gryphon', 'Hawk', 'Heron', 'Jaguar', 'Leopard', 'Lion', 'Lynx', 'Otter',
  'Owl', 'Panther', 'Phoenix', 'Puma', 'Raven', 'Robin', 'Sable', 'Stag',
  'Tiger', 'Viper', 'Wolf', 'Wolverine'
];

export function generateDisplayName(deviceId: string): string {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  const adj = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[(hash >>> 6) % NOUNS.length];
  const num = (hash >>> 12) % 900 + 100;
  return `${adj}-${noun}-${num}`;
}

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateChallengeCode(): string {
  const chars: string[] = [];
  while (chars.length < 12) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && chars.length < 12; i++) {
      if (bytes[i] < 248) {
        chars.push(BASE62_CHARS[bytes[i] % 62]);
      }
    }
  }
  return chars.join('');
}

export function getCorsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const isAllowed = origin === 'https://rogue2048.vercel.app' || /^http:\/\/localhost(?::\d+)?$/.test(origin);
  if (!isAllowed) {
    return { 'Vary': 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
    'Vary': 'Origin',
  };
}

export const IP_REQUEST_LIMIT_HOURLY = 600;
export const DEVICE_CHALLENGE_LIMIT_DAILY = 25;
export const IP_NEW_DEVICE_LIMIT_DAILY = 30;

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return normalizeIp(cfIp);
  }
  return 'unknown';
}

export interface CreateChallengeDbAdapter {
  consumeIpLimit(ip: string, hourKey: string, limit: number): Promise<{ allowed: boolean }>;
  isDeviceRegistered(deviceId: string): Promise<boolean>;
  consumeNewDeviceLimit(ip: string, dayKey: string, limit: number): Promise<{ allowed: boolean }>;
  createDailyChallenge(params: {
    deviceId: string;
    code: string;
    dayUtc?: string | null;
    limitKey: string;
    limit: number;
  }): Promise<{
    status: 'CREATED' | 'IDEMPOTENT' | 'NO_RUN' | 'LIMIT_EXCEEDED' | 'COLLISION';
    code?: string;
    expires_at?: string;
  }>;
  createFreeChallenge(params: {
    deviceId: string;
    displayName: string;
    code: string;
    points: number;
    totalMoves: number;
    maxTile: number;
    relics: any;
    seed: bigint;
    finalBoard: any;
    replayVersion: string;
    eventsHash: string;
    expiresAt: string;
    limitKey: string;
    limit: number;
  }): Promise<{
    status: 'CREATED' | 'IDEMPOTENT' | 'LIMIT_EXCEEDED' | 'COLLISION';
    code?: string;
    expires_at?: string;
  }>;
}

export async function handleCreateChallengeRequest(
  req: Request,
  db?: CreateChallengeDbAdapter,
  manifestOverride?: any
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const clientIp = getClientIp(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Body size check: 1MB limit
  const MAX_BODY_BYTES = 1048576;
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    const rawText = await req.text();
    if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }), {
        status: 413,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    body = JSON.parse(rawText);
  } catch (_e) {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { deviceId, mode } = body;
  if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
    return new Response(JSON.stringify({ error: 'DEVICE_ID_REQUIRED' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!db) {
    return new Response(JSON.stringify({ error: 'DATABASE_UNAVAILABLE' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Rate Limiting Keys
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const hourKey = `${todayUtc}T${String(now.getUTCHours()).padStart(2, '0')}`;
  const retryAfterHour = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
  const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const retryAfterMidnight = Math.max(1, Math.ceil((midnightUtc.getTime() - now.getTime()) / 1000));

  // Check IP rate limit (600/hr)
  const ipCheck = await db.consumeIpLimit(clientIp, hourKey, IP_REQUEST_LIMIT_HOURLY);
  if (!ipCheck.allowed) {
    return new Response(JSON.stringify({
      error: 'IP_HOURLY_LIMIT_EXCEEDED',
      message: `Max ${IP_REQUEST_LIMIT_HOURLY} requests per IP per hour`,
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterHour),
      },
    });
  }

  const devLimitKey = `chal_create:${deviceId}:${todayUtc}`;
  const challengeMode = mode === 'free' || body.runLog ? 'free' : 'daily';

  // 1. DAILY MODE
  if (challengeMode === 'daily') {
    let dayUtc: string | null = null;
    if (typeof body.dayUtc === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dayUtc)) {
      dayUtc = body.dayUtc;
    } else if (typeof body.dayUTC === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dayUTC)) {
      dayUtc = body.dayUTC;
    }

    if (dayUtc) {
      const yesterdayUtc = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      if (dayUtc !== todayUtc && dayUtc !== yesterdayUtc) {
        return new Response(JSON.stringify({
          error: 'INVALID_DAY_UTC',
          message: `Day must be today (${todayUtc}) or yesterday (${yesterdayUtc}) UTC`,
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    let code = generateChallengeCode();
    let result: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await db.createDailyChallenge({
        deviceId,
        code,
        dayUtc,
        limitKey: devLimitKey,
        limit: DEVICE_CHALLENGE_LIMIT_DAILY,
      });
      if (result.status !== 'COLLISION') break;
      code = generateChallengeCode();
    }

    if (result.status === 'NO_RUN') {
      return new Response(JSON.stringify({
        error: 'NO_RUN_FOUND',
        message: 'No accepted daily run found for this device',
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (result.status === 'LIMIT_EXCEEDED') {
      return new Response(JSON.stringify({
        error: 'DEVICE_DAILY_LIMIT_EXCEEDED',
        message: `Max ${DEVICE_CHALLENGE_LIMIT_DAILY} challenge creations per device per day`,
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterMidnight),
        },
      });
    }

    const finalCode = result.code || code;
    return new Response(JSON.stringify({
      code: finalCode,
      mode: 'daily',
      expiresAt: result.expires_at,
      url: `/c/${finalCode}`,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. FREE MODE
  const runLog = body.runLog;
  if (!runLog || typeof runLog !== 'object') {
    return new Response(JSON.stringify({ error: 'RUN_LOG_REQUIRED', message: 'Free challenges require a valid runLog' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Precheck: per-IP new device creation limit (30/day) if device not yet registered
  const isRegistered = await db.isDeviceRegistered(deviceId);
  if (!isRegistered) {
    const devCheck = await db.consumeNewDeviceLimit(clientIp, todayUtc, IP_NEW_DEVICE_LIMIT_DAILY);
    if (!devCheck.allowed) {
      return new Response(JSON.stringify({
        error: 'DEVICE_CREATION_LIMIT',
        message: `Max ${IP_NEW_DEVICE_LIMIT_DAILY} new devices per IP per day`,
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterMidnight),
        },
      });
    }
  }

  const manifest = manifestOverride !== undefined ? manifestOverride : defaultManifest;
  if (manifest?.replayVersion && runLog.replayVersion !== manifest.replayVersion) {
    return new Response(JSON.stringify({
      error: 'REPLAY_VERSION_MISMATCH',
      message: `Replay version ${runLog.replayVersion} does not match expected ${manifest.replayVersion}`,
      expectedVersion: manifest.replayVersion,
    }), {
      status: 422,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const verdict = verifyRun(runLog, {
    mode: 'challenge',
    expectedReplayVersion: manifest?.replayVersion || null,
  });

  if (!verdict.ok) {
    return new Response(JSON.stringify({
      error: 'VERIFICATION_REJECTED',
      status: verdict.status,
      reason: verdict.reason,
      flags: verdict.flags || [],
    }), {
      status: 422,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if ((verdict.replay?.moves ?? 0) < 10) {
    return new Response(JSON.stringify({
      error: 'RUN_TOO_SHORT',
      message: 'Challenge runs must have at least 10 moves',
    }), {
      status: 422,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const submission = await extractSubmission(runLog, verdict);
  if (!submission) {
    return new Response(JSON.stringify({ error: 'SUBMISSION_EXTRACTION_FAILED' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const displayName = generateDisplayName(deviceId);
  const expiresAt = new Date(now.getTime() + 32 * 3600 * 1000).toISOString();

  let code = generateChallengeCode();
  let result: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await db.createFreeChallenge({
      deviceId,
      displayName,
      code,
      points: submission.points,
      totalMoves: submission.moves,
      maxTile: submission.maxTile,
      relics: submission.relicsOwned,
      seed: BigInt(submission.seed),
      finalBoard: (submission as any).finalBoard ?? null,
      replayVersion: submission.replayVersion,
      eventsHash: submission.eventsHash,
      expiresAt,
      limitKey: devLimitKey,
      limit: DEVICE_CHALLENGE_LIMIT_DAILY,
    });
    if (result.status !== 'COLLISION') break;
    code = generateChallengeCode();
  }

  if (result.status === 'LIMIT_EXCEEDED') {
    return new Response(JSON.stringify({
      error: 'DEVICE_DAILY_LIMIT_EXCEEDED',
      message: `Max ${DEVICE_CHALLENGE_LIMIT_DAILY} challenge creations per device per day`,
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterMidnight),
      },
    });
  }

  const finalCode = result.code || code;
  return new Response(JSON.stringify({
    code: finalCode,
    mode: 'free',
    expiresAt: result.expires_at || expiresAt,
    url: `/c/${finalCode}`,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

