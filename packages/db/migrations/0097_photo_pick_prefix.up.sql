-- A pre-selected photo is recorded as pick:<id>. The constraint accepts the earlier prefix too, so a loader that
-- predates this migration still writes; the rows are renamed.
ALTER TABLE vehicle_photo DROP CONSTRAINT vehicle_photo_reviewer_format;

UPDATE vehicle_photo SET approved_by = 'pick:' || substr(approved_by, 7) WHERE approved_by LIKE 'agent:%';

ALTER TABLE vehicle_photo ADD CONSTRAINT vehicle_photo_reviewer_format
  CHECK (approved_by ~ '^(user|pick:[A-Za-z0-9.-]{1,40}|agent:[A-Za-z0-9.-]{1,40})$');
