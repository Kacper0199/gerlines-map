ALTER TABLE category
  ADD COLUMN name_de text,
  ADD COLUMN name_pl text,
  ADD COLUMN names_source_id text REFERENCES source (source_id),
  ADD CONSTRAINT category_name_de_not_blank CHECK (btrim(name_de) <> ''),
  ADD CONSTRAINT category_name_pl_not_blank CHECK (btrim(name_pl) <> ''),
  ADD CONSTRAINT category_names_sourced CHECK (
    (name_de IS NULL AND name_pl IS NULL) OR names_source_id IS NOT NULL
  );

ALTER TABLE operator
  ADD COLUMN brand_name text,
  ADD COLUMN legal_name text,
  ADD COLUMN wikidata_qid text,
  ADD COLUMN wikidata_role text,
  ADD COLUMN wikidata_basis_source_id text REFERENCES source (source_id),
  ADD COLUMN website_url text,
  ADD COLUMN parents jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN valid_from date,
  ADD COLUMN valid_to date,
  ADD COLUMN catalog_source_id text REFERENCES source (source_id),
  ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN missing jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT operator_brand_name_not_blank CHECK (btrim(brand_name) <> ''),
  ADD CONSTRAINT operator_legal_name_not_blank CHECK (btrim(legal_name) <> ''),
  ADD CONSTRAINT operator_catalogued_has_brand CHECK (
    (catalog_source_id IS NULL) = (brand_name IS NULL)
  ),
  ADD CONSTRAINT operator_wikidata_qid_format CHECK (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  ADD CONSTRAINT operator_wikidata_role_known CHECK (
    wikidata_role IN ('company', 'parent_company', 'brand', 'network')
  ),
  ADD CONSTRAINT operator_wikidata_complete CHECK (
    (wikidata_qid IS NULL) = (wikidata_role IS NULL)
    AND (wikidata_qid IS NULL) = (wikidata_basis_source_id IS NULL)
  ),
  ADD CONSTRAINT operator_website_url_http CHECK (website_url ~ '^https?://'),
  ADD CONSTRAINT operator_parents_array CHECK (jsonb_typeof(parents) = 'array'),
  ADD CONSTRAINT operator_field_sources_object CHECK (jsonb_typeof(field_sources) = 'object'),
  ADD CONSTRAINT operator_missing_object CHECK (jsonb_typeof(missing) = 'object'),
  ADD CONSTRAINT operator_valid_order CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);

CREATE INDEX operator_wikidata_qid_idx ON operator (wikidata_qid);

ALTER TABLE operator_alias
  ADD COLUMN valid_from date,
  ADD COLUMN valid_to date,
  ADD CONSTRAINT operator_alias_valid_order CHECK (
    valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from
  );

CREATE TABLE verbund (
  verbund_id text PRIMARY KEY,
  abbr text NOT NULL,
  name text NOT NULL,
  laender text[] NOT NULL,
  spnv_integrated boolean,
  wikidata_qid text,
  website_url text,
  source_id text NOT NULL REFERENCES source (source_id),
  field_sources jsonb NOT NULL DEFAULT '{}',
  missing jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verbund_id_format CHECK (verbund_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT verbund_abbr_not_blank CHECK (btrim(abbr) <> ''),
  CONSTRAINT verbund_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT verbund_laender_known CHECK (
    cardinality(laender) > 0
    AND laender <@ ARRAY[
      'DE-BW', 'DE-BY', 'DE-BE', 'DE-BB', 'DE-HB', 'DE-HH', 'DE-HE', 'DE-MV',
      'DE-NI', 'DE-NW', 'DE-RP', 'DE-SL', 'DE-SN', 'DE-ST', 'DE-SH', 'DE-TH'
    ]::text[]
  ),
  CONSTRAINT verbund_wikidata_qid_format CHECK (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  CONSTRAINT verbund_website_url_http CHECK (website_url ~ '^https?://'),
  CONSTRAINT verbund_field_sources_object CHECK (jsonb_typeof(field_sources) = 'object'),
  CONSTRAINT verbund_missing_object CHECK (jsonb_typeof(missing) = 'object'),
  CONSTRAINT verbund_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX verbund_laender_idx ON verbund USING gin (laender);

CREATE TRIGGER verbund_set_updated_at
  BEFORE UPDATE ON verbund
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicle_series (
  series_id text PRIMARY KEY,
  name text NOT NULL,
  br text,
  family text,
  manufacturers text[] NOT NULL DEFAULT '{}',
  traction text,
  unit_kind text,
  double_deck boolean,
  cars_min smallint,
  cars_max smallint,
  unit_length_m numeric(7, 3),
  max_speed_kmh smallint,
  priority text NOT NULL,
  wikidata_qid text,
  commons_category text,
  dewiki_title text,
  source_id text NOT NULL REFERENCES source (source_id),
  field_sources jsonb NOT NULL DEFAULT '{}',
  missing jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_series_id_format CHECK (series_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT vehicle_series_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT vehicle_series_traction_known CHECK (
    traction IN ('electric', 'diesel', 'battery_electric', 'hydrogen', 'dual_mode')
  ),
  CONSTRAINT vehicle_series_unit_kind_known CHECK (
    unit_kind IN ('emu', 'dmu', 'locomotive', 'coach', 'trainset', 'tram_train')
  ),
  CONSTRAINT vehicle_series_cars_range CHECK (
    cars_min BETWEEN 1 AND 40 AND cars_max BETWEEN 1 AND 40 AND cars_max >= cars_min
  ),
  CONSTRAINT vehicle_series_length_range CHECK (unit_length_m > 5 AND unit_length_m < 500),
  CONSTRAINT vehicle_series_speed_range CHECK (max_speed_kmh BETWEEN 20 AND 400),
  CONSTRAINT vehicle_series_priority_known CHECK (priority IN ('P1', 'P2', 'P3')),
  CONSTRAINT vehicle_series_wikidata_qid_format CHECK (wikidata_qid ~ '^Q[1-9][0-9]*$'),
  CONSTRAINT vehicle_series_field_sources_object CHECK (jsonb_typeof(field_sources) = 'object'),
  CONSTRAINT vehicle_series_missing_object CHECK (jsonb_typeof(missing) = 'object'),
  CONSTRAINT vehicle_series_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX vehicle_series_wikidata_qid_idx ON vehicle_series (wikidata_qid);

CREATE TRIGGER vehicle_series_set_updated_at
  BEFORE UPDATE ON vehicle_series
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicle_series_operator (
  series_id text NOT NULL REFERENCES vehicle_series (series_id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operator (operator_id),
  source_id text NOT NULL REFERENCES source (source_id),
  CONSTRAINT vehicle_series_operator_pkey PRIMARY KEY (series_id, operator_id)
);

CREATE INDEX vehicle_series_operator_operator_idx ON vehicle_series_operator (operator_id);

CREATE TABLE livery (
  livery_id text PRIMARY KEY,
  name text NOT NULL,
  operator_id text REFERENCES operator (operator_id),
  valid_from date,
  valid_to date,
  source_id text NOT NULL REFERENCES source (source_id),
  missing jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT livery_id_format CHECK (livery_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT livery_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT livery_valid_order CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT livery_missing_object CHECK (jsonb_typeof(missing) = 'object'),
  CONSTRAINT livery_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX livery_operator_idx ON livery (operator_id);

CREATE TRIGGER livery_set_updated_at
  BEFORE UPDATE ON livery
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE livery_series (
  livery_id text NOT NULL REFERENCES livery (livery_id) ON DELETE CASCADE,
  series_id text NOT NULL REFERENCES vehicle_series (series_id) ON DELETE CASCADE,
  CONSTRAINT livery_series_pkey PRIMARY KEY (livery_id, series_id)
);

CREATE INDEX livery_series_series_idx ON livery_series (series_id);

CREATE TABLE livery_colour (
  livery_id text NOT NULL REFERENCES livery (livery_id) ON DELETE CASCADE,
  colour_index smallint NOT NULL,
  role text NOT NULL,
  name text NOT NULL,
  ral text,
  hex text,
  source_id text NOT NULL REFERENCES source (source_id),
  hex_source_id text REFERENCES source (source_id),
  CONSTRAINT livery_colour_pkey PRIMARY KEY (livery_id, colour_index),
  CONSTRAINT livery_colour_index_range CHECK (colour_index >= 0),
  CONSTRAINT livery_colour_role_known CHECK (
    role IN ('body', 'upper_body', 'lower_body', 'window_band', 'stripe', 'doors', 'accent')
  ),
  CONSTRAINT livery_colour_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT livery_colour_ral_format CHECK (ral ~ '^RAL [0-9]{4}$'),
  CONSTRAINT livery_colour_hex_format CHECK (hex ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT livery_colour_hex_sourced CHECK ((hex IS NULL) = (hex_source_id IS NULL))
);

CREATE TABLE line_colour (
  line_colour_id text PRIMARY KEY,
  upstream_operator text NOT NULL,
  line_name text NOT NULL,
  delfi_agency_key text,
  delfi_agency_name text,
  operator_id text REFERENCES operator (operator_id),
  background_hex text NOT NULL,
  text_hex text NOT NULL,
  border_hex text,
  shape text NOT NULL,
  line_wikidata_qid text,
  source_id text NOT NULL REFERENCES source (source_id),
  CONSTRAINT line_colour_id_format CHECK (line_colour_id ~ '^[a-z0-9][a-z0-9._-]{0,200}$'),
  CONSTRAINT line_colour_line_name_not_blank CHECK (btrim(line_name) <> ''),
  CONSTRAINT line_colour_background_hex_format CHECK (background_hex ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT line_colour_text_hex_format CHECK (text_hex ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT line_colour_border_hex_format CHECK (border_hex ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT line_colour_shape_known CHECK (
    shape IN ('circle', 'hexagon', 'rectangle', 'rectangle-rounded-corner', 'pill', 'trapezoid')
  ),
  CONSTRAINT line_colour_wikidata_qid_format CHECK (line_wikidata_qid ~ '^Q[1-9][0-9]*$')
);

CREATE INDEX line_colour_operator_line_idx ON line_colour (operator_id, line_name);
CREATE INDEX line_colour_agency_line_idx ON line_colour (delfi_agency_key, line_name);

CREATE TABLE catalog_version (
  content_sha256 text PRIMARY KEY,
  row_counts jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_version_sha256_hex CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT catalog_version_row_counts_object CHECK (jsonb_typeof(row_counts) = 'object')
);
