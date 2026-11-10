ALTER TABLE raw_object ADD COLUMN observed_at timestamptz;
UPDATE raw_object SET observed_at = fetched_at;
ALTER TABLE raw_object
  ADD CONSTRAINT raw_object_observed_at_present CHECK (observed_at IS NOT NULL);

CREATE FUNCTION raw_object_default_observed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.observed_at := coalesce(NEW.observed_at, NEW.fetched_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER raw_object_default_observed_at
BEFORE INSERT OR UPDATE ON raw_object
FOR EACH ROW EXECUTE FUNCTION raw_object_default_observed_at();

CREATE INDEX raw_object_source_observed_idx ON raw_object (source_id, observed_at DESC);
