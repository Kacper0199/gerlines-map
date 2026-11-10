CREATE TABLE formation_observation (
  source_id text NOT NULL,
  service_date date NOT NULL,
  train_number text NOT NULL,
  operator_id text,
  category_code text,
  line text,
  series_id text NOT NULL,
  units smallint,
  cars smallint,
  length_m real,
  unit_names text[] NOT NULL DEFAULT '{}',
  sequence_status text,
  raw_sha256 text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT formation_observation_pkey PRIMARY KEY (source_id, service_date, train_number),
  CONSTRAINT formation_observation_source_id_format CHECK (source_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT formation_observation_train_number_format CHECK (train_number ~ '^[0-9]{1,6}$'),
  CONSTRAINT formation_observation_series_id_format CHECK (series_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT formation_observation_units_range CHECK (units BETWEEN 1 AND 8),
  CONSTRAINT formation_observation_cars_range CHECK (cars BETWEEN 1 AND 40),
  CONSTRAINT formation_observation_length_range CHECK (length_m > 0 AND length_m < 1000),
  CONSTRAINT formation_observation_raw_sha256_hex CHECK (raw_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX formation_observation_train_idx
  ON formation_observation (train_number, service_date DESC);

COMMENT ON TABLE formation_observation IS
  'Exact formations (layer L0 of the vehicle identity, ADR-0011): one row per source, service day and train '
  'number, the series read from the vehicle numbers. Layer L1 takes the majority over the last 14 days. '
  'Keyed by source id without foreign keys: catalogue rows are written by their loader after migrations run.';
