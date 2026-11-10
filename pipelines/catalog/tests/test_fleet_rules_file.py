import yaml

from gerlines_catalog import commands
from gerlines_catalog.fleet import line_key
from gerlines_catalog.fleet_lists import LISTS_BY_SHORT, MATCH_SHARE_FLOOR, match_exception

from .conftest import CATALOG


def test_the_committed_generated_rules_keep_the_floor_and_cite_the_lists() -> None:
    text = (CATALOG / "fleet-rules.yaml").read_text()
    assert "gerlines-catalog fleet-ic-regional-lines" in text.split(commands.GENERATED_SECTION)[0]
    block = text.split(commands.GENERATED_SECTION, 1)[1].split(commands.NEXT_SECTION, 1)[0]
    rules = yaml.safe_load(block)
    sources = {spec.source_id: short for short, spec in LISTS_BY_SHORT.items()}
    assert rules
    for rule in rules:
        assert rule["source"] in sources
        if rule["match_share"] < MATCH_SHARE_FLOOR:
            label = rule["evidence"].split(":", 1)[0].split(",", 1)[0]
            exception = match_exception(sources[rule["source"]], line_key(label))
            assert exception is not None, rule["rule_id"]
            assert rule["match_share"] >= exception.floor
        assert "[[" not in rule["evidence"]
        assert "&#" not in rule["evidence"]
