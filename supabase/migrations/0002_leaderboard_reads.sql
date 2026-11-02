-- 0002_leaderboard_reads.sql: Clamped reads and individual device rank lookups

-- Drop old unbounded signatures
drop function if exists public.daily_best(date);
drop function if exists public.weekly_best(date);
drop function if exists public.daily_best(date, int);
drop function if exists public.weekly_best(date, int);

-- 1. daily_best with server-side limit clamping (1..100, default 100)
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
  order by rank asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

-- 2. weekly_best with server-side limit clamping (1..100, default 100)
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
  order by rank asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

-- 3. my_daily_rank(target_day date, p_device_id text)
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

-- 4. my_weekly_rank(target_week_start date, p_device_id text)
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
      b.device_id,
      d.display_name,
      sum(b.points)::bigint as total_points,
      sum(b.total_moves)::bigint as total_moves,
      max(b.max_tile)::int as highest_tile,
      max(b.received_at) as latest_received_at,
      min(b.id) as first_id
    from daily_best_per_device b
    join public.devices d on d.device_id = b.device_id
    where b.rn = 1
    group by b.device_id, d.device_id, d.display_name
  ),
  leaderboard as (
    select
      device_id,
      display_name,
      total_points as points,
      total_moves,
      highest_tile as max_tile,
      row_number() over (
        order by total_points desc, latest_received_at asc, first_id asc
      ) as rank,
      count(*) over () as total_players
    from aggregated
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

-- 5. Function Execution Privileges
revoke all on function public.daily_best(date, int) from public;
grant execute on function public.daily_best(date, int) to anon, authenticated;

revoke all on function public.weekly_best(date, int) from public;
grant execute on function public.weekly_best(date, int) to anon, authenticated;

revoke all on function public.my_daily_rank(date, text) from public;
grant execute on function public.my_daily_rank(date, text) to anon, authenticated;

revoke all on function public.my_weekly_rank(date, text) from public;
grant execute on function public.my_weekly_rank(date, text) to anon, authenticated;

