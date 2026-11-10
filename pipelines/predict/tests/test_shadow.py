import gzip
import json
from datetime import UTC, date, datetime, timedelta

import polars as pl
import pytest

from gerlines_predict import shadow

AT = datetime(2026, 11, 7, 8, 0, tzinfo=UTC)
TABLE_CATEGORIES = ["hsr", "ld", "night", "rfast", "reg", "sbahn"]


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def trip_row(trip: str, source: str = "delfi-gtfs-rt", from_delay_s: int | None = 130, **kw):
    row = {
        "at": iso(AT),
        "trip": trip,
        "service_date": "2026-11-07",
        "category": "reg",
        "train_number": "12345",
        "source": source,
        "from_index": 3,
        "from_delay_s": from_delay_s,
        "forecast_stops": 1,
        "null_reason": None,
        "product": "RB",
    }
    return ["t", *{**row, **kw}.values()]


def stop_row(trip: str, index: int, ahead: int, **kw):
    row = {
        "at": iso(AT),
        "trip": trip,
        "stop_index": index,
        "ahead": ahead,
        "scheduled_arrival": iso(AT + timedelta(minutes=10 * ahead)),
        "feed_delay_s": 150,
        "prediction": "propagated",
        "eva": 8000105,
        "b1": 3,
        "b1_upper": 5,
        "level": "train",
        "runs": 40,
        "card": 2,
        "card_upper": 4,
        "basis": "feed_plus_spread",
    }
    return ["s", *{**row, **kw}.values()]


def write_details(path, rows) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row) + "\n")


def finals_frame(rows) -> pl.DataFrame:
    """Rows of (trip, stop_index, source, final minus the instant in s, delay in s)."""
    return pl.DataFrame(
        {
            "trip": [row[0] for row in rows],
            "stop_index": [row[1] for row in rows],
            "source": [row[2] for row in rows],
            "final_arrival": [AT + timedelta(seconds=row[3]) for row in rows],
            "final_delay_s": [row[4] for row in rows],
        },
        schema_overrides={"stop_index": pl.Int32, "final_arrival": pl.Datetime("ms", "UTC")},
    )


@pytest.fixture
def details(tmp_path):
    path = tmp_path / "details.jsonl.gz"
    write_details(
        path,
        [
            trip_row("a"),
            stop_row("a", 4, 1),
            stop_row("a", 5, 2, feed_delay_s=None, card=3, card_upper=5, basis="b1"),
            stop_row(
                "a",
                6,
                3,
                b1=None,
                b1_upper=None,
                level=None,
                runs=None,
                card=None,
                card_upper=None,
                basis=None,
            ),
            trip_row("b", source="gtfsde-rt", from_delay_s=-30, train_number="S1"),
            stop_row("b", 1, 1, feed_delay_s=0, b1=0, b1_upper=1, card=0, card_upper=1),
        ],
    )
    return shadow.read_details(path)


def test_read_details_splits_and_types(details):
    trips, stops = details
    assert trips.height == 2
    assert stops.height == 4
    assert trips.schema["from_delay_s"] == pl.Int64
    assert stops.schema["at"] == pl.Datetime("ms", "UTC")
    assert stops["b1"].to_list() == [3, 3, None, 0]


def test_read_details_reads_files_written_before_the_card_columns(tmp_path):
    path = tmp_path / "old.jsonl.gz"
    write_details(path, [trip_row("a"), stop_row("a", 4, 1)[:-3]])
    _, stops = shadow.read_details(path)
    assert stops.select("b1", "card", "card_upper", "basis").rows() == [(3, None, None, None)]


def test_read_finals_keeps_live_uncancelled_arrivals(tmp_path):
    path = tmp_path / "finals.csv"
    path.write_text(
        "trip_instance_id,stop_index,source_id,scheduled_arrival,final_arrival,final_quality,"
        "cancelled\n"
        "a,4,delfi-gtfs-rt,2026-11-07 08:10:00+00,2026-11-07 08:13:30+00,live,f\n"
        "a,5,delfi-gtfs-rt,2026-11-07 08:20:00+00,2026-11-07 08:21:00+00,carried,f\n"
        "a,6,delfi-gtfs-rt,2026-11-07 08:30:00+00,,,t\n"
        "a,7,delfi-gtfs-rt,,2026-11-07 08:40:00+00,live,f\n"
    )
    finals = shadow.read_finals(path)
    assert finals.select("trip", "stop_index", "final_delay_s").rows() == [("a", 4, 210)]


def test_pairs_scores_only_stops_reached_after_the_instant(details):
    trips, stops = details
    finals = finals_frame(
        [
            ("a", 4, "delfi-gtfs-rt", 600, 200),
            ("a", 5, "delfi-gtfs-rt", -60, 200),
            ("a", 6, "delfi-gtfs-rt", 1800, 300),
            ("a", 4, "gtfsde-rt", 600, 260),
            ("b", 1, "gtfsde-rt", 300, 20),
        ]
    )
    same = shadow.pairs(trips, stops, finals)
    assert sorted(same.select("trip", "stop_index").rows()) == [("a", 4), ("a", 6), ("b", 1)]
    other = shadow.pairs(trips, stops, finals, truth="other")
    assert other.select("trip", "stop_index", "final_delay_s").rows() == [("a", 4, 260)]


def test_forecasts_round_down_like_the_api(details):
    trips, stops = details
    finals = finals_frame([("a", 4, "delfi-gtfs-rt", 600, 239), ("b", 1, "gtfsde-rt", 300, -1)])
    scored = shadow.forecasts(shadow.pairs(trips, stops, finals)).sort("trip")
    assert scored["b0"].to_list() == [2.0, -1.0]
    assert scored["truth"].to_list() == [3.0, -1.0]
    assert scored["feed"].to_list() == [2.0, 0.0]
    assert scored["covered"].to_list() == [True, True]
    assert scored["feed_covered"].to_list() == [True, True]
    assert scored["card"].to_list() == [2.0, 0.0]
    assert scored["card_covered"].to_list() == [True, True]
    seconds = shadow.forecasts(shadow.pairs(trips, stops, finals), "seconds").sort("trip")
    assert seconds["truth"].to_list() == pytest.approx([239 / 60, -1 / 60])
    assert seconds["feed"].to_list() == pytest.approx([2.5, 0.0])
    with pytest.raises(ValueError, match="hours"):
        shadow.forecasts(shadow.pairs(trips, stops, finals), "hours")


def test_common_needs_all_three_forecasts(details):
    trips, stops = details
    finals = finals_frame(
        [
            ("a", 4, "delfi-gtfs-rt", 600, 200),
            ("a", 5, "delfi-gtfs-rt", 1200, 200),
            ("a", 6, "delfi-gtfs-rt", 1800, 200),
        ]
    )
    scored = shadow.forecasts(shadow.pairs(trips, stops, finals))
    assert shadow.common(scored)["stop_index"].to_list() == [4]
    cover = shadow.coverage(scored, ["trip"]).row(0, named=True)
    assert cover["pairs"] == 3
    assert cover["b1_share"] == pytest.approx(2 / 3)
    assert cover["feed_share"] == pytest.approx(2 / 3)


def scored_frame(values: dict[str, list[int]], trips: list[str] | None = None) -> pl.DataFrame:
    truth, b1, feed, upper = (values[name] for name in ("truth", "b1", "feed", "upper"))
    size = len(truth)
    return pl.DataFrame(
        {
            "trip": trips or [f"t{i}" for i in range(size)],
            "ahead_bin": ["1"] * size,
            "truth": [float(v) for v in truth],
            "b0": [float(v) for v in values["b0"]],
            "b1": [float(v) for v in b1],
            "feed": [float(v) for v in feed],
            "b1_upper": upper,
            "covered": [t <= u for t, u in zip(truth, upper, strict=True)],
            "feed_covered": [
                t <= f + u - b for t, f, u, b in zip(truth, feed, upper, b1, strict=True)
            ],
        }
    )


def test_summarise_errors_shares_and_cover():
    scored = scored_frame(
        {
            "truth": [0, 4, 10, 1],
            "b0": [0, 0, 0, 1],
            "b1": [1, 3, 4, 1],
            "feed": [0, 4, 9, 7],
            "upper": [2, 3, 6, 2],
        }
    )
    row = shadow.summarise(scored, ["ahead_bin"]).row(0, named=True)
    assert row["pairs"] == 4
    assert row["mae_b0"] == pytest.approx((0 + 4 + 10 + 0) / 4)
    assert row["mae_b1"] == pytest.approx((1 + 1 + 6 + 0) / 4)
    assert row["mae_feed"] == pytest.approx((0 + 0 + 1 + 6) / 4)
    assert row["bias_feed"] == pytest.approx((0 + 0 - 1 + 6) / 4)
    assert row["within2_b1"] == pytest.approx(3 / 4)
    assert row["within5_feed"] == pytest.approx(3 / 4)
    assert row["p80_cover"] == pytest.approx(2 / 4)
    assert row["feed_p80_cover"] == pytest.approx(1.0)
    assert row["p80_width"] == pytest.approx((1 + 0 + 2 + 1) / 4)


def test_summarise_scores_the_card_where_it_is_present():
    scored = scored_frame(
        {
            "truth": [0, 4, 10],
            "b0": [0, 0, 0],
            "b1": [1, 3, 4],
            "feed": [0, 4, 9],
            "upper": [2, 3, 6],
        }
    ).with_columns(
        pl.Series("card", [0.0, 4.0, 4.0]),
        pl.Series("card_covered", [True, True, False]),
        pl.Series("card_upper", [2, 4, 6]),
    )
    row = shadow.summarise(scored, ["ahead_bin"]).row(0, named=True)
    assert row["mae_card"] == pytest.approx((0 + 0 + 6) / 3)
    assert row["card_p80_cover"] == pytest.approx(2 / 3)
    assert row["card_p80_width"] == pytest.approx((2 + 0 + 2) / 3)
    assert "mae_card" not in shadow.summarise(scored.drop("card"), ["ahead_bin"]).columns


def test_card_report_matches_the_feed_where_it_anchors(details, tmp_path):
    trips, stops = details
    finals = finals_frame(
        [
            ("a", 4, "delfi-gtfs-rt", 600, 239),
            ("a", 5, "delfi-gtfs-rt", 1200, 400),
            ("b", 1, "gtfsde-rt", 300, 70),
        ]
    )
    scored = shadow.with_groups(shadow.forecasts(shadow.pairs(trips, stops, finals)))
    report = shadow.card_report(scored, replicates=50)
    anchored = [row for row in report["by_basis"] if row["basis"] == "feed_plus_spread"]
    assert {row["ahead_bin"] for row in anchored} == {"1"}
    assert anchored[0]["mae_card"] == pytest.approx(anchored[0]["mae_feed"])
    assert anchored[0]["card_p80_cover"] == pytest.approx(anchored[0]["feed_p80_cover"])
    assert report["basis_share"] == [
        {"ahead_bin": "1", "pairs": 2, "feed_plus_spread": 1.0},
        {"ahead_bin": "2", "pairs": 1, "feed_plus_spread": 0.0},
    ]
    assert report["card_minus_feed"][0]["difference"] == pytest.approx(0.0)
    assert [row["pairs"] for row in report["scored"]] == [2, 1]


def test_bootstrap_resamples_trips():
    scored = scored_frame(
        {"truth": [0] * 4, "b0": [1, 1, 3, 3], "b1": [0] * 4, "feed": [1] * 4, "upper": [0] * 4},
        trips=["x", "x", "y", "y"],
    )
    row = shadow.bootstrap(scored, "ahead_bin", "b1", "feed", replicates=200).row(0, named=True)
    assert row["difference"] == pytest.approx(-1.0)
    assert row["low"] == pytest.approx(-1.0)
    assert row["high"] == pytest.approx(-1.0)
    assert row["trips"] == 2
    spread = shadow.bootstrap(scored, "ahead_bin", "b1", "b0", replicates=200).row(0, named=True)
    assert spread["difference"] == pytest.approx(-2.0)
    assert spread["low"] == pytest.approx(-3.0)
    assert spread["high"] == pytest.approx(-1.0)


def packed(category: int, number: int, eva: int, band: int, horizon: int) -> int:
    return category * 2**45 + number * 2**21 + (eva - 8_000_000) * 2**4 + band * 2**2 + horizon


def table_file(rows) -> dict:
    return {
        "meta": {"key": {"categories": TABLE_CATEGORIES}, "minRuns": 20},
        "train": {"key": sorted(float(packed(*row)) for row in rows)},
    }


def test_train_numbers_unpack_category_and_number():
    table = table_file(
        [(4, 12345, 8000105, 1, 3), (4, 12345, 8000207, 0, 0), (0, 619, 8000261, 3, 2)]
    )
    numbers = shadow.train_numbers(table).sort("number")
    assert numbers.rows() == [("hsr", 619), ("reg", 12345)]


def test_mapping_counts_hits_and_numbers_under_another_category():
    trips = pl.DataFrame(
        {
            "trip": ["a", "a", "b", "c", "d", "e"],
            "category": ["reg", "reg", "sbahn", "rfast", "other", "reg"],
            "train_number": ["12345", "12345", "12345", "999", "77", "S1"],
            "source": ["delfi-gtfs-rt"] * 6,
        }
    )
    numbers = pl.DataFrame({"table_category": ["reg"], "number": [12345]})
    result = shadow.mapping(trips, numbers, TABLE_CATEGORIES)
    assert result["trips"] == 5
    assert result["outside_table"] == 1
    assert result["not_numeric_in_table_categories"] == 1
    assert result["known"] == 3
    assert result["train_rows_share"] == pytest.approx(1 / 3)
    assert result["number_under_other_category"] == [
        {"category": "sbahn", "table_category": "reg", "trips": 1}
    ]


def test_missing_reasons_split_absent_few_days_and_pruned(tmp_path):
    files = []
    for day, number, category in [
        (date(2026, 10, 1), "12345", "reg"),
        (date(2026, 10, 1), "500", "sbahn"),
        (date(2026, 10, 2), "500", "sbahn"),
        (date(2026, 10, 1), "600", "reg"),
        (date(2026, 10, 2), "600", "reg"),
        (date(2026, 10, 3), "600", "reg"),
        (date(2026, 10, 1), "700", "rfast"),
    ]:
        path = tmp_path / f"{day}-{number}-{category}.parquet"
        pl.DataFrame(
            {"service_date": [day], "train_number": [number], "category_code": [category]}
        ).write_parquet(path)
        files.append(path)
    days = shadow.piebro_days(files)
    trips = pl.DataFrame(
        {
            "trip": ["hit", "few", "pruned", "other", "absent"],
            "category": ["reg", "sbahn", "reg", "reg", "reg"],
            "train_number": ["12345", "500", "600", "700", "800"],
        }
    )
    numbers = pl.DataFrame({"table_category": ["reg"], "number": [12345]})
    reasons = shadow.missing_reasons(trips, numbers, days, min_runs=3)
    assert reasons == {"missing": 4, "absent": 2, "other_category": 1, "few_days": 1, "pruned": 1}


def test_bins_and_groups():
    frame = pl.DataFrame(
        {
            "ahead": [1, 4, 30, 11],
            "at": [AT] * 4,
            "scheduled_arrival": [AT + timedelta(minutes=m) for m in (-2, 16, 60, 121)],
            "from_delay_s": [-30, 300, 359, 960],
        }
    )
    labelled = shadow.with_groups(frame.with_columns(shadow.ahead_bin(), shadow.minutes_bin()))
    assert labelled["ahead_bin"].to_list() == ["1", "4_5", "21_30", "11_20"]
    assert labelled["minutes_bin"].to_list() == ["0_15", "16_30", "31_60", "over_120"]
    assert labelled["band"].to_list() == ["on_time", "1_5", "1_5", "over_15"]
    assert labelled["horizon_group"].to_list() == ["1", "4_10", "11_30", "11_30"]
