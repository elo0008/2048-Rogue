// supabase/functions/challenge-event/index.ts
// Deno Edge Function entry point for Rogue 2048 Challenge Events
// Imports @supabase/supabase-js via jsr: (Supabase's officially recommended specifier for Deno)

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleChallengeEventRequest, ChallengeEventDbAdapter } from './handler.ts';

export function createRealDatabaseAdapter(supabase: SupabaseClient): ChallengeEventDbAdapter {
  return {
    async consumeIpLimit(ip: string, hourKey: string, limit: number) {
      const key = `ip_req:${ip}:${hourKey}`;
      const { data, error } = await supabase.rpc('consume_rate_limit', {
        p_key: key,
        p_limit: limit,
      });
      if (error) {
        throw new Error(`consume_rate_limit RPC failed: ${error.message}`);
      }
      return { allowed: Boolean(data) };
    },

    async recordChallengeEvent(code: string, kind: 'open' | 'accept') {
      const { data, error } = await supabase.rpc('record_challenge_event', {
        p_code: code,
        p_kind: kind,
      });
      if (error) {
        throw new Error(`record_challenge_event RPC failed: ${error.message}`);
      }
      return Boolean(data);
    },
  };
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn('[challenge-event] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const databaseAdapter = createRealDatabaseAdapter(supabase);

Deno.serve(async (req: Request) => {
  return handleChallengeEventRequest(req, databaseAdapter);
});

