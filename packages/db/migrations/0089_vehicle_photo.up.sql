CREATE TABLE vehicle_photo (
  photo_id text PRIMARY KEY,
  series_id text NOT NULL REFERENCES vehicle_series (series_id) ON DELETE CASCADE,
  rank smallint NOT NULL,
  file_title text NOT NULL,
  page_url text NOT NULL,
  author text NOT NULL,
  author_url text,
  licence text NOT NULL,
  licence_name text NOT NULL,
  licence_url text,
  attribution_required boolean NOT NULL,
  focus_x real NOT NULL DEFAULT 0.5,
  focus_y real NOT NULL DEFAULT 0.5,
  mime text NOT NULL,
  small_width smallint NOT NULL,
  small_height smallint NOT NULL,
  small_sha256 text NOT NULL,
  large_width smallint NOT NULL,
  large_height smallint NOT NULL,
  large_sha256 text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  user_review text NOT NULL,
  CONSTRAINT vehicle_photo_id_format CHECK (photo_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT vehicle_photo_id_of_series CHECK (starts_with(photo_id, series_id || '-')),
  CONSTRAINT vehicle_photo_rank_range CHECK (rank BETWEEN 1 AND 2),
  CONSTRAINT vehicle_photo_series_rank_key UNIQUE (series_id, rank) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT vehicle_photo_file_title_format CHECK (file_title ~* '^File:[^|#<>{}\[\]]+\.(jpe?g|png)$'),
  CONSTRAINT vehicle_photo_page_url_commons CHECK (
    starts_with(page_url, 'https://commons.wikimedia.org/wiki/File:')
  ),
  CONSTRAINT vehicle_photo_links_https CHECK (
    (author_url IS NULL OR starts_with(author_url, 'https://'))
    AND (licence_url IS NULL OR starts_with(licence_url, 'https://'))
  ),
  CONSTRAINT vehicle_photo_author_not_blank CHECK (btrim(author) <> '' AND length(author) <= 200),
  CONSTRAINT vehicle_photo_licence_allowed CHECK (
    licence ~ '^(CC0-1\.0|LicenseRef-Public-Domain|CC-BY(-SA)?-[0-9]\.[0-9](-[A-Z]{2,3})?)$'
  ),
  CONSTRAINT vehicle_photo_cc_licence_linked CHECK (licence NOT LIKE 'CC-BY%' OR licence_url IS NOT NULL),
  CONSTRAINT vehicle_photo_focus_range CHECK (focus_x BETWEEN 0 AND 1 AND focus_y BETWEEN 0 AND 1),
  CONSTRAINT vehicle_photo_mime_known CHECK (mime IN ('image/jpeg', 'image/png')),
  CONSTRAINT vehicle_photo_small_size CHECK (small_width = 330 AND small_height BETWEEN 16 AND 4000),
  CONSTRAINT vehicle_photo_large_size CHECK (large_width = 960 AND large_height BETWEEN 16 AND 4000),
  CONSTRAINT vehicle_photo_sha256_format CHECK (
    small_sha256 ~ '^[0-9a-f]{64}$' AND large_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT vehicle_photo_reviewer_format CHECK (approved_by ~ '^(user|agent:[A-Za-z0-9.-]{1,40})$'),
  CONSTRAINT vehicle_photo_user_review_known CHECK (user_review IN ('pending', 'done'))
);

COMMENT ON TABLE vehicle_photo IS
  'Approved vehicle photos of catalog/photos.yaml (WP-6.3), written by gerlines-catalog photos load: one '
  'Commons file per row with its full credit and the SHA-256 of the local copies at 330 and 960 px in '
  'data/photos/<series_id>/<photo_id>-<width>.<ext>. Rank 1 is the photo the train card shows.';
