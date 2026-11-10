-- gerlines:no-transaction
CREATE MATERIALIZED VIEW land_category_day
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', d.day) AS day,
  l.land_code,
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
  CASE WHEN count(d.delay_hist) > 0 THEN ARRAY[
    sum(d.delay_hist[1]), sum(d.delay_hist[2]), sum(d.delay_hist[3]), sum(d.delay_hist[4]), sum(d.delay_hist[5]), sum(d.delay_hist[6]), sum(d.delay_hist[7]), sum(d.delay_hist[8]),
    sum(d.delay_hist[9]), sum(d.delay_hist[10]), sum(d.delay_hist[11]), sum(d.delay_hist[12]), sum(d.delay_hist[13]), sum(d.delay_hist[14]), sum(d.delay_hist[15]), sum(d.delay_hist[16]),
    sum(d.delay_hist[17]), sum(d.delay_hist[18]), sum(d.delay_hist[19]), sum(d.delay_hist[20]), sum(d.delay_hist[21]), sum(d.delay_hist[22]), sum(d.delay_hist[23]), sum(d.delay_hist[24]),
    sum(d.delay_hist[25]), sum(d.delay_hist[26]), sum(d.delay_hist[27]), sum(d.delay_hist[28]), sum(d.delay_hist[29]), sum(d.delay_hist[30]), sum(d.delay_hist[31]), sum(d.delay_hist[32])
  ]::bigint[] END AS delay_hist
FROM station_day d
LEFT JOIN stop_place_land l ON l.stop_place_id = d.stop_place_id
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE MATERIALIZED VIEW land_category_hour
WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  time_bucket(INTERVAL '1 day', d.day) AS day,
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
  sum(d.n_platform_changed)::bigint AS n_platform_changed
FROM station_hour d
LEFT JOIN stop_place_land l ON l.stop_place_id = d.stop_place_id
GROUP BY 1, 2, 3, 4
WITH NO DATA;

CREATE INDEX land_category_day_land_idx ON land_category_day (land_code, day);
CREATE INDEX land_category_hour_land_idx ON land_category_hour (land_code, day);
CALL refresh_continuous_aggregate('land_category_day', NULL, (now() + INTERVAL '14 days')::date);
CALL refresh_continuous_aggregate('land_category_hour', NULL, (now() + INTERVAL '14 days')::date);
SELECT add_continuous_aggregate_policy(
  'land_category_day',
  start_offset => NULL,
  end_offset => INTERVAL '-14 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '20 minutes',
  if_not_exists => true
);
SELECT add_continuous_aggregate_policy(
  'land_category_hour',
  start_offset => NULL,
  end_offset => INTERVAL '-14 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '21 minutes',
  if_not_exists => true
);
