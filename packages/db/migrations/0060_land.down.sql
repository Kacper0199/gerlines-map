DROP TRIGGER stop_place_land_update ON stop_place;
DROP TRIGGER stop_place_land_insert ON stop_place;
DROP FUNCTION stop_place_land_on_update();
DROP FUNCTION stop_place_land_on_insert();
DROP FUNCTION assign_stop_place_lands(uuid[]);
DROP FUNCTION stop_place_land_rule(geometry, text, text);
DROP TABLE stop_place_land;
DROP TABLE land_area;
DROP TABLE land;
