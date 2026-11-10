ALTER TABLE livery_colour
  DROP CONSTRAINT livery_colour_role_known,
  ADD CONSTRAINT livery_colour_role_known CHECK (
    role IN (
      'body', 'upper_body', 'lower_body', 'window_band', 'stripe', 'doors', 'accent',
      'mask', 'skirt', 'roof'
    )
  );
