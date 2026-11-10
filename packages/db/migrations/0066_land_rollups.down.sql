SELECT remove_continuous_aggregate_policy('land_category_hour', if_exists => true);
SELECT remove_continuous_aggregate_policy('land_category_day', if_exists => true);
DROP MATERIALIZED VIEW land_category_hour;
DROP MATERIALIZED VIEW land_category_day;
