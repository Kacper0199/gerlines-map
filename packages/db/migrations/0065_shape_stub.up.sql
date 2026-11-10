CREATE TABLE shape_stub (
  shape_no integer NOT NULL REFERENCES shape_pattern (shape_no) ON DELETE CASCADE,
  side text NOT NULL,
  geom geometry(LineStringZM, 4326) NOT NULL,
  length_m double precision NOT NULL,
  end_reason text NOT NULL,
  stub_version integer NOT NULL,
  source_note text NOT NULL,
  licence text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shape_stub_pkey PRIMARY KEY (shape_no, side),
  CONSTRAINT shape_stub_side_known CHECK (side IN ('before', 'after')),
  CONSTRAINT shape_stub_end_known CHECK (end_reason IN ('limit', 'buffer', 'no_continuation')),
  CONSTRAINT shape_stub_length_range CHECK (length_m > 0 AND length_m <= 400.5),
  CONSTRAINT shape_stub_geom_valid CHECK (
    ST_NPoints(geom) >= 2
    AND ST_IsValidTrajectory(geom)
    AND ST_M(ST_StartPoint(geom)) = 0
    AND abs(ST_M(ST_EndPoint(geom)) - length_m) <= 0.01
  ),
  CONSTRAINT shape_stub_version_positive CHECK (stub_version >= 1),
  CONSTRAINT shape_stub_source_note_not_blank CHECK (btrim(source_note) <> ''),
  CONSTRAINT shape_stub_licence_not_blank CHECK (btrim(licence) <> '')
);

COMMENT ON TABLE shape_stub IS
  'Track beyond a shape end (D-055): M is the distance from the shape''s end vertex, 0 at it';
