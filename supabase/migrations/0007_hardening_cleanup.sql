-- 0007_hardening_cleanup.sql: Rate limits cleanup and atomic set_display_name_limited RPC

-- 1. Create cleanup_rate_limits:
-- Deletes rows older than 2 days from abuse_rate_limits using idx_abuse_rate_limits_window.
-- Strictly service_role only.
create or replace function public.cleanup_rate_limits()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.abuse_rate_limits
  where window_start < now() - interval '2 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_rate_limits() from public, anon, authenticated;
grant execute on function public.cleanup_rate_limits() to service_role;

-- 2. Update precheck_submission:
-- Calls cleanup_rate_limits with probability 1/50 (random() < 0.02).
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
  -- Probabilistic cleanup: 1 in 50 calls (2%) deletes rate limit rows older than 2 days
  if (random() < 0.02) then
    perform public.cleanup_rate_limits();
  end if;

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

revoke all on function public.precheck_submission(text, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.precheck_submission(text, text, text, text, int, int) to service_role;

-- 3. Create set_display_name_limited:
-- Atomic custom display name update with rate limiting and collision checks.
-- Service_role only.
create or replace function public.set_display_name_limited(
  p_device_id text,
  p_display_name text,
  p_name_norm text,
  p_limit_key text,
  p_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dev_exists boolean;
  v_cur_count int;
  v_gen_conflict boolean;
  v_final_display_name text;
begin
  -- (1) Check if device exists: missing -> 404 without touching any counter
  select exists(
    select 1 from public.devices where device_id = p_device_id
  ) into v_dev_exists;

  if not v_dev_exists then
    return jsonb_build_object(
      'ok', false,
      'status', 404,
      'error', 'DEVICE_NOT_FOUND',
      'message', 'Device must be registered through gameplay before setting a custom name'
    );
  end if;

  -- (2) Check if counter for p_limit_key is already >= p_limit -> 429
  select count into v_cur_count
  from public.abuse_rate_limits
  where key = p_limit_key;

  if v_cur_count is not null and v_cur_count >= p_limit then
    return jsonb_build_object(
      'ok', false,
      'status', 429,
      'error', 'DEVICE_DAILY_LIMIT_EXCEEDED',
      'message', 'Max ' || p_limit || ' name changes per device per day'
    );
  end if;

  -- (3) Reject (409 NAME_TAKEN) if custom name norm equals another device's generated_name norm
  if p_name_norm is not null then
    select exists(
      select 1 from public.devices
      where device_id <> p_device_id
        and lower(regexp_replace(generated_name, '[\s_\-]+', '', 'g')) = p_name_norm
    ) into v_gen_conflict;

    if v_gen_conflict then
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'error', 'NAME_TAKEN',
        'message', 'Display name is already taken'
      );
    end if;
  end if;

  -- (4) Perform the update:
  -- If p_display_name is null: clear back to generated_name
  if p_display_name is null then
    update public.devices
    set display_name = generated_name,
        name_norm = null,
        name_changed_at = now()
    where device_id = p_device_id
    returning display_name into v_final_display_name;
  else
    begin
      update public.devices
      set display_name = p_display_name,
          name_norm = p_name_norm,
          name_changed_at = now()
      where device_id = p_device_id
      returning display_name into v_final_display_name;
    exception when unique_violation then
      -- unique_violation does NOT consume quota
      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'error', 'NAME_TAKEN',
        'message', 'Display name is already taken'
      );
    end;
  end if;

  -- (5) Increment the counter ONLY on success
  insert into public.abuse_rate_limits (key, count, window_start)
  values (p_limit_key, 1, now())
  on conflict (key)
  do update set count = abuse_rate_limits.count + 1;

  return jsonb_build_object(
    'ok', true,
    'status', 200,
    'display_name', v_final_display_name
  );
end;
$$;

revoke all on function public.set_display_name_limited(text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.set_display_name_limited(text, text, text, text, int) to service_role;

