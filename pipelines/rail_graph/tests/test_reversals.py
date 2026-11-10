import numpy as np

from gerlines_rail_graph import national
from gerlines_rail_graph.reversals import (
    GERMANY_BBOX,
    load_reversal_stations,
    reversal_points,
)


def test_every_curated_reversal_station_is_in_germany_with_its_evidence_and_source():
    stations = load_reversal_stations()

    assert len({s.name for s in stations}) == len(stations)
    for s in stations:
        assert GERMANY_BBOX[0] <= s.lon <= GERMANY_BBOX[2]
        assert GERMANY_BBOX[1] <= s.lat <= GERMANY_BBOX[3]
        assert s.evidence.strip()
        assert s.source.startswith("https://")
    assert reversal_points().shape == (len(stations), 2)


def test_an_empty_list_gives_no_reversal_points(tmp_path):
    empty = tmp_path / "none.csv"
    empty.write_text("name,lon,lat,evidence,source\n")

    assert reversal_points(empty).shape == (0, 2)
    assert np.isfinite(reversal_points()).all()


def test_the_evaluation_no_longer_allows_reversals_near_every_feed_stop():
    assert not hasattr(national, "station_points")
