-- =============================================================================
-- End of Wednesday & Thursday Send Report (Chat-Ready Single Cell Output)
--
-- Run this in Supabase SQL Editor to get a single copy-pastable cell formatted
-- with monospace code fences for Google Chat / Slack.
--
-- Scopes to Wednesday + Thursday (Melbourne time).
-- =============================================================================

with params as (
  select
    -- Scopes to Wednesday & Thursday of the current week (Melbourne time)
    (date_trunc('week', now() at time zone 'Australia/Melbourne')::date + 2) as start_date,
    (date_trunc('week', now() at time zone 'Australia/Melbourne')::date + 3) as end_date
),
scope as (
  select
    case m.priority
      when 2 then 'Contacts (Wed)'
      when 1 then 'Leads full (Wed)'
      when 0 then 'Leads taster (Thu)'
      else coalesce(m.sf_type, 'Other')
    end as cohort,
    m.priority,
    m.message_status
  from messages m, params p
  where (coalesce(m.send_after, m.queued_at) at time zone 'Australia/Melbourne')::date
        between p.start_date and p.end_date
),
rollup as (
  select
    cohort,
    priority,
    count(*)                                                               as total,
    count(*) filter (where message_status = 'delivered')                   as delivered,
    count(*) filter (where message_status = 'sent')                        as sent,
    count(*) filter (where message_status in ('failed','undelivered'))     as failed,
    count(*) filter (where message_status in ('pending','sending'))        as in_flight,
    count(*) filter (where message_status = 'queued')                      as not_sent
  from scope
  group by cohort, priority
),
agg as (
  select
    string_agg(
      rpad(cohort, 19) || lpad(total::text, 6) || lpad(delivered::text, 11) || lpad(sent::text, 7)
        || lpad(failed::text, 8) || lpad(in_flight::text, 11) || lpad(not_sent::text, 8),
      E'\n' order by priority desc
    ) as body,
    sum(total)     as total,
    sum(delivered) as delivered,
    sum(sent)      as sent,
    sum(failed)    as failed,
    sum(in_flight) as in_flight,
    sum(not_sent)  as not_sent
  from rollup
),
failed_list as (
  select
    coalesce(
      string_agg(
        '• *' || coalesce(trim(substring(m.text from 'For ([^\r\n]+)')), 'Unknown') || '* ('
          || array_to_string(m.to_numbers, ', ') || ', '
          || case m.priority when 2 then 'Contact' when 1 then 'Lead' else 'Lead (taster)' end || '): '
          || upper(m.message_status) || ' – '
          || coalesce(sa.delivery_result, sa.error_detail, '(no reason reported)')
          || ' (attempt ' || m.attempt_count || ')',
        E'\n'
        order by m.priority desc, m.text
      ),
      '✓ No failed or undelivered messages'
    ) as failure_text
  from messages m
  left join lateral (
    select delivery_result, error_detail
    from send_attempts
    where message_id = m.id
    order by attempt_number desc
    limit 1
  ) sa on true,
  params p
  where (coalesce(m.send_after, m.queued_at) at time zone 'Australia/Melbourne')::date
        between p.start_date and p.end_date
    and m.message_status in ('failed', 'undelivered')
)
select
  '*Weekly Text Send Report (Wed & Thu) – '
  || to_char((select start_date from params), 'DD Mon') || ' to '
  || to_char((select end_date from params), 'DD Mon YYYY') || '*'
  || E'\n```\n'
  || rpad('Cohort', 19) || lpad('Total', 6) || lpad('Delivered', 11) || lpad('Sent', 7)
     || lpad('Failed', 8) || lpad('In flight', 11) || lpad('Queued', 8) || E'\n'
  || repeat('-', 70) || E'\n'
  || coalesce(body, '(no messages queued for this window)') || E'\n'
  || repeat('-', 70) || E'\n'
  || rpad('TOTAL', 19) || lpad(coalesce(total, 0)::text, 6)
     || lpad(coalesce(delivered, 0)::text, 11) || lpad(coalesce(sent, 0)::text, 7)
     || lpad(coalesce(failed, 0)::text, 8)
     || lpad(coalesce(in_flight, 0)::text, 11) || lpad(coalesce(not_sent, 0)::text, 8)
  || E'\n```\n'
  || 'Delivered: ' || coalesce(delivered, 0) || '/' || coalesce(total, 0)
  || case when coalesce(total, 0) > 0
          then ' (' || round(100.0 * delivered / total, 1) || '%)'
          else '' end
  || case when coalesce(sent, 0) > 0 then ' | Sent (awaiting carrier DLR): ' || sent else '' end
  || E'\n\n*Failed / Undelivered:* \n'
  || (select failure_text from failed_list)
  as chat_report
from agg;
