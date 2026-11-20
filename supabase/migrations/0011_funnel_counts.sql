-- Migration 0011: anonymous funnel counters.
-- Stores aggregate event counts per UTC day. No identifiers, no IPs, no user agents.

create table if not exists public.funnel_daily (
  day date not null default ((now() at time zone 'utc')::date),
  event text not null,
  n bigint not null default 0,
  constraint funnel_daily_pkey primary key (day, event)
);

alter table public.funnel_daily enable row level security;

revoke all on table public.funnel_daily from public, anon, authenticated;

create or replace function public.record_funnel_event(p_event text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event is null
     or p_event not in ('visit', 'run_start', 'run_end', 'share_tap', 'challenge_open', 'challenge_accept') then
    return;
  end if;

  insert into public.funnel_daily (day, event, n)
  values ((now() at time zone 'utc')::date, p_event, 1)
  on conflict (day, event)
  do update set n = public.funnel_daily.n + 1;
end;
$$;

revoke all on function public.record_funnel_event(text) from public;
grant execute on function public.record_funnel_event(text) to anon, authenticated;

notify pgrst, 'reload schema';