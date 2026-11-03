// supabase/functions/set-name/index.ts
// Deno Edge Function entry point for Rogue 2048 Custom Display Names
// Imports @supabase/supabase-js via jsr: (Supabase's officially recommended specifier for Deno)

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleSetNameRequest, SetNameDatabaseAdapter } from './handler.ts';

export function createRealSetNameAdapter(supabase: SupabaseClient): SetNameDatabaseAdapter {
  return {
    async consumeRateLimit(key: string, limit: number) {
      const { data, error } = await supabase.rpc('consume_rate_limit', {
        p_key: key,
        p_limit: limit,
      });

      if (error) {
        throw new Error(`consume_rate_limit RPC failed: ${error.message}`);
      }

      const row = Array.isArray(data) ? data[0] : data;
      return {
        allowed: Boolean(row?.allowed),
        current: Number(row?.current_count ?? 0),
      };
    },

    async setDisplayNameLimited(
      deviceId: string,
      displayName: string | null,
      nameNorm: string | null,
      limitKey: string,
      limit: number
    ) {
      const { data, error } = await supabase.rpc('set_display_name_limited', {
        p_device_id: deviceId,
        p_display_name: displayName,
        p_name_norm: nameNorm,
        p_limit_key: limitKey,
        p_limit: limit,
      });

      if (error) {
        throw new Error(`set_display_name_limited RPC failed: ${error.message}`);
      }

      return data as any;
    },
  };
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn('[set-name] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const databaseAdapter = createRealSetNameAdapter(supabase);

Deno.serve(async (req: Request) => {
  return handleSetNameRequest(req, databaseAdapter);
});
