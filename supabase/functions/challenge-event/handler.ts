// supabase/functions/challenge-event/handler.ts
// Pure HTTP request handler for Rogue 2048 Challenge Events (open, accept)
// Web-standard types only (Request, Response, Headers) - zero Deno or Node specific globals

import { normalizeIp } from './ip.ts';

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

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) {
    return normalizeIp(cfIp);
  }
  return 'unknown';
}

export interface ChallengeEventDbAdapter {
  consumeIpLimit(ip: string, hourKey: string, limit: number): Promise<{ allowed: boolean }>;
  recordChallengeEvent(code: string, kind: 'open' | 'accept'): Promise<boolean>;
}

export async function handleChallengeEventRequest(
  req: Request,
  db?: ChallengeEventDbAdapter
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

  const { code, kind } = body;
  if (!kind || (kind !== 'open' && kind !== 'accept')) {
    return new Response(JSON.stringify({ error: 'INVALID_KIND', message: 'kind must be "open" or "accept"' }), {
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

  // IP Hourly Rate Limit check
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const hourKey = `${todayUtc}T${String(now.getUTCHours()).padStart(2, '0')}`;
  const retryAfterHour = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());

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

  // If code is malformed or invalid type: no-op with generic 200, never leak existence or error details
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{12}$/.test(code)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    await db.recordChallengeEvent(code, kind);
  } catch (_e) {
    // Fail quietly and return generic 200
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

