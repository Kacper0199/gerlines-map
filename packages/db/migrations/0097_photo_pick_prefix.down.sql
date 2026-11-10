ALTER TABLE vehicle_photo DROP CONSTRAINT vehicle_photo_reviewer_format;

UPDATE vehicle_photo SET approved_by = 'agent:' || substr(approved_by, 6) WHERE approved_by LIKE 'pick:%';

ALTER TABLE vehicle_photo ADD CONSTRAINT vehicle_photo_reviewer_format
  CHECK (approved_by ~ '^(user|agent:[A-Za-z0-9.-]{1,40})$');
