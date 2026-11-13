-- supabase/migrations/0010_challenges.sql
-- Schema migration for Challenge feature:
-- 1. Add final_board column to daily_runs
-- 2. Update record_submission RPC to store replayed final_board
-- 3. Create challenges table with strict RLS (service_role only direct access)
-- 4. Create internal challenge helper RPCs (service_role only)
-- 5. Create public get_challenge RPC (anon/authenticated/service_role execute)

-- 1. Add final_board column to daily_runs (16 values array, nullable for legacy runs)
alter table public.daily_runs
  add column if not exists final_board jsonb null;

-- 2. Update record_submission RPC
drop function if exists public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int);

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
  p_dev_limit int,
  p_final_board jsonb default null
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
  -- 1. Upsert device
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
    flags,
    final_board
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
    p_flags,
    p_final_board
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

revoke all on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int, jsonb) from public, anon, authenticated;
grant execute on function public.record_submission(text, text, date, bigint, int, int, int, jsonb, text, text, int, text[], text, int, jsonb) to service_role;

-- 3. Create challenges table
create table if not exists public.challenges (
  code text primary key,
  creator_device_id text not null references public.devices(device_id) on delete cascade,
  mode text not null check (mode in ('daily', 'free')),
  day_utc date null,
  daily_run_id bigint null references public.daily_runs(id) on delete set null,
  points int null,
  total_moves int null,
  max_tile int null,
  relics_owned jsonb null default '[]'::jsonb,
  seed bigint null,
  final_board jsonb null,
  replay_version text null,
  events_hash text null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  open_count int not null default 0,
  accept_count int not null default 0
);

create index if not exists idx_challenges_creator on public.challenges(creator_device_id);
create index if not exists idx_challenges_expires_at on public.challenges(expires_at);

create unique index if not exists idx_challenges_daily_run_id
  on public.challenges (daily_run_id)
  where mode = 'daily' and daily_run_id is not null;

create unique index if not exists idx_challenges_free_idempotent
  on public.challenges (creator_device_id, events_hash)
  where mode = 'free' and events_hash is not null;

alter table public.challenges enable row level security;
revoke all on table public.challenges from public, anon, authenticated;
grant all on table public.challenges to service_role;

-- 4. Challenge internal RPCs (service_role only)

-- 4a. create_daily_challenge
create or replace function public.create_daily_challenge(
  p_device_id text,
  p_code text,
  p_day_utc date default null,
  p_limit_key text default null,
  p_limit int default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run record;
  v_existing record;
  v_dev_count int;
  v_expires_at timestamptz;
  v_today date;
  v_yesterday date;
begin
  -- 1. Opportunistic cleanup: bounded batch (100) of free challenges expired > 7 days
  delete from public.challenges
  where code in (
    select code from public.challenges
    where mode = 'free'
      and expires_at < (now() - interval '7 days')
    limit 100
  );

  -- 2. Determine target run
  v_today := (now() at time zone 'utc')::date;
  v_yesterday := v_today - 1;

  if p_day_utc is not null then
    select * into v_run
    from public.daily_runs
    where device_id = p_device_id
      and day_utc = p_day_utc
    order by points desc, total_moves desc, received_at asc, id asc
    limit 1;
  else
    -- Check today first
    select * into v_run
    from public.daily_runs
    where device_id = p_device_id
      and day_utc = v_today
    order by points desc, total_moves desc, received_at asc, id asc
    limit 1;

    -- If no run today, check yesterday
    if v_run.id is null then
      select * into v_run
      from public.daily_runs
      where device_id = p_device_id
        and day_utc = v_yesterday
      order by points desc, total_moves desc, received_at asc, id asc
      limit 1;
    end if;
  end if;

  if v_run.id is null then
    return jsonb_build_object('status', 'NO_RUN');
  end if;

  -- 3. Idempotent check
  select code, expires_at into v_existing
  from public.challenges
  where daily_run_id = v_run.id
  limit 1;

  if v_existing.code is not null then
    return jsonb_build_object(
      'status', 'IDEMPOTENT',
      'code', v_existing.code,
      'expires_at', v_existing.expires_at
    );
  end if;

  -- 4. Consume device rate limit
  if p_limit_key is not null then
    insert into public.abuse_rate_limits (key, count, window_start)
    values (p_limit_key, 1, now())
    on conflict (key)
    do update set count = abuse_rate_limits.count + 1
    returning count into v_dev_count;

    if v_dev_count > p_limit then
      return jsonb_build_object('status', 'LIMIT_EXCEEDED');
    end if;
  end if;

  -- 5. Expiry: end of that run's UTC day (23:59:59.999Z)
  v_expires_at := (v_run.day_utc || 'T23:59:59.999Z')::timestamptz;

  -- 6. Insert challenge
  begin
    insert into public.challenges (
      code,
      creator_device_id,
      mode,
      day_utc,
      daily_run_id,
      points,
      total_moves,
      max_tile,
      relics_owned,
      seed,
      final_board,
      replay_version,
      events_hash,
      created_at,
      expires_at
    ) values (
      p_code,
      p_device_id,
      'daily',
      v_run.day_utc,
      v_run.id,
      v_run.points,
      v_run.total_moves,
      v_run.max_tile,
      v_run.relics_owned,
      v_run.seed,
      v_run.final_board,
      v_run.replay_version,
      v_run.events_hash,
      now(),
      v_expires_at
    );

    return jsonb_build_object(
      'status', 'CREATED',
      'code', p_code,
      'expires_at', v_expires_at
    );
  exception
    when unique_violation then
      select code, expires_at into v_existing
      from public.challenges
      where daily_run_id = v_run.id
      limit 1;

      if v_existing.code is not null then
        return jsonb_build_object(
          'status', 'IDEMPOTENT',
          'code', v_existing.code,
          'expires_at', v_existing.expires_at
        );
      end if;

      return jsonb_build_object('status', 'COLLISION');
  end;
end;
$$;

revoke all on function public.create_daily_challenge(text, text, date, text, int) from public, anon, authenticated;
grant execute on function public.create_daily_challenge(text, text, date, text, int) to service_role;

-- 4b. create_free_challenge
create or replace function public.create_free_challenge(
  p_device_id text,
  p_display_name text,
  p_code text,
  p_points int,
  p_total_moves int,
  p_max_tile int,
  p_relics jsonb,
  p_seed bigint,
  p_final_board jsonb,
  p_replay_version text,
  p_events_hash text,
  p_expires_at timestamptz,
  p_limit_key text default null,
  p_limit int default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
  v_dev_count int;
begin
  -- 1. Opportunistic cleanup: bounded batch (100) of free challenges expired > 7 days
  delete from public.challenges
  where code in (
    select code from public.challenges
    where mode = 'free'
      and expires_at < (now() - interval '7 days')
    limit 100
  );

  -- 2. Upsert device if not present
  insert into public.devices (device_id, display_name, generated_name, last_seen_at)
  values (p_device_id, p_display_name, p_display_name, now())
  on conflict (device_id)
  do update set last_seen_at = now();

  -- 3. Idempotent check
  select code, expires_at into v_existing
  from public.challenges
  where creator_device_id = p_device_id
    and events_hash = p_events_hash
    and mode = 'free'
  limit 1;

  if v_existing.code is not null then
    return jsonb_build_object(
      'status', 'IDEMPOTENT',
      'code', v_existing.code,
      'expires_at', v_existing.expires_at
    );
  end if;

  -- 4. Consume device rate limit
  if p_limit_key is not null then
    insert into public.abuse_rate_limits (key, count, window_start)
    values (p_limit_key, 1, now())
    on conflict (key)
    do update set count = abuse_rate_limits.count + 1
    returning count into v_dev_count;

    if v_dev_count > p_limit then
      return jsonb_build_object('status', 'LIMIT_EXCEEDED');
    end if;
  end if;

  -- 5. Insert challenge
  begin
    insert into public.challenges (
      code,
      creator_device_id,
      mode,
      points,
      total_moves,
      max_tile,
      relics_owned,
      seed,
      final_board,
      replay_version,
      events_hash,
      created_at,
      expires_at
    ) values (
      p_code,
      p_device_id,
      'free',
      p_points,
      p_total_moves,
      p_max_tile,
      p_relics,
      p_seed,
      p_final_board,
      p_replay_version,
      p_events_hash,
      now(),
      p_expires_at
    );

    return jsonb_build_object(
      'status', 'CREATED',
      'code', p_code,
      'expires_at', p_expires_at
    );
  exception
    when unique_violation then
      select code, expires_at into v_existing
      from public.challenges
      where creator_device_id = p_device_id
        and events_hash = p_events_hash
        and mode = 'free'
      limit 1;

      if v_existing.code is not null then
        return jsonb_build_object(
          'status', 'IDEMPOTENT',
          'code', v_existing.code,
          'expires_at', v_existing.expires_at
        );
      end if;

      return jsonb_build_object('status', 'COLLISION');
  end;
end;
$$;

revoke all on function public.create_free_challenge(text, text, text, int, int, int, jsonb, bigint, jsonb, text, text, timestamptz, text, int) from public, anon, authenticated;
grant execute on function public.create_free_challenge(text, text, text, int, int, int, jsonb, bigint, jsonb, text, text, timestamptz, text, int) to service_role;

-- 4c. record_challenge_event
create or replace function public.record_challenge_event(
  p_code text,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{12}$' then
    return false;
  end if;

  if p_kind = 'open' then
    update public.challenges
    set open_count = open_count + 1
    where code = p_code
      and expires_at > now();
    v_updated := found;
  elsif p_kind = 'accept' then
    update public.challenges
    set accept_count = accept_count + 1
    where code = p_code
      and expires_at > now();
    v_updated := found;
  end if;

  return v_updated;
end;
$$;

revoke all on function public.record_challenge_event(text, text) from public, anon, authenticated;
grant execute on function public.record_challenge_event(text, text) to service_role;

-- 5. Public read RPC get_challenge(code)
create or replace function public.get_challenge(
  code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch record;
  v_run record;
  v_dev record;
  v_display_name text;
  v_status text;
  v_rank bigint;
  v_total_players bigint;
begin
  -- Validate code format: exactly 12 alphanumeric characters
  if code is null or code !~ '^[A-Za-z0-9]{12}$' then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_ch
  from public.challenges
  where public.challenges.code = get_challenge.code;

  if v_ch.code is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Device lookup for display name with masking
  select * into v_dev
  from public.devices
  where device_id = v_ch.creator_device_id;

  if v_dev.device_id is not null then
    if v_dev.name_hidden then
      v_display_name := v_dev.generated_name;
    else
      v_display_name := coalesce(v_dev.display_name, v_dev.generated_name);
    end if;
  else
    v_display_name := null;
  end if;

  -- Determine valid vs expired status
  if now() > v_ch.expires_at then
    v_status := 'expired';
  else
    v_status := 'valid';
  end if;

  if v_ch.mode = 'daily' then
    -- For daily, fetch associated daily run if exists
    if v_ch.daily_run_id is not null then
      select * into v_run
      from public.daily_runs
      where id = v_ch.daily_run_id;
    end if;

    -- If the daily run row was purged/deleted, fall back to frozen values on challenge
    if v_run.id is null then
      v_run.points := v_ch.points;
      v_run.total_moves := v_ch.total_moves;
      v_run.max_tile := v_ch.max_tile;
      v_run.relics_owned := v_ch.relics_owned;
      v_run.final_board := v_ch.final_board;
      v_run.day_utc := v_ch.day_utc;
    end if;

    -- Compute sender_rank and total_players for that day per daily_best spec
    if v_run.day_utc is not null and v_ch.creator_device_id is not null then
      with ranked_attempts as (
        select
          r.device_id,
          r.points,
          r.total_moves,
          r.received_at,
          r.id,
          row_number() over (
            partition by r.device_id
            order by r.points desc, r.total_moves desc, r.received_at asc, r.id asc
          ) as rn
        from public.daily_runs r
        where r.day_utc = v_run.day_utc
      ),
      device_bests as (
        select
          device_id,
          points,
          total_moves,
          received_at,
          id
        from ranked_attempts
        where rn = 1
      ),
      leaderboard as (
        select
          device_id,
          row_number() over (
            order by points desc, total_moves desc, received_at asc, id asc
          ) as rank,
          count(*) over () as total_players
        from device_bests
      )
      select rank, total_players into v_rank, v_total_players
      from leaderboard
      where device_id = v_ch.creator_device_id;
    end if;

    return jsonb_build_object(
      'status', v_status,
      'mode', 'daily',
      'sender_display_name', v_display_name,
      'points', v_run.points,
      'total_moves', v_run.total_moves,
      'max_tile', v_run.max_tile,
      'relics_owned', coalesce(v_run.relics_owned, '[]'::jsonb),
      'final_board', v_run.final_board,
      'day_utc', v_run.day_utc,
      'created_at', v_ch.created_at,
      'expires_at', v_ch.expires_at,
      'sender_rank', v_rank,
      'total_players', v_total_players
    );
  else
    -- Mode is 'free'
    return jsonb_build_object(
      'status', v_status,
      'mode', 'free',
      'sender_display_name', v_display_name,
      'points', v_ch.points,
      'total_moves', v_ch.total_moves,
      'max_tile', v_ch.max_tile,
      'relics_owned', coalesce(v_ch.relics_owned, '[]'::jsonb),
      'final_board', v_ch.final_board,
      'seed', v_ch.seed,
      'created_at', v_ch.created_at,
      'expires_at', v_ch.expires_at
    );
  end if;
end;
$$;

revoke all on function public.get_challenge(text) from public;
grant execute on function public.get_challenge(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';


