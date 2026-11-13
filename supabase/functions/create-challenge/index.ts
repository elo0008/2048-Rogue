// supabase/functions/create-challenge/index.ts
// Deno Edge Function entry point for Rogue 2048 Challenge Creation
// Imports @supabase/supabase-js via jsr: (Supabase's officially recommended specifier for Deno)

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleCreateChallengeRequest, CreateChallengeDbAdapter } from './handler.ts';

export function createRealDatabaseAdapter(supabase: SupabaseClient): CreateChallengeDbAdapter {
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

    async isDeviceRegistered(deviceId: string) {
      const { data, error } = await supabase
        .from('devices')
        .select('device_id')
        .eq('device_id', deviceId)
        .maybeSingle();
      if (error) {
        throw new Error(`isDeviceRegistered query failed: ${error.message}`);
      }
      return Boolean(data);
    },

    async consumeNewDeviceLimit(ip: string, dayKey: string, limit: number) {
      const key = `ip_newdev:${ip}:${dayKey}`;
      const { data, error } = await supabase.rpc('consume_rate_limit', {
        p_key: key,
        p_limit: limit,
      });
      if (error) {
        throw new Error(`consume_rate_limit RPC failed: ${error.message}`);
      }
      return { allowed: Boolean(data) };
    },

    async createDailyChallenge(params) {
      const { data, error } = await supabase.rpc('create_daily_challenge', {
        p_device_id: params.deviceId,
        p_code: params.code,
        p_day_utc: params.dayUtc ?? null,
        p_limit_key: params.limitKey,
        p_limit: params.limit,
      });
      if (error) {
        throw new Error(`create_daily_challenge RPC failed: ${error.message}`);
      }
      return data as any;
    },

    async createFreeChallenge(params) {
      const { data, error } = await supabase.rpc('create_free_challenge', {
        p_device_id: params.deviceId,
        p_display_name: params.displayName,
        p_code: params.code,
        p_points: params.points,
        p_total_moves: params.totalMoves,
        p_max_tile: params.maxTile,
        p_relics: params.relics,
        p_seed: params.seed.toString(),
        p_final_board: params.finalBoard ?? null,
        p_replay_version: params.replayVersion,
        p_events_hash: params.eventsHash,
        p_expires_at: params.expiresAt,
        p_limit_key: params.limitKey,
        p_limit: params.limit,
      });
      if (error) {
        throw new Error(`create_free_challenge RPC failed: ${error.message}`);
      }
      return data as any;
    },
  };
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn('[create-challenge] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const databaseAdapter = createRealDatabaseAdapter(supabase);

Deno.serve(async (req: Request) => {
  return handleCreateChallengeRequest(req, databaseAdapter);
});

