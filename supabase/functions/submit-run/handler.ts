// supabase/functions/submit-run/handler.ts
// Pure HTTP request handler for Rogue 2048 Leaderboard Verification
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

// Adjectives and nouns for deterministic server-side display name generation
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
  // Deterministic pseudo-random name based on deviceId characters
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  const adj = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[(hash >>> 6) % NOUNS.length];
  const num = (hash >>> 12) % 900 + 100; // 100 - 999
  return `${adj}-${noun}-${num}`;
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

// Rate Limits for Abuse Protection and Carrier NAT Accommodation
// Mobile players frequently share IP addresses (Carrier Grade NAT).
// Per-IP request limit: 600/hour allows multiple active devices behind the same public mobile IP.
export const IP_REQUEST_LIMIT_HOURLY = 600;
// New devices per IP per day: 30 permits households and mobile carrier IP pools to onboard devices.
export const IP_NEW_DEVICE_LIMIT_DAILY = 30;
// Accepted submissions per device per day: 60 allows active daily play while bounding spam.
export const DEVICE_SUBMISSION_LIMIT_DAILY = 60;

export function getClientIp(req: Request): string {
  // Use cf-connecting-ip only. In production on Supabase Edge Runtime, Cloudflare sets/overwrites cf-connecting-ip.
  // If absent, fall back to the shared bucket 'unknown' and log a warning.
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return normalizeIp(cfIp);
  }
  console.warn('[getClientIp] cf-connecting-ip header missing; falling back to "unknown"');
  return 'unknown';
}

export interface PrecheckResult {
  ok: boolean;
  reason: string | null;
  retry_scope: 'hour' | 'day' | null;
}

export interface RecordSubmissionParams {
  deviceId: string;
  displayName: string;
  dayUtc: string;
  seed: bigint;
  points: number;
  totalMoves: number;
  maxTile: number;
  relics: any;
  replayVersion: string;
  eventsHash: string;
  durationMs: number | null;
  flags: string[];
  devKey: string;
  devLimit: number;
  finalBoard?: any;
}

export interface RecordSubmissionResult {
  status: 'ACCEPTED' | 'ALREADY_SUBMITTED' | 'DEVICE_LIMIT';
  id?: number | string | null;
}

// A3: Fail Closed DatabaseAdapter interface - strictly requires precheckSubmission and recordSubmission
export interface DatabaseAdapter {
  precheckSubmission(
    ip: string,
    deviceId: string,
    hourKey: string,
    dayKey: string,
    ipReqLimit: number,
    ipNewDevLimit: number
  ): Promise<PrecheckResult>;

  recordSubmission(params: RecordSubmissionParams): Promise<RecordSubmissionResult>;
}

export async function handleSubmissionRequest(
  req: Request,
  db?: DatabaseAdapter,
  manifestOverride?: any
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const clientIp = getClientIp(req);
  const ipSourceHeaders: Record<string, string> = {};
  if (clientIp === 'unknown') {
    ipSourceHeaders['x-ip-source'] = 'missing';
  }

  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, ...ipSourceHeaders } });
  }

  // S0: Version Endpoint for GET requests
  if (req.method === 'GET') {
    const manifest = manifestOverride !== undefined ? manifestOverride : defaultManifest;
    if (!manifest || !manifest.rulesVersion || !manifest.replayVersion) {
      return new Response(JSON.stringify({
        error: 'SERVER_CONFIGURATION_ERROR',
        message: 'Manifest missing or incomplete',
      }), {
        status: 500,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      rulesVersion: manifest.rulesVersion,
      replayVersion: manifest.replayVersion,
    }), {
      status: 200,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // A3 FAIL CLOSED: If the adapter is missing, or either method is missing,
  // return 500 SERVER_CONFIGURATION_ERROR before doing anything (no verification, no ACCEPTED).
  if (
    !db ||
    typeof db.precheckSubmission !== 'function' ||
    typeof db.recordSubmission !== 'function'
  ) {
    return new Response(JSON.stringify({
      error: 'SERVER_CONFIGURATION_ERROR',
      message: 'Database adapter or required methods missing',
    }), {
      status: 500,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. Read raw request body cleanly and validate size (<= 1 MB)
  let rawBodyText: string;
  try {
    rawBodyText = await req.text();
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'BODY_READ_FAILED', message: err.message }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
  if (contentLength > 1048576 || rawBodyText.length > 1048576) {
    return new Response(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 1 MB limit' }), {
      status: 413,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON', message: 'Malformed JSON payload' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 3. Pre-Verification Validation: Device ID
  const deviceId = body?.deviceId;
  if (!deviceId || typeof deviceId !== 'string' || !/^[a-z0-9_]{8,64}$/.test(deviceId)) {
    return new Response(JSON.stringify({ error: 'INVALID_DEVICE_ID', message: 'deviceId must match /^[a-z0-9_]{8,64}$/' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Verification mode is strictly constant 'daily' in submit-run
  const mode = 'daily';
  const runLog = body?.runLog;

  // 4. Pre-Verification Validation: Event count <= 20000
  if (!runLog || typeof runLog !== 'object' || !Array.isArray(runLog.events)) {
    return new Response(JSON.stringify({ error: 'INVALID_RUN_LOG', message: 'runLog.events array required' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (runLog.events.length > 20000) {
    return new Response(JSON.stringify({ error: 'EVENTS_LIMIT_EXCEEDED', message: 'Max 20000 events permitted' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 5. Abuse Limits & Precheck (Atomic RPC via required precheckSubmission)
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const currentHourKey = `${todayUtc}T${String(now.getUTCHours()).padStart(2, '0')}`;

  const nextHourMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0);
  const retryAfterHour = Math.max(1, Math.ceil((nextHourMs - now.getTime()) / 1000));
  const nextMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const retryAfterMidnight = Math.max(1, Math.ceil((nextMidnightMs - now.getTime()) / 1000));

  const precheck = await db.precheckSubmission(
    clientIp,
    deviceId,
    currentHourKey,
    todayUtc,
    IP_REQUEST_LIMIT_HOURLY,
    IP_NEW_DEVICE_LIMIT_DAILY
  );

  if (!precheck.ok) {
    const isDayLimit = precheck.retry_scope === 'day';
    const retryAfter = isDayLimit ? retryAfterMidnight : retryAfterHour;
    const message = isDayLimit
      ? `Max ${IP_NEW_DEVICE_LIMIT_DAILY} new devices per IP per day`
      : `Too many requests from this IP (limit: ${IP_REQUEST_LIMIT_HOURLY}/hour)`;
    const error = precheck.reason || (isDayLimit ? 'DEVICE_CREATION_LIMIT' : 'RATE_LIMIT_EXCEEDED');

    return new Response(JSON.stringify({ error, message }), {
      status: 429,
      headers: {
        ...corsHeaders,
        ...ipSourceHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    });
  }

  // 6. Day Boundary Rule
  let dayUTC: string | null = null;
  if (runLog.startTimestamp) {
    const d = new Date(runLog.startTimestamp);
    if (!isNaN(d.getTime())) {
      dayUTC = d.toISOString().slice(0, 10);
    }
  }
  if (!dayUTC && typeof body.dayUTC === 'string') {
    dayUTC = body.dayUTC;
  }

  if (mode === 'daily') {
    if (!dayUTC || !/^\d{4}-\d{2}-\d{2}$/.test(dayUTC)) {
      return new Response(JSON.stringify({ error: 'DAY_UTC_REQUIRED', message: 'daily mode requires valid startTimestamp or dayUTC' }), {
        status: 400,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }

    const yesterdayUtc = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    if (dayUTC !== todayUtc && dayUTC !== yesterdayUtc) {
      return new Response(JSON.stringify({
        error: 'DAY_OUT_OF_BOUNDS',
        message: `Run start day (${dayUTC}) must be today (${todayUtc}) or yesterday (${yesterdayUtc}) UTC`
      }), {
        status: 400,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Fail closed: manifest validation
  let activeManifest: any = null;
  try {
    activeManifest = manifestOverride !== undefined
      ? (typeof manifestOverride === 'function' ? await manifestOverride() : manifestOverride)
      : defaultManifest;

    if (!activeManifest && manifestOverride === undefined) {
      const mod = await import('./vendor/manifest.json', { with: { type: 'json' } });
      activeManifest = mod.default || mod;
    }
  } catch (_e) {
    activeManifest = null;
  }

  const expectedRulesVersion = activeManifest?.rulesVersion;
  const expectedReplayVersion = activeManifest?.replayVersion;

  if (
    !expectedRulesVersion ||
    !expectedReplayVersion ||
    typeof expectedRulesVersion !== 'string' ||
    typeof expectedReplayVersion !== 'string'
  ) {
    return new Response(JSON.stringify({
      error: 'SERVER_CONFIGURATION_ERROR',
      message: 'Failed to load authoritative rules/replay manifest'
    }), {
      status: 500,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 7. Execute Verification (verifyRun) with wall-clock and CPU measurement
  const verifyOptions: any = {
    mode,
    dayUTC,
    expectedRulesVersion,
    expectedReplayVersion,
  };

  const tVerifyStart = performance.now();
  const denoGlobal = (globalThis as any).Deno;
  const cpuStart = (typeof denoGlobal?.cpuUsage === 'function') ? denoGlobal.cpuUsage() : null;

  const verdict = verifyRun(runLog, verifyOptions);
  const verifyWallMs = performance.now() - tVerifyStart;
  const cpuEnd = (cpuStart && typeof denoGlobal?.cpuUsage === 'function') ? denoGlobal.cpuUsage() : null;

  let verifyCpuMs: number | null = null;
  if (cpuStart && cpuEnd) {
    verifyCpuMs = ((cpuEnd.user - cpuStart.user) + (cpuEnd.system - cpuStart.system)) / 1000;
  }

  const timingHeaders: Record<string, string> = {
    'x-verify-ms': verifyWallMs.toFixed(2),
    'Server-Timing': `verify;dur=${verifyWallMs.toFixed(2)}`,
  };
  if (verifyCpuMs !== null) {
    timingHeaders['x-verify-cpu-ms'] = verifyCpuMs.toFixed(2);
  }

  if (!verdict.ok) {
    return new Response(JSON.stringify({
      error: 'VERIFICATION_REJECTED',
      status: verdict.status,
      reason: verdict.reason,
      flags: verdict.flags || [],
    }), {
      status: 422,
      headers: { ...corsHeaders, ...ipSourceHeaders, ...timingHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 8. Extract Trusted Replay Submission
  const submission = await extractSubmission(runLog, verdict);
  if (!submission) {
    return new Response(JSON.stringify({ error: 'SUBMISSION_EXTRACTION_FAILED' }), {
      status: 500,
      headers: { ...corsHeaders, ...ipSourceHeaders, ...timingHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 9. Atomic Recording & Idempotency / Device Limit Check via required recordSubmission
  const devSubKey = `dev_sub:${deviceId}:${dayUTC || todayUtc}`;
  const displayName = generateDisplayName(deviceId);

  const recordResult = await db.recordSubmission({
    deviceId,
    displayName,
    dayUtc: dayUTC || todayUtc,
    seed: BigInt(submission.seed),
    points: submission.points,
    totalMoves: submission.moves,
    maxTile: submission.maxTile,
    relics: submission.relicsOwned,
    replayVersion: submission.replayVersion,
    eventsHash: submission.eventsHash,
    durationMs: typeof runLog.durationMs === 'number' ? runLog.durationMs : (typeof runLog.activeMs === 'number' ? runLog.activeMs : null),
    flags: verdict.flags || [],
    devKey: devSubKey,
    devLimit: DEVICE_SUBMISSION_LIMIT_DAILY,
    finalBoard: (submission as any).finalBoard ?? null,
  });

  if (recordResult.status === 'ALREADY_SUBMITTED') {
    return new Response(JSON.stringify({
      status: 'ALREADY_SUBMITTED',
      message: 'This exact run was already recorded.',
      eventsHash: submission.eventsHash,
    }), {
      status: 200,
      headers: { ...corsHeaders, ...ipSourceHeaders, ...timingHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (recordResult.status === 'DEVICE_LIMIT') {
    return new Response(JSON.stringify({
      error: 'DEVICE_DAILY_LIMIT_EXCEEDED',
      message: `Max ${DEVICE_SUBMISSION_LIMIT_DAILY} submissions per device per day`,
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        ...ipSourceHeaders,
        ...timingHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterMidnight),
      },
    });
  }

  return new Response(JSON.stringify({
    status: 'ACCEPTED',
    verdict: {
      status: verdict.status,
      points: submission.points,
      moves: submission.moves,
      maxTile: submission.maxTile,
      eventsHash: submission.eventsHash,
      flags: verdict.flags || [],
    }
  }), {
    status: 200,
    headers: { ...corsHeaders, ...ipSourceHeaders, ...timingHeaders, 'Content-Type': 'application/json' },
  });
}
