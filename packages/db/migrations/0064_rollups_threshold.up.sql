-- gerlines:no-transaction
CALL refresh_continuous_aggregate('station_day', NULL, (now() + INTERVAL '7 days')::date);
CALL refresh_continuous_aggregate('segment_day', NULL, (now() + INTERVAL '7 days')::date);
CALL refresh_continuous_aggregate('station_hour', NULL, (now() + INTERVAL '7 days')::date);
CALL refresh_continuous_aggregate('train_day', NULL, (now() + INTERVAL '7 days')::date);
CALL refresh_continuous_aggregate('line_day', NULL, (now() + INTERVAL '7 days')::date);
SELECT add_continuous_aggregate_policy(
  'station_day',
  start_offset => NULL,
  end_offset => INTERVAL '-7 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '5 minutes',
  if_not_exists => true
);
SELECT add_continuous_aggregate_policy(
  'station_hour',
  start_offset => NULL,
  end_offset => INTERVAL '-7 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '6 minutes',
  if_not_exists => true
);
SELECT add_continuous_aggregate_policy(
  'train_day',
  start_offset => NULL,
  end_offset => INTERVAL '-7 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '7 minutes',
  if_not_exists => true
);
SELECT add_continuous_aggregate_policy(
  'line_day',
  start_offset => NULL,
  end_offset => INTERVAL '-7 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '8 minutes',
  if_not_exists => true
);
SELECT add_continuous_aggregate_policy(
  'segment_day',
  start_offset => NULL,
  end_offset => INTERVAL '-7 days',
  schedule_interval => INTERVAL '30 minutes',
  initial_start => date_trunc('hour', now()) + INTERVAL '9 minutes',
  if_not_exists => true
);
