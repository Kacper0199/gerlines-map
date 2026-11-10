import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client.ts";
import { generateTypes } from "./codegen.ts";
import { redactDatabaseUrl, resolveDatabaseUrl, withDatabase } from "./config.ts";
import type { DB } from "./generated/database.ts";
import { defaultMigrationsDir, loadMigrations } from "./migrations.ts";
import { probeDatabase } from "./probe.ts";
import {
  getStatus,
  MigrationLockError,
  migrateDown,
  migrateDownAll,
  migrateUp,
  migrationLockKey,
} from "./runner.ts";

const serverUrl = resolveDatabaseUrl(process.env);
const required =
  process.env.GERLINES_DB_TESTS === "required" || ["1", "true"].includes(process.env.CI ?? "");

const reachable = await probeDatabase(serverUrl);
if (!reachable && required) {
  throw new Error(
    `database ${redactDatabaseUrl(serverUrl)} is not reachable and database tests are required`,
  );
}

const suiteName = reachable
  ? "schema migrations against a throwaway database"
  : `schema migrations (skipped: no database at ${redactDatabaseUrl(serverUrl)}, run pnpm infra:up)`;

const expectedTables = [
  "alert_message",
  "alert_scope",
  "catalog_version",
  "category",
  "event",
  "feed_version",
  "fleet_rule",
  "formation_observation",
  "geography_columns",
  "geometry_columns",
  "history_archive_day",
  "id_map",
  "ingest_run",
  "land",
  "land_area",
  "land_category_day",
  "land_category_hour",
  "land_day",
  "land_hour",
  "line_colour",
  "line_day",
  "livery",
  "livery_colour",
  "livery_series",
  "match_backlog",
  "operator",
  "operator_alias",
  "raw_object",
  "raw_object_segment",
  "recording_gap",
  "route",
  "rt_payload",
  "rt_rebuild_forecast",
  "rt_rebuild_job",
  "rt_rebuild_segment",
  "rt_rebuild_stop_event",
  "segment_day",
  "segment_obs",
  "service_calendar",
  "service_calendar_date",
  "shape_pattern",
  "shape_registry",
  "shape_stub",
  "source",
  "source_holder",
  "spatial_ref_sys",
  "stat_bin",
  "stat_segment",
  "stat_stop",
  "station_day",
  "station_hour",
  "stop_event",
  "stop_event_forecast",
  "stop_place",
  "stop_place_display_name",
  "stop_place_land",
  "stop_place_search_name",
  "stop_point",
  "stop_time",
  "train_day",
  "trip",
  "trip_instance",
  "trip_instance_source",
  "trip_pattern",
  "trip_pattern_shape",
  "trip_pattern_stop",
  "trip_product",
  "vehicle_photo",
  "vehicle_series",
  "vehicle_series_operator",
  "verbund",
];

const expectedConstraints = [
  "alert_message.alert_message_content_hash_hex",
  "alert_message.alert_message_first_raw_object_id_fkey",
  "alert_message.alert_message_key_not_blank",
  "alert_message.alert_message_pkey",
  "alert_message.alert_message_seen_order",
  "alert_message.alert_message_selector_count_range",
  "alert_message.alert_message_source_id_fkey",
  "alert_scope.alert_scope_first_raw_object_id_fkey",
  "alert_scope.alert_scope_message_fkey",
  "alert_scope.alert_scope_one_target",
  "alert_scope.alert_scope_seen_order",
  "alert_scope.alert_scope_stop_place_id_fkey",
  "alert_scope.alert_scope_trip_instance_id_fkey",
  "catalog_version.catalog_version_pkey",
  "catalog_version.catalog_version_row_counts_object",
  "catalog_version.catalog_version_sha256_hex",
  "category.category_code_format",
  "category.category_name_de_not_blank",
  "category.category_name_not_blank",
  "category.category_name_pl_not_blank",
  "category.category_names_source_id_fkey",
  "category.category_names_sourced",
  "category.category_pkey",
  "category.category_sort_order_key",
  "event.event_pkey",
  "event.event_raw_object_id_fkey",
  "event.event_source_id_fkey",
  "event.event_trip_instance_id_fkey",
  "event.event_type_known",
  "feed_version.feed_version_categories_present",
  "feed_version.feed_version_loaded_when_done",
  "feed_version.feed_version_pkey",
  "feed_version.feed_version_raw_object_id_fkey",
  "feed_version.feed_version_run_fkey",
  "feed_version.feed_version_sha256_hex",
  "feed_version.feed_version_source_id_fkey",
  "feed_version.feed_version_source_sha256_key",
  "feed_version.feed_version_status_known",
  "feed_version.feed_version_valid_order",
  "fleet_rule.fleet_rule_category_code_fkey",
  "fleet_rule.fleet_rule_category_shape",
  "fleet_rule.fleet_rule_dates_in_order",
  "fleet_rule.fleet_rule_evidence_not_blank",
  "fleet_rule.fleet_rule_id_format",
  "fleet_rule.fleet_rule_line_shape",
  "fleet_rule.fleet_rule_operator_id_fkey",
  "fleet_rule.fleet_rule_operator_shape",
  "fleet_rule.fleet_rule_pkey",
  "fleet_rule.fleet_rule_scope_known",
  "fleet_rule.fleet_rule_source_id_fkey",
  "fleet_rule.fleet_rule_units_range",
  "formation_observation.formation_observation_cars_range",
  "formation_observation.formation_observation_length_range",
  "formation_observation.formation_observation_pkey",
  "formation_observation.formation_observation_raw_sha256_hex",
  "formation_observation.formation_observation_series_id_format",
  "formation_observation.formation_observation_source_id_format",
  "formation_observation.formation_observation_train_number_format",
  "formation_observation.formation_observation_units_range",
  "history_archive_day.history_archive_day_legs_check",
  "history_archive_day.history_archive_day_pkey",
  "history_archive_day.history_archive_day_source_id_fkey",
  "history_archive_day.history_archive_day_stop_events_check",
  "id_map.id_map_entity_known",
  "id_map.id_map_pkey",
  "id_map.id_map_seen_order",
  "id_map.id_map_source_id_fkey",
  "id_map.id_map_source_key_not_blank",
  "ingest_run.ingest_run_app_version_not_blank",
  "ingest_run.ingest_run_finished_after_start",
  "ingest_run.ingest_run_finished_when_done",
  "ingest_run.ingest_run_id_source_key",
  "ingest_run.ingest_run_job_format",
  "ingest_run.ingest_run_pkey",
  "ingest_run.ingest_run_source_id_fkey",
  "ingest_run.ingest_run_status_known",
  "land.land_ars_format",
  "land.land_ars_key",
  "land.land_ars_present",
  "land.land_code_format",
  "land.land_display_order_key",
  "land.land_pkey",
  "land_area.land_area_edition_not_blank",
  "land_area.land_area_german",
  "land_area.land_area_land_code_fkey",
  "land_area.land_area_pkey",
  "land_area.land_area_sha256_hex",
  "land_area.land_area_valid",
  "line_colour.line_colour_background_hex_format",
  "line_colour.line_colour_border_hex_format",
  "line_colour.line_colour_id_format",
  "line_colour.line_colour_line_name_not_blank",
  "line_colour.line_colour_operator_id_fkey",
  "line_colour.line_colour_pkey",
  "line_colour.line_colour_shape_known",
  "line_colour.line_colour_source_id_fkey",
  "line_colour.line_colour_text_hex_format",
  "line_colour.line_colour_wikidata_qid_format",
  "livery.livery_id_format",
  "livery.livery_missing_object",
  "livery.livery_name_not_blank",
  "livery.livery_operator_id_fkey",
  "livery.livery_pkey",
  "livery.livery_source_id_fkey",
  "livery.livery_updated_after_created",
  "livery.livery_valid_order",
  "livery_colour.livery_colour_hex_format",
  "livery_colour.livery_colour_hex_source_id_fkey",
  "livery_colour.livery_colour_hex_sourced",
  "livery_colour.livery_colour_index_range",
  "livery_colour.livery_colour_livery_id_fkey",
  "livery_colour.livery_colour_name_not_blank",
  "livery_colour.livery_colour_pkey",
  "livery_colour.livery_colour_ral_format",
  "livery_colour.livery_colour_role_known",
  "livery_colour.livery_colour_source_id_fkey",
  "livery_series.livery_series_livery_id_fkey",
  "livery_series.livery_series_pkey",
  "livery_series.livery_series_series_id_fkey",
  "match_backlog.match_backlog_entity_key_not_blank",
  "match_backlog.match_backlog_first_raw_object_id_fkey",
  "match_backlog.match_backlog_pkey",
  "match_backlog.match_backlog_reason_format",
  "match_backlog.match_backlog_seen_order",
  "match_backlog.match_backlog_source_id_fkey",
  "operator.operator_brand_name_not_blank",
  "operator.operator_catalog_source_id_fkey",
  "operator.operator_catalogued_has_brand",
  "operator.operator_country_code_format",
  "operator.operator_field_sources_object",
  "operator.operator_id_format",
  "operator.operator_legal_name_not_blank",
  "operator.operator_missing_object",
  "operator.operator_name_not_blank",
  "operator.operator_name_source_id_fkey",
  "operator.operator_parents_array",
  "operator.operator_pkey",
  "operator.operator_updated_after_created",
  "operator.operator_valid_order",
  "operator.operator_website_url_http",
  "operator.operator_wikidata_basis_source_id_fkey",
  "operator.operator_wikidata_complete",
  "operator.operator_wikidata_qid_format",
  "operator.operator_wikidata_role_known",
  "operator_alias.operator_alias_not_blank",
  "operator_alias.operator_alias_operator_id_fkey",
  "operator_alias.operator_alias_pkey",
  "operator_alias.operator_alias_seen_order",
  "operator_alias.operator_alias_source_id_fkey",
  "operator_alias.operator_alias_valid_order",
  "raw_object.raw_object_bytes_non_negative",
  "raw_object.raw_object_content_type_not_blank",
  "raw_object.raw_object_http_status_range",
  "raw_object.raw_object_object_key_key",
  "raw_object.raw_object_object_key_relative",
  "raw_object.raw_object_observed_at_present",
  "raw_object.raw_object_pkey",
  "raw_object.raw_object_request_url_no_userinfo",
  "raw_object.raw_object_run_fkey",
  "raw_object.raw_object_sha256_hex",
  "raw_object.raw_object_source_id_fkey",
  "raw_object_segment.raw_object_segment_base_before",
  "raw_object_segment.raw_object_segment_format_version_positive",
  "raw_object_segment.raw_object_segment_frame_range",
  "raw_object_segment.raw_object_segment_key_relative",
  "raw_object_segment.raw_object_segment_pkey",
  "raw_object_segment.raw_object_segment_position_key",
  "raw_object_segment.raw_object_segment_raw_object_id_fkey",
  "raw_object_segment.raw_object_segment_seq_non_negative",
  "recording_gap.recording_gap_order",
  "recording_gap.recording_gap_pkey",
  "recording_gap.recording_gap_source_id_fkey",
  "route.route_category_code_fkey",
  "route.route_category_rule_not_blank",
  "route.route_feed_version_id_fkey",
  "route.route_key_not_blank",
  "route.route_operator_id_fkey",
  "route.route_pkey",
  "rt_payload.rt_payload_fold_source_id_fkey",
  "rt_payload.rt_payload_pkey",
  "rt_payload.rt_payload_raw_object_id_fkey",
  "rt_payload.rt_payload_source_id_fkey",
  "rt_rebuild_forecast.rt_rebuild_forecast_pkey",
  "rt_rebuild_job.rt_rebuild_job_pkey",
  "rt_rebuild_job.rt_rebuild_job_single",
  "rt_rebuild_segment.rt_rebuild_segment_pkey",
  "rt_rebuild_stop_event.rt_rebuild_stop_event_pkey",
  "segment_obs.segment_obs_from_stop_place_id_fkey",
  "segment_obs.segment_obs_gain",
  "segment_obs.segment_obs_leg_order",
  "segment_obs.segment_obs_pkey",
  "segment_obs.segment_obs_raw_object_id_fkey",
  "segment_obs.segment_obs_source_id_fkey",
  "segment_obs.segment_obs_to_stop_place_id_fkey",
  "segment_obs.segment_obs_trip_instance_id_fkey",
  "service_calendar.service_calendar_date_order",
  "service_calendar.service_calendar_dates_together",
  "service_calendar.service_calendar_feed_version_id_fkey",
  "service_calendar.service_calendar_pkey",
  "service_calendar.service_calendar_weekdays_range",
  "service_calendar_date.service_calendar_date_exception_known",
  "service_calendar_date.service_calendar_date_pkey",
  "service_calendar_date.service_calendar_date_service_fkey",
  "shape_pattern.shape_pattern_geom_valid",
  "shape_pattern.shape_pattern_hash_hex",
  "shape_pattern.shape_pattern_length_positive",
  "shape_pattern.shape_pattern_licence_not_blank",
  "shape_pattern.shape_pattern_method_known",
  "shape_pattern.shape_pattern_pkey",
  "shape_pattern.shape_pattern_qa_status_known",
  "shape_pattern.shape_pattern_shape_no_key",
  "shape_pattern.shape_pattern_source_note_not_blank",
  "shape_pattern.shape_pattern_spans_paired",
  "shape_pattern.shape_pattern_stop_arcs_ordered",
  "shape_pattern.shape_pattern_stops_present",
  "shape_pattern.shape_pattern_straight_is_fallback",
  "shape_registry.shape_registry_epoch_positive",
  "shape_registry.shape_registry_note_not_blank",
  "shape_registry.shape_registry_pkey",
  "shape_stub.shape_stub_end_known",
  "shape_stub.shape_stub_geom_valid",
  "shape_stub.shape_stub_length_range",
  "shape_stub.shape_stub_licence_not_blank",
  "shape_stub.shape_stub_pkey",
  "shape_stub.shape_stub_shape_no_fkey",
  "shape_stub.shape_stub_side_known",
  "shape_stub.shape_stub_source_note_not_blank",
  "shape_stub.shape_stub_version_positive",
  "source.source_attribution_not_blank",
  "source.source_id_format",
  "source.source_licence_not_blank",
  "source.source_name_not_blank",
  "source.source_pkey",
  "source_holder.source_holder_name_not_blank",
  "source_holder.source_holder_pkey",
  "source_holder.source_holder_position_range",
  "source_holder.source_holder_role_known",
  "source_holder.source_holder_source_id_format",
  "source_holder.source_holder_url_https",
  "stat_bin.stat_bin_bounds",
  "stat_bin.stat_bin_kind_known",
  "stat_bin.stat_bin_order",
  "stat_bin.stat_bin_pkey",
  "stat_bin.stat_bin_unit_rule",
  "stop_event.stop_event_final_quality_known",
  "stop_event.stop_event_final_quality_present",
  "stop_event.stop_event_pkey",
  "stop_event.stop_event_prediction_kind_known",
  "stop_event.stop_event_raw_object_id_fkey",
  "stop_event.stop_event_source_id_fkey",
  "stop_event.stop_event_stop_index_range",
  "stop_event.stop_event_stop_place_id_fkey",
  "stop_event.stop_event_trip_instance_id_fkey",
  "stop_event_forecast.stop_event_forecast_pkey",
  "stop_event_forecast.stop_event_forecast_raw_object_id_fkey",
  "stop_event_forecast.stop_event_forecast_source_id_fkey",
  "stop_event_forecast.stop_event_forecast_stop_index_range",
  "stop_event_forecast.stop_event_forecast_trip_instance_id_fkey",
  "stop_place.stop_place_country_code_format",
  "stop_place.stop_place_dhid_format",
  "stop_place.stop_place_dhid_key",
  "stop_place.stop_place_eva_range",
  "stop_place.stop_place_geom_lon_lat",
  "stop_place.stop_place_geom_source_id_fkey",
  "stop_place.stop_place_geom_source_present",
  "stop_place.stop_place_ifopt_format",
  "stop_place.stop_place_ifopt_key",
  "stop_place.stop_place_name_not_blank",
  "stop_place.stop_place_name_source_id_fkey",
  "stop_place.stop_place_pkey",
  "stop_place.stop_place_uic_range",
  "stop_place.stop_place_updated_after_created",
  "stop_place_display_name.stop_place_display_name_not_blank",
  "stop_place_display_name.stop_place_display_name_pkey",
  "stop_place_display_name.stop_place_display_name_rule_format",
  "stop_place_display_name.stop_place_display_name_source_id_fkey",
  "stop_place_display_name.stop_place_display_name_stop_place_id_fkey",
  "stop_place_land.stop_place_land_edition_present",
  "stop_place_land.stop_place_land_land_code_fkey",
  "stop_place_land.stop_place_land_method_known",
  "stop_place_land.stop_place_land_method_rule",
  "stop_place_land.stop_place_land_pkey",
  "stop_place_land.stop_place_land_stop_place_id_fkey",
  "stop_place_search_name.stop_place_search_name_not_blank",
  "stop_place_search_name.stop_place_search_name_pkey",
  "stop_place_search_name.stop_place_search_name_source_id_fkey",
  "stop_place_search_name.stop_place_search_name_stop_place_id_fkey",
  "stop_point.stop_point_dhid_format",
  "stop_point.stop_point_dhid_key",
  "stop_point.stop_point_geom_lon_lat",
  "stop_point.stop_point_geom_source_id_fkey",
  "stop_point.stop_point_geom_source_present",
  "stop_point.stop_point_ifopt_format",
  "stop_point.stop_point_ifopt_key",
  "stop_point.stop_point_name_not_blank",
  "stop_point.stop_point_name_source_id_fkey",
  "stop_point.stop_point_name_source_present",
  "stop_point.stop_point_pkey",
  "stop_point.stop_point_platform_code_not_blank",
  "stop_point.stop_point_stop_place_id_fkey",
  "stop_point.stop_point_updated_after_created",
  "stop_time.stop_time_drop_off_known",
  "stop_time.stop_time_index_range",
  "stop_time.stop_time_order",
  "stop_time.stop_time_pickup_known",
  "stop_time.stop_time_pkey",
  "stop_time.stop_time_trip_fkey",
  "trip.trip_category_code_fkey",
  "trip.trip_direction_known",
  "trip.trip_pattern_fkey",
  "trip.trip_pkey",
  "trip.trip_route_fkey",
  "trip.trip_service_fkey",
  "trip.trip_time_order",
  "trip_instance.trip_instance_backfill_unlinked",
  "trip_instance.trip_instance_category_code_fkey",
  "trip_instance.trip_instance_feed_version_id_fkey",
  "trip_instance.trip_instance_first_raw_object_id_fkey",
  "trip_instance.trip_instance_first_source_id_fkey",
  "trip_instance.trip_instance_operator_id_fkey",
  "trip_instance.trip_instance_origin_stop_place_id_fkey",
  "trip_instance.trip_instance_pkey",
  "trip_instance.trip_instance_static_or_added",
  "trip_instance.trip_instance_train_number_not_blank",
  "trip_instance_source.trip_instance_source_last_raw_object_id_fkey",
  "trip_instance_source.trip_instance_source_pkey",
  "trip_instance_source.trip_instance_source_seen_order",
  "trip_instance_source.trip_instance_source_source_id_fkey",
  "trip_instance_source.trip_instance_source_trip_instance_id_fkey",
  "trip_pattern.trip_pattern_pkey",
  "trip_pattern.trip_pattern_route_fkey",
  "trip_pattern.trip_pattern_stop_count_min",
  "trip_pattern_shape.trip_pattern_shape_group_method_known",
  "trip_pattern_shape.trip_pattern_shape_pattern_fkey",
  "trip_pattern_shape.trip_pattern_shape_pkey",
  "trip_pattern_shape.trip_pattern_shape_shape_hash_fkey",
  "trip_pattern_stop.trip_pattern_stop_index_range",
  "trip_pattern_stop.trip_pattern_stop_pattern_fkey",
  "trip_pattern_stop.trip_pattern_stop_pkey",
  "trip_pattern_stop.trip_pattern_stop_stop_point_id_fkey",
  "trip_product.trip_product_format",
  "trip_product.trip_product_pkey",
  "trip_product.trip_product_rule_format",
  "trip_product.trip_product_source_id_fkey",
  "trip_product.trip_product_trip_fkey",
  "vehicle_photo.vehicle_photo_author_not_blank",
  "vehicle_photo.vehicle_photo_cc_licence_linked",
  "vehicle_photo.vehicle_photo_file_title_format",
  "vehicle_photo.vehicle_photo_focus_range",
  "vehicle_photo.vehicle_photo_id_format",
  "vehicle_photo.vehicle_photo_id_of_series",
  "vehicle_photo.vehicle_photo_large_size",
  "vehicle_photo.vehicle_photo_licence_allowed",
  "vehicle_photo.vehicle_photo_links_https",
  "vehicle_photo.vehicle_photo_mime_known",
  "vehicle_photo.vehicle_photo_page_url_commons",
  "vehicle_photo.vehicle_photo_pkey",
  "vehicle_photo.vehicle_photo_rank_range",
  "vehicle_photo.vehicle_photo_reviewer_format",
  "vehicle_photo.vehicle_photo_series_id_fkey",
  "vehicle_photo.vehicle_photo_series_rank_key",
  "vehicle_photo.vehicle_photo_sha256_format",
  "vehicle_photo.vehicle_photo_small_size",
  "vehicle_photo.vehicle_photo_user_review_known",
  "vehicle_series.vehicle_series_cars_range",
  "vehicle_series.vehicle_series_field_sources_object",
  "vehicle_series.vehicle_series_id_format",
  "vehicle_series.vehicle_series_length_range",
  "vehicle_series.vehicle_series_missing_object",
  "vehicle_series.vehicle_series_name_not_blank",
  "vehicle_series.vehicle_series_pkey",
  "vehicle_series.vehicle_series_priority_known",
  "vehicle_series.vehicle_series_source_id_fkey",
  "vehicle_series.vehicle_series_speed_range",
  "vehicle_series.vehicle_series_traction_known",
  "vehicle_series.vehicle_series_unit_kind_known",
  "vehicle_series.vehicle_series_updated_after_created",
  "vehicle_series.vehicle_series_wikidata_qid_format",
  "vehicle_series_operator.vehicle_series_operator_operator_id_fkey",
  "vehicle_series_operator.vehicle_series_operator_pkey",
  "vehicle_series_operator.vehicle_series_operator_series_id_fkey",
  "vehicle_series_operator.vehicle_series_operator_source_id_fkey",
  "verbund.verbund_abbr_not_blank",
  "verbund.verbund_field_sources_object",
  "verbund.verbund_id_format",
  "verbund.verbund_laender_known",
  "verbund.verbund_missing_object",
  "verbund.verbund_name_not_blank",
  "verbund.verbund_pkey",
  "verbund.verbund_source_id_fkey",
  "verbund.verbund_updated_after_created",
  "verbund.verbund_website_url_http",
  "verbund.verbund_wikidata_qid_format",
];

const expectedIndexes = [
  "alert_message.alert_message_pkey (source_id, alert_key, content_hash)",
  "alert_scope.alert_scope_place_idx (stop_place_id) WHERE (stop_place_id IS NOT NULL)",
  "alert_scope.alert_scope_place_key (source_id, alert_key, content_hash, stop_place_id) WHERE (stop_place_id IS NOT NULL)",
  "alert_scope.alert_scope_trip_idx (trip_instance_id) WHERE (trip_instance_id IS NOT NULL)",
  "alert_scope.alert_scope_trip_key (source_id, alert_key, content_hash, trip_instance_id) WHERE (trip_instance_id IS NOT NULL)",
  "catalog_version.catalog_version_pkey (content_sha256)",
  "category.category_pkey (category_code)",
  "category.category_sort_order_key (sort_order)",
  "event.event_instance_idx (trip_instance_id, occurred_at)",
  "event.event_pkey (event_id, occurred_at)",
  "feed_version.feed_version_pkey (feed_version_id)",
  "feed_version.feed_version_source_published_idx (source_id, published_on DESC)",
  "feed_version.feed_version_source_sha256_key (source_id, sha256)",
  "fleet_rule.fleet_rule_operator_idx (operator_id, category_code)",
  "fleet_rule.fleet_rule_pkey (rule_id)",
  "formation_observation.formation_observation_day_idx (service_date)",
  "formation_observation.formation_observation_pkey (source_id, service_date, train_number)",
  "formation_observation.formation_observation_train_idx (train_number, service_date DESC)",
  "history_archive_day.history_archive_day_pkey (service_date)",
  "id_map.id_map_canonical_idx (entity, canonical_id)",
  "id_map.id_map_pkey (source_id, entity, source_key)",
  "ingest_run.ingest_run_id_source_key (ingest_run_id, source_id)",
  "ingest_run.ingest_run_pkey (ingest_run_id)",
  "ingest_run.ingest_run_source_started_idx (source_id, started_at DESC)",
  "land.land_ars_key (ars)",
  "land.land_display_order_key (display_order)",
  "land.land_pkey (land_code)",
  "land_area.land_area_geom_idx USING gist (geom)",
  "land_area.land_area_pkey (land_code)",
  "line_colour.line_colour_agency_line_idx (delfi_agency_key, line_name)",
  "line_colour.line_colour_operator_line_idx (operator_id, line_name)",
  "line_colour.line_colour_pkey (line_colour_id)",
  "livery.livery_operator_idx (operator_id)",
  "livery.livery_pkey (livery_id)",
  "livery_colour.livery_colour_pkey (livery_id, colour_index)",
  "livery_series.livery_series_pkey (livery_id, series_id)",
  "livery_series.livery_series_series_idx (series_id)",
  "match_backlog.match_backlog_pkey (source_id, entity_key, service_date, reason)",
  "match_backlog.match_backlog_reason_idx (source_id, reason, service_date)",
  "operator.operator_pkey (operator_id)",
  "operator.operator_wikidata_qid_idx (wikidata_qid)",
  "operator_alias.operator_alias_operator_idx (operator_id)",
  "operator_alias.operator_alias_pkey (source_id, alias)",
  "raw_object.raw_object_ingest_run_idx (ingest_run_id)",
  "raw_object.raw_object_object_key_key (object_key)",
  "raw_object.raw_object_pkey (raw_object_id)",
  "raw_object.raw_object_sha256_idx (sha256)",
  "raw_object.raw_object_source_fetched_idx (source_id, fetched_at DESC)",
  "raw_object.raw_object_source_observed_idx (source_id, observed_at DESC)",
  "raw_object_segment.raw_object_segment_pkey (raw_object_id)",
  "raw_object_segment.raw_object_segment_position_key (segment_key, seq)",
  "recording_gap.recording_gap_pkey (source_id, gap_start)",
  "route.route_operator_idx (operator_id)",
  "route.route_pkey (feed_version_id, route_key)",
  "rt_payload.rt_payload_observed_idx (observed_at)",
  "rt_payload.rt_payload_pkey (raw_object_id)",
  "rt_payload.rt_payload_processed_idx (processed_at)",
  "rt_payload.rt_payload_source_observed_idx (source_id, observed_at)",
  "rt_rebuild_forecast.rt_rebuild_forecast_pkey (trip_instance_id, stop_index, source_id, observed_at)",
  "rt_rebuild_job.rt_rebuild_job_pkey (singleton)",
  "rt_rebuild_segment.rt_rebuild_segment_pkey (service_date, trip_instance_id, from_index, source_id)",
  "rt_rebuild_stop_event.rt_rebuild_stop_event_pkey (service_date, trip_instance_id, stop_index, source_id)",
  "segment_obs.segment_obs_pkey (service_date, trip_instance_id, from_index, source_id)",
  "segment_obs.segment_obs_places_idx (from_stop_place_id, to_stop_place_id, service_date)",
  "service_calendar.service_calendar_pkey (feed_version_id, service_key)",
  "service_calendar_date.service_calendar_date_pkey (feed_version_id, service_key, service_date)",
  "shape_pattern.shape_pattern_geom_idx USING gist (geom)",
  "shape_pattern.shape_pattern_pkey (shape_hash)",
  "shape_pattern.shape_pattern_qa_status_idx (qa_status)",
  "shape_pattern.shape_pattern_shape_no_key (shape_no)",
  "shape_registry.shape_registry_pkey (epoch)",
  "shape_stub.shape_stub_pkey (shape_no, side)",
  "source.source_pkey (source_id)",
  'source_holder.source_holder_pkey (source_id, "position")',
  "stat_bin.stat_bin_pkey (kind, bin)",
  "stop_event.stop_event_instance_idx (trip_instance_id, stop_index)",
  "stop_event.stop_event_pkey (service_date, trip_instance_id, stop_index, source_id)",
  "stop_event_forecast.stop_event_forecast_observed_brin USING brin (observed_at) WITH (autosummarize='on')",
  "stop_event_forecast.stop_event_forecast_pkey (trip_instance_id, stop_index, source_id, observed_at)",
  "stop_place.stop_place_dhid_key (dhid)",
  "stop_place.stop_place_eva_idx (eva)",
  "stop_place.stop_place_geom_idx USING gist (geom)",
  "stop_place.stop_place_ifopt_key (ifopt)",
  "stop_place.stop_place_pkey (stop_place_id)",
  "stop_place.stop_place_uic_idx (uic)",
  "stop_place_display_name.stop_place_display_name_pkey (stop_place_id)",
  "stop_place_land.stop_place_land_land_idx (land_code)",
  "stop_place_land.stop_place_land_pkey (stop_place_id)",
  "stop_place_search_name.stop_place_search_name_pkey (stop_place_id, name)",
  "stop_point.stop_point_dhid_key (dhid)",
  "stop_point.stop_point_geom_idx USING gist (geom)",
  "stop_point.stop_point_ifopt_key (ifopt)",
  "stop_point.stop_point_pkey (stop_point_id)",
  "stop_point.stop_point_stop_place_idx (stop_place_id)",
  "stop_time.stop_time_pkey (feed_version_id, trip_key, stop_index)",
  "trip.trip_pattern_idx (feed_version_id, trip_pattern_id)",
  "trip.trip_pkey (feed_version_id, trip_key)",
  "trip.trip_route_idx (feed_version_id, route_key)",
  "trip.trip_short_name_idx (feed_version_id, short_name)",
  "trip_instance.trip_instance_pkey (trip_instance_id)",
  "trip_instance.trip_instance_service_date_idx (service_date)",
  "trip_instance.trip_instance_trip_idx (feed_version_id, trip_key)",
  "trip_instance_source.trip_instance_source_pkey (trip_instance_id, source_id)",
  "trip_pattern.trip_pattern_pkey (feed_version_id, trip_pattern_id)",
  "trip_pattern.trip_pattern_route_idx (feed_version_id, route_key)",
  "trip_pattern_shape.trip_pattern_shape_hash_idx (shape_hash)",
  "trip_pattern_shape.trip_pattern_shape_pkey (feed_version_id, trip_pattern_id)",
  "trip_pattern_shape.trip_pattern_shape_review_flags_idx USING gin (review_flags)",
  "trip_pattern_stop.trip_pattern_stop_pkey (feed_version_id, trip_pattern_id, stop_index)",
  "trip_pattern_stop.trip_pattern_stop_point_idx (stop_point_id)",
  "trip_product.trip_product_pkey (feed_version_id, trip_key)",
  "vehicle_photo.vehicle_photo_pkey (photo_id)",
  "vehicle_photo.vehicle_photo_series_rank_key (series_id, rank)",
  "vehicle_series.vehicle_series_pkey (series_id)",
  "vehicle_series.vehicle_series_wikidata_qid_idx (wikidata_qid)",
  "vehicle_series_operator.vehicle_series_operator_operator_idx (operator_id)",
  "vehicle_series_operator.vehicle_series_operator_pkey (series_id, operator_id)",
  "verbund.verbund_laender_idx USING gin (laender)",
  "verbund.verbund_pkey (verbund_id)",
];

const sha = "a".repeat(64);

const migrations = await loadMigrations();
const versions = migrations.map((migration) => migration.version);
const probeVersion = (versions.at(-1) ?? 0) + 1;
const probeFile = (name: string, direction: "up" | "down") =>
  `${String(probeVersion).padStart(4, "0")}_${name}.${direction}.sql`;

describe.skipIf(!reachable)(suiteName, () => {
  const databaseName = `gerlines_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = withDatabase(serverUrl, databaseName);
  const runner = { databaseUrl, lockWaitMs: 1000 };
  let admin: pg.Client;
  let db: Kysely<DB>;

  async function rows<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return (await client.query<T>(text)).rows;
    } finally {
      await client.end();
    }
  }

  async function publicTables(): Promise<string[]> {
    const result = await rows<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return result.map((row) => row.name);
  }

  async function extensions(): Promise<Record<string, string>> {
    const result = await rows<{ extname: string; extversion: string }>(
      "SELECT extname, extversion FROM pg_extension ORDER BY extname",
    );
    return Object.fromEntries(result.map((row) => [row.extname, row.extversion]));
  }

  async function appliedVersions(): Promise<number[]> {
    const status = await getStatus(runner);
    return status.filter((row) => row.state === "applied").map((row) => row.version);
  }

  async function seedSourceAndRun(sourceId: string): Promise<string> {
    await db
      .insertInto("source")
      .values({
        source_id: sourceId,
        name: `Test source ${sourceId}`,
        licence: "CC-BY-4.0",
        attribution: "Test attribution",
      })
      .execute();
    const run = await db
      .insertInto("ingest_run")
      .values({ source_id: sourceId, job: "poll", app_version: "0.0.0-test" })
      .returning("ingest_run_id")
      .executeTakeFirstOrThrow();
    return run.ingest_run_id;
  }

  function rawObject(sourceId: string, ingestRunId: string, objectKey: string) {
    return {
      source_id: sourceId,
      ingest_run_id: ingestRunId,
      object_key: objectKey,
      sha256: sha,
      bytes: 1234,
      content_type: "application/json",
      fetched_at: new Date("2026-10-24T00:00:00Z"),
      http_status: 200,
    };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(databaseName)} TEMPLATE template0`);
    db = createDatabase({ databaseUrl, applicationName: "gerlines-db-test", maxConnections: 2 });
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(databaseName)} WITH (FORCE)`,
      );
      await admin.end();
    }
  });

  it("starts from an empty database with every migration pending", async () => {
    expect(await publicTables()).toEqual([]);
    expect(await extensions()).toEqual({ plpgsql: "1.0" });
    expect(await appliedVersions()).toEqual([]);
  });

  it("migrates all the way up in version order", async () => {
    const applied = await migrateUp(runner);
    expect(applied.map((m) => `${m.version} ${m.name}`)).toEqual(
      migrations.map((m) => `${m.version} ${m.name}`),
    );
    expect(applied.map((m) => `${m.version} ${m.name}`)).toEqual(
      expect.arrayContaining([
        "1 extensions",
        "4 id_map",
        "10 catalog",
        "11 timetable",
        "30 realtime",
      ]),
    );
    expect(await appliedVersions()).toEqual(versions);
    expect(await migrateUp(runner)).toEqual([]);
  });

  it("records checksums and durations in the migration table", async () => {
    const history = await rows<{ version: number; up_checksum: string; duration_ms: number }>(
      "SELECT version, up_checksum, duration_ms FROM gerlines_meta.migration ORDER BY version",
    );
    expect(history.map((row) => row.version)).toEqual(versions);
    for (const row of history) {
      expect(row.up_checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("installs TimescaleDB 2.31 and PostGIS 3.6", async () => {
    const installed = await extensions();
    expect(installed.timescaledb).toMatch(/^2\.31\./);
    expect(installed.postgis).toMatch(/^3\.6\./);
  });

  it("runs the Timescale License build that compression and continuous aggregates need", async () => {
    const [setting] = await rows<{ license: string }>(
      "SELECT current_setting('timescaledb.license') AS license",
    );
    expect(setting?.license).toBe("timescale");
  });

  it("creates exactly the expected tables and the realtime hypertables", async () => {
    expect(await publicTables()).toEqual(expectedTables);
    const hypertables = await rows<{ name: string }>(
      "SELECT hypertable_name AS name FROM timescaledb_information.hypertables ORDER BY 1",
    );
    expect(hypertables.map((row) => row.name)).toEqual([
      "event",
      "segment_obs",
      "stop_event",
      "stop_event_forecast",
    ]);
  });

  it("moves realtime chunks to the columnstore two days after their range, in day chunks", async () => {
    const policies = await rows<{ name: string; after: string }>(
      `SELECT hypertable_name AS name, config->>'compress_after' AS after
         FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'
          AND hypertable_name IN ('event', 'segment_obs', 'stop_event', 'stop_event_forecast') ORDER BY 1`,
    );
    expect(policies).toEqual(
      ["event", "segment_obs", "stop_event", "stop_event_forecast"].map((name) => ({
        name,
        after: "2 days",
      })),
    );
    const intervals = await rows<{ name: string; interval: string }>(
      `SELECT hypertable_name AS name, time_interval::text AS interval
         FROM timescaledb_information.dimensions WHERE hypertable_name IN ('event', 'segment_obs', 'stop_event', 'stop_event_forecast') ORDER BY 1`,
    );
    expect(intervals.map((row) => row.interval)).toEqual(["1 day", "1 day", "1 day", "1 day"]);
    const segmentBy = await rows<{ name: string; columns: string }>(
      `SELECT hypertable_name AS name, string_agg(attname, ',' ORDER BY attname) AS columns
         FROM timescaledb_information.compression_settings
        WHERE segmentby_column_index IS NOT NULL
          AND hypertable_name IN ('event', 'segment_obs', 'stop_event', 'stop_event_forecast')
        GROUP BY 1 ORDER BY 1`,
    );
    expect(segmentBy.map((row) => row.columns)).toEqual([
      "source_id",
      "source_id",
      "source_id",
      "source_id",
    ]);
  });

  it("moves the rollups to the columnstore: level 1 in day chunks after 3 days, segment_day after 35, the rest after 14", async () => {
    const policies = await rows<{ name: string; after: string }>(
      `SELECT hypertable_name AS name, config->>'compress_after' AS after
         FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'
          AND hypertable_name NOT IN ('event', 'segment_obs', 'stop_event', 'stop_event_forecast') ORDER BY 1`,
    );
    expect(policies).toEqual([
      { name: "land_category_day", after: "14 days" },
      { name: "land_category_hour", after: "14 days" },
      { name: "line_day", after: "14 days" },
      { name: "segment_day", after: "35 days" },
      { name: "stat_segment", after: "3 days" },
      { name: "stat_stop", after: "3 days" },
      { name: "station_day", after: "14 days" },
      { name: "station_hour", after: "14 days" },
      { name: "train_day", after: "14 days" },
    ]);
    const settings = await rows<{
      name: string;
      segmentby: string;
      orderby: string;
      interval: string;
    }>(
      `SELECT ca.user_view_name::text AS name, array_to_string(s.segmentby, ',') AS segmentby,
              array_to_string(s.orderby, ',') AS orderby, d.time_interval::text AS interval
         FROM _timescaledb_catalog.continuous_agg ca
         JOIN _timescaledb_catalog.hypertable h ON h.id = ca.mat_hypertable_id
         JOIN _timescaledb_catalog.compression_settings s
           ON s.relid = format('%I.%I', h.schema_name, h.table_name)::regclass
         JOIN timescaledb_information.dimensions d ON d.hypertable_name = h.table_name
        ORDER BY 1`,
    );
    expect(settings).toEqual([
      {
        name: "land_category_day",
        segmentby: "land_code",
        orderby: "category_code,day",
        interval: "10 days",
      },
      {
        name: "land_category_hour",
        segmentby: "land_code",
        orderby: "category_code,local_hour,day",
        interval: "10 days",
      },
      {
        name: "line_day",
        segmentby: "category_code",
        orderby: "line_name,operator_id,day",
        interval: "10 days",
      },
      {
        name: "segment_day",
        segmentby: "",
        orderby: "from_stop_place_id,to_stop_place_id,day",
        interval: "10 days",
      },
      {
        name: "stat_segment",
        segmentby: "category_code",
        orderby: "train_number,trip_instance_id,from_index,day",
        interval: "1 day",
      },
      {
        name: "stat_stop",
        segmentby: "category_code",
        orderby: "trip_instance_id,stop_index,day",
        interval: "1 day",
      },
      {
        name: "station_day",
        segmentby: "category_code",
        orderby: "stop_place_id,operator_id,day",
        interval: "10 days",
      },
      {
        name: "station_hour",
        segmentby: "category_code",
        orderby: "stop_place_id,local_hour,day",
        interval: "10 days",
      },
      {
        name: "train_day",
        segmentby: "category_code",
        orderby: "train_number,operator_id,line_name,day",
        interval: "10 days",
      },
    ]);
  });

  it("creates exactly the expected constraints", async () => {
    const result = await rows<{ name: string }>(
      `SELECT c.conrelid::regclass::text || '.' || c.conname AS name
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.conrelid::regclass::text <> 'spatial_ref_sys'
          AND c.contype <> 'n'
        ORDER BY 1`,
    );
    expect(result.map((row) => row.name)).toEqual(expectedConstraints);
  });

  it("creates exactly the expected indexes", async () => {
    const result = await rows<{ name: string }>(
      `SELECT tablename || '.' || indexname || ' ' ||
              regexp_replace(indexdef, '^.* ON public\\.[a-z_]+ (USING btree )?', '') AS name
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'
        ORDER BY 1`,
    );
    expect(result.map((row) => row.name)).toEqual(expectedIndexes);
  });

  it("stores stop geometry as points in EPSG:4326", async () => {
    const result = await rows<{ name: string }>(
      `SELECT f_table_name || '.' || f_geometry_column || ' ' || type || ' ' || srid AS name
         FROM geometry_columns WHERE f_table_schema = 'public' ORDER BY 1`,
    );
    expect(result.map((row) => row.name)).toEqual([
      "land_area.geom MULTIPOLYGON 25832",
      "shape_pattern.geom LINESTRING 4326",
      "shape_stub.geom LINESTRING 4326",
      "stop_place.geom POINT 4326",
      "stop_point.geom POINT 4326",
    ]);
  });

  it("matches the committed Kysely types", async () => {
    await expect(generateTypes({ databaseUrl, verify: true })).resolves.toContain(
      "export interface DB",
    );
  });

  it("writes provenance rows with time-ordered UUIDv7 ids and a running default", async () => {
    const runId = await seedSourceAndRun("test-provenance");
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const run = await db
      .selectFrom("ingest_run")
      .select(["status", "finished_at"])
      .where("ingest_run_id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ status: "running", finished_at: null });
    const object = await db
      .insertInto("raw_object")
      .values(rawObject("test-provenance", runId, "test-provenance/2026-10-24/a.json.zst"))
      .returning(["bytes", "fetched_at"])
      .executeTakeFirstOrThrow();
    expect(object).toEqual({ bytes: "1234", fetched_at: new Date("2026-10-24T00:00:00Z") });
  });

  it("rejects provenance rows that break the rules", async () => {
    const runId = await seedSourceAndRun("test-rules");
    await seedSourceAndRun("test-other");
    const base = rawObject("test-rules", runId, "test-rules/x.json");
    const cases: [Record<string, unknown>, string][] = [
      [{ source_id: "test-other" }, "raw_object_run_fkey"],
      [{ sha256: "ABC" }, "raw_object_sha256_hex"],
      [{ object_key: "test-rules/../etc/passwd" }, "raw_object_object_key_relative"],
      [{ object_key: "/absolute/path" }, "raw_object_object_key_relative"],
      [{ http_status: 700 }, "raw_object_http_status_range"],
      [{ bytes: -1 }, "raw_object_bytes_non_negative"],
      [
        { request_url: ["https://user", "made-up@example.org/feed"].join(":") },
        "raw_object_request_url_no_userinfo",
      ],
      [{ request_url: "HTTPS://token@example.org/feed" }, "raw_object_request_url_no_userinfo"],
    ];
    for (const [override, constraint] of cases) {
      await expect(
        db
          .insertInto("raw_object")
          .values({ ...base, ...override })
          .execute(),
      ).rejects.toMatchObject({ constraint });
    }
    await db
      .insertInto("raw_object")
      .values({ ...base, request_url: "https://example.org/feed?contact=ops@example.org" })
      .execute();
    await expect(db.insertInto("raw_object").values(base).execute()).rejects.toMatchObject({
      constraint: "raw_object_object_key_key",
    });
    await expect(
      db
        .updateTable("ingest_run")
        .set({ status: "succeeded" })
        .where("ingest_run_id", "=", runId)
        .execute(),
    ).rejects.toMatchObject({ constraint: "ingest_run_finished_when_done" });
    await expect(
      db
        .insertInto("source")
        .values({ source_id: "Bad Id", name: "x", licence: "x", attribution: "x" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "source_id_format" });
  });

  it("stores recorder segment positions and gaps and rejects rows that break their rules", async () => {
    const runId = await seedSourceAndRun("test-recording");
    const insertObject = async (key: string) =>
      (
        await db
          .insertInto("raw_object")
          .values({ ...rawObject("test-recording", runId, key), content_encoding: "zstd-patch-v1" })
          .returning("raw_object_id")
          .executeTakeFirstOrThrow()
      ).raw_object_id;
    const first = await insertObject("test-recording/2026-10-25/09/00000");
    const second = await insertObject("test-recording/2026-10-25/09/00001");
    const backfilled = await db
      .insertInto("raw_object")
      .values({
        ...rawObject("test-recording", runId, "test-recording/2026-10-25/09.backfill/00000"),
        observed_at: new Date("2026-10-23T09:06:01Z"),
      })
      .returning(["observed_at", "fetched_at"])
      .executeTakeFirstOrThrow();
    expect(backfilled.observed_at).toEqual(new Date("2026-10-23T09:06:01Z"));
    const defaulted = await db
      .selectFrom("raw_object")
      .select(["observed_at", "fetched_at"])
      .where("raw_object_id", "=", first)
      .executeTakeFirstOrThrow();
    expect(defaulted.observed_at).toEqual(defaulted.fetched_at);
    const segment = {
      raw_object_id: first,
      segment_key: "test-recording/2026-10-25/09.seg.zst",
      seq: 0,
      base_seq: null,
      frame_offset: 120,
      frame_bytes: 2048,
      format_version: 1,
    };
    await db.insertInto("raw_object_segment").values(segment).execute();
    const cases: [Record<string, unknown>, string][] = [
      [{ seq: 0 }, "raw_object_segment_position_key"],
      [{ seq: 1, base_seq: 1 }, "raw_object_segment_base_before"],
      [{ seq: -1 }, "raw_object_segment_seq_non_negative"],
      [{ seq: 1, frame_bytes: 0 }, "raw_object_segment_frame_range"],
      [{ seq: 1, segment_key: "../escape.seg.zst" }, "raw_object_segment_key_relative"],
      [{ seq: 1, format_version: 0 }, "raw_object_segment_format_version_positive"],
    ];
    for (const [override, constraint] of cases) {
      await expect(
        db
          .insertInto("raw_object_segment")
          .values({ ...segment, raw_object_id: second, ...override })
          .execute(),
      ).rejects.toMatchObject({ constraint });
    }
    await db.deleteFrom("raw_object").where("raw_object_id", "=", first).execute();
    const remaining = await db.selectFrom("raw_object_segment").select("raw_object_id").execute();
    expect(remaining).toEqual([]);

    const gap = {
      source_id: "test-recording",
      gap_start: new Date("2026-10-25T00:58:20Z"),
      gap_end: new Date("2026-10-25T01:03:20Z"),
    };
    await db.insertInto("recording_gap").values(gap).execute();
    await expect(
      db
        .insertInto("recording_gap")
        .values({ ...gap, gap_start: new Date("2026-10-25T02:00:00Z"), gap_end: gap.gap_start })
        .execute(),
    ).rejects.toMatchObject({ constraint: "recording_gap_order" });
  });

  it("stores stops with typed ids and finds them with a spatial query", async () => {
    await seedSourceAndRun("test-stops");
    const placeId = "00000000-0000-5000-8000-000000000001";
    await db
      .insertInto("stop_place")
      .values({
        stop_place_id: placeId,
        name: "Berlin Hbf",
        name_source_id: "test-stops",
        geom_source_id: "test-stops",
        dhid: "de:11000:900003201",
        eva: 8011160,
        uic: 8011160,
        country_code: "DE",
        geom: sql<string>`ST_SetSRID(ST_MakePoint(13.369545, 52.525592), 4326)`,
      })
      .execute();
    await db
      .insertInto("stop_point")
      .values({
        stop_point_id: "00000000-0000-5000-8000-000000000002",
        stop_place_id: placeId,
        platform_code: "1",
        geom_source_id: "test-stops",
        dhid: "de:11000:900003201:1:50",
        geom: sql<string>`ST_SetSRID(ST_MakePoint(13.3696, 52.5257), 4326)`,
      })
      .execute();
    const near = await db
      .selectFrom("stop_place")
      .select("name")
      .where(
        sql<boolean>`ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(13.37, 52.525), 4326)::geography, 500)`,
      )
      .execute();
    expect(near).toEqual([{ name: "Berlin Hbf" }]);
  });

  it("rejects stops that break the rules", async () => {
    const place = (id: number, extra: Record<string, unknown>) =>
      db
        .insertInto("stop_place")
        .values({
          stop_place_id: `00000000-0000-5000-8000-0000000001${String(id).padStart(2, "0")}`,
          name: `Stop ${id}`,
          name_source_id: "test-stops",
          ...extra,
        })
        .execute();
    await expect(place(2, { dhid: "11000:9000" })).rejects.toMatchObject({
      constraint: "stop_place_dhid_format",
    });
    await expect(place(3, { country_code: "de" })).rejects.toMatchObject({
      constraint: "stop_place_country_code_format",
    });
    await expect(
      place(4, {
        geom: sql<string>`ST_SetSRID(ST_MakePoint(52.5, 113.4), 4326)`,
        geom_source_id: "test-stops",
      }),
    ).rejects.toMatchObject({ constraint: "stop_place_geom_lon_lat" });
    await expect(
      place(5, {
        geom: sql<string>`ST_SetSRID(ST_MakePoint(1488000, 6894000), 3857)`,
        geom_source_id: "test-stops",
      }),
    ).rejects.toThrow(/SRID/);
    await expect(
      place(6, { geom: sql<string>`ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)` }),
    ).rejects.toMatchObject({ constraint: "stop_place_geom_source_present" });
    await expect(place(7, { name_source_id: "test-missing" })).rejects.toMatchObject({
      constraint: "stop_place_name_source_id_fkey",
    });
    await expect(
      db
        .insertInto("stop_point")
        .values({
          stop_point_id: "00000000-0000-5000-8000-000000000199",
          stop_place_id: "00000000-0000-5000-8000-000000000198",
        })
        .execute(),
    ).rejects.toMatchObject({ constraint: "stop_point_stop_place_id_fkey" });
    await expect(
      db
        .insertInto("stop_point")
        .values({
          stop_point_id: "00000000-0000-5000-8000-000000000197",
          stop_place_id: "00000000-0000-5000-8000-000000000001",
          name: "Gleis 1",
        })
        .execute(),
    ).rejects.toMatchObject({ constraint: "stop_point_name_source_present" });
  });

  it("lets several stop places share one EVA and UIC number", async () => {
    await db
      .insertInto("stop_place")
      .values({
        stop_place_id: "00000000-0000-5000-8000-000000000003",
        name: "Berlin Hbf (tief)",
        name_source_id: "test-stops",
        dhid: "de:11000:900003200",
        eva: 8011160,
        uic: 8011160,
      })
      .execute();
    const shared = await db
      .selectFrom("stop_place")
      .select("dhid")
      .where("eva", "=", 8011160)
      .where("uic", "=", 8011160)
      .orderBy("dhid")
      .execute();
    expect(shared.map((row) => row.dhid)).toEqual(["de:11000:900003200", "de:11000:900003201"]);
  });

  it("moves updated_at forward on a real change and keeps it on a no-op update", async () => {
    const id = "00000000-0000-5000-8000-000000000004";
    const past = new Date("2026-01-01T00:00:00Z");
    await db
      .insertInto("stop_place")
      .values({
        stop_place_id: id,
        name: "Spandau",
        name_source_id: "test-stops",
        created_at: past,
        updated_at: past,
      })
      .execute();
    const updatedAt = async () =>
      (
        await db
          .selectFrom("stop_place")
          .select("updated_at")
          .where("stop_place_id", "=", id)
          .executeTakeFirstOrThrow()
      ).updated_at;
    await db
      .updateTable("stop_place")
      .set({ name: "Spandau" })
      .where("stop_place_id", "=", id)
      .execute();
    expect(await updatedAt()).toEqual(past);
    await db
      .updateTable("stop_place")
      .set({ name: "Berlin-Spandau" })
      .where("stop_place_id", "=", id)
      .execute();
    expect((await updatedAt()).getTime()).toBeGreaterThan(past.getTime());

    const pointId = "00000000-0000-5000-8000-000000000005";
    await db
      .insertInto("stop_point")
      .values({ stop_point_id: pointId, stop_place_id: id, created_at: past, updated_at: past })
      .execute();
    await db
      .updateTable("stop_point")
      .set({ platform_code: "3" })
      .where("stop_point_id", "=", pointId)
      .execute();
    const point = await db
      .selectFrom("stop_point")
      .select("updated_at")
      .where("stop_point_id", "=", pointId)
      .executeTakeFirstOrThrow();
    expect(point.updated_at.getTime()).toBeGreaterThan(past.getTime());
  });

  it("maps source keys to canonical ids idempotently", async () => {
    await seedSourceAndRun("test-idmap");
    const mapping = {
      source_id: "test-idmap",
      entity: "stop_place",
      source_key: "8011160",
      canonical_id: "00000000-0000-5000-8000-000000000001",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .insertInto("id_map")
        .values(mapping)
        .onConflict((oc) => oc.columns(["source_id", "entity", "source_key"]).doNothing())
        .execute();
    }
    await db
      .insertInto("id_map")
      .values({ ...mapping, entity: "stop_point" })
      .execute();
    const mapped = await db
      .selectFrom("id_map")
      .select(["entity", "canonical_id"])
      .where("source_id", "=", "test-idmap")
      .orderBy("entity")
      .execute();
    expect(mapped).toEqual([
      { entity: "stop_place", canonical_id: mapping.canonical_id },
      { entity: "stop_point", canonical_id: mapping.canonical_id },
    ]);
    await expect(
      db
        .insertInto("id_map")
        .values({ ...mapping, entity: "train" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "id_map_entity_known" });
  });

  it("follows the documented id_map upsert rule and reports a changed canonical id", async () => {
    const key = {
      source_id: "test-idmap",
      entity: "stop_place",
      source_key: "8098160",
    } as const;
    const canonical = "00000000-0000-5000-8000-000000000010";
    const upsert = (canonicalId: string, seenAt: Date) =>
      db
        .insertInto("id_map")
        .values({ ...key, canonical_id: canonicalId, first_seen_at: seenAt, last_seen_at: seenAt })
        .onConflict((oc) =>
          oc
            .columns(["source_id", "entity", "source_key"])
            .doUpdateSet({ last_seen_at: (eb) => eb.ref("excluded.last_seen_at") })
            .where("id_map.canonical_id", "=", (eb) => eb.ref("excluded.canonical_id")),
        )
        .executeTakeFirst();
    const first = new Date("2026-10-01T00:00:00Z");
    const later = new Date("2026-10-24T00:00:00Z");
    expect((await upsert(canonical, first)).numInsertedOrUpdatedRows).toBe(1n);
    expect((await upsert(canonical, later)).numInsertedOrUpdatedRows).toBe(1n);
    const conflict = await upsert("00000000-0000-5000-8000-000000000011", later);
    expect(conflict.numInsertedOrUpdatedRows).toBe(0n);
    const stored = await db
      .selectFrom("id_map")
      .select(["canonical_id", "first_seen_at", "last_seen_at"])
      .where("source_key", "=", key.source_key)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ canonical_id: canonical, first_seen_at: first, last_seen_at: later });
  });

  it("stores catalogue rows and rejects rows that break the catalogue rules", async () => {
    await seedSourceAndRun("test-catalog");
    const operator = {
      operator_id: "test-catalog-op",
      name: "Test Bahn GmbH",
      name_source_id: "test-catalog",
      brand_name: "Test Bahn",
      catalog_source_id: "test-catalog",
      wikidata_qid: "Q1",
      wikidata_role: "company",
      wikidata_basis_source_id: "test-catalog",
    };
    const operatorCases: [Record<string, unknown>, string][] = [
      [{ wikidata_qid: "P31" }, "operator_wikidata_qid_format"],
      [{ wikidata_role: null }, "operator_wikidata_complete"],
      [{ wikidata_role: "owner" }, "operator_wikidata_role_known"],
      [{ catalog_source_id: null }, "operator_catalogued_has_brand"],
      [{ valid_from: "2020-01-02", valid_to: "2020-01-01" }, "operator_valid_order"],
      [{ website_url: "ftp://example.org" }, "operator_website_url_http"],
    ];
    for (const [override, constraint] of operatorCases) {
      await expect(
        db
          .insertInto("operator")
          .values({ ...operator, ...override })
          .execute(),
      ).rejects.toMatchObject({ constraint });
    }
    await db.insertInto("operator").values(operator).execute();

    const verbund = {
      verbund_id: "test-vv",
      abbr: "TVV",
      name: "Test Verkehrsverbund",
      laender: ["DE-BW", "DE-HE"],
      source_id: "test-catalog",
    };
    await expect(
      db
        .insertInto("verbund")
        .values({ ...verbund, laender: ["DE-XX"] })
        .execute(),
    ).rejects.toMatchObject({ constraint: "verbund_laender_known" });
    await db.insertInto("verbund").values(verbund).execute();

    await db
      .insertInto("vehicle_series")
      .values({
        series_id: "test-412",
        name: "Test 412",
        priority: "P1",
        source_id: "test-catalog",
      })
      .execute();
    await db
      .insertInto("vehicle_series_operator")
      .values({
        series_id: "test-412",
        operator_id: operator.operator_id,
        source_id: "test-catalog",
      })
      .execute();
    await expect(
      db
        .insertInto("vehicle_series")
        .values({ series_id: "test-x", name: "X", priority: "P9", source_id: "test-catalog" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "vehicle_series_priority_known" });

    await db
      .insertInto("livery")
      .values({ livery_id: "test-livery", name: "Test livery", source_id: "test-catalog" })
      .execute();
    const colour = {
      livery_id: "test-livery",
      colour_index: 0,
      role: "body",
      name: "Lichtgrau",
      ral: "RAL 7035",
      source_id: "test-catalog",
    };
    await expect(
      db
        .insertInto("livery_colour")
        .values({ ...colour, hex: "#cbd0cc" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "livery_colour_hex_sourced" });
    await expect(
      db
        .insertInto("livery_colour")
        .values({ ...colour, ral: "7035" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "livery_colour_ral_format" });
    await expect(
      db
        .insertInto("livery_colour")
        .values({ ...colour, colour_index: 9, role: "helmet" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "livery_colour_role_known" });
    await db.insertInto("livery_colour").values(colour).execute();
    await db
      .insertInto("livery_colour")
      .values(
        (["mask", "skirt", "roof"] as const).map((role, i) => ({
          ...colour,
          colour_index: i + 1,
          role,
          name: "Basaltgrau",
          ral: "RAL 7012",
        })),
      )
      .execute();

    const line = {
      line_colour_id: "test-rb-1",
      upstream_operator: "test",
      line_name: "RB 1",
      operator_id: operator.operator_id,
      background_hex: "#24b27d",
      text_hex: "#ffffff",
      shape: "rectangle",
      source_id: "test-catalog",
    };
    await expect(
      db
        .insertInto("line_colour")
        .values({ ...line, shape: "star" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "line_colour_shape_known" });
    await expect(
      db
        .insertInto("line_colour")
        .values({ ...line, background_hex: "#24B27D" })
        .execute(),
    ).rejects.toMatchObject({ constraint: "line_colour_background_hex_format" });
    await db.insertInto("line_colour").values(line).execute();

    await db.deleteFrom("vehicle_series").where("series_id", "=", "test-412").execute();
    const links = await db
      .selectFrom("vehicle_series_operator")
      .select("operator_id")
      .where("series_id", "=", "test-412")
      .execute();
    expect(links).toEqual([]);
    await db.deleteFrom("livery").where("livery_id", "=", "test-livery").execute();
    await db.deleteFrom("line_colour").execute();
    await db.deleteFrom("verbund").execute();
    await db.deleteFrom("operator").where("operator_id", "=", operator.operator_id).execute();
  });

  it("seeds the canonical categories in display order", async () => {
    const categories = await db
      .selectFrom("category")
      .select(["category_code", "is_train"])
      .orderBy("sort_order")
      .execute();
    expect(categories.map((row) => row.category_code)).toEqual([
      "hsr",
      "ld",
      "night",
      "rfast",
      "reg",
      "sbahn",
      "urban",
      "bus",
      "other",
    ]);
    expect(categories.filter((row) => row.is_train)).toHaveLength(6);
  });

  it("stores a timetable version, refuses broken rows and drops it as a whole", async () => {
    const runId = await seedSourceAndRun("test-timetable");
    const raw = await db
      .insertInto("raw_object")
      .values({
        ...rawObject("test-timetable", runId, "inputs/delfi/2026-10-19/delfi-gtfs.zip"),
        content_type: "application/zip",
      })
      .returning("raw_object_id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("operator")
      .values({
        operator_id: "db-fernverkehr-ag",
        name: "DB Fernverkehr AG",
        name_source_id: "test-timetable",
        country_code: "DE",
      })
      .execute();
    await db
      .insertInto("operator_alias")
      .values({
        source_id: "test-timetable",
        alias: "DB Fernverkehr AG",
        operator_id: "db-fernverkehr-ag",
      })
      .execute();
    const version = await db
      .insertInto("feed_version")
      .values({
        source_id: "test-timetable",
        raw_object_id: raw.raw_object_id,
        published_on: "2026-10-19",
        sha256: sha,
        category_codes: ["hsr"],
        ingest_run_id: runId,
      })
      .returning("feed_version_id")
      .executeTakeFirstOrThrow();
    const v = version.feed_version_id;
    const patternId = "00000000-0000-5000-8000-0000000000aa";
    await db
      .insertInto("route")
      .values({
        feed_version_id: v,
        route_key: "r1",
        operator_id: "db-fernverkehr-ag",
        short_name: "1",
        gtfs_route_type: 101,
        category_code: "hsr",
        category_rule: "type:101",
        is_foreign: false,
      })
      .execute();
    await db
      .insertInto("service_calendar")
      .values({
        feed_version_id: v,
        service_key: "s1",
        weekdays: 31,
        start_date: "2026-10-03",
        end_date: "2026-12-12",
      })
      .execute();
    await db
      .insertInto("service_calendar_date")
      .values({
        feed_version_id: v,
        service_key: "s1",
        service_date: "2026-10-03",
        exception_type: 2,
      })
      .execute();
    await db
      .insertInto("trip_pattern")
      .values({ feed_version_id: v, trip_pattern_id: patternId, route_key: "r1", stop_count: 2 })
      .execute();
    await db
      .insertInto("trip_pattern_stop")
      .values(
        [0, 1].map((stop_index) => ({
          feed_version_id: v,
          trip_pattern_id: patternId,
          stop_index,
          stop_point_id: "00000000-0000-5000-8000-000000000002",
        })),
      )
      .execute();
    await db
      .insertInto("trip")
      .values({
        feed_version_id: v,
        trip_key: "t1",
        route_key: "r1",
        service_key: "s1",
        trip_pattern_id: patternId,
        short_name: "571",
        category_code: "hsr",
        is_foreign: false,
        first_departure_s: 28_800,
        last_arrival_s: 34_920,
      })
      .execute();
    await db
      .insertInto("stop_time")
      .values([
        {
          feed_version_id: v,
          trip_key: "t1",
          stop_index: 0,
          stop_sequence: 0,
          departure_s: 28_800,
        },
        { feed_version_id: v, trip_key: "t1", stop_index: 1, stop_sequence: 2, arrival_s: 34_920 },
      ])
      .execute();

    const cases: [() => Promise<unknown>, string][] = [
      [
        () =>
          db
            .insertInto("stop_time")
            .values({
              feed_version_id: v,
              trip_key: "t1",
              stop_index: 2,
              stop_sequence: 3,
              arrival_s: 40_000,
              departure_s: 39_000,
            })
            .execute(),
        "stop_time_order",
      ],
      [
        () =>
          db
            .insertInto("service_calendar")
            .values({ feed_version_id: v, service_key: "s2", weekdays: 200 })
            .execute(),
        "service_calendar_weekdays_range",
      ],
      [
        () =>
          db
            .insertInto("trip_pattern")
            .values({
              feed_version_id: v,
              trip_pattern_id: "00000000-0000-5000-8000-0000000000ab",
              route_key: "r1",
              stop_count: 1,
            })
            .execute(),
        "trip_pattern_stop_count_min",
      ],
      [
        () =>
          db
            .updateTable("feed_version")
            .set({ status: "loaded" })
            .where("feed_version_id", "=", v)
            .execute(),
        "feed_version_loaded_when_done",
      ],
      [
        () =>
          db
            .insertInto("operator")
            .values({ operator_id: "Bad Id", name: "x", name_source_id: "test-timetable" })
            .execute(),
        "operator_id_format",
      ],
      [
        () =>
          db
            .updateTable("route")
            .set({ category_code: "tram" })
            .where("route_key", "=", "r1")
            .execute(),
        "route_category_code_fkey",
      ],
    ];
    for (const [attempt, constraint] of cases) {
      await expect(attempt()).rejects.toMatchObject({ constraint });
    }

    await db.deleteFrom("feed_version").where("feed_version_id", "=", v).execute();
    for (const table of [
      "route",
      "service_calendar",
      "trip_pattern",
      "trip",
      "stop_time",
    ] as const) {
      const [count] = await rows<{ count: string }>(`SELECT count(*) FROM ${table}`);
      expect(count?.count).toBe("0");
    }
  });

  it("numbers shapes for good, links them to patterns and refuses broken shapes", async () => {
    const runId = await seedSourceAndRun("test-shapes");
    const raw = await db
      .insertInto("raw_object")
      .values({
        ...rawObject("test-shapes", runId, "inputs/delfi/2026-10-19/shapes-test.zip"),
        content_type: "application/zip",
      })
      .returning("raw_object_id")
      .executeTakeFirstOrThrow();
    const version = await db
      .insertInto("feed_version")
      .values({
        source_id: "test-shapes",
        raw_object_id: raw.raw_object_id,
        published_on: "2026-10-19",
        sha256: "b".repeat(64),
        category_codes: ["reg"],
        ingest_run_id: runId,
      })
      .returning("feed_version_id")
      .executeTakeFirstOrThrow();
    const v = version.feed_version_id;
    const patternId = "00000000-0000-5000-8000-0000000000ba";
    await db
      .insertInto("route")
      .values({
        feed_version_id: v,
        route_key: "r-shape",
        gtfs_route_type: 106,
        category_code: "reg",
        category_rule: "type:106",
        is_foreign: false,
      })
      .execute();
    await db
      .insertInto("trip_pattern")
      .values({
        feed_version_id: v,
        trip_pattern_id: patternId,
        route_key: "r-shape",
        stop_count: 2,
      })
      .execute();

    const line = "LINESTRING ZM (13.0 52.0 34.5 0, 13.001 52.0 35.0 68.6)";
    const insertShape = (
      hash: string,
      overrides: Partial<Record<string, string>> = {},
    ): Promise<{ shape_no: number }[]> => {
      const values = {
        geom: `ST_GeomFromText('${line}', 4326)`,
        length_m: "68.6",
        stop_arc_m: "'{0,68.6}'",
        method: "'motis'",
        qa_status: "'pass'",
        tunnel_spans: "'{}'",
        ...overrides,
      };
      return rows<{ shape_no: number }>(
        `INSERT INTO shape_pattern (shape_hash, geom, length_m, stop_arc_m, method, qa_status,
           tunnel_spans, source_note, licence)
         VALUES ('${hash}', ${values.geom}, ${values.length_m}, ${values.stop_arc_m},
           ${values.method}, ${values.qa_status}, ${values.tunnel_spans},
           'OpenStreetMap contributors', 'ODbL-1.0')
         RETURNING shape_no`,
      );
    };
    const [first] = await insertShape("1".repeat(64));
    const [second] = await insertShape("2".repeat(64), {
      method: "'straight'",
      qa_status: "'low_quality'",
    });
    const [unmeasured] = await insertShape("5".repeat(64), {
      method: "'straight'",
      qa_status: "'unmeasured'",
      stop_arc_m: "'{0,20,20,68.6}'",
    });
    expect(first?.shape_no).toBeGreaterThan(0);
    expect(second?.shape_no).toBeGreaterThan(first?.shape_no ?? 0);
    expect(unmeasured?.shape_no).toBeGreaterThan(second?.shape_no ?? 0);
    await rows(
      `INSERT INTO trip_pattern_shape (feed_version_id, trip_pattern_id, shape_hash, group_method,
         candidate_verdicts, metrics, review_flags)
       VALUES (${v}, '${patternId}', '${"1".repeat(64)}', 'motis', '{"motis":"pass"}',
         '{"detour":0.95,"detour_low":1.0}', '{floor_by_lower_bound}')`,
    );
    const [linked] = await rows<{ shape_no: number; m_end: number; review_flags: string[] }>(
      `SELECT s.shape_no, ST_M(ST_EndPoint(s.geom)) AS m_end, l.review_flags
         FROM trip_pattern_shape l JOIN shape_pattern s USING (shape_hash)
        WHERE l.trip_pattern_id = '${patternId}'`,
    );
    expect(linked).toEqual({
      shape_no: first?.shape_no,
      m_end: 68.6,
      review_flags: ["floor_by_lower_bound"],
    });

    const cases: [() => Promise<unknown>, string][] = [
      [() => insertShape("3".repeat(64), { method: "'delfi'" }), "shape_pattern_method_known"],
      [
        () => insertShape("3".repeat(64), { method: "'straight'" }),
        "shape_pattern_straight_is_fallback",
      ],
      [
        () => insertShape("3".repeat(64), { qa_status: "'unmeasured'" }),
        "shape_pattern_straight_is_fallback",
      ],
      [
        () => insertShape("3".repeat(64), { stop_arc_m: "'{0,50,20,68.6}'" }),
        "shape_pattern_stop_arcs_ordered",
      ],
      [() => insertShape("3".repeat(64), { length_m: "70" }), "shape_pattern_geom_valid"],
      [() => insertShape("3".repeat(64), { tunnel_spans: "'{10}'" }), "shape_pattern_spans_paired"],
      [
        () => insertShape("3".repeat(64), { stop_arc_m: "'{0,99}'" }),
        "shape_pattern_stop_arcs_ordered",
      ],
      [() => insertShape("NOT-HEX"), "shape_pattern_hash_hex"],
      [
        () =>
          rows(
            `INSERT INTO trip_pattern_shape (feed_version_id, trip_pattern_id, shape_hash,
               group_method)
             VALUES (${v}, '${patternId}', '${"2".repeat(64)}', 'straight')`,
          ),
        "trip_pattern_shape_group_method_known",
      ],
      [
        () => rows(`DELETE FROM shape_pattern WHERE shape_hash = '${"1".repeat(64)}'`),
        "trip_pattern_shape_shape_hash_fkey",
      ],
    ];
    for (const [attempt, constraint] of cases) {
      await expect(attempt()).rejects.toMatchObject({ constraint });
    }

    await db.deleteFrom("feed_version").where("feed_version_id", "=", v).execute();
    const [links] = await rows<{ count: string }>("SELECT count(*) FROM trip_pattern_shape");
    expect(links?.count).toBe("0");
    await rows(`DELETE FROM shape_pattern WHERE shape_hash = '${"1".repeat(64)}'`);
    const [third] = await insertShape("4".repeat(64));
    expect(third?.shape_no).toBeGreaterThan(second?.shape_no ?? 0);
    await rows("DELETE FROM shape_pattern");
  });

  it("keeps the shape epoch registry append only, in rising order", async () => {
    await rows("INSERT INTO shape_registry (epoch, note) VALUES (2, 'test epoch two')");
    const refused = [
      "UPDATE shape_registry SET note = 'changed' WHERE epoch = 2",
      "DELETE FROM shape_registry WHERE epoch = 2",
      "TRUNCATE shape_registry",
      "INSERT INTO shape_registry (epoch, note) VALUES (5, 'five'), (4, 'four')",
    ];
    for (const statement of refused) {
      await expect(rows(statement)).rejects.toMatchObject({
        code: "23001",
        message: expect.stringContaining("shape_registry"),
      });
    }
    const epochs = await rows<{ epoch: number; note: string }>(
      "SELECT epoch, note FROM shape_registry ORDER BY epoch",
    );
    expect(epochs.map((row) => row.epoch)).toEqual([1, 2]);
    expect(epochs[1]?.note).toBe("test epoch two");
  });

  it("stores a track stub per shape end, M from the end vertex, and refuses broken stubs (D-055)", async () => {
    const [shape] = await rows<{ shape_no: number }>(
      `INSERT INTO shape_pattern (shape_hash, geom, length_m, stop_arc_m, method, qa_status,
         source_note, licence)
       VALUES ('${"6".repeat(64)}',
         ST_GeomFromText('LINESTRING ZM (13 52 30 0, 13.001 52 31 68.6)', 4326), 68.6,
         '{0,68.6}', 'motis', 'pass', 'OpenStreetMap contributors', 'ODbL-1.0')
       RETURNING shape_no`,
    );
    const shapeNo = shape?.shape_no ?? 0;
    const stub = (
      side: string,
      overrides: Partial<Record<"geom" | "length" | "end" | "version" | "licence", string>> = {},
    ) =>
      rows(
        `INSERT INTO shape_stub (shape_no, side, geom, length_m, end_reason, stub_version,
           source_note, licence)
         VALUES (${shapeNo}, '${side}',
           ${overrides.geom ?? "ST_GeomFromText('LINESTRING ZM (13 52 30 0, 12.999 52 30 68.6)', 4326)"},
           ${overrides.length ?? "68.6"}, '${overrides.end ?? "buffer"}', ${overrides.version ?? "1"},
           'OpenStreetMap contributors', '${overrides.licence ?? "ODbL-1.0"}')`,
      );
    await stub("before");
    await stub("after", { end: "limit" });
    await expect(stub("before")).rejects.toMatchObject({ constraint: "shape_stub_pkey" });
    await expect(stub("middle")).rejects.toMatchObject({ constraint: "shape_stub_side_known" });
    await rows("DELETE FROM shape_stub");
    const refused: [Parameters<typeof stub>[1], string][] = [
      [{ end: "no_track" }, "shape_stub_end_known"],
      [
        { length: "0", geom: "ST_GeomFromText('LINESTRING ZM (13 52 30 0, 13 52 30 0)', 4326)" },
        "shape_stub_geom_valid",
      ],
      [
        { geom: "ST_GeomFromText('LINESTRING ZM (13 52 30 5, 12.999 52 30 73.6)', 4326)" },
        "shape_stub_geom_valid",
      ],
      [{ length: "60" }, "shape_stub_geom_valid"],
      [
        {
          geom: "ST_GeomFromText('LINESTRING ZM (13 52 30 0, 12.998 52 30 70, 12.999 52 30 68.6)', 4326)",
        },
        "shape_stub_geom_valid",
      ],
      [
        {
          geom: "ST_GeomFromText('LINESTRING ZM (13 52 30 0, 13 52 30 0, 12.999 52 30 68.6)', 4326)",
        },
        "shape_stub_geom_valid",
      ],
      [
        {
          length: "401",
          geom: "ST_GeomFromText('LINESTRING ZM (13 52 30 0, 12.994 52 30 401)', 4326)",
        },
        "shape_stub_length_range",
      ],
      [{ version: "0" }, "shape_stub_version_positive"],
      [{ licence: " " }, "shape_stub_licence_not_blank"],
    ];
    for (const [overrides, constraint] of refused) {
      await expect(stub("before", overrides)).rejects.toMatchObject({ constraint });
    }
    await expect(
      rows(
        `INSERT INTO shape_stub (shape_no, side, geom, length_m, end_reason, stub_version,
           source_note, licence)
         VALUES (2147483000, 'before',
           ST_GeomFromText('LINESTRING ZM (13 52 30 0, 12.999 52 30 68.6)', 4326), 68.6,
           'buffer', 1, 'OpenStreetMap contributors', 'ODbL-1.0')`,
      ),
    ).rejects.toMatchObject({ constraint: "shape_stub_shape_no_fkey" });
    await stub("after");
    await rows(`DELETE FROM shape_pattern WHERE shape_no = ${shapeNo}`);
    const [left] = await rows<{ count: string }>("SELECT count(*) FROM shape_stub");
    expect(left?.count).toBe("0");
  });

  it("seeds attribution holders per source and refuses holders that break the rules", async () => {
    const holders = await rows<{ source_id: string; name: string; role: string }>(
      `SELECT source_id, name, role FROM source_holder
        WHERE source_id IN ('delfi-gtfs-rt', 'gtfsde-rt') ORDER BY source_id, position`,
    );
    expect(holders).toEqual([
      { source_id: "delfi-gtfs-rt", name: "DELFI e.V.", role: "publisher" },
      { source_id: "delfi-gtfs-rt", name: "traines.eu", role: "mirror" },
      { source_id: "gtfsde-rt", name: "DELFI e.V.", role: "publisher" },
      { source_id: "gtfsde-rt", name: "GTFS.de", role: "aggregator" },
    ]);
    const insert = (values: string) =>
      rows(`INSERT INTO source_holder (source_id, position, name, role, url) VALUES (${values})`);
    const cases: [() => Promise<unknown>, string][] = [
      [() => insert("'test-holder', 0, 'X', 'owner', NULL"), "source_holder_role_known"],
      [
        () => insert("'test-holder', 0, 'X', 'publisher', 'http://example.org/'"),
        "source_holder_url_https",
      ],
      [
        () => insert("'test-holder', 0, 'X', 'publisher', 'https://user@example.org/'"),
        "source_holder_url_https",
      ],
      [() => insert("'test-holder', 0, ' ', 'publisher', NULL"), "source_holder_name_not_blank"],
      [() => insert("'Bad Id', 0, 'X', 'publisher', NULL"), "source_holder_source_id_format"],
    ];
    for (const [attempt, constraint] of cases) {
      await expect(attempt()).rejects.toMatchObject({ constraint });
    }
  });

  it("refuses display names and products that break the rules", async () => {
    await seedSourceAndRun("test-display");
    const placeId = "0b7e6c1a-3f2d-5a4b-8c9d-1e2f3a4b5c70";
    await rows(
      `INSERT INTO stop_place (stop_place_id, name, name_source_id)
       VALUES ('${placeId}', 'Hauptbahnhof', 'test-display')`,
    );
    await rows(
      `INSERT INTO stop_place_display_name (stop_place_id, name, source_id, rule)
       VALUES ('${placeId}', 'Stuttgart Hbf', 'test-display', 'eva:town-missing')`,
    );
    const cases: [() => Promise<unknown>, string][] = [
      [
        () =>
          rows(`UPDATE stop_place_display_name SET name = ' ' WHERE stop_place_id = '${placeId}'`),
        "stop_place_display_name_not_blank",
      ],
      [
        () =>
          rows(
            `UPDATE stop_place_display_name SET rule = 'Bad' WHERE stop_place_id = '${placeId}'`,
          ),
        "stop_place_display_name_rule_format",
      ],
      [
        () =>
          rows(
            `INSERT INTO trip_product (feed_version_id, trip_key, product, source_id, rule)
             VALUES (999999, 't1', 'ICE', 'test-display', 'gtfsde:trip')`,
          ),
        "trip_product_trip_fkey",
      ],
    ];
    for (const [attempt, constraint] of cases) {
      await expect(attempt()).rejects.toMatchObject({ constraint });
    }
    await rows(`DELETE FROM stop_place WHERE stop_place_id = '${placeId}'`);
    const [left] = await rows<{ count: string }>("SELECT count(*) FROM stop_place_display_name");
    expect(left?.count).toBe("0");
  });

  it("refuses to run when an applied migration file changed", async () => {
    const tampered = await mkdtemp(join(tmpdir(), "gerlines-tampered-"));
    try {
      await cp(defaultMigrationsDir, tampered, { recursive: true });
      await writeFile(join(tampered, "0002_provenance.up.sql"), "SELECT 1;\n");
      await expect(getStatus({ ...runner, migrationsDir: tampered })).rejects.toThrow(
        /migration 2 provenance changed after it was applied/,
      );
      await expect(migrateUp({ ...runner, migrationsDir: tampered })).rejects.toThrow(
        /checksum mismatch/,
      );
    } finally {
      await rm(tampered, { recursive: true, force: true });
    }
  });

  it("rolls back a failing migration completely", async () => {
    const broken = await mkdtemp(join(tmpdir(), "gerlines-broken-"));
    try {
      await cp(defaultMigrationsDir, broken, { recursive: true });
      await writeFile(
        join(broken, probeFile("broken", "up")),
        "CREATE TABLE broken_probe (id int);\nSELECT 1 / 0;\n",
      );
      await writeFile(join(broken, probeFile("broken", "down")), "DROP TABLE broken_probe;\n");
      await expect(migrateUp({ ...runner, migrationsDir: broken })).rejects.toThrow(
        new RegExp(`migration ${probeVersion} broken \\(up\\) failed: division by zero`),
      );
      expect(await publicTables()).not.toContain("broken_probe");
      expect(await appliedVersions()).toEqual(versions);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("rolls back a migration whose history row cannot be written", async () => {
    const clashing = await mkdtemp(join(tmpdir(), "gerlines-clashing-"));
    try {
      await cp(defaultMigrationsDir, clashing, { recursive: true });
      await writeFile(
        join(clashing, probeFile("clash", "up")),
        `CREATE TABLE clash_probe (id int);
INSERT INTO gerlines_meta.migration (version, name, up_checksum, down_checksum, duration_ms)
VALUES (${probeVersion}, 'clash', repeat('0', 64), repeat('0', 64), 0);
`,
      );
      await writeFile(join(clashing, probeFile("clash", "down")), "DROP TABLE clash_probe;\n");
      await expect(migrateUp({ ...runner, migrationsDir: clashing })).rejects.toThrow(
        new RegExp(`migration ${probeVersion} clash \\(up\\) failed: duplicate key`),
      );
      expect(await publicTables()).not.toContain("clash_probe");
      expect(await appliedVersions()).toEqual(versions);
    } finally {
      await rm(clashing, { recursive: true, force: true });
    }
  });

  it("refuses to run while another run holds the lock", async () => {
    const holder = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockKey]);
      await expect(migrateUp({ ...runner, lockWaitMs: 300 })).rejects.toBeInstanceOf(
        MigrationLockError,
      );
    } finally {
      await holder.end();
    }
    expect(await migrateUp(runner)).toEqual([]);
  });

  it("runs a no-transaction migration statement by statement and records it", async () => {
    const concurrent = await mkdtemp(join(tmpdir(), "gerlines-concurrent-"));
    try {
      await cp(defaultMigrationsDir, concurrent, { recursive: true });
      await writeFile(
        join(concurrent, probeFile("concurrent_index", "up")),
        "-- gerlines:no-transaction\nCREATE INDEX CONCURRENTLY stop_place_name_probe_idx ON stop_place (name);\nANALYZE stop_place;\n",
      );
      await writeFile(
        join(concurrent, probeFile("concurrent_index", "down")),
        "-- gerlines:no-transaction\nDROP INDEX CONCURRENTLY stop_place_name_probe_idx;\n",
      );
      const options = { ...runner, migrationsDir: concurrent };
      expect((await migrateUp(options)).map((m) => m.version)).toEqual([probeVersion]);
      const [index] = await rows<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid FROM pg_index i
          WHERE i.indexrelid = to_regclass('stop_place_name_probe_idx')`,
      );
      expect(index?.valid).toBe(true);
      expect((await getStatus(options)).at(-1)).toMatchObject({
        version: probeVersion,
        state: "applied",
      });
      expect((await migrateDown({ ...options, steps: 1 })).map((m) => m.version)).toEqual([
        probeVersion,
      ]);
      expect(await appliedVersions()).toEqual(versions);
    } finally {
      await rm(concurrent, { recursive: true, force: true });
    }
  });

  it("applies each migration once when two runs start together on a fresh database", async () => {
    const raceName = `${databaseName}_race`;
    const raceUrl = withDatabase(serverUrl, raceName);
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(raceName)} TEMPLATE template0`);
    try {
      const race = { databaseUrl: raceUrl, lockWaitMs: 60_000 };
      const [a, b] = await Promise.all([migrateUp(race), migrateUp(race)]);
      const applied = [...(a ?? []), ...(b ?? [])].map((m) => m.version).sort((x, y) => x - y);
      expect(applied).toEqual(versions);
      expect([a?.length, b?.length].sort((x = 0, y = 0) => x - y)).toEqual([0, versions.length]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(raceName)} WITH (FORCE)`);
    }
  });

  it("guards archived days against a level-1 rebuild and against rolling back 0096", async () => {
    await rows(`SELECT assert_no_archived_days('recreating stat_stop')`);
    await rows(
      `INSERT INTO source (source_id, name, licence, attribution)
       VALUES ('test-archive', 'Test archive', 'CC0-1.0', 'Test')`,
    );
    await rows(
      `INSERT INTO history_archive_day (service_date, source_id, stop_events, legs)
       VALUES ('2025-11-12', 'test-archive', 1, 0)`,
    );
    try {
      await expect(rows(`SELECT assert_no_archived_days('recreating stat_stop')`)).rejects.toThrow(
        /recreating stat_stop.*1 archived service day.*reload/s,
      );
      expect((await migrateDown({ ...runner, steps: 1 })).map((m) => m.version)).toEqual([97]);
      await expect(migrateDown({ ...runner, steps: 1 })).rejects.toThrow(/reload them/);
      expect(await publicTables()).toContain("history_archive_day");
    } finally {
      await rows(`DELETE FROM history_archive_day`);
      await rows(`DELETE FROM source WHERE source_id = 'test-archive'`);
      await migrateUp(runner);
    }
  });

  it("rolls back one step at a time", async () => {
    const reviewerCheck = async () =>
      (
        await rows<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conname = 'vehicle_photo_reviewer_format'`,
        )
      )[0]?.definition ?? "";
    expect(await reviewerCheck()).toContain("pick:");
    const pick = await migrateDown({ ...runner, steps: 1 });
    expect(pick.map((m) => m.version)).toEqual(versions.slice(-1));
    expect(await reviewerCheck()).not.toContain("pick:");
    const archive = await migrateDown({ ...runner, steps: 1 });
    expect(archive.map((m) => m.version)).toEqual(versions.slice(-2, -1));
    expect(await publicTables()).not.toContain("history_archive_day");
    const columnstore = await migrateDown({ ...runner, steps: 1 });
    expect(columnstore.map((m) => m.version)).toEqual(versions.slice(-3, -2));
    const [rollupPolicies] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'`,
    );
    expect(rollupPolicies?.count).toBe(4);
    const [rollupSettings] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM _timescaledb_catalog.continuous_agg ca
         JOIN _timescaledb_catalog.hypertable h ON h.id = ca.mat_hypertable_id
         JOIN _timescaledb_catalog.compression_settings s
           ON s.relid = format('%I.%I', h.schema_name, h.table_name)::regclass`,
    );
    expect(rollupSettings?.count).toBe(0);
    const level1 = await rows<{ interval: string }>(
      `SELECT d.time_interval::text AS interval FROM _timescaledb_catalog.continuous_agg ca
         JOIN _timescaledb_catalog.hypertable h ON h.id = ca.mat_hypertable_id
         JOIN timescaledb_information.dimensions d ON d.hypertable_name = h.table_name
        WHERE ca.user_view_name IN ('stat_stop', 'stat_segment')`,
    );
    expect(level1.map((row) => row.interval)).toEqual(["10 days", "10 days"]);
    const withoutColumnstore = versions.slice(0, -3);
    const searchNames = await migrateDown({ ...runner, steps: 1 });
    expect(searchNames.map((m) => m.version)).toEqual(withoutColumnstore.slice(-1));
    expect(await publicTables()).not.toContain("stop_place_search_name");
    expect(await publicTables()).toContain("stop_place_display_name");
    const day = await migrateDown({ ...runner, steps: 1 });
    expect(day.map((m) => m.version)).toEqual(withoutColumnstore.slice(-2, -1));
    const [dayIndex] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = 'formation_observation_day_idx'`,
    );
    expect(dayIndex?.count).toBe(0);
    const photo = await migrateDown({ ...runner, steps: 1 });
    expect(photo.map((m) => m.version)).toEqual(withoutColumnstore.slice(-3, -2));
    expect(await publicTables()).not.toContain("vehicle_photo");
    expect(await publicTables()).toContain("fleet_rule");
    const backfill = await migrateDown({ ...runner, steps: 1 });
    expect(backfill.map((m) => m.version)).toEqual(withoutColumnstore.slice(-4, -3));
    const [column] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = 'trip_instance' AND column_name = 'backfill'`,
    );
    expect(column?.count).toBe(0);
    const [quality] = await rows<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'stop_event_final_quality_known' AND conrelid = 'stop_event'::regclass`,
    );
    expect(quality?.def).not.toContain("final_only");
    const fleet = await migrateDown({ ...runner, steps: 1 });
    expect(fleet.map((m) => m.version)).toEqual(withoutColumnstore.slice(-5, -4));
    expect(await publicTables()).not.toContain("fleet_rule");
    expect(await publicTables()).toContain("formation_observation");
    const formation = await migrateDown({ ...runner, steps: 1 });
    expect(formation.map((m) => m.version)).toEqual(withoutColumnstore.slice(-6, -5));
    expect(await publicTables()).not.toContain("formation_observation");
    const mainVersions = withoutColumnstore.slice(0, -6);
    const land = await migrateDown({ ...runner, steps: 1 });
    expect(land.map((m) => m.version)).toEqual(mainVersions.slice(-1));
    expect(await publicTables()).not.toContain("land_category_day");
    expect(await publicTables()).not.toContain("land_category_hour");
    expect(await publicTables()).toContain("land_day");
    const [left] = await rows<{ policies: number }>(
      `SELECT count(*)::int AS policies FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_refresh_continuous_aggregate'`,
    );
    expect(left?.policies).toBe(7);
    const stub = await migrateDown({ ...runner, steps: 1 });
    expect(stub.map((m) => m.version)).toEqual(mainVersions.slice(-2, -1));
    expect(await publicTables()).not.toContain("shape_stub");
    expect(await publicTables()).toContain("shape_pattern");
    expect(await appliedVersions()).toEqual(mainVersions.slice(0, -2));
    const older = mainVersions.slice(0, -2);
    const threshold = await migrateDown({ ...runner, steps: 1 });
    expect(threshold.map((m) => m.version)).toEqual(older.slice(-1));
    const policies = await rows<{ name: string; end_offset: string }>(
      `SELECT hypertable_name AS name, (config->>'end_offset')::interval::text AS end_offset
         FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'
        ORDER BY 1`,
    );
    expect(policies).toEqual([
      { name: "stat_segment", end_offset: "-2 days" },
      { name: "stat_stop", end_offset: "-2 days" },
    ]);
    expect(await publicTables()).toContain("segment_day");
    expect(await appliedVersions()).toEqual(older.slice(0, -1));
    const reverted = await migrateDown({ ...runner, steps: 1 });
    expect(reverted.map((m) => m.version)).toEqual(older.slice(-2, -1));
    expect(await publicTables()).not.toContain("segment_day");
    expect(await publicTables()).toContain("stat_stop");
    expect(await appliedVersions()).toEqual(older.slice(0, -2));
    const rollups = await migrateDown({ ...runner, steps: 3 });
    expect(rollups.map((m) => m.version)).toEqual(older.slice(-5, -2).reverse());
    expect(await publicTables()).not.toContain("stat_stop");
    expect(await publicTables()).not.toContain("stop_place_land");
    expect(await appliedVersions()).toEqual(older.slice(0, -5));
    const registry = await migrateDown({ ...runner, steps: 1 });
    expect(registry.map((m) => m.version)).toEqual(older.slice(-6, -5));
    const triggers = await rows<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'shape_registry'::regclass AND NOT tgisinternal`,
    );
    expect(triggers).toEqual([]);
    const [fn] = await rows<{ fn: string | null }>(
      "SELECT to_regproc('shape_registry_append_only')::text AS fn",
    );
    expect(fn?.fn).toBeNull();
    expect(await appliedVersions()).toEqual(older.slice(0, -6));
    const next = await migrateDown({ ...runner, steps: 1 });
    expect(next.map((m) => m.version)).toEqual(older.slice(-7, -6));
    const [roles] = await rows<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'livery_colour_role_known'`,
    );
    expect(roles?.def).toContain("'accent'");
    expect(roles?.def).not.toContain("'mask'");
    expect(await publicTables()).toContain("trip_product");
    expect(await publicTables()).toContain("shape_registry");
    expect(await appliedVersions()).toEqual(older.slice(0, -7));
    const third = await migrateDown({ ...runner, steps: 1 });
    expect(third.map((m) => m.version)).toEqual(older.slice(-8, -7));
    expect(await publicTables()).not.toContain("trip_product");
    expect(await publicTables()).toContain("shape_registry");
    expect(await publicTables()).toContain("trip_instance_source");
    expect(await appliedVersions()).toEqual(older.slice(0, -8));
  });

  it("migrates all the way down to an empty public schema", async () => {
    const reverted = await migrateDownAll(runner);
    expect(reverted.map((m) => m.version)).toEqual(versions.slice(0, -19).reverse());
    expect(await publicTables()).toEqual([]);
    expect(await extensions()).toEqual({ plpgsql: "1.0" });
    const [leftovers] = await rows<{ count: string }>(
      `SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public')
            + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public') AS count`,
    );
    expect(leftovers?.count).toBe("0");
    expect(await appliedVersions()).toEqual([]);
    expect(await migrateDownAll(runner)).toEqual([]);
  });

  it("migrates up again after a full rollback", async () => {
    expect((await migrateUp(runner)).map((m) => m.version)).toEqual(versions);
    expect(await publicTables()).toEqual(expectedTables);
    await expect(generateTypes({ databaseUrl, verify: true })).resolves.toContain(
      "export interface DB",
    );
  });
});
