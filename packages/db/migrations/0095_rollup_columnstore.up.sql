-- Rollups in the columnstore (T-141): level 1 in day chunks after 3 days, levels 2 and 3 after 14 days, except
-- segment_day after 35 days: the segment profile joins it by place pair, which only its index serves quickly.
-- Segment by category, order by what the statistics routes filter on, so a read decompresses few batches;
-- segment_day is not segmented, since the profile reads every category of a pair and filters by origin.
SELECT set_chunk_time_interval('stat_stop', INTERVAL '1 day');
SELECT set_chunk_time_interval('stat_segment', INTERVAL '1 day');

ALTER MATERIALIZED VIEW stat_stop SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'trip_instance_id, stop_index'
);
ALTER MATERIALIZED VIEW stat_segment SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'train_number, trip_instance_id, from_index'
);
ALTER MATERIALIZED VIEW station_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'stop_place_id, operator_id, day'
);
ALTER MATERIALIZED VIEW station_hour SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'stop_place_id, local_hour, day'
);
ALTER MATERIALIZED VIEW train_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'train_number, operator_id, line_name, day'
);
ALTER MATERIALIZED VIEW line_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'category_code',
  timescaledb.orderby = 'line_name, operator_id, day'
);
ALTER MATERIALIZED VIEW segment_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = '',
  timescaledb.orderby = 'from_stop_place_id, to_stop_place_id, day'
);
ALTER MATERIALIZED VIEW land_category_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'land_code',
  timescaledb.orderby = 'category_code, day'
);
ALTER MATERIALIZED VIEW land_category_hour SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'land_code',
  timescaledb.orderby = 'category_code, local_hour, day'
);

CALL add_columnstore_policy('stat_stop', after => INTERVAL '3 days');
CALL add_columnstore_policy('stat_segment', after => INTERVAL '3 days');
CALL add_columnstore_policy('station_day', after => INTERVAL '14 days');
CALL add_columnstore_policy('station_hour', after => INTERVAL '14 days');
CALL add_columnstore_policy('train_day', after => INTERVAL '14 days');
CALL add_columnstore_policy('line_day', after => INTERVAL '14 days');
CALL add_columnstore_policy('segment_day', after => INTERVAL '35 days');
CALL add_columnstore_policy('land_category_day', after => INTERVAL '14 days');
CALL add_columnstore_policy('land_category_hour', after => INTERVAL '14 days');
