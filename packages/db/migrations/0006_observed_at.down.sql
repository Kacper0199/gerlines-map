DROP INDEX raw_object_source_observed_idx;
DROP TRIGGER raw_object_default_observed_at ON raw_object;
DROP FUNCTION raw_object_default_observed_at();
ALTER TABLE raw_object DROP CONSTRAINT raw_object_observed_at_present;
ALTER TABLE raw_object DROP COLUMN observed_at;
