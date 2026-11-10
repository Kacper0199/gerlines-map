CREATE TABLE id_map (
  source_id text NOT NULL REFERENCES source (source_id),
  entity text NOT NULL,
  source_key text NOT NULL,
  canonical_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT id_map_pkey PRIMARY KEY (source_id, entity, source_key),
  CONSTRAINT id_map_entity_known CHECK (entity IN ('stop_place', 'stop_point')),
  CONSTRAINT id_map_source_key_not_blank CHECK (btrim(source_key) <> ''),
  CONSTRAINT id_map_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX id_map_canonical_idx ON id_map (entity, canonical_id);
