CREATE FUNCTION shape_arcs_ordered(arcs double precision[], length_m double precision)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT arcs[1] >= 0
    AND arcs[cardinality(arcs)] <= length_m + 0.01
    AND coalesce(
      (SELECT bool_and(a <= b)
         FROM unnest(arcs[1:cardinality(arcs) - 1], arcs[2:cardinality(arcs)]) AS pairs (a, b)),
      true
    )
$$;

CREATE TABLE shape_pattern (
  shape_hash text PRIMARY KEY,
  shape_no integer GENERATED ALWAYS AS IDENTITY (MINVALUE 1 START WITH 1 NO CYCLE) NOT NULL,
  geom geometry(LineStringZM, 4326) NOT NULL,
  length_m double precision NOT NULL,
  stop_arc_m double precision[] NOT NULL,
  method text NOT NULL,
  qa_status text NOT NULL,
  tunnel_spans double precision[] NOT NULL DEFAULT '{}',
  bridge_spans double precision[] NOT NULL DEFAULT '{}',
  elevation_source text,
  source_note text NOT NULL,
  licence text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shape_pattern_shape_no_key UNIQUE (shape_no),
  CONSTRAINT shape_pattern_hash_hex CHECK (shape_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shape_pattern_stop_arcs_ordered CHECK (shape_arcs_ordered(stop_arc_m, length_m)),
  CONSTRAINT shape_pattern_method_known CHECK (method IN ('motis', 'pfaedle', 'straight')),
  CONSTRAINT shape_pattern_qa_status_known CHECK (
    qa_status IN ('pass', 'fail', 'unmeasured', 'low_quality')
  ),
  CONSTRAINT shape_pattern_straight_is_fallback CHECK (
    (method = 'straight') = (qa_status IN ('low_quality', 'unmeasured'))
  ),
  CONSTRAINT shape_pattern_length_positive CHECK (length_m > 0),
  CONSTRAINT shape_pattern_geom_valid CHECK (
    ST_NPoints(geom) >= 2
    AND ST_M(ST_StartPoint(geom)) = 0
    AND abs(ST_M(ST_EndPoint(geom)) - length_m) <= 0.01
  ),
  CONSTRAINT shape_pattern_stops_present CHECK (cardinality(stop_arc_m) >= 2),
  CONSTRAINT shape_pattern_spans_paired CHECK (
    cardinality(tunnel_spans) % 2 = 0 AND cardinality(bridge_spans) % 2 = 0
  ),
  CONSTRAINT shape_pattern_source_note_not_blank CHECK (btrim(source_note) <> ''),
  CONSTRAINT shape_pattern_licence_not_blank CHECK (btrim(licence) <> '')
);

CREATE INDEX shape_pattern_geom_idx ON shape_pattern USING gist (geom);
CREATE INDEX shape_pattern_qa_status_idx ON shape_pattern (qa_status);
