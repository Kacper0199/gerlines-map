-- SP-1 proof that a MOTIS user script can move DELFI night trains into the NIGHT class.
-- DELFI files NJ, EN and night lines named like 27N as route_type 102, which MOTIS reads as LONG_DISTANCE.
-- Kept to rerun SP-1 only: the router service imports the enriched feed, whose route types carry our categories.

local function is_night_name(name)
  return name == "NJ" or name == "EN" or string.match(name, "^%d+N$") ~= nil
end

function process_route(route)
  if route:get_route_type() == 102 and is_night_name(route:get_short_name()) then
    route:set_route_type(SLEEPER_RAIL_SERVICE)
  end
  return true
end
