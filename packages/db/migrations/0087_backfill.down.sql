ALTER TABLE stop_event DROP CONSTRAINT stop_event_final_quality_known;

ALTER TABLE stop_event ADD CONSTRAINT stop_event_final_quality_known CHECK (final_quality IN ('live', 'carried'));

ALTER TABLE trip_instance DROP CONSTRAINT trip_instance_backfill_unlinked;

ALTER TABLE trip_instance DROP CONSTRAINT trip_instance_static_or_added;

ALTER TABLE trip_instance ADD CONSTRAINT trip_instance_static_or_added CHECK (
  is_added OR (feed_version_id IS NOT NULL AND trip_key IS NOT NULL AND category_code IS NOT NULL)
);

ALTER TABLE trip_instance DROP COLUMN backfill;
