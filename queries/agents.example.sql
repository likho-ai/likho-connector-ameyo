-- The agents of a window (of one campaign when $3 is not empty), most calls first.
--   $1 = since, $2 = until (the dialer's own clock), $3 = a campaign or ''
-- Columns: id, name, calls, connected, talk_seconds (see src/lists.ts). An example against a
-- made-up table; the real one is queries/agents.local.sql, named in AGENTS_QUERY_FILE.
SELECT
  agent_id                                                                 AS id,
  agent_id                                                                 AS name,
  count(*)                                                                 AS calls,
  count(*) FILTER (WHERE status = 'connected')                             AS connected,
  COALESCE(sum(talk_time_seconds) FILTER (WHERE status = 'connected'), 0) AS talk_seconds
FROM calls
WHERE call_time >= $1::timestamp
  AND call_time <  $2::timestamp
  AND ($3 = '' OR campaign_name = $3)
  AND agent_id IS NOT NULL
  AND agent_id <> ''
GROUP BY agent_id
ORDER BY calls DESC, agent_id
LIMIT 1000;
