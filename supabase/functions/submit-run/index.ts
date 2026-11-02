// supabase/functions/submit-run/index.ts
// Deno Edge Function entry point for Rogue 2048 Leaderboard Submission
// Imports @supabase/supabase-js via jsr: (Supabase's officially recommended specifier for Deno)

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleSubmissionRequest, DatabaseAdapter } from './handler.ts';

export function createRealDatabaseAdapter(supabase: SupabaseClient): DatabaseAdapter {
  return {
    async isDeviceRegistered(deviceId: string): Promise<boolean> {
      const { data, error } = await supabase
        .from('devices')
        .select('device_id')
        .eq('device_id', deviceId)
        .maybeSingle();

      if (error) {
        throw new Error(`isDeviceRegistered failed: ${error.message}`);
      }
      return Boolean(data);
    },

    async registerDevice(deviceId: string, displayName: string): Promise<void> {
      const { error } = await supabase
        .from('devices')
        .insert({
          device_id: deviceId,
          display_name: displayName,
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        });

      if (error) {
        throw new Error(`registerDevice failed: ${error.message}`);
      }
    },

    async updateDeviceSeen(deviceId: string): Promise<void> {
      const { error } = await supabase
        .from('devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('device_id', deviceId);

      if (error) {
        throw new Error(`updateDeviceSeen failed: ${error.message}`);
      }
    },

    async isDuplicateEvent(deviceId: string, eventsHash: string): Promise<boolean> {
      const { data, error } = await supabase
        .from('daily_runs')
        .select('id')
        .eq('device_id', deviceId)
        .eq('events_hash', eventsHash)
        .maybeSingle();

      if (error) {
        throw new Error(`isDuplicateEvent failed: ${error.message}`);
      }
      return Boolean(data);
    },

    async consumeRateLimit(key: string, limit: number): Promise<{ allowed: boolean; current: number }> {
      // Single atomic statement via PostgreSQL security definer RPC
      const { data, error } = await supabase.rpc('consume_rate_limit', {
        p_key: key,
        p_limit: limit,
      });

      if (error) {
        throw new Error(`consumeRateLimit RPC failed: ${error.message}`);
      }

      const row = Array.isArray(data) ? data[0] : data;
      return {
        allowed: Boolean(row?.allowed),
        current: Number(row?.current_count ?? 0),
      };
    },

    async recordAcceptedRun(submission): Promise<{ id: number | string }> {
      const payload: any = {
        device_id: submission.deviceId,
        day_utc: submission.dayUtc,
        seed: submission.seed.toString(),
        points: submission.points,
        total_moves: submission.totalMoves,
        max_tile: submission.maxTile,
        relics_owned: submission.relicsOwned,
        replay_version: submission.replayVersion,
        events_hash: submission.eventsHash,
        duration_ms: submission.durationMs,
        flags: submission.flags,
      };

      if (submission.receivedAt) {
        payload.received_at = submission.receivedAt;
      }

      const { data, error } = await supabase
        .from('daily_runs')
        .insert(payload)
        .select('id')
        .single();

      if (error) {
        throw new Error(`recordAcceptedRun failed: ${error.message}`);
      }
      return { id: data.id };
    },
  };
}

// Injected environment variables provided by Supabase Edge Runtime
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn('[submit-run] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const databaseAdapter = createRealDatabaseAdapter(supabase);

Deno.serve(async (req: Request) => {
  return handleSubmissionRequest(req, databaseAdapter);
});
