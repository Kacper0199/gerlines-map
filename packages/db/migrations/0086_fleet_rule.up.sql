CREATE TABLE fleet_rule (
  rule_id text PRIMARY KEY,
  scope text NOT NULL,
  operator_id text REFERENCES operator (operator_id),
  category_code text REFERENCES category (category_code),
  line_keys text[] NOT NULL DEFAULT '{}',
  series_ids text[] NOT NULL DEFAULT '{}',
  model_id text,
  model_name text,
  units smallint,
  fleet_count integer,
  fleet_total integer,
  valid_from date,
  valid_to date,
  source_id text NOT NULL REFERENCES source (source_id),
  evidence text NOT NULL,
  CONSTRAINT fleet_rule_id_format CHECK (rule_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT fleet_rule_scope_known CHECK (scope IN ('line', 'operator', 'category')),
  CONSTRAINT fleet_rule_line_shape CHECK (
    scope <> 'line' OR (operator_id IS NOT NULL AND cardinality(line_keys) > 0
      AND cardinality(series_ids) > 0)
  ),
  CONSTRAINT fleet_rule_operator_shape CHECK (
    scope <> 'operator' OR (operator_id IS NOT NULL AND cardinality(series_ids) = 1
      AND fleet_count BETWEEN 1 AND fleet_total)
  ),
  CONSTRAINT fleet_rule_category_shape CHECK (
    scope <> 'category' OR (category_code IS NOT NULL AND model_id IS NOT NULL AND model_name IS NOT NULL)
  ),
  CONSTRAINT fleet_rule_units_range CHECK (units BETWEEN 1 AND 4),
  CONSTRAINT fleet_rule_dates_in_order CHECK (valid_to >= valid_from),
  CONSTRAINT fleet_rule_evidence_not_blank CHECK (btrim(evidence) <> '')
);

CREATE INDEX fleet_rule_operator_idx ON fleet_rule (operator_id, category_code);

COMMENT ON TABLE fleet_rule IS
  'Fleet rules of catalog/fleet-rules.yaml (layers L2 line, L3 operator, L4 category of the vehicle identity, '
  'ADR-0011), written by gerlines-catalog load. line_keys are upper case without spaces.';
