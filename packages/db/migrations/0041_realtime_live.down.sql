DROP TABLE rt_rebuild_segment;
DROP TABLE rt_rebuild_forecast;
DROP TABLE rt_rebuild_stop_event;
DROP TABLE rt_rebuild_job;

CALL remove_columnstore_policy('event', if_exists => true);
CALL remove_columnstore_policy('segment_obs', if_exists => true);
CALL remove_columnstore_policy('stop_event_forecast', if_exists => true);
CALL remove_columnstore_policy('stop_event', if_exists => true);

SELECT decompress_chunk(chunk, true) FROM show_chunks('event') AS chunk;
SELECT decompress_chunk(chunk, true) FROM show_chunks('segment_obs') AS chunk;
SELECT decompress_chunk(chunk, true) FROM show_chunks('stop_event_forecast') AS chunk;
SELECT decompress_chunk(chunk, true) FROM show_chunks('stop_event') AS chunk;

ALTER TABLE event SET (timescaledb.enable_columnstore = false);
ALTER TABLE segment_obs SET (timescaledb.enable_columnstore = false);
ALTER TABLE stop_event_forecast SET (timescaledb.enable_columnstore = false);
ALTER TABLE stop_event SET (timescaledb.enable_columnstore = false);

SELECT set_chunk_time_interval('event', INTERVAL '7 days');
SELECT set_chunk_time_interval('segment_obs', INTERVAL '7 days');
SELECT set_chunk_time_interval('stop_event', INTERVAL '7 days');

DROP INDEX rt_payload_observed_idx;
DROP INDEX rt_payload_processed_idx;
ALTER TABLE rt_payload DROP COLUMN fold_source_id;

DROP TABLE trip_instance_source;
DROP TABLE alert_scope;
DROP TABLE alert_message;

CREATE TABLE alert (
  source_id text NOT NULL REFERENCES source (source_id),
  alert_key text NOT NULL,
  content_hash text NOT NULL,
  cause smallint,
  effect smallint,
  severity smallint,
  active_periods jsonb NOT NULL,
  selectors jsonb NOT NULL,
  header jsonb NOT NULL,
  description jsonb NOT NULL,
  url jsonb NOT NULL,
  trip_instance_ids uuid[] NOT NULL,
  stop_place_ids uuid[] NOT NULL,
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  last_seen_hour timestamptz NOT NULL,
  CONSTRAINT alert_pkey PRIMARY KEY (source_id, alert_key, content_hash),
  CONSTRAINT alert_key_not_blank CHECK (btrim(alert_key) <> ''),
  CONSTRAINT alert_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT alert_seen_order CHECK (last_seen_hour >= date_trunc('hour', first_observed_at))
);

CREATE INDEX alert_trip_instances_idx ON alert USING gin (trip_instance_ids);
