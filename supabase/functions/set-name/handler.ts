// supabase/functions/set-name/handler.ts
// Pure HTTP request handler for Rogue 2048 Custom Display Names
// Web-standard types only (Request, Response, Headers) - zero Deno or Node specific globals

import { validateName, ValidateNameResult } from './names.ts';

export interface SetNameResult {
  ok: boolean;
  status: number;
  error?: string;
  display_name?: string;
}

export interface SetNameDatabaseAdapter {
  consumeRateLimit(key: string, limit: number): Promise<{ allowed: boolean; current: number }>;
  setDisplayName(
    deviceId: string,
    displayName: string | null,
    nameNorm: string | null
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
    return cfIp.trim();
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

  // 2. Body size check (<= 2 KB = 2048 bytes)
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

  // 3. Parse JSON
  let body: any;
  try {
    body = JSON.parse(rawBodyText);
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON', message: 'Malformed JSON payload' }), {
      status: 400,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 4. Validate deviceId regex: /^[a-z0-9_]{8,64}$/
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

  // 5. Validate name (null = clear to generated_name; string = validateName)
  const nameInput = body?.name;
  let validatedTargetName: string | null = null;
  let validatedTargetNorm: string | null = null;

  if (nameInput !== null) {
    const v: ValidateNameResult = validateName(nameInput);
    if (!v.ok) {
      return new Response(JSON.stringify({ error: 'NAME_NOT_ALLOWED' }), {
        status: 400,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }
    validatedTargetName = v.name;
    validatedTargetNorm = v.norm;
  }

  // 6. Rate limit checks
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const currentHourKey = `${todayUtc}T${String(now.getUTCHours()).padStart(2, '0')}`;

  const nextHourMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0);
  const retryAfterHour = Math.max(1, Math.ceil((nextHourMs - now.getTime()) / 1000));

  const nextMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const retryAfterMidnight = Math.max(1, Math.ceil((nextMidnightMs - now.getTime()) / 1000));

  if (db) {
    // 6a. IP request limit: reuse 600/hour
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

    // 6b. Per device 3 name changes per UTC day
    const devNameKey = `dev_name:${deviceId}:${todayUtc}`;
    const devCheck = await db.consumeRateLimit(devNameKey, DEVICE_NAME_CHANGE_LIMIT_DAILY);
    if (!devCheck.allowed) {
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

    // 7. Atomic RPC set_display_name
    const result = await db.setDisplayName(deviceId, validatedTargetName, validatedTargetNorm);

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

    if (result.status === 200 || result.ok) {
      return new Response(JSON.stringify({
        status: nameInput === null ? 'RESET' : 'UPDATED',
        displayName: result.display_name,
      }), {
        status: 200,
        headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      error: result.error || 'UPDATE_FAILED'
    }), {
      status: result.status || 500,
      headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    status: nameInput === null ? 'RESET' : 'UPDATED',
    displayName: validatedTargetName || 'Generated-Player-100',
  }), {
    status: 200,
    headers: { ...corsHeaders, ...ipSourceHeaders, 'Content-Type': 'application/json' },
  });
}

