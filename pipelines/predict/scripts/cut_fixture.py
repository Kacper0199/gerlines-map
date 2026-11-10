"""Cut a test fixture from a served B1 table: the meta, every category row, and the train and stop
rows of the given trains and EVA numbers.

    uv run python pipelines/predict/scripts/cut_fixture.py <table.json.gz> <out.json> \
        --train hsr:619 --eva 8000170 8000139 8000013 8000261
"""

import argparse
import gzip
import json
from pathlib import Path


def unpack(key: int, place: list[int]) -> int:
    shift, bits = place
    return (key >> shift) & ((1 << bits) - 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("table", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--train", nargs="+", required=True, help="category:number")
    parser.add_argument("--eva", nargs="+", type=int, required=True)
    args = parser.parse_args()
    table = json.loads(gzip.decompress(args.table.read_bytes()))
    key = table["meta"]["key"]
    fields = key["fields"]
    categories = key["categories"]
    trains = {(c, int(n)) for c, n in (item.split(":") for item in args.train)}
    evas = {eva - key["evaBase"] for eva in args.eva}
    wanted_categories = {categories.index(c) for c, _ in trains}

    def keep(level: str, packed: int) -> bool:
        category = unpack(packed, fields["category"])
        if level == "category":
            return category in wanted_categories
        eva_ok = unpack(packed, fields["eva"]) in evas
        if level == "stop":
            return category in wanted_categories and eva_ok
        number = unpack(packed, fields["train_number"])
        return eva_ok and (categories[category], number) in trains

    cut = {"format": table["format"], "meta": table["meta"]}
    for level in ("train", "stop", "category"):
        columns = table[level]
        rows = [i for i, packed in enumerate(columns["key"]) if keep(level, packed)]
        cut[level] = {name: [columns[name][i] for i in rows] for name in columns}
    cut["meta"]["counts"] = {
        f"{level}_rows": len(cut[level]["key"]) for level in ("train", "stop", "category")
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(cut, indent=2) + "\n")


if __name__ == "__main__":
    main()
