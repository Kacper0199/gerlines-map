CREATE TABLE source (
  source_id text PRIMARY KEY,
  name text NOT NULL,
  homepage_url text,
  licence text NOT NULL,
  licence_url text,
  attribution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_id_format CHECK (source_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT source_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT source_licence_not_blank CHECK (btrim(licence) <> ''),
  CONSTRAINT source_attribution_not_blank CHECK (btrim(attribution) <> '')
);

CREATE TABLE ingest_run (
  ingest_run_id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id text NOT NULL REFERENCES source (source_id),
  job text NOT NULL,
  app_version text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text,
  CONSTRAINT ingest_run_id_source_key UNIQUE (ingest_run_id, source_id),
  CONSTRAINT ingest_run_job_format CHECK (job ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT ingest_run_app_version_not_blank CHECK (btrim(app_version) <> ''),
  CONSTRAINT ingest_run_status_known CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT ingest_run_finished_when_done CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT ingest_run_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX ingest_run_source_started_idx ON ingest_run (source_id, started_at DESC);

CREATE TABLE raw_object (
  raw_object_id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id text NOT NULL REFERENCES source (source_id),
  ingest_run_id uuid NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL,
  bytes bigint NOT NULL,
  content_type text NOT NULL,
  content_encoding text,
  fetched_at timestamptz NOT NULL,
  http_status smallint,
  request_url text,
  CONSTRAINT raw_object_run_fkey FOREIGN KEY (ingest_run_id, source_id)
    REFERENCES ingest_run (ingest_run_id, source_id),
  CONSTRAINT raw_object_object_key_key UNIQUE (object_key),
  CONSTRAINT raw_object_object_key_relative CHECK (
    object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/=-]*$' AND object_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT raw_object_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT raw_object_bytes_non_negative CHECK (bytes >= 0),
  CONSTRAINT raw_object_content_type_not_blank CHECK (btrim(content_type) <> ''),
  CONSTRAINT raw_object_http_status_range CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT raw_object_request_url_no_userinfo CHECK (
    request_url !~* '^[a-z][a-z0-9+.-]*://[^/?#]*@'
  )
);

CREATE INDEX raw_object_source_fetched_idx ON raw_object (source_id, fetched_at DESC);
CREATE INDEX raw_object_ingest_run_idx ON raw_object (ingest_run_id);
CREATE INDEX raw_object_sha256_idx ON raw_object (sha256);
