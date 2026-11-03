// supabase/functions/set-name/handler.ts
// Pure HTTP request handler for Rogue 2048 Custom Display Names
// Web-standard types only (Request, Response, Headers) - zero Deno or Node specific globals

import { validateNameDetailed } from './names.ts';
import { normalizeIp } from './ip.ts';

export interface SetNameResult {
  ok: boolean;
  status: number;
  error?: string;
  message?: string;
  display_name?: string;
}

export interface SetNameDatabaseAdapter {
  consumeRateLimit(key: string, limit: number): Promise<{ allowed: boolean; current: number }>;
  setDisplayNameLimited(
    deviceId: string,
    displayName: string | null,
    nameNorm: string | null,
    limitKey: string,
    limit: number
  ): Promise<SetNameResult>;
}

export function getCorsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const isAllowed = origin === 'https://rogue2048.vercel.app' || /^http:\/\/localhost(?::\d+)?$/.test(origin);
  if (!isAllowed) {
    return { 'Vary': 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
    'Vary': 'Origin',
  };
}

export function getClientIp(req: Request): string {
  // Use cf-connecting-ip only. In production on Supabase Edge Runtime, Cloudflare sets cf-connecting-ip.
  // If absent, fall back to the shared bucket 'unknown' and set x-ip-source: missing.
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return normalizeIp(cfIp);
  }
  console.warn('[getClientIp] cf-connecting-ip header missing; falling back to "unknown"');
  return 'unknown';
}

export const IP_REQUEST_LIMIT_HOURLY = 600;
export const DEVICE_NAME_CHANGE_LIMIT_DAILY = 3;

export async function handleSetNameRequest(
  req: Request,
  db?: SetNameDatabaseAdapter
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

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. FAIL CLOSED: If database adapter or required methods are missing, return 500 SERVER_CONFIGURATION_ERROR
  if (
    !db ||
    typeof db.consumeRateLimit !== 'function' ||
    typeof db.setDisplayNameLimited !== 'function'
  ) {
    return new Response(JSON.stringify({
      error: 'SERVER_CONFIGURATION_ERROR',
      message: 'Database adapter or required methods missing',
    }), {
      status: 500,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 3. Body size check (<= 2 KB = 2048 bytes)
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
  if (contentLength > 2048 || rawBodyText.length > 2048) {
    return new Response(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE', message: 'Body exceeds 2 KB limit' }), {
      status: 413,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 4. Parse JSON
  let body: any;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON', message: 'Malformed JSON payload' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 5. Validate deviceId regex: /^[a-z0-9_]{8,64}$/
  const deviceId = body?.deviceId;
  if (!deviceId || typeof deviceId !== 'string' || !/^[a-z0-9_]{8,64}$/.test(deviceId)) {
    return new Response(JSON.stringify({
      error: 'INVALID_DEVICE_ID',
      message: 'deviceId must match /^[a-z0-9_]{8,64}$/'
    }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 6. Validate name (only explicit null resets; missing/undefined returns 400 INVALID_NAME_FIELD)
  if (!body || !('name' in body) || body.name === undefined) {
    return new Response(JSON.stringify({
      error: 'INVALID_NAME_FIELD',
      message: "Field 'name' is required (string to set, null to reset)"
    }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  const nameInput = body.name;
  let validatedTargetName: string | null = null;
  let validatedTargetNorm: string | null = null;

  if (nameInput !== null) {
    const v = validateNameDetailed(nameInput);
    if (!v.ok) {
      // P1 NO RULE LEAKS: response body is exactly {"error":"NAME_NOT_ALLOWED"}
      return new Response(JSON.stringify({
        error: 'NAME_NOT_ALLOWED',
      }), {
        status: 400,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }
    validatedTargetName = v.name;
    validatedTargetNorm = v.norm;
  }

  // 7. Rate limit timing keys
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const currentHourKey = `${todayUtc}T${String(now.getUTCHours()).padStart(2, '0')}`;

  const nextHourMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0);
  const retryAfterHour = Math.max(1, Math.ceil((nextHourMs - now.getTime()) / 1000));

  const nextMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const retryAfterMidnight = Math.max(1, Math.ceil((nextMidnightMs - now.getTime()) / 1000));

  // 8. IP request rate limit (600/hour)
  const ipReqKey = `ip_req:${clientIp}:${currentHourKey}`;
  const ipCheck = await db.consumeRateLimit(ipReqKey, IP_REQUEST_LIMIT_HOURLY);
  if (!ipCheck.allowed) {
    return new Response(JSON.stringify({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests from this IP (limit: ${IP_REQUEST_LIMIT_HOURLY}/hour)`
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        ...ipSourceHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterHour),
      },
    });
  }

  // 9. Atomic RPC set_display_name_limited
  const devNameKey = `dev_name:${deviceId}:${todayUtc}`;
  const result = await db.setDisplayNameLimited(
    deviceId,
    validatedTargetName,
    validatedTargetNorm,
    devNameKey,
    DEVICE_NAME_CHANGE_LIMIT_DAILY
  );

  if (result.status === 404 || result.error === 'DEVICE_NOT_FOUND') {
    return new Response(JSON.stringify({
      error: 'DEVICE_NOT_FOUND',
      message: 'Device must be registered through gameplay before setting a custom name'
    }), {
      status: 404,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (result.status === 409 || result.error === 'NAME_TAKEN') {
    return new Response(JSON.stringify({
      error: 'NAME_TAKEN',
      message: 'Display name is already taken'
    }), {
      status: 409,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (result.status === 429 || result.error === 'DEVICE_DAILY_LIMIT_EXCEEDED') {
    return new Response(JSON.stringify({
      error: 'DEVICE_DAILY_LIMIT_EXCEEDED',
      message: `Max ${DEVICE_NAME_CHANGE_LIMIT_DAILY} name changes per device per day`
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        ...ipSourceHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterMidnight),
      },
    });
  }

  if (result.status === 200 || result.ok) {
    return new Response(JSON.stringify({
      status: (nameInput === null || nameInput === undefined) ? 'RESET' : 'UPDATED',
      displayName: result.display_name,
    }), {
      status: 200,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    error: result.error || 'UPDATE_FAILED',
    message: result.message || 'Name update failed',
  }), {
    status: result.status || 500,
    headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
  });
}
