-- Decompresses every rollup chunk first: on a large history this needs the uncompressed size free on disk.
CALL remove_columnstore_policy('land_category_hour', if_exists => true);
CALL remove_columnstore_policy('land_category_day', if_exists => true);
CALL remove_columnstore_policy('segment_day', if_exists => true);
CALL remove_columnstore_policy('line_day', if_exists => true);
CALL remove_columnstore_policy('train_day', if_exists => true);
CALL remove_columnstore_policy('station_hour', if_exists => true);
CALL remove_columnstore_policy('station_day', if_exists => true);
CALL remove_columnstore_policy('stat_segment', if_exists => true);
CALL remove_columnstore_policy('stat_stop', if_exists => true);

SELECT count(decompress_chunk(c, true))
  FROM unnest(ARRAY[
    'stat_stop', 'stat_segment', 'station_day', 'station_hour', 'train_day', 'line_day', 'segment_day',
    'land_category_day', 'land_category_hour'
  ]) AS r (name), show_chunks(r.name) AS c;

ALTER MATERIALIZED VIEW land_category_hour SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW land_category_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW segment_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW line_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW train_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW station_hour SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW station_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW stat_segment SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW stat_stop SET (timescaledb.enable_columnstore = false);

SELECT set_chunk_time_interval('stat_segment', INTERVAL '10 days');
SELECT set_chunk_time_interval('stat_stop', INTERVAL '10 days');
