-- One call by its id, in the same columns as calls.example.sql.
--   $1 = the crt_object_id
-- The real one is queries/call.local.sql (ignored by git), named in CALL_QUERY_FILE.
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
WHERE crt_object_id = $1
ORDER BY call_time DESC
LIMIT 1;
