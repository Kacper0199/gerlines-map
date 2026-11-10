CREATE FUNCTION shape_registry_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('shape_registry'));
    IF EXISTS (SELECT 1 FROM shape_registry WHERE epoch >= NEW.epoch) THEN
      RAISE EXCEPTION 'shape_registry is append only: epoch % must be above every registered epoch', NEW.epoch
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'shape_registry is append only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER shape_registry_append_only
BEFORE INSERT OR UPDATE OR DELETE ON shape_registry
FOR EACH ROW EXECUTE FUNCTION shape_registry_append_only();

CREATE TRIGGER shape_registry_no_truncate
BEFORE TRUNCATE ON shape_registry
FOR EACH STATEMENT EXECUTE FUNCTION shape_registry_append_only();
