-- The transcript back into the CRM (MS SQL Server). Two named parameters:
--   @externalId  the call's id (its crt_object_id)
--   @transcript  the Hinglish text, one line per spoken line
-- It should change the row of that call and nothing else. The real one is
-- queries/writeback.local.sql (ignored by git), named in WRITEBACK_QUERY_FILE.
UPDATE call_records
SET transcript_text = @transcript,
    transcript_updated_at = SYSDATETIME()
WHERE crt_object_id = @externalId;
