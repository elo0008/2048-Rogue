-- 0003_submit_rpcs.sql: Atomic RPCs for submission precheck and recording

-- Function 1: precheck_submission
-- Atomically checks & increments IP request counter, checks if device is registered,
-- and if not registered, checks & increments new-device-per-IP counter.
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

  -- 2. Check if device is already registered
  select exists(
    select 1 from public.devices where device_id = p_device_id
  ) into v_dev_exists;

  -- 3. If device is not registered, consume new-device-per-IP counter atomically
  if not v_dev_exists then
    insert into public.abuse_rate_limits (key, count, window_start)
    values (v_ip_newdev_key, 1, now())
    on conflict (key)
    do update set count = abuse_rate_limits.count + 1
    returning count into v_ip_newdev_count;

    if v_ip_newdev_count > p_ip_newdev_limit then
      return jsonb_build_object(
        'ok', false,
        'reason', 'DEVICE_CREATION_LIMIT',
        'retry_scope', 'day'
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', null,
    'retry_scope', null
  );
end;
$$;

-- Function 2: record_submission
-- Atomically upserts device, inserts run with ON CONFLICT (device_id, events_hash) DO NOTHING.
-- If duplicate, returns ALREADY_SUBMITTED without consuming device rate limit.
-- If new, consumes device limit; if over limit, rolls back insert and returns DEVICE_LIMIT;
-- else returns ACCEPTED with run id.
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
  -- 1. Upsert device: insert if not exists, update last_seen_at
  insert into public.devices (device_id, display_name, last_seen_at)
  values (p_device_id, p_display_name, now())
  on conflict (device_id)
  do update set
    display_name = coalesce(excluded.display_name, devices.display_name),
    last_seen_at = now();

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

  -- 3. If nothing was inserted (duplicate events_hash for this device)
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
    -- Roll back the run insertion by deleting the inserted row
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

-- Revoke from public, anon, authenticated; grant ONLY to service_role
revoke all on function public.precheck_submission(text, text, text, text, int, int) from public;
revoke all on function public.precheck_submission(text, text, text, text, int, int) from anon, authenticated;
grant execute on function public.precheck_submission(text, text, text, text, int, int) to service_role;

revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) from public;
revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) from anon, authenticated;
grant execute on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) to service_role;
