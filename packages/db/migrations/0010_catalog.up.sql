CREATE TABLE category (
  category_code text PRIMARY KEY,
  name text NOT NULL,
  motis_classes text[] NOT NULL,
  is_train boolean NOT NULL,
  sort_order smallint NOT NULL,
  CONSTRAINT category_code_format CHECK (category_code ~ '^[a-z]{2,16}$'),
  CONSTRAINT category_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT category_sort_order_key UNIQUE (sort_order)
);

INSERT INTO category (category_code, name, motis_classes, is_train, sort_order) VALUES
  ('hsr', 'High-speed rail', '{HIGHSPEED_RAIL}', true, 1),
  ('ld', 'Long-distance rail', '{LONG_DISTANCE}', true, 2),
  ('night', 'Night train', '{NIGHT_RAIL}', true, 3),
  ('rfast', 'Fast regional rail', '{REGIONAL_RAIL}', true, 4),
  ('reg', 'Regional rail', '{REGIONAL_RAIL}', true, 5),
  ('sbahn', 'S-Bahn', '{SUBURBAN,METRO}', true, 6),
  ('urban', 'U-Bahn and tram', '{SUBWAY,TRAM}', false, 7),
  ('bus', 'Bus and coach', '{BUS,COACH}', false, 8),
  ('other', 'Ferry, cable car and other', '{}', false, 9);

CREATE TABLE operator (
  operator_id text PRIMARY KEY,
  name text NOT NULL,
  name_source_id text NOT NULL REFERENCES source (source_id),
  country_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_id_format CHECK (operator_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT operator_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT operator_country_code_format CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT operator_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TRIGGER operator_set_updated_at
  BEFORE UPDATE ON operator
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE operator_alias (
  source_id text NOT NULL REFERENCES source (source_id),
  alias text NOT NULL,
  operator_id text NOT NULL REFERENCES operator (operator_id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_alias_pkey PRIMARY KEY (source_id, alias),
  CONSTRAINT operator_alias_not_blank CHECK (btrim(alias) <> ''),
  CONSTRAINT operator_alias_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX operator_alias_operator_idx ON operator_alias (operator_id);
