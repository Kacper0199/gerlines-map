CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TABLE stop_place (
  stop_place_id uuid PRIMARY KEY,
  name text NOT NULL,
  name_source_id text NOT NULL REFERENCES source (source_id),
  dhid text,
  eva integer,
  ifopt text,
  uic integer,
  country_code text,
  geom geometry(Point, 4326),
  geom_source_id text REFERENCES source (source_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_place_dhid_key UNIQUE (dhid),
  CONSTRAINT stop_place_ifopt_key UNIQUE (ifopt),
  CONSTRAINT stop_place_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT stop_place_dhid_format CHECK (dhid ~ '^[a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+$'),
  CONSTRAINT stop_place_eva_range CHECK (eva BETWEEN 1 AND 9999999),
  CONSTRAINT stop_place_ifopt_format CHECK (ifopt ~ '^[a-z]{2}:[0-9A-Za-z_]+(:[0-9A-Za-z_]+)*$'),
  CONSTRAINT stop_place_uic_range CHECK (uic BETWEEN 1000000 AND 9999999),
  CONSTRAINT stop_place_country_code_format CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT stop_place_geom_lon_lat CHECK (
    geom IS NULL
    OR (NOT ST_IsEmpty(geom) AND ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
  ),
  CONSTRAINT stop_place_geom_source_present CHECK ((geom IS NULL) = (geom_source_id IS NULL)),
  CONSTRAINT stop_place_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX stop_place_eva_idx ON stop_place (eva);
CREATE INDEX stop_place_uic_idx ON stop_place (uic);
CREATE INDEX stop_place_geom_idx ON stop_place USING gist (geom);

CREATE TRIGGER stop_place_set_updated_at
  BEFORE UPDATE ON stop_place
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE stop_point (
  stop_point_id uuid PRIMARY KEY,
  stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id),
  name text,
  name_source_id text REFERENCES source (source_id),
  platform_code text,
  dhid text,
  ifopt text,
  geom geometry(Point, 4326),
  geom_source_id text REFERENCES source (source_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_point_dhid_key UNIQUE (dhid),
  CONSTRAINT stop_point_ifopt_key UNIQUE (ifopt),
  CONSTRAINT stop_point_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT stop_point_platform_code_not_blank CHECK (btrim(platform_code) <> ''),
  CONSTRAINT stop_point_dhid_format CHECK (
    dhid ~ '^[a-z]{2}:[0-9]{5}:[0-9A-Za-z_]+(:[0-9A-Za-z_]+){1,2}$'
  ),
  CONSTRAINT stop_point_ifopt_format CHECK (ifopt ~ '^[a-z]{2}:[0-9A-Za-z_]+(:[0-9A-Za-z_]+)*$'),
  CONSTRAINT stop_point_geom_lon_lat CHECK (
    geom IS NULL
    OR (NOT ST_IsEmpty(geom) AND ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
  ),
  CONSTRAINT stop_point_name_source_present CHECK ((name IS NULL) = (name_source_id IS NULL)),
  CONSTRAINT stop_point_geom_source_present CHECK ((geom IS NULL) = (geom_source_id IS NULL)),
  CONSTRAINT stop_point_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX stop_point_stop_place_idx ON stop_point (stop_place_id);
CREATE INDEX stop_point_geom_idx ON stop_point USING gist (geom);

CREATE TRIGGER stop_point_set_updated_at
  BEFORE UPDATE ON stop_point
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
