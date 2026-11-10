CREATE TABLE land (
  land_code text PRIMARY KEY,
  ars text UNIQUE,
  name_de text NOT NULL,
  display_order smallint NOT NULL UNIQUE,
  CONSTRAINT land_code_format CHECK (land_code ~ '^DE-[A-Z]{2}$' OR land_code = 'foreign'),
  CONSTRAINT land_ars_present CHECK ((ars IS NULL) = (land_code = 'foreign')),
  CONSTRAINT land_ars_format CHECK (ars ~ '^[0-9]{2}$')
);

INSERT INTO land (land_code, ars, name_de, display_order) VALUES
  ('DE-SH', '01', 'Schleswig-Holstein', 1),
  ('DE-HH', '02', 'Hamburg', 2),
  ('DE-NI', '03', 'Niedersachsen', 3),
  ('DE-HB', '04', 'Bremen', 4),
  ('DE-NW', '05', 'Nordrhein-Westfalen', 5),
  ('DE-HE', '06', 'Hessen', 6),
  ('DE-RP', '07', 'Rheinland-Pfalz', 7),
  ('DE-BW', '08', 'Baden-Württemberg', 8),
  ('DE-BY', '09', 'Bayern', 9),
  ('DE-SL', '10', 'Saarland', 10),
  ('DE-BE', '11', 'Berlin', 11),
  ('DE-BB', '12', 'Brandenburg', 12),
  ('DE-MV', '13', 'Mecklenburg-Vorpommern', 13),
  ('DE-SN', '14', 'Sachsen', 14),
  ('DE-ST', '15', 'Sachsen-Anhalt', 15),
  ('DE-TH', '16', 'Thüringen', 16),
  ('foreign', NULL, 'Ausland', 17);

CREATE TABLE land_area (
  land_code text PRIMARY KEY REFERENCES land (land_code),
  geom geometry(MultiPolygon, 25832) NOT NULL,
  edition text NOT NULL,
  source_url text NOT NULL,
  source_sha256 text NOT NULL,
  licence text NOT NULL,
  attribution text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT land_area_german CHECK (land_code <> 'foreign'),
  CONSTRAINT land_area_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
  CONSTRAINT land_area_sha256_hex CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT land_area_edition_not_blank CHECK (btrim(edition) <> '')
);

CREATE INDEX land_area_geom_idx ON land_area USING gist (geom);

CREATE TABLE stop_place_land (
  stop_place_id uuid PRIMARY KEY REFERENCES stop_place (stop_place_id) ON DELETE CASCADE,
  land_code text REFERENCES land (land_code),
  method text NOT NULL,
  distance_m double precision,
  edition text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_place_land_method_known CHECK (method IN ('within', 'nearest', 'outside', 'no_geometry')),
  CONSTRAINT stop_place_land_method_rule CHECK (
    CASE method
      WHEN 'within' THEN land_code <> 'foreign' AND distance_m = 0
      WHEN 'nearest' THEN land_code <> 'foreign' AND distance_m > 0
      WHEN 'outside' THEN land_code = 'foreign' AND distance_m > 0
      ELSE land_code IS NULL AND distance_m IS NULL
    END
  ),
  CONSTRAINT stop_place_land_edition_present CHECK ((edition IS NULL) = (method = 'no_geometry'))
);

CREATE INDEX stop_place_land_land_idx ON stop_place_land (land_code);

CREATE FUNCTION stop_place_land_rule(
  geom geometry, dhid text, country_code text, OUT land_code text, OUT method text, OUT distance_m double precision
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, pg_catalog AS $$
  WITH p AS (SELECT ST_Transform(geom, 25832) AS g),
  nearest_any AS (
    SELECT a.land_code, ST_Distance(a.geom, p.g) AS d FROM public.land_area a, p ORDER BY 2, 1 LIMIT 1
  ),
  inside AS (
    SELECT a.land_code FROM public.land_area a, p WHERE ST_Covers(a.geom, p.g)
    UNION ALL
    SELECT land_code FROM nearest_any WHERE d = 0
    ORDER BY 1 LIMIT 1
  ),
  nearest AS (SELECT land_code, d FROM nearest_any)
  SELECT
    CASE
      WHEN geom IS NULL THEN NULL
      WHEN EXISTS (SELECT 1 FROM inside) THEN (SELECT inside.land_code FROM inside)
      WHEN (dhid LIKE 'de:%' OR country_code = 'DE') AND (SELECT d FROM nearest) <= 100
        THEN (SELECT nearest.land_code FROM nearest)
      ELSE 'foreign'
    END,
    CASE
      WHEN geom IS NULL THEN 'no_geometry'
      WHEN EXISTS (SELECT 1 FROM inside) THEN 'within'
      WHEN (dhid LIKE 'de:%' OR country_code = 'DE') AND (SELECT d FROM nearest) <= 100 THEN 'nearest'
      ELSE 'outside'
    END,
    CASE
      WHEN geom IS NULL THEN NULL
      WHEN EXISTS (SELECT 1 FROM inside) THEN 0
      ELSE (SELECT d FROM nearest)
    END
$$;

CREATE FUNCTION assign_stop_place_lands(only_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
DECLARE
  current_edition text;
  changed integer;
BEGIN
  SELECT min(edition) INTO current_edition FROM public.land_area;
  IF current_edition IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO public.stop_place_land AS l (stop_place_id, land_code, method, distance_m, edition, assigned_at)
  SELECT s.stop_place_id, r.land_code, r.method, r.distance_m,
         CASE WHEN r.method = 'no_geometry' THEN NULL ELSE current_edition END, now()
    FROM public.stop_place s
    CROSS JOIN LATERAL public.stop_place_land_rule(s.geom, s.dhid, s.country_code) r
   WHERE only_ids IS NULL OR s.stop_place_id = ANY (only_ids)
  ON CONFLICT (stop_place_id) DO UPDATE
     SET land_code = excluded.land_code, method = excluded.method, distance_m = excluded.distance_m,
         edition = excluded.edition, assigned_at = excluded.assigned_at
   WHERE (l.land_code, l.method, l.distance_m, l.edition)
         IS DISTINCT FROM (excluded.land_code, excluded.method, excluded.distance_m, excluded.edition);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;

CREATE FUNCTION stop_place_land_on_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM public.assign_stop_place_lands(ARRAY(SELECT stop_place_id FROM new_rows));
  RETURN NULL;
END
$$;

CREATE FUNCTION stop_place_land_on_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM public.assign_stop_place_lands(ARRAY(
    SELECT n.stop_place_id
      FROM new_rows n JOIN old_rows o USING (stop_place_id)
     WHERE (n.geom, n.dhid, n.country_code) IS DISTINCT FROM (o.geom, o.dhid, o.country_code)
  ));
  RETURN NULL;
END
$$;

CREATE TRIGGER stop_place_land_insert AFTER INSERT ON stop_place
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION stop_place_land_on_insert();

CREATE TRIGGER stop_place_land_update AFTER UPDATE ON stop_place
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION stop_place_land_on_update();
