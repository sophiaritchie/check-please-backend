-- =============================================================================
-- End-of-day send report
--
-- Run at EOD on each send day. Returns ONE cell — copy it straight into Google
-- Chat. The ``` fences make Chat render it monospace so the columns line up.
--
-- Scopes to whatever was DUE to send today (Melbourne), so the same query with
-- no edits gives you Contacts + full-text Leads on day 1, and the market-taster
-- Leads on day 2.
--
-- To re-run for a past day, swap the report_date expression for e.g.
--   select date '2026-08-19' as report_date
-- =============================================================================

with params as (
  select (now() at time zone 'Australia/Melbourne')::date as report_date
),
scope as (
  select
    case m.priority
      when 2 then 'Contacts'
      when 1 then 'Leads (full text)'
      else        'Leads (mkt taster)'
    end as cohort,
    m.message_status
  from messages m, params p
  where (coalesce(m.send_after, m.queued_at) at time zone 'Australia/Melbourne')::date
        = p.report_date
),
rollup as (
  select
    cohort,
    count(*)                                                               as total,
    count(*) filter (where message_status = 'delivered')                   as delivered,
    count(*) filter (where message_status in ('failed','undelivered'))     as failed,
    count(*) filter (where message_status in ('sent','pending','sending')) as in_flight,
    count(*) filter (where message_status = 'queued')                      as not_sent
  from scope
  group by cohort
),
agg as (
  select
    string_agg(
      rpad(cohort, 20) || lpad(total::text, 7) || lpad(delivered::text, 11)
        || lpad(failed::text, 8) || lpad(in_flight::text, 11) || lpad(not_sent::text, 10),
      E'\n' order by cohort
    ) as body,
    sum(total)     as total,
    sum(delivered) as delivered,
    sum(failed)    as failed,
    sum(in_flight) as in_flight,
    sum(not_sent)  as not_sent
  from rollup
)
select
  '*Text send report – ' || to_char((select report_date from params), 'Dy DD Mon YYYY') || '*'
  || E'\n```\n'
  || rpad('Cohort', 20) || lpad('Total', 7) || lpad('Delivered', 11)
     || lpad('Failed', 8) || lpad('In flight', 11) || lpad('Not sent', 10) || E'\n'
  || repeat('-', 67) || E'\n'
  || coalesce(body, '(nothing was due to send today)') || E'\n'
  || repeat('-', 67) || E'\n'
  || rpad('TOTAL', 20) || lpad(coalesce(total, 0)::text, 7)
     || lpad(coalesce(delivered, 0)::text, 11) || lpad(coalesce(failed, 0)::text, 8)
     || lpad(coalesce(in_flight, 0)::text, 11) || lpad(coalesce(not_sent, 0)::text, 10)
  || E'\n```\n'
  || 'Delivered ' || coalesce(delivered, 0) || '/' || coalesce(total, 0)
  || case when coalesce(total, 0) > 0
          then ' (' || round(100.0 * delivered / total, 1) || '%)'
          else '' end
  as report
from agg;


-- =============================================================================
-- Optional follow-up: why the failed/undelivered ones failed.
-- Reads the reason off each message's most recent send_attempt.
-- =============================================================================

select
  case m.priority
    when 2 then 'Contacts'
    when 1 then 'Leads (full text)'
    else        'Leads (mkt taster)'
  end as cohort,
  m.message_status,
  coalesce(sa.delivery_result, sa.error_detail, '(none reported)') as reason,
  count(*) as n
from messages m
left join lateral (
  select delivery_result, error_detail
  from send_attempts
  where message_id = m.id
  order by attempt_number desc
  limit 1
) sa on true
where (coalesce(m.send_after, m.queued_at) at time zone 'Australia/Melbourne')::date
      = (now() at time zone 'Australia/Melbourne')::date
  and m.message_status in ('failed', 'undelivered')
group by 1, 2, 3
order by n desc;
