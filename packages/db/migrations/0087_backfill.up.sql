-- History backfill (WP-7.1, ADR-0009): runs from an archive without a timetable link, final values only.
ALTER TABLE trip_instance ADD COLUMN backfill boolean NOT NULL DEFAULT false;

ALTER TABLE trip_instance DROP CONSTRAINT trip_instance_static_or_added;

ALTER TABLE trip_instance ADD CONSTRAINT trip_instance_static_or_added CHECK (
  is_added
  OR (category_code IS NOT NULL AND (backfill OR (feed_version_id IS NOT NULL AND trip_key IS NOT NULL)))
);

ALTER TABLE trip_instance ADD CONSTRAINT trip_instance_backfill_unlinked CHECK (
  NOT backfill OR (feed_version_id IS NULL AND trip_key IS NULL AND NOT is_added)
);

ALTER TABLE stop_event DROP CONSTRAINT stop_event_final_quality_known;

ALTER TABLE stop_event ADD CONSTRAINT stop_event_final_quality_known CHECK (
  final_quality IN ('live', 'carried', 'final_only')
);
