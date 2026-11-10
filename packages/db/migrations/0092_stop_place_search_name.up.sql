CREATE TABLE stop_place_search_name (
  stop_place_id uuid NOT NULL REFERENCES stop_place (stop_place_id) ON DELETE CASCADE,
  name text NOT NULL,
  source_id text NOT NULL REFERENCES source (source_id),
  CONSTRAINT stop_place_search_name_pkey PRIMARY KEY (stop_place_id, name),
  CONSTRAINT stop_place_search_name_not_blank CHECK (btrim(name) <> '')
);

COMMENT ON TABLE stop_place_search_name IS
  'Other names a stop place is found by in search but never shown with (T-073): the timetable name where the '
  'display name differs, DB StaDa''s and the EVA copy''s station names.';
