-- 0004_week_snap.sql: Normalise target_week_start to ISO Monday (UTC) server-side

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

revoke all on function public.weekly_best(date, int) from public;
grant execute on function public.weekly_best(date, int) to anon, authenticated;

revoke all on function public.my_weekly_rank(date, text) from public;
grant execute on function public.my_weekly_rank(date, text) to anon, authenticated;

