DROP TABLE catalog_version;
DROP TABLE line_colour;
DROP TABLE livery_colour;
DROP TABLE livery_series;
DROP TABLE livery;
DROP TABLE vehicle_series_operator;
DROP TABLE vehicle_series;
DROP TABLE verbund;

ALTER TABLE operator_alias
  DROP CONSTRAINT operator_alias_valid_order,
  DROP COLUMN valid_to,
  DROP COLUMN valid_from;

DROP INDEX operator_wikidata_qid_idx;

ALTER TABLE operator
  DROP CONSTRAINT operator_valid_order,
  DROP CONSTRAINT operator_missing_object,
  DROP CONSTRAINT operator_field_sources_object,
  DROP CONSTRAINT operator_parents_array,
  DROP CONSTRAINT operator_website_url_http,
  DROP CONSTRAINT operator_wikidata_complete,
  DROP CONSTRAINT operator_wikidata_role_known,
  DROP CONSTRAINT operator_wikidata_qid_format,
  DROP CONSTRAINT operator_catalogued_has_brand,
  DROP CONSTRAINT operator_legal_name_not_blank,
  DROP CONSTRAINT operator_brand_name_not_blank,
  DROP COLUMN missing,
  DROP COLUMN field_sources,
  DROP COLUMN catalog_source_id,
  DROP COLUMN valid_to,
  DROP COLUMN valid_from,
  DROP COLUMN parents,
  DROP COLUMN website_url,
  DROP COLUMN wikidata_basis_source_id,
  DROP COLUMN wikidata_role,
  DROP COLUMN wikidata_qid,
  DROP COLUMN legal_name,
  DROP COLUMN brand_name;

ALTER TABLE category
  DROP CONSTRAINT category_names_sourced,
  DROP CONSTRAINT category_name_pl_not_blank,
  DROP CONSTRAINT category_name_de_not_blank,
  DROP COLUMN names_source_id,
  DROP COLUMN name_pl,
  DROP COLUMN name_de;
