-- 0006_submit_hardening.sql: Prevent name clobbering and deduplicate new-device counter per IP/day

-- 1. Update precheck_submission:
-- Counts an unregistered device at most once per (ip, device, day) by inserting a marker key.
-- If the marker already exists, the counter is not incremented.
-- If the daily limit is exceeded for a new device, the marker is deleted and 429 DEVICE_CREATION_LIMIT is returned.
create or replace function public.precheck_submission(
  p_ip text,
  p_device_id text,
  p_hour_key text,
  p_day_key text,
  p_ip_req_limit int,
  p_ip_newdev_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip_req_key text := 'ip_req:' || p_ip || ':' || p_hour_key;
  v_ip_req_count int;
  v_dev_exists boolean;
  v_ip_newdev_key text := 'ip_newdev:' || p_ip || ':' || p_day_key;
  v_marker_key text := 'ip_newdev_seen:' || p_ip || ':' || p_day_key || ':' || p_device_id;
  v_ip_newdev_count int;
begin
  -- 1. Consume IP-request counter atomically
  insert into public.abuse_rate_limits (key, count, window_start)
  values (v_ip_req_key, 1, now())
  on conflict (key)
  do update set count = abuse_rate_limits.count + 1
  returning count into v_ip_req_count;

  if v_ip_req_count > p_ip_req_limit then
    return jsonb_build_object(
      'ok', false,
      'reason', 'RATE_LIMIT_EXCEEDED',
      'retry_scope', 'hour'
    );
  end if;

  -- 2. Check if device is already registered in devices table
  select exists(
    select 1 from public.devices where device_id = p_device_id
  ) into v_dev_exists;

  -- 3. If device is not registered, count at most once per (ip, device, day)
  if not v_dev_exists then
    -- Attempt to insert the marker key atomically for this (ip, day, device)
    insert into public.abuse_rate_limits (key, count, window_start)
    values (v_marker_key, 1, now())
    on conflict (key) do nothing;

    -- If marker was newly inserted, this device is seen for the first time today from this IP
    if found then
      insert into public.abuse_rate_limits (key, count, window_start)
      values (v_ip_newdev_key, 1, now())
      on conflict (key)
      do update set count = abuse_rate_limits.count + 1
      returning count into v_ip_newdev_count;

      if v_ip_newdev_count > p_ip_newdev_limit then
        -- Roll back the marker so rejected device is not marked as seen
        delete from public.abuse_rate_limits where key = v_marker_key;
        return jsonb_build_object(
          'ok', false,
          'reason', 'DEVICE_CREATION_LIMIT',
          'retry_scope', 'day'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', null,
    'retry_scope', null
  );
end;
$$;

-- 2. Update record_submission:
-- On initial device insert: set display_name = p_display_name AND generated_name = p_display_name.
-- On conflict: update ONLY last_seen_at = now() (never clobber custom display_name).
create or replace function public.record_submission(
  p_device_id text,
  p_display_name text,
  p_day_utc date,
  p_seed bigint,
  p_points int,
  p_total_moves int,
  p_max_tile int,
  p_relics jsonb,
  p_replay_version text,
  p_events_hash text,
  p_duration_ms int,
  p_flags text[],
  p_dev_key text,
  p_dev_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id bigint;
  v_dev_count int;
begin
  -- 1. Upsert device: on insert, populate display_name and generated_name; on conflict, update ONLY last_seen_at
  insert into public.devices (device_id, display_name, generated_name, last_seen_at)
  values (p_device_id, p_display_name, p_display_name, now())
  on conflict (device_id)
  do update set last_seen_at = now();

  -- 2. Insert run with ON CONFLICT (device_id, events_hash) DO NOTHING
  insert into public.daily_runs (
    device_id,
    day_utc,
    seed,
    points,
    total_moves,
    max_tile,
    relics_owned,
    replay_version,
    events_hash,
    duration_ms,
    flags
  )
  values (
    p_device_id,
    p_day_utc,
    p_seed,
    p_points,
    p_total_moves,
    p_max_tile,
    p_relics,
    p_replay_version,
    p_events_hash,
    p_duration_ms,
    p_flags
  )
  on conflict (device_id, events_hash) do nothing
  returning id into v_run_id;

  -- 3. If duplicate events_hash for this device
  if v_run_id is null then
    return jsonb_build_object(
      'status', 'ALREADY_SUBMITTED',
      'id', null
    );
  end if;

  -- 4. Consume device counter atomically
  insert into public.abuse_rate_limits (key, count, window_start)
  values (p_dev_key, 1, now())
  on conflict (key)
  do update set count = abuse_rate_limits.count + 1
  returning count into v_dev_count;

  -- 5. Check if device limit exceeded
  if v_dev_count > p_dev_limit then
    delete from public.daily_runs where id = v_run_id;
    return jsonb_build_object(
      'status', 'DEVICE_LIMIT',
      'id', null
    );
  end if;

  -- 6. Successfully accepted
  return jsonb_build_object(
    'status', 'ACCEPTED',
    'id', v_run_id
  );
end;
$$;

-- 3. Privileges and Security (Strictly service_role only)
revoke all on function public.precheck_submission(text, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.precheck_submission(text, text, text, text, int, int) to service_role;

revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) from public, anon, authenticated;
grant execute on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) to service_role;

