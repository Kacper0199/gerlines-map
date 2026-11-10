CREATE TABLE raw_object_segment (
  raw_object_id uuid PRIMARY KEY REFERENCES raw_object (raw_object_id) ON DELETE CASCADE,
  segment_key text NOT NULL,
  seq integer NOT NULL,
  base_seq integer,
  frame_offset bigint NOT NULL,
  frame_bytes bigint NOT NULL,
  format_version smallint NOT NULL,
  CONSTRAINT raw_object_segment_position_key UNIQUE (segment_key, seq),
  CONSTRAINT raw_object_segment_key_relative CHECK (
    segment_key ~ '^[A-Za-z0-9][A-Za-z0-9._/=-]*$' AND segment_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT raw_object_segment_seq_non_negative CHECK (seq >= 0),
  CONSTRAINT raw_object_segment_base_before CHECK (base_seq IS NULL OR (base_seq >= 0 AND base_seq < seq)),
  CONSTRAINT raw_object_segment_frame_range CHECK (frame_offset >= 0 AND frame_bytes > 0),
  CONSTRAINT raw_object_segment_format_version_positive CHECK (format_version >= 1)
);

CREATE TABLE recording_gap (
  source_id text NOT NULL REFERENCES source (source_id),
  gap_start timestamptz NOT NULL,
  gap_end timestamptz NOT NULL,
  CONSTRAINT recording_gap_pkey PRIMARY KEY (source_id, gap_start),
  CONSTRAINT recording_gap_order CHECK (gap_end > gap_start)
);
