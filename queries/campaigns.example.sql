-- The campaigns of a window, with their counts, most calls first.
--   $1 = since, $2 = until: the dialer's own clock, 'YYYY-MM-DD HH:MM:SS' (since included, until not)
-- Columns: name, calls, connected, interactions, talk_seconds (see src/lists.ts). This file is an
-- example against a made-up table; the real one is queries/campaigns.local.sql (ignored by git),
-- named in CAMPAIGNS_LIST_QUERY_FILE.
SELECT
  campaign_name                                                            AS name,
  count(*)                                                                 AS calls,
  count(*) FILTER (WHERE status = 'connected')                             AS connected,
  count(DISTINCT crt_object_id)                                            AS interactions,
  COALESCE(sum(talk_time_seconds) FILTER (WHERE status = 'connected'), 0) AS talk_seconds
FROM calls
WHERE call_time >= $1::timestamp
  AND call_time <  $2::timestamp
  AND campaign_name IS NOT NULL
  AND campaign_name <> ''
GROUP BY campaign_name
ORDER BY calls DESC, campaign_name
LIMIT 500;
