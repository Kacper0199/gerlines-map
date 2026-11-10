import pytest

from gerlines_rail_graph.polyline import decode, encode


def test_decodes_the_reference_example_of_the_google_format():
    points = decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5)

    flat = [v for point in points for v in point]
    assert flat == pytest.approx([38.5, -120.2, 40.7, -120.95, 43.252, -126.453])


@pytest.mark.parametrize("precision", [5, 6, 7])
def test_round_trips_coordinates_at_each_precision(precision):
    coords = [(52.525, 13.369), (52.5251234, 13.3698765), (48.140, 11.558)]

    decoded = decode(encode(coords, precision), precision)

    flat = [v for point in decoded for v in point]
    assert flat == pytest.approx([v for point in coords for v in point], abs=10**-precision)


def test_returns_no_points_for_an_empty_string():
    assert decode("", precision=6) == []


def test_rejects_a_truncated_string():
    with pytest.raises(ValueError, match="truncated"):
        decode("_p~iF~ps|U_", precision=5)
