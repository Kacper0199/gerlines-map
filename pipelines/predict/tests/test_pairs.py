import polars as pl

from gerlines_predict.pairs import band_of, horizon_of, served_stops, stop_pairs


def pairs_of(day_frames) -> pl.DataFrame:
    stops, trips = day_frames
    served = served_stops(stops.lazy(), trips.lazy()).collect()
    return stop_pairs(served).sort("train_number", "current_min", "ahead")


def test_rail_runs_only_and_cancelled_stops_left_out(day_frames):
    stops, trips = day_frames
    served = served_stops(stops.lazy(), trips.lazy()).collect()
    assert set(served["train_number"].to_list()) == {4711, 4712}
    b = served.filter(pl.col("train_number") == 4712).sort("position")
    assert b["eva"].to_list() == [8000001, 8000002, 8000004]
    assert b["position"].to_list() == [0, 1, 2]


def test_every_pair_with_known_current_delay_and_target_arrival(day_frames):
    pairs = pairs_of(day_frames)
    a = pairs.filter(pl.col("train_number") == 4711)
    assert a.select("current_min", "target_min", "ahead").rows() == [
        (0, 2, 1),
        (0, 4, 2),
        (0, 3, 3),
        (2, 4, 1),
        (2, 3, 2),
        (5, 3, 1),
    ]
    assert a["minutes_ahead"].to_list() == [9, 19, 29, 9, 19, 9]


def test_ahead_counts_served_stops_across_a_cancelled_one(day_frames):
    b = pairs_of(day_frames).filter(pl.col("train_number") == 4712)
    assert b.select("current_min", "target_min", "ahead", "minutes_ahead", "eva").rows() == [
        (1, 7, 1, 9, 8000002),
        (1, 20, 2, 29, 8000004),
        (8, 20, 1, 19, 8000004),
    ]


def test_current_delay_is_departure_else_arrival():
    stops = pl.DataFrame({"departure_delay_s": [None, 120, 59], "arrival_delay_s": [420, 60, None]})
    minutes = stops.select(
        pl.coalesce("departure_delay_s", "arrival_delay_s").floordiv(60).alias("m")
    )["m"].to_list()
    assert minutes == [7, 2, 0]


def test_bands_and_horizons():
    frame = pl.DataFrame({"m": [-3, 0, 1, 5, 6, 15, 16, 90]})
    assert frame.select(band_of(pl.col("m")).alias("b"))["b"].to_list() == [0, 0, 1, 1, 2, 2, 3, 3]
    ahead = pl.DataFrame({"k": [1, 2, 3, 4, 7, 8, 30]})
    assert ahead.select(horizon_of(pl.col("k")).alias("h"))["h"].to_list() == [0, 1, 1, 2, 2, 3, 3]


def test_no_pairs_keep_the_schema(day_frames):
    stops, trips = day_frames
    served = served_stops(stops.head(0).lazy(), trips.lazy()).collect()
    pairs = stop_pairs(served)
    assert pairs.height == 0
    assert pairs.schema["train_number"] == pl.UInt32
