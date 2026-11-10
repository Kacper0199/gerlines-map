-- Archived history (T-141): service days whose raw rows (stop_event, segment_obs) were detached and dropped after
-- their rollups were built and compressed. A detached chunk logs no invalidation, so the rollups keep these days;
-- a forced level-1 refresh, the rollup check and a rebuild of stat_stop or stat_segment would recompute them from
-- missing raw rows, so the first two refuse them and a migration that recreates a level-1 rollup calls
-- assert_no_archived_days first.
CREATE TABLE history_archive_day (
  service_date date NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  stop_events bigint NOT NULL CHECK (stop_events >= 0),
  legs bigint NOT NULL CHECK (legs >= 0),
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT history_archive_day_pkey PRIMARY KEY (service_date)
);

CREATE FUNCTION assert_no_archived_days(what text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  archived bigint;
  first_day date;
  last_day date;
BEGIN
  SELECT count(*), min(service_date), max(service_date) INTO archived, first_day, last_day FROM history_archive_day;
  IF archived > 0 THEN
    RAISE EXCEPTION '% needs the raw rows of % archived service days (% to %): reload archived months from their '
      'converted folders (gerlines-backfill load), then migrate', what, archived, first_day, last_day;
  END IF;
END
$$;
