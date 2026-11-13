// supabase/functions/submit-run/index.ts
// Deno Edge Function entry point for Rogue 2048 Leaderboard Submission
// Imports @supabase/supabase-js via jsr: (Supabase's officially recommended specifier for Deno)

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleSubmissionRequest, DatabaseAdapter } from './handler.ts';

export function createRealDatabaseAdapter(supabase: SupabaseClient): DatabaseAdapter {
  return {
    async precheckSubmission(
      ip: string,
      deviceId: string,
      hourKey: string,
      dayKey: string,
      ipReqLimit: number,
      ipNewDevLimit: number
    ) {
      const { data, error } = await supabase.rpc('precheck_submission', {
        p_ip: ip,
        p_device_id: deviceId,
        p_hour_key: hourKey,
        p_day_key: dayKey,
        p_ip_req_limit: ipReqLimit,
        p_ip_newdev_limit: ipNewDevLimit,
      });

      if (error) {
        throw new Error(`precheck_submission RPC failed: ${error.message}`);
      }

      return data as any;
    },

    async recordSubmission(params) {
      const { data, error } = await supabase.rpc('record_submission', {
        p_device_id: params.deviceId,
        p_display_name: params.displayName,
        p_day_utc: params.dayUtc,
        p_seed: params.seed.toString(),
        p_points: params.points,
        p_total_moves: params.totalMoves,
        p_max_tile: params.maxTile,
        p_relics: params.relics,
        p_replay_version: params.replayVersion,
        p_events_hash: params.eventsHash,
        p_duration_ms: params.durationMs,
        p_flags: params.flags,
        p_dev_key: params.devKey,
        p_dev_limit: params.devLimit,
        p_final_board: params.finalBoard ?? null,
      });

      if (error) {
        throw new Error(`record_submission RPC failed: ${error.message}`);
      }

      return data as any;
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
