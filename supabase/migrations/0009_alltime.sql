-- 0009_alltime.sql: All-time leaderboard and individual device rank lookups

-- 1. alltime_best(p_limit int default 100)
-- Best attempt per device across all days.
-- Ranked by: points DESC, total_moves DESC (more moves survived wins), received_at ASC, id ASC.
-- display_name masks custom name when name_hidden is true.
-- Limit clamped to 1..100 (null -> 100).
create or replace function public.alltime_best(
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

-- 2. my_alltime_rank(p_device_id text)
-- Returns the caller device's rank, display_name, points, moves, max_tile, and total_players across all days.
create or replace function public.my_alltime_rank(
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

-- 3. Composite Index on daily_runs for all-time ranking
create index if not exists idx_daily_runs_device_alltime
on public.daily_runs (device_id, points desc, total_moves desc, received_at asc, id asc);

-- 4. Function Execution Privileges
revoke all on function public.alltime_best(int) from public;
grant execute on function public.alltime_best(int) to anon, authenticated;

revoke all on function public.my_alltime_rank(text) from public;
grant execute on function public.my_alltime_rank(text) to anon, authenticated;

