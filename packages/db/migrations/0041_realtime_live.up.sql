-- alert rows are derived from recorded payloads: a replay rebuilds them as alert_message and alert_scope.
DROP TABLE alert;

CREATE TABLE alert_message (
  source_id text NOT NULL REFERENCES source (source_id),
  alert_key text NOT NULL,
  content_hash text NOT NULL,
  cause smallint,
  effect smallint,
  severity smallint,
  active_periods jsonb NOT NULL,
  header jsonb NOT NULL,
  description jsonb NOT NULL,
  url jsonb NOT NULL,
  selector_count integer NOT NULL,
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  last_seen_hour timestamptz NOT NULL,
  CONSTRAINT alert_message_pkey PRIMARY KEY (source_id, alert_key, content_hash),
  CONSTRAINT alert_message_key_not_blank CHECK (btrim(alert_key) <> ''),
  CONSTRAINT alert_message_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT alert_message_selector_count_range CHECK (selector_count >= 0),
  CONSTRAINT alert_message_seen_order CHECK (last_seen_hour >= date_trunc('hour', first_observed_at))
);

CREATE TABLE alert_scope (
  source_id text NOT NULL,
  alert_key text NOT NULL,
  content_hash text NOT NULL,
  trip_instance_id uuid REFERENCES trip_instance (trip_instance_id),
  stop_place_id uuid REFERENCES stop_place (stop_place_id),
  first_observed_at timestamptz NOT NULL,
  first_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  last_seen_hour timestamptz NOT NULL,
  CONSTRAINT alert_scope_message_fkey FOREIGN KEY (source_id, alert_key, content_hash)
    REFERENCES alert_message (source_id, alert_key, content_hash) ON DELETE CASCADE,
  CONSTRAINT alert_scope_one_target CHECK ((trip_instance_id IS NULL) <> (stop_place_id IS NULL)),
  CONSTRAINT alert_scope_seen_order CHECK (last_seen_hour >= date_trunc('hour', first_observed_at))
);

CREATE UNIQUE INDEX alert_scope_trip_key ON alert_scope (source_id, alert_key, content_hash, trip_instance_id)
  WHERE trip_instance_id IS NOT NULL;
CREATE UNIQUE INDEX alert_scope_place_key ON alert_scope (source_id, alert_key, content_hash, stop_place_id)
  WHERE stop_place_id IS NOT NULL;
CREATE INDEX alert_scope_trip_idx ON alert_scope (trip_instance_id) WHERE trip_instance_id IS NOT NULL;
CREATE INDEX alert_scope_place_idx ON alert_scope (stop_place_id) WHERE stop_place_id IS NOT NULL;

CREATE TABLE trip_instance_source (
  trip_instance_id uuid NOT NULL REFERENCES trip_instance (trip_instance_id),
  source_id text NOT NULL REFERENCES source (source_id),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_raw_object_id uuid NOT NULL REFERENCES raw_object (raw_object_id),
  CONSTRAINT trip_instance_source_pkey PRIMARY KEY (trip_instance_id, source_id),
  CONSTRAINT trip_instance_source_seen_order CHECK (last_observed_at >= first_observed_at)
) WITH (fillfactor = 70);

ALTER TABLE rt_payload ADD COLUMN fold_source_id text REFERENCES source (source_id);
UPDATE rt_payload SET fold_source_id = source_id;
ALTER TABLE rt_payload ALTER COLUMN fold_source_id SET NOT NULL;
CREATE INDEX rt_payload_processed_idx ON rt_payload (processed_at);
CREATE INDEX rt_payload_observed_idx ON rt_payload (observed_at);

-- Trips of sources without a static timetable are counted per payload now; the down migration does not restore these rows.
DELETE FROM match_backlog WHERE reason = 'no_static_for_source';

SELECT set_chunk_time_interval('stop_event', INTERVAL '1 day');
SELECT set_chunk_time_interval('segment_obs', INTERVAL '1 day');
SELECT set_chunk_time_interval('event', INTERVAL '1 day');

ALTER TABLE stop_event SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'source_id',
  timescaledb.orderby = 'trip_instance_id, stop_index'
);
ALTER TABLE stop_event_forecast SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'source_id',
  timescaledb.orderby = 'trip_instance_id, stop_index, observed_at'
);
ALTER TABLE segment_obs SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'source_id',
  timescaledb.orderby = 'trip_instance_id, from_index'
);
ALTER TABLE event SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'source_id',
  timescaledb.orderby = 'occurred_at, event_id'
);

CALL add_columnstore_policy('stop_event', after => INTERVAL '2 days');
CALL add_columnstore_policy('stop_event_forecast', after => INTERVAL '2 days');
CALL add_columnstore_policy('segment_obs', after => INTERVAL '2 days');
CALL add_columnstore_policy('event', after => INTERVAL '2 days');

-- Staging of a rebuild that runs beside the live tail: its rows wait here until they are swapped in.
-- rt_rebuild_job names the rebuild the staged rows belong to, so a swap refuses rows that are not its own.
CREATE UNLOGGED TABLE rt_rebuild_job (
  singleton boolean NOT NULL DEFAULT true,
  token uuid NOT NULL,
  postmaster_start timestamptz NOT NULL,
  CONSTRAINT rt_rebuild_job_pkey PRIMARY KEY (singleton),
  CONSTRAINT rt_rebuild_job_single CHECK (singleton)
);

CREATE UNLOGGED TABLE rt_rebuild_stop_event (
  service_date date NOT NULL,
  trip_instance_id uuid NOT NULL,
  stop_index smallint NOT NULL,
  source_id text NOT NULL,
  stop_place_id uuid NOT NULL,
  scheduled_arrival timestamptz,
  scheduled_departure timestamptz,
  predicted_arrival timestamptz,
  predicted_departure timestamptz,
  arrival_delay_s integer,
  departure_delay_s integer,
  prediction_kind text,
  final_arrival timestamptz,
  final_departure timestamptz,
  final_quality text,
  platform_scheduled text,
  platform_actual text,
  cancelled boolean NOT NULL,
  additional boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  raw_object_id uuid NOT NULL,
  CONSTRAINT rt_rebuild_stop_event_pkey PRIMARY KEY (service_date, trip_instance_id, stop_index, source_id)
);

CREATE UNLOGGED TABLE rt_rebuild_forecast (
  trip_instance_id uuid NOT NULL,
  stop_index smallint NOT NULL,
  source_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  service_date date NOT NULL,
  predicted_arrival timestamptz,
  predicted_departure timestamptz,
  arrival_delay_s integer,
  departure_delay_s integer,
  cancelled boolean NOT NULL,
  explicit boolean NOT NULL,
  raw_object_id uuid NOT NULL,
  CONSTRAINT rt_rebuild_forecast_pkey PRIMARY KEY (trip_instance_id, stop_index, source_id, observed_at)
);

CREATE UNLOGGED TABLE rt_rebuild_segment (
  service_date date NOT NULL,
  trip_instance_id uuid NOT NULL,
  from_index smallint NOT NULL,
  source_id text NOT NULL,
  to_index smallint NOT NULL,
  from_stop_place_id uuid NOT NULL,
  to_stop_place_id uuid NOT NULL,
  dep_delay_from_s integer NOT NULL,
  arr_delay_to_s integer NOT NULL,
  delay_gain_s integer NOT NULL,
  run_sched_s integer NOT NULL,
  run_act_s integer NOT NULL,
  dwell_delay_s integer,
  observed_at timestamptz NOT NULL,
  raw_object_id uuid NOT NULL,
  CONSTRAINT rt_rebuild_segment_pkey PRIMARY KEY (service_date, trip_instance_id, from_index, source_id)
);
