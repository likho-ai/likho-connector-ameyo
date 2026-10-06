-- One leg's call_id to its interaction's crt_object_id: reports show call ids, and the dialer
-- files the recording under the interaction. One column, at most one row.
--   $1 = the call_id
-- An example against a made-up table; the real one is queries/crt.local.sql, named in CRT_QUERY_FILE.
SELECT crt_object_id
FROM calls
WHERE call_id = $1
LIMIT 1;
