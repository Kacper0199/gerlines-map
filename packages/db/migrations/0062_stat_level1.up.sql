CREATE MATERIALIZED VIEW stat_stop
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', e.service_date) AS day,
  e.trip_instance_id,
  e.stop_index,
  ti.category_code,
  ti.operator_id,
  ti.train_number,
  r.short_name AS line_name,
  coalesce(
    first(e.stop_place_id, stat_source_key(ti.category_code, e.source_id, e.final_quality))
      FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL),
    first(e.stop_place_id, stat_source_key(ti.category_code, e.source_id, e.final_quality))
  ) AS stop_place_id,
  first(e.source_id, stat_source_key(ti.category_code, e.source_id, e.final_quality))
    FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS source_id,
  count(*)::smallint AS n_sources,
  bool_or(e.additional) AS additional,
  first(e.cancelled, stat_source_key(ti.category_code, e.source_id, e.final_quality))
    FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS cancelled,
  first(e.final_quality, stat_source_key(ti.category_code, e.source_id, e.final_quality))
    FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS final_quality,
  first(e.prediction_kind, stat_source_key(ti.category_code, e.source_id, e.final_quality))
    FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS prediction_kind,
  first(
    extract(hour FROM timezone('Europe/Berlin', coalesce(
      e.scheduled_arrival, e.scheduled_departure, e.final_arrival, e.final_departure,
      e.predicted_arrival, e.predicted_departure
    )))::smallint,
    stat_source_key(ti.category_code, e.source_id, e.final_quality)
  ) AS local_hour,
  first(
    CASE WHEN NOT e.cancelled AND e.final_arrival IS NOT NULL AND e.scheduled_arrival IS NOT NULL
          AND e.final_arrival - e.scheduled_arrival >= INTERVAL '-30 minutes'
      THEN round(extract(epoch FROM e.final_arrival - e.scheduled_arrival))::integer END,
    stat_source_key(ti.category_code, e.source_id, e.final_quality)
  ) FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS arr_delay_s,
  first(
    CASE WHEN NOT e.cancelled AND e.final_departure IS NOT NULL AND e.scheduled_departure IS NOT NULL
          AND e.final_departure - e.scheduled_departure >= INTERVAL '-30 minutes'
      THEN round(extract(epoch FROM e.final_departure - e.scheduled_departure))::integer END,
    stat_source_key(ti.category_code, e.source_id, e.final_quality)
  ) FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS dep_delay_s,
  first(
    CASE
      WHEN e.cancelled THEN NULL
      WHEN e.scheduled_arrival IS NOT NULL THEN
        CASE WHEN e.final_arrival IS NOT NULL
               AND e.final_arrival - e.scheduled_arrival >= INTERVAL '-30 minutes'
          THEN round(extract(epoch FROM e.final_arrival - e.scheduled_arrival))::integer END
      ELSE
        CASE WHEN e.final_departure IS NOT NULL AND e.scheduled_departure IS NOT NULL
               AND e.final_departure - e.scheduled_departure >= INTERVAL '-30 minutes'
          THEN round(extract(epoch FROM e.final_departure - e.scheduled_departure))::integer END
    END,
    stat_source_key(ti.category_code, e.source_id, e.final_quality)
  ) FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS stop_delay_s,
  first(
    e.platform_actual IS NOT NULL AND e.platform_scheduled IS NOT NULL
      AND e.platform_actual <> e.platform_scheduled,
    stat_source_key(ti.category_code, e.source_id, e.final_quality)
  ) FILTER (WHERE e.cancelled OR e.final_quality IS NOT NULL) AS platform_changed
FROM stop_event e
JOIN trip_instance ti ON ti.trip_instance_id = e.trip_instance_id
LEFT JOIN trip t ON t.feed_version_id = ti.feed_version_id AND t.trip_key = ti.trip_key
LEFT JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
GROUP BY 1, 2, 3, ti.category_code, ti.operator_id, ti.train_number, r.short_name
WITH NO DATA;

CREATE INDEX stat_stop_place_idx ON stat_stop (stop_place_id, day);
CREATE INDEX stat_stop_train_idx ON stat_stop (operator_id, train_number, day);
CREATE INDEX stat_stop_instance_idx ON stat_stop (trip_instance_id, stop_index);

CREATE MATERIALIZED VIEW stat_segment
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.service_date) AS day,
  s.trip_instance_id,
  s.from_index,
  ti.category_code,
  ti.operator_id,
  ti.train_number,
  r.short_name AS line_name,
  first(s.source_id, stat_source_key(ti.category_code, s.source_id, NULL)) AS source_id,
  count(*)::smallint AS n_sources,
  first(s.to_index, stat_source_key(ti.category_code, s.source_id, NULL)) AS to_index,
  first(s.from_stop_place_id, stat_source_key(ti.category_code, s.source_id, NULL)) AS from_stop_place_id,
  first(s.to_stop_place_id, stat_source_key(ti.category_code, s.source_id, NULL)) AS to_stop_place_id,
  first(s.dep_delay_from_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS dep_delay_from_s,
  first(s.arr_delay_to_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS arr_delay_to_s,
  first(s.delay_gain_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS delay_gain_s,
  first(s.run_sched_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS run_sched_s,
  first(s.run_act_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS run_act_s,
  first(s.dwell_delay_s, stat_source_key(ti.category_code, s.source_id, NULL)) AS dwell_delay_s,
  first(s.distance_m, stat_source_key(ti.category_code, s.source_id, NULL)) AS distance_m
FROM segment_obs s
JOIN trip_instance ti ON ti.trip_instance_id = s.trip_instance_id
LEFT JOIN trip t ON t.feed_version_id = ti.feed_version_id AND t.trip_key = ti.trip_key
LEFT JOIN route r ON r.feed_version_id = t.feed_version_id AND r.route_key = t.route_key
GROUP BY 1, 2, 3, ti.category_code, ti.operator_id, ti.train_number, r.short_name
WITH NO DATA;

CREATE INDEX stat_segment_places_idx ON stat_segment (from_stop_place_id, to_stop_place_id, day);
CREATE INDEX stat_segment_train_idx ON stat_segment (operator_id, train_number, day);
CREATE INDEX stat_segment_instance_idx ON stat_segment (trip_instance_id, from_index);

SELECT add_continuous_aggregate_policy(
  'stat_stop',
  start_offset => NULL,
  end_offset => INTERVAL '-2 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now() + INTERVAL '10 minutes') + INTERVAL '1 hour'
);

SELECT add_continuous_aggregate_policy(
  'stat_segment',
  start_offset => NULL,
  end_offset => INTERVAL '-2 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now() + INTERVAL '10 minutes') + INTERVAL '1 hour 1 minute'
);
