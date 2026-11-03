-- 0005_custom_names.sql: Custom display names, uniqueness, hiding, and leaderboard integration

-- 1. Alter public.devices table
alter table public.devices add column if not exists generated_name text;
alter table public.devices add column if not exists name_hidden boolean not null default false;
alter table public.devices add column if not exists name_norm text;
alter table public.devices add column if not exists name_changed_at timestamptz;

-- Backfill generated_name from current display_name
update public.devices
set generated_name = display_name
where generated_name is null;

-- Partial unique index on name_norm (only when name_norm is not null)
create unique index if not exists idx_devices_name_norm
on public.devices (name_norm)
where name_norm is not null;

-- 2. Leaderboard Public RPC Views with name_hidden support
-- When name_hidden is true, mask custom display_name with generated_name

-- daily_best(target_day, p_limit)
create or replace function public.daily_best(
  target_day date,
  p_limit int default 100
)
returns table (
  display_name text,
  points int,
  total_moves int,
  max_tile int,
  rank bigint
)
language sql
security definer
set search_path = public
as $$
  with ranked_attempts as (
    select
      case when d.name_hidden then d.generated_name else d.display_name end as display_name,
      r.id,
      r.points,
      r.total_moves,
      r.max_tile,
      r.received_at,
      row_number() over (
        partition by r.device_id
        order by r.points desc, r.total_moves desc, r.received_at asc, r.id asc
      ) as rn
    from public.daily_runs r
    join public.devices d on d.device_id = r.device_id
    where r.day_utc = target_day
  ),
  device_bests as (
    select
      id,
      display_name,
      points,
      total_moves,
      max_tile,
      received_at
    from ranked_attempts
    where rn = 1
  )
  select
    display_name,
    points,
    total_moves,
    max_tile,
    row_number() over (
      order by points desc, total_moves desc, received_at asc, id asc
    ) as rank
  from device_bests
  order by rank asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

-- weekly_best(target_week_start, p_limit) with ISO Monday normalisation
create or replace function public.weekly_best(
  target_week_start date default date_trunc('week', now() at time zone 'utc')::date,
  p_limit int default 100
)
returns table (
  display_name text,
  points bigint,
  total_moves bigint,
  max_tile int,
  rank bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_monday date;
begin
  v_monday := date_trunc('week', coalesce(target_week_start, now() at time zone 'utc')::timestamp)::date;

  return query
  with daily_best_per_device as (
    select
      r.device_id,
      r.day_utc,
      r.id,
      r.points,
      r.total_moves,
      r.max_tile,
      r.received_at,
      row_number() over (
        partition by r.device_id, r.day_utc
        order by r.points desc, r.total_moves desc, r.received_at asc, r.id asc
      ) as rn
    from public.daily_runs r
    where r.day_utc >= v_monday
      and r.day_utc < (v_monday + interval '7 days')::date
  ),
  aggregated as (
    select
      case when d.name_hidden then d.generated_name else d.display_name end as display_name,
      sum(b.points)::bigint as total_points,
      sum(b.total_moves)::bigint as total_moves,
      max(b.max_tile)::int as highest_tile,
      max(b.received_at) as latest_received_at,
      min(b.id) as first_id
    from daily_best_per_device b
    join public.devices d on d.device_id = b.device_id
    where b.rn = 1
    group by d.device_id, d.display_name, d.generated_name, d.name_hidden
  )
  select
    a.display_name,
    a.total_points as points,
    a.total_moves,
    a.highest_tile as max_tile,
    row_number() over (
      order by a.total_points desc, a.latest_received_at asc, a.first_id asc
    ) as rank
  from aggregated a
  order by rank asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
end;
$$;

-- my_daily_rank(target_day, p_device_id)
create or replace function public.my_daily_rank(
  target_day date,
  p_device_id text
)
returns table (
  rank bigint,
  display_name text,
  points int,
  total_moves int,
  max_tile int,
  total_players bigint
)
language sql
security definer
set search_path = public
as $$
  with ranked_attempts as (
    select
      r.device_id,
      case when d.name_hidden then d.generated_name else d.display_name end as display_name,
      r.id,
      r.points,
      r.total_moves,
      r.max_tile,
      r.received_at,
      row_number() over (
        partition by r.device_id
        order by r.points desc, r.total_moves desc, r.received_at asc, r.id asc
      ) as rn
    from public.daily_runs r
    join public.devices d on d.device_id = r.device_id
    where r.day_utc = target_day
  ),
  device_bests as (
    select
      device_id,
      id,
      display_name,
      points,
      total_moves,
      max_tile,
      received_at
    from ranked_attempts
    where rn = 1
  ),
  leaderboard as (
    select
      device_id,
      display_name,
      points,
      total_moves,
      max_tile,
      row_number() over (
        order by points desc, total_moves desc, received_at asc, id asc
      ) as rank,
      count(*) over () as total_players
    from device_bests
  )
  select
    rank,
    display_name,
    points,
    total_moves,
    max_tile,
    total_players
  from leaderboard
  where device_id = p_device_id;
$$;

-- my_weekly_rank(target_week_start, p_device_id)
create or replace function public.my_weekly_rank(
  target_week_start date,
  p_device_id text
)
returns table (
  rank bigint,
  display_name text,
  points bigint,
  total_moves bigint,
  max_tile int,
  total_players bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_monday date;
begin
  v_monday := date_trunc('week', coalesce(target_week_start, now() at time zone 'utc')::timestamp)::date;

  return query
  with daily_best_per_device as (
    select
      r.device_id,
      r.day_utc,
      r.id,
      r.points,
      r.total_moves,
      r.max_tile,
      r.received_at,
      row_number() over (
        partition by r.device_id, r.day_utc
        order by r.points desc, r.total_moves desc, r.received_at asc, r.id asc
      ) as rn
    from public.daily_runs r
    where r.day_utc >= v_monday
      and r.day_utc < (v_monday + interval '7 days')::date
  ),
  aggregated as (
    select
      b.device_id,
      case when d.name_hidden then d.generated_name else d.display_name end as display_name,
      sum(b.points)::bigint as total_points,
      sum(b.total_moves)::bigint as total_moves,
      max(b.max_tile)::int as highest_tile,
      max(b.received_at) as latest_received_at,
      min(b.id) as first_id
    from daily_best_per_device b
    join public.devices d on d.device_id = b.device_id
    where b.rn = 1
    group by b.device_id, d.device_id, d.display_name, d.generated_name, d.name_hidden
  ),
  leaderboard as (
    select
      a.device_id,
      a.display_name,
      a.total_points as points,
      a.total_moves,
      a.highest_tile as max_tile,
      row_number() over (
        order by a.total_points desc, a.latest_received_at asc, a.first_id asc
      ) as rank,
      count(*) over () as total_players
    from aggregated a
  )
  select
    l.rank,
    l.display_name,
    l.points,
    l.total_moves,
    l.max_tile,
    l.total_players
  from leaderboard l
  where l.device_id = p_device_id;
end;
$$;

-- 3. Update record_submission to preserve generated_name and existing custom display_name
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
  -- 1. Upsert device: insert if not exists; preserve existing custom display_name
  insert into public.devices (device_id, display_name, generated_name, last_seen_at)
  values (p_device_id, p_display_name, p_display_name, now())
  on conflict (device_id)
  do update set
    generated_name = coalesce(devices.generated_name, excluded.generated_name),
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

-- 4. Atomic RPC set_display_name
-- Executable exclusively by service_role
-- Handles clearing to generated_name when p_display_name or p_name_norm is null
-- Catches unique_violation on name_norm and returns 409 NAME_TAKEN (never 500)
create or replace function public.set_display_name(
  p_device_id text,
  p_display_name text,
  p_name_norm text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dev_exists boolean;
  v_generated text;
begin
  -- Verify device exists
  select exists(select 1 from public.devices where device_id = p_device_id) into v_dev_exists;
  if not v_dev_exists then
    return jsonb_build_object(
      'ok', false,
      'error', 'DEVICE_NOT_FOUND',
      'status', 404
    );
  end if;

  -- Clear / reset to generated_name
  if p_display_name is null or p_name_norm is null then
    select generated_name into v_generated from public.devices where device_id = p_device_id;
    update public.devices
    set display_name = coalesce(v_generated, display_name),
        name_norm = null,
        name_changed_at = now()
    where device_id = p_device_id;

    return jsonb_build_object(
      'ok', true,
      'status', 200,
      'display_name', coalesce(v_generated, p_device_id)
    );
  end if;

  -- Set custom name; catch unique constraint collision on name_norm
  begin
    update public.devices
    set display_name = p_display_name,
        name_norm = p_name_norm,
        name_changed_at = now()
    where device_id = p_device_id;

    return jsonb_build_object(
      'ok', true,
      'status', 200,
      'display_name', p_display_name
    );
  exception
    when unique_violation then
      return jsonb_build_object(
        'ok', false,
        'error', 'NAME_TAKEN',
        'status', 409
      );
  end;
end;
$$;

-- 5. Privileges and Security
-- daily_best, weekly_best, my_daily_rank, my_weekly_rank: public views for anon and authenticated
revoke all on function public.daily_best(date, int) from public;
grant execute on function public.daily_best(date, int) to anon, authenticated;

revoke all on function public.weekly_best(date, int) from public;
grant execute on function public.weekly_best(date, int) to anon, authenticated;

revoke all on function public.my_daily_rank(date, text) from public;
grant execute on function public.my_daily_rank(date, text) to anon, authenticated;

revoke all on function public.my_weekly_rank(date, text) from public;
grant execute on function public.my_weekly_rank(date, text) to anon, authenticated;

-- record_submission: service_role only
revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) from public;
revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) from anon, authenticated;
grant execute on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int) to service_role;

-- set_display_name: service_role only
revoke all on function public.set_display_name(text, text, text) from public;
revoke all on function public.set_display_name(text, text, text) from anon, authenticated;
grant execute on function public.set_display_name(text, text, text) to service_role;

