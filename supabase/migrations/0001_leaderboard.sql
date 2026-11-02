-- 0001_leaderboard.sql: Leaderboard schema for Rogue 2048

-- 1. Base Tables
create table if not exists public.devices (
  device_id text primary key,
  display_name text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.daily_runs (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices(device_id) on delete cascade,
  day_utc date not null,
  seed bigint not null,
  points int not null,
  total_moves int not null,
  max_tile int not null,
  relics_owned jsonb not null default '[]'::jsonb,
  replay_version text not null,
  events_hash text not null,
  duration_ms int null,
  flags text[] not null default '{}'::text[],
  received_at timestamptz not null default now(),
  constraint uq_device_events_hash unique (device_id, events_hash)
);

create table if not exists public.abuse_rate_limits (
  key text primary key,
  count int not null default 1,
  window_start timestamptz not null default now()
);

-- Indexes for efficient leaderboard aggregation and rate limits
create index if not exists idx_daily_runs_day_points on public.daily_runs (day_utc, points desc, total_moves desc, received_at asc, id asc);
create index if not exists idx_daily_runs_device_day on public.daily_runs (device_id, day_utc);
create index if not exists idx_devices_last_seen on public.devices (last_seen_at desc);
create index if not exists idx_abuse_rate_limits_window on public.abuse_rate_limits (window_start);

-- 2. Row Level Security & Table Privileges (Belt and Braces)
alter table public.devices enable row level security;
alter table public.daily_runs enable row level security;
alter table public.abuse_rate_limits enable row level security;

-- STRICT ZERO-TRUST: Revoke all table privileges from public, anon, and authenticated.
-- Base tables have zero policies and zero direct grants for anon/authenticated.
revoke all on table public.devices from public, anon, authenticated;
revoke all on table public.daily_runs from public, anon, authenticated;
revoke all on table public.abuse_rate_limits from public, anon, authenticated;

-- Writes are performed exclusively by the Edge Function using the service_role key.
grant all on table public.devices to service_role;
grant all on table public.daily_runs to service_role;
grant all on table public.abuse_rate_limits to service_role;

-- 3. Atomic Rate Limiter Function
-- Single atomic statement (UPSERT with increment) to eliminate race conditions under concurrency
create or replace function public.consume_rate_limit(p_key text, p_limit int)
returns table (
  allowed boolean,
  current_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Periodic cleanup: ~1 in 100 calls cleans expired rate limit entries older than 2 days
  -- Uses idx_abuse_rate_limits_window to avoid table scan overhead
  if (random() < 0.01) then
    delete from public.abuse_rate_limits
    where window_start < now() - interval '2 days';
  end if;

  insert into public.abuse_rate_limits (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
  set count = public.abuse_rate_limits.count + 1
  returning count into v_count;

  return query select (v_count <= p_limit), v_count;
end;
$$;

-- 4. Public RPC Views

-- daily_best(target_day): Best attempt per device per day.
-- Ranked by: points DESC, total_moves DESC (more moves survived ranks higher), received_at ASC (earliest wins), id ASC.
-- duration_ms is completely omitted from all ranking and tie-breaking.
-- row_number() assigns a distinct ordinal rank without gaps or ties.
create or replace function public.daily_best(target_day date)
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
      d.display_name,
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
  order by rank asc;
$$;

-- weekly_best(target_week_start): Sum of each device's daily bests across ISO week (Mon-Sun UTC).
-- Ranked by: total points DESC, latest accepted-submission received_at ASC, first_id ASC.
create or replace function public.weekly_best(target_week_start date default date_trunc('week', now() at time zone 'utc')::date)
returns table (
  display_name text,
  points bigint,
  total_moves bigint,
  max_tile int,
  rank bigint
)
language sql
security definer
set search_path = public
as $$
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
    where r.day_utc >= target_week_start
      and r.day_utc < (target_week_start + interval '7 days')::date
  ),
  aggregated as (
    select
      d.display_name,
      sum(b.points)::bigint as total_points,
      sum(b.total_moves)::bigint as total_moves,
      max(b.max_tile)::int as highest_tile,
      max(b.received_at) as latest_received_at,
      min(b.id) as first_id
    from daily_best_per_device b
    join public.devices d on d.device_id = b.device_id
    where b.rn = 1
    group by d.device_id, d.display_name
  )
  select
    display_name,
    total_points as points,
    total_moves,
    highest_tile as max_tile,
    row_number() over (
      order by total_points desc, latest_received_at asc, first_id asc
    ) as rank
  from aggregated
  order by rank asc;
$$;

-- 5. Function Execution Privileges
-- PostgreSQL grants EXECUTE to PUBLIC by default on new functions.
-- Explicitly revoke all and grant only to authorized roles.

-- consume_rate_limit: strictly internal / service_role only (never callable by anon or authenticated)
revoke all on function public.consume_rate_limit(text, int) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, int) to service_role;

-- daily_best: public view for anon and authenticated
revoke all on function public.daily_best(date) from public;
grant execute on function public.daily_best(date) to anon, authenticated;

-- weekly_best: public view for anon and authenticated
revoke all on function public.weekly_best(date) from public;
grant execute on function public.weekly_best(date) to anon, authenticated;
