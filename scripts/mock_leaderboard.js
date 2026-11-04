// scripts/mock_leaderboard.js
// Local Node HTTP server wrapping real handleSubmissionRequest and handleSetNameRequest
// with SecurityDatabaseEngine, RPC endpoints, and behaviour control.

import http from 'node:http';
import { handleSubmissionRequest } from '../supabase/functions/submit-run/handler.ts';
import { handleSetNameRequest } from '../supabase/functions/set-name/handler.ts';
import { SecurityDatabaseEngine } from './lib/inmemory_db.js';

export function createMockLeaderboardServer(initialDb = null) {
  let db = initialDb || new SecurityDatabaseEngine();
  let behaviour = 'ok'; // ok | offline | slow | status:429 | status:500 | reject:422 | reject:422-version
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
      'Access-Control-Expose-Headers': 'Retry-After, x-region, x-verify-ms',
    };

    // 1. Handle OPTIONS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // 2. Read full body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let bodyJson = null;
    try {
      bodyJson = rawBody ? JSON.parse(rawBody) : null;
    } catch {}

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Track request
    requests.push({
      method: req.method,
      path: pathname,
      headers: req.headers,
      body: bodyJson,
      rawBody,
      timestamp: Date.now(),
    });

    // 3. Control Endpoints
    if (pathname === '/__control/behaviour' && req.method === 'POST') {
      if (bodyJson && bodyJson.behaviour) {
        behaviour = bodyJson.behaviour;
      }
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, behaviour }));
      return;
    }

    if (pathname === '/__control/reset' && req.method === 'POST') {
      db = new SecurityDatabaseEngine();
      behaviour = 'ok';
      requests.length = 0;
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/__control/stats' && req.method === 'GET') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        behaviour,
        requestsCount: requests.length,
        dailyRunsCount: db.dailyRuns.length,
        devicesCount: db.devices.size,
        requests,
      }));
      return;
    }

    // 4. Behaviour Override for submit-run
    if (pathname === '/functions/v1/submit-run' && req.method === 'POST') {
      if (behaviour === 'offline') {
        req.socket.destroy();
        return;
      }
      if (behaviour === 'slow') {
        await new Promise(r => setTimeout(r, 2000));
      }
      if (behaviour === 'status:429') {
        res.writeHead(429, {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': '30',
        });
        res.end(JSON.stringify({ error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' }));
        return;
      }
      if (behaviour === 'status:500') {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: 'Mock 500 error' }));
        return;
      }
      if (behaviour === 'reject:422') {
        res.writeHead(422, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'VERIFICATION_REJECTED',
          status: 'REJECT',
          reason: 'Illegal swipe direction',
          flags: [],
        }));
        return;
      }
      if (behaviour === 'reject:422-version') {
        res.writeHead(422, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'VERIFICATION_REJECTED',
          status: 'REJECT',
          reason: 'Rules version mismatch: claimed "old", expected "new"',
          flags: [],
        }));
        return;
      }
    }

    // 5. REST RPC Endpoints
    if (pathname === '/rest/v1/rpc/my_daily_rank' && req.method === 'POST') {
      const targetDay = bodyJson?.target_day || new Date().toISOString().slice(0, 10);
      const deviceId = bodyJson?.p_device_id || '';
      const result = db.rpcMyDailyRank(targetDay, deviceId);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/rest/v1/rpc/daily_best' && req.method === 'POST') {
      const targetDay = bodyJson?.target_day || new Date().toISOString().slice(0, 10);
      const result = db.rpcDailyBest(targetDay);
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // 6. Submit-Run Edge Function
    if (pathname === '/functions/v1/submit-run') {
      // Build web-standard Request with fixed documentation-range cf-connecting-ip
      const webHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) webHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      webHeaders.set('cf-connecting-ip', '198.51.100.42');

      const webReq = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: webHeaders,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? rawBody : undefined,
      });

      const webRes = await handleSubmissionRequest(webReq, db);
      const resBody = await webRes.text();

      const outHeaders = { ...corsHeaders };
      webRes.headers.forEach((val, key) => {
        outHeaders[key] = val;
      });

      res.writeHead(webRes.status, outHeaders);
      res.end(resBody);
      return;
    }

    // 7. Set-Name Edge Function
    if (pathname === '/functions/v1/set-name') {
      const webHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) webHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      webHeaders.set('cf-connecting-ip', '198.51.100.42');

      const webReq = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: webHeaders,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? rawBody : undefined,
      });

      const webRes = await handleSetNameRequest(webReq, db);
      const resBody = await webRes.text();

      const outHeaders = { ...corsHeaders };
      webRes.headers.forEach((val, key) => {
        outHeaders[key] = val;
      });

      res.writeHead(webRes.status, outHeaders);
      res.end(resBody);
      return;
    }

    // 404 fallback
    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  return {
    server,
    getDb: () => db,
    setDb: newDb => { db = newDb; },
    getBehaviour: () => behaviour,
    setBehaviour: b => { behaviour = b; },
    getRequests: () => [...requests],
    clearRequests: () => { requests.length = 0; },
    listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => {
      server.listen(port, host, () => {
        resolve(server.address().port);
      });
    }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// Standalone execution support
if (process.argv[1] && process.argv[1].endsWith('mock_leaderboard.js')) {
  const port = parseInt(process.env.MOCK_PORT || '54321', 10);
  const mock = createMockLeaderboardServer();
  mock.listen(port).then(actualPort => {
    console.log(`Mock Leaderboard Server listening on http://localhost:${actualPort}`);
  });
}

