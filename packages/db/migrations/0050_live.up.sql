CREATE TABLE shape_registry (
  epoch integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL,
  CONSTRAINT shape_registry_epoch_positive CHECK (epoch >= 1),
  CONSTRAINT shape_registry_note_not_blank CHECK (btrim(note) <> '')
);

INSERT INTO shape_registry (epoch, note)
VALUES (1, 'shape_pattern.shape_no as WP-2.2 assigns it: an identity that is never reset or reused');

CREATE INDEX stop_event_forecast_observed_brin ON stop_event_forecast
  USING brin (observed_at) WITH (autosummarize = on);
