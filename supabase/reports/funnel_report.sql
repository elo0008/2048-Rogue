-- Read-only. Paste into the Supabase SQL editor.
-- NOTE: these are EVENT counts, not unique people. A page reload counts as a visit,
-- search-engine crawlers that run JavaScript may add visits, and anyone can inflate
-- the counts on purpose. Treat the numbers as approximate.

select
  day,
  sum(n) filter (where event = 'visit')            as visits,
  sum(n) filter (where event = 'run_start')        as run_starts,
  sum(n) filter (where event = 'run_end')          as run_ends,
  sum(n) filter (where event = 'share_tap')        as share_taps,
  sum(n) filter (where event = 'challenge_open')   as challenge_opens,
  sum(n) filter (where event = 'challenge_accept') as challenge_accepts,
  round(100.0 * sum(n) filter (where event = 'run_start')        / nullif(sum(n) filter (where event = 'visit'), 0), 1)          as start_pct_of_visits,
  round(100.0 * sum(n) filter (where event = 'run_end')          / nullif(sum(n) filter (where event = 'run_start'), 0), 1)      as finish_pct_of_starts,
  round(100.0 * sum(n) filter (where event = 'share_tap')        / nullif(sum(n) filter (where event = 'run_end'), 0), 1)        as share_pct_of_finishes,
  round(100.0 * sum(n) filter (where event = 'challenge_accept') / nullif(sum(n) filter (where event = 'challenge_open'), 0), 1) as accept_pct_of_opens
from public.funnel_daily
group by day
order by day desc;