CREATE TABLE trip_pattern_shape (
  feed_version_id integer NOT NULL,
  trip_pattern_id uuid NOT NULL,
  shape_hash text NOT NULL REFERENCES shape_pattern (shape_hash),
  group_method text NOT NULL,
  candidate_verdicts jsonb NOT NULL DEFAULT '{}',
  metrics jsonb NOT NULL DEFAULT '{}',
  review_flags text[] NOT NULL DEFAULT '{}',
  built_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_pattern_shape_pkey PRIMARY KEY (feed_version_id, trip_pattern_id),
  CONSTRAINT trip_pattern_shape_pattern_fkey FOREIGN KEY (feed_version_id, trip_pattern_id)
    REFERENCES trip_pattern (feed_version_id, trip_pattern_id) ON DELETE CASCADE,
  CONSTRAINT trip_pattern_shape_group_method_known CHECK (group_method IN ('motis', 'pfaedle'))
);

CREATE INDEX trip_pattern_shape_hash_idx ON trip_pattern_shape (shape_hash);
CREATE INDEX trip_pattern_shape_review_flags_idx ON trip_pattern_shape USING gin (review_flags);
