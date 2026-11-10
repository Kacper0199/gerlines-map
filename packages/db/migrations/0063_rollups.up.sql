CREATE MATERIALIZED VIEW station_day
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.day) AS day,
  s.stop_place_id,
  s.category_code,
  s.operator_id,
  count(*) AS n_stops,
  count(*) FILTER (WHERE s.cancelled) AS n_cancelled,
  count(*) FILTER (WHERE s.additional) AS n_additional,
  count(*) FILTER (WHERE s.source_id IS NULL) AS n_no_data,
  count(*) FILTER (WHERE s.final_quality = 'carried' AND NOT s.cancelled) AS n_carried,
  count(s.stop_delay_s) AS n_observed,
  count(*) FILTER (WHERE s.stop_delay_s < 360) AS n_lt_6min,
  count(*) FILTER (WHERE s.stop_delay_s < 960) AS n_lt_16min,
  count(s.stop_delay_s) FILTER (WHERE s.stop_index > 0) AS n_observed_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 360) AS n_lt_6min_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 960) AS n_lt_16min_arr,
  count(s.stop_delay_s) FILTER (WHERE s.final_quality = 'carried') AS n_observed_carried,
  count(s.stop_delay_s) FILTER (WHERE s.prediction_kind = 'propagated') AS n_observed_propagated,
  sum(s.stop_delay_s)::bigint AS sum_delay_s,
  sum(greatest(s.stop_delay_s, 0))::bigint AS sum_delay_pos_s,
  max(s.stop_delay_s) AS max_delay_s,
  count(*) FILTER (WHERE s.platform_changed) AS n_platform_changed,
  histogram(stat_delay_bin(s.stop_delay_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.stop_delay_s) IS NOT NULL) AS delay_hist,
  count(s.dep_delay_s) AS n_dep_observed,
  count(*) FILTER (WHERE s.dep_delay_s < 360) AS n_dep_lt_6min,
  histogram(stat_delay_bin(s.dep_delay_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.dep_delay_s) IS NOT NULL) AS dep_delay_hist
FROM stat_stop s
GROUP BY 1, 2, 3, 4
WITH NO DATA;

CREATE MATERIALIZED VIEW station_hour
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.day) AS day,
  s.stop_place_id,
  s.local_hour,
  s.category_code,
  count(*) AS n_stops,
  count(*) FILTER (WHERE s.cancelled) AS n_cancelled,
  count(*) FILTER (WHERE s.additional) AS n_additional,
  count(*) FILTER (WHERE s.source_id IS NULL) AS n_no_data,
  count(*) FILTER (WHERE s.final_quality = 'carried' AND NOT s.cancelled) AS n_carried,
  count(s.stop_delay_s) AS n_observed,
  count(*) FILTER (WHERE s.stop_delay_s < 360) AS n_lt_6min,
  count(*) FILTER (WHERE s.stop_delay_s < 960) AS n_lt_16min,
  count(s.stop_delay_s) FILTER (WHERE s.stop_index > 0) AS n_observed_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 360) AS n_lt_6min_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 960) AS n_lt_16min_arr,
  count(s.stop_delay_s) FILTER (WHERE s.final_quality = 'carried') AS n_observed_carried,
  count(s.stop_delay_s) FILTER (WHERE s.prediction_kind = 'propagated') AS n_observed_propagated,
  sum(s.stop_delay_s)::bigint AS sum_delay_s,
  sum(greatest(s.stop_delay_s, 0))::bigint AS sum_delay_pos_s,
  max(s.stop_delay_s) AS max_delay_s,
  count(*) FILTER (WHERE s.platform_changed) AS n_platform_changed,
  histogram(stat_delay_bin(s.stop_delay_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.stop_delay_s) IS NOT NULL) AS delay_hist
FROM stat_stop s
GROUP BY 1, 2, 3, 4
WITH NO DATA;

CREATE MATERIALIZED VIEW train_day
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.day) AS day,
  s.operator_id,
  s.train_number,
  s.category_code,
  s.line_name,
  count(DISTINCT s.trip_instance_id) AS n_runs,
  count(*) AS n_stops,
  count(*) FILTER (WHERE s.cancelled) AS n_cancelled,
  count(*) FILTER (WHERE s.additional) AS n_additional,
  count(*) FILTER (WHERE s.source_id IS NULL) AS n_no_data,
  count(*) FILTER (WHERE s.final_quality = 'carried' AND NOT s.cancelled) AS n_carried,
  count(s.stop_delay_s) AS n_observed,
  count(*) FILTER (WHERE s.stop_delay_s < 360) AS n_lt_6min,
  count(*) FILTER (WHERE s.stop_delay_s < 960) AS n_lt_16min,
  count(s.stop_delay_s) FILTER (WHERE s.stop_index > 0) AS n_observed_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 360) AS n_lt_6min_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 960) AS n_lt_16min_arr,
  count(s.stop_delay_s) FILTER (WHERE s.final_quality = 'carried') AS n_observed_carried,
  count(s.stop_delay_s) FILTER (WHERE s.prediction_kind = 'propagated') AS n_observed_propagated,
  sum(s.stop_delay_s)::bigint AS sum_delay_s,
  sum(greatest(s.stop_delay_s, 0))::bigint AS sum_delay_pos_s,
  max(s.stop_delay_s) AS max_delay_s,
  count(*) FILTER (WHERE s.platform_changed) AS n_platform_changed,
  histogram(stat_delay_bin(s.stop_delay_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.stop_delay_s) IS NOT NULL) AS delay_hist
FROM stat_stop s
GROUP BY 1, 2, 3, 4, 5
WITH NO DATA;

CREATE MATERIALIZED VIEW line_day
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.day) AS day,
  s.operator_id,
  s.line_name,
  s.category_code,
  count(DISTINCT s.trip_instance_id) AS n_runs,
  count(*) AS n_stops,
  count(*) FILTER (WHERE s.cancelled) AS n_cancelled,
  count(*) FILTER (WHERE s.additional) AS n_additional,
  count(*) FILTER (WHERE s.source_id IS NULL) AS n_no_data,
  count(*) FILTER (WHERE s.final_quality = 'carried' AND NOT s.cancelled) AS n_carried,
  count(s.stop_delay_s) AS n_observed,
  count(*) FILTER (WHERE s.stop_delay_s < 360) AS n_lt_6min,
  count(*) FILTER (WHERE s.stop_delay_s < 960) AS n_lt_16min,
  count(s.stop_delay_s) FILTER (WHERE s.stop_index > 0) AS n_observed_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 360) AS n_lt_6min_arr,
  count(*) FILTER (WHERE s.stop_index > 0 AND s.stop_delay_s < 960) AS n_lt_16min_arr,
  count(s.stop_delay_s) FILTER (WHERE s.final_quality = 'carried') AS n_observed_carried,
  count(s.stop_delay_s) FILTER (WHERE s.prediction_kind = 'propagated') AS n_observed_propagated,
  sum(s.stop_delay_s)::bigint AS sum_delay_s,
  sum(greatest(s.stop_delay_s, 0))::bigint AS sum_delay_pos_s,
  max(s.stop_delay_s) AS max_delay_s,
  count(*) FILTER (WHERE s.platform_changed) AS n_platform_changed,
  histogram(stat_delay_bin(s.stop_delay_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.stop_delay_s) IS NOT NULL) AS delay_hist
FROM stat_stop s
GROUP BY 1, 2, 3, 4
WITH NO DATA;

CREATE MATERIALIZED VIEW segment_day
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', s.day) AS day,
  s.from_stop_place_id,
  s.to_stop_place_id,
  s.category_code,
  count(*) AS n_legs,
  count(DISTINCT s.trip_instance_id) AS n_runs,
  sum(s.delay_gain_s)::bigint AS sum_gain_s,
  count(*) FILTER (WHERE s.delay_gain_s > 0) AS n_gain_pos,
  count(*) FILTER (WHERE s.delay_gain_s < 0) AS n_gain_neg,
  histogram(stat_gain_bin(s.delay_gain_s)::double precision, 0, 21, 21)
    FILTER (WHERE stat_gain_bin(s.delay_gain_s) IS NOT NULL) AS gain_hist,
  count(*) FILTER (WHERE s.arr_delay_to_s < 360) AS n_arr_lt_6min,
  sum(s.arr_delay_to_s)::bigint AS sum_arr_delay_s,
  histogram(stat_delay_bin(s.arr_delay_to_s)::double precision, 0, 30, 30)
    FILTER (WHERE stat_delay_bin(s.arr_delay_to_s) IS NOT NULL) AS arr_delay_hist,
  sum(s.run_sched_s)::bigint AS sum_run_sched_s,
  sum(s.run_act_s)::bigint AS sum_run_act_s,
  count(s.dwell_delay_s) AS n_dwell,
  sum(s.dwell_delay_s)::bigint AS sum_dwell_delay_s,
  count(*) FILTER (WHERE s.distance_m IS NOT NULL AND s.run_act_s > 0 AND s.run_sched_s > 0) AS n_speed,
  sum(s.distance_m)
    FILTER (WHERE s.distance_m IS NOT NULL AND s.run_act_s > 0 AND s.run_sched_s > 0) AS sum_distance_m,
  sum(s.run_act_s)
    FILTER (WHERE s.distance_m IS NOT NULL AND s.run_act_s > 0 AND s.run_sched_s > 0) AS sum_speed_run_act_s,
  sum(s.run_sched_s)
    FILTER (WHERE s.distance_m IS NOT NULL AND s.run_act_s > 0 AND s.run_sched_s > 0) AS sum_speed_run_sched_s,
  histogram(stat_speed_bin(s.distance_m / s.run_act_s * 3.6)::double precision, 0, 31, 31)
    FILTER (WHERE s.distance_m IS NOT NULL AND s.run_act_s > 0 AND s.run_sched_s > 0) AS speed_hist
FROM stat_segment s
GROUP BY 1, 2, 3, 4
WITH NO DATA;

CREATE VIEW land_day AS
SELECT
  d.day,
  l.land_code,
  d.category_code,
  d.operator_id,
  sum(d.n_stops)::bigint AS n_stops,
  sum(d.n_cancelled)::bigint AS n_cancelled,
  sum(d.n_additional)::bigint AS n_additional,
  sum(d.n_no_data)::bigint AS n_no_data,
  sum(d.n_carried)::bigint AS n_carried,
  sum(d.n_observed)::bigint AS n_observed,
  sum(d.n_lt_6min)::bigint AS n_lt_6min,
  sum(d.n_lt_16min)::bigint AS n_lt_16min,
  sum(d.n_observed_arr)::bigint AS n_observed_arr,
  sum(d.n_lt_6min_arr)::bigint AS n_lt_6min_arr,
  sum(d.n_lt_16min_arr)::bigint AS n_lt_16min_arr,
  sum(d.n_observed_carried)::bigint AS n_observed_carried,
  sum(d.n_observed_propagated)::bigint AS n_observed_propagated,
  sum(d.sum_delay_s)::bigint AS sum_delay_s,
  sum(d.sum_delay_pos_s)::bigint AS sum_delay_pos_s,
  max(d.max_delay_s) AS max_delay_s,
  sum(d.n_platform_changed)::bigint AS n_platform_changed,
  stat_hist_sum(d.delay_hist) AS delay_hist
FROM station_day d
LEFT JOIN stop_place_land l ON l.stop_place_id = d.stop_place_id
GROUP BY 1, 2, 3, 4;

CREATE VIEW land_hour AS
SELECT
  d.day,
  l.land_code,
  d.local_hour,
  d.category_code,
  sum(d.n_stops)::bigint AS n_stops,
  sum(d.n_cancelled)::bigint AS n_cancelled,
  sum(d.n_additional)::bigint AS n_additional,
  sum(d.n_no_data)::bigint AS n_no_data,
  sum(d.n_carried)::bigint AS n_carried,
  sum(d.n_observed)::bigint AS n_observed,
  sum(d.n_lt_6min)::bigint AS n_lt_6min,
  sum(d.n_lt_16min)::bigint AS n_lt_16min,
  sum(d.n_observed_arr)::bigint AS n_observed_arr,
  sum(d.n_lt_6min_arr)::bigint AS n_lt_6min_arr,
  sum(d.n_lt_16min_arr)::bigint AS n_lt_16min_arr,
  sum(d.n_observed_carried)::bigint AS n_observed_carried,
  sum(d.n_observed_propagated)::bigint AS n_observed_propagated,
  sum(d.sum_delay_s)::bigint AS sum_delay_s,
  sum(d.sum_delay_pos_s)::bigint AS sum_delay_pos_s,
  max(d.max_delay_s) AS max_delay_s,
  sum(d.n_platform_changed)::bigint AS n_platform_changed,
  stat_hist_sum(d.delay_hist) AS delay_hist
FROM station_hour d
LEFT JOIN stop_place_land l ON l.stop_place_id = d.stop_place_id
GROUP BY 1, 2, 3, 4;

CREATE INDEX station_day_place_idx ON station_day (stop_place_id, day);
CREATE INDEX station_hour_place_idx ON station_hour (stop_place_id, day);
CREATE INDEX train_day_train_idx ON train_day (operator_id, train_number, day);
CREATE INDEX line_day_line_idx ON line_day (operator_id, line_name, day);
CREATE INDEX segment_day_places_idx ON segment_day (from_stop_place_id, to_stop_place_id, day);
