DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM history_archive_day) THEN
    RAISE EXCEPTION 'history_archive_day lists archived days; reload them before rolling back 0096';
  END IF;
END
$$;

DROP FUNCTION assert_no_archived_days(text);

DROP TABLE history_archive_day;
