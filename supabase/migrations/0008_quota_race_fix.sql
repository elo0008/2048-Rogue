-- 0008_quota_race_fix.sql: Atomic quota increment first with rollback on failure or limit exceeded

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

  -- (2) Increment the counter FIRST atomically
  insert into public.abuse_rate_limits (key, count, window_start)
  values (p_limit_key, 1, now())
  on conflict (key)
  do update set count = abuse_rate_limits.count + 1
  returning count into v_cur_count;

  -- Check if limit exceeded: rollback (decrement) and return 429
  if v_cur_count > p_limit then
    update public.abuse_rate_limits
    set count = count - 1
    where key = p_limit_key;

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
      -- Rollback counter increment
      update public.abuse_rate_limits
      set count = count - 1
      where key = p_limit_key;

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
      -- Rollback counter increment on unique_violation
      update public.abuse_rate_limits
      set count = count - 1
      where key = p_limit_key;

      return jsonb_build_object(
        'ok', false,
        'status', 409,
        'error', 'NAME_TAKEN',
        'message', 'Display name is already taken'
      );
    end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 200,
    'display_name', v_final_display_name
  );
end;
$$;

revoke all on function public.set_display_name_limited(text, text, text, text, int) from public, anon, authenticated;
grant execute on function public.set_display_name_limited(text, text, text, text, int) to service_role;

