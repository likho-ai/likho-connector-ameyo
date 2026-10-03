-- The calls the schedule takes, oldest first, after the cursor.
--   $1 = the cursor: the call_time text the last run ended at ('' the first time)
--   $2 = how many at most
-- Returns the columns src/dialer.ts documents (crt_object_id is required; the rest optional;
-- any other column becomes an attribute of the recording). This file is an example against a
-- made-up table; the real one is queries/calls.local.sql (ignored by git), named in
-- CALLS_QUERY_FILE, with the company's table and campaign names.
SELECT
  crt_object_id,
  call_id,
  to_char(call_time, 'YYYY-MM-DD HH24:MI:SS') AS call_time,
  campaign_name                                AS campaign,
  agent_id                                     AS agent,
  disposition                                  AS disposition,
  talk_time_seconds                            AS talk_seconds,
  customer_phone                               AS phone
FROM calls
WHERE to_char(call_time, 'YYYY-MM-DD HH24:MI:SS') > $1
  AND crt_object_id IS NOT NULL
  AND status = 'connected'
ORDER BY call_time
LIMIT $2;
