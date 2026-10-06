-- The calls of a window, newest first, a page at a time.
--   $1 = since, $2 = until (the dialer's own clock), $3 = campaign or '', $4 = agent or '',
--   $5 = connected only (boolean), $6 = shortest customer talk in seconds, $7 = offset, $8 = how many
-- Columns: see src/lists.ts. An example against a made-up table; the real one is
-- queries/window.local.sql, named in WINDOW_QUERY_FILE.
SELECT
  crt_object_id,
  call_id,
  to_char(call_time, 'YYYY-MM-DD HH24:MI:SS') AS call_time,
  campaign_name                                AS campaign,
  ''                                           AS transferred_campaign,
  agent_id                                     AS agent,
  agent_id                                     AS agent_id,
  disposition,
  ''                                           AS call_type,
  (status = 'connected')                       AS connected,
  talk_time_seconds                            AS talk_seconds,
  customer_phone                               AS phone,
  ''                                           AS hangup_by,
  ''                                           AS queue
FROM calls
WHERE call_time >= $1::timestamp
  AND call_time <  $2::timestamp
  AND crt_object_id IS NOT NULL
  AND ($3 = '' OR campaign_name = $3)
  AND ($4 = '' OR agent_id = $4)
  AND (NOT $5::boolean OR status = 'connected')
  AND COALESCE(talk_time_seconds, 0) >= $6::int
ORDER BY call_time DESC, call_id
OFFSET $7::int
LIMIT $8::int;
