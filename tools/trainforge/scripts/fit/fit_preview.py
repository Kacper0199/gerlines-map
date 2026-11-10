"""Silhouette fit of a trainforge nose against a digitised outline.

Run with the preview server up (pnpm preview, port FIT_PORT, default 5813), a built dist and an open
Playwright session (playwright-cli -s=<FIT_SESSION, default fit> open about:blank):
  uv run --with numpy,pillow python scripts/fit/fit_preview.py scripts/fit/outlines/talent2.json

The outline JSON holds metres: side.top is the roof line as [setback behind the tip, height],
side.front the front edge from top to bottom, side.zmin and side.xmax the compared window,
side.body_floor (optional) the height of the
underbody edge behind the nose, which is not part of the compared profile.
Output: IoU and the largest deviation in metres, plus an overlay PNG in FIT_OUT (grey both, red
only ours, blue only the photo).
"""

import json
import os
import subprocess
import sys
import tempfile
from itertools import pairwise
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

S, W, H = 200, 1700, 1000
PORT = os.environ.get("FIT_PORT", "5813")
OUT = Path(os.environ.get("FIT_OUT", tempfile.gettempdir()))


def cli(*args):
    session = "-s=" + os.environ.get("FIT_SESSION", "fit")
    subprocess.run(["playwright-cli", session, *args], capture_output=True, check=True)  # noqa: S603, S607


WAIT = "async page => { await page.waitForSelector('body[data-ready]', {timeout: 20000}); }"


def shoot(model, c, out):
    url = f"http://127.0.0.1:{PORT}/?model={model}&lods=0&straight=1&ortho=side&sil=1&panel=0&scale={S}&c={c}"
    cli("resize", str(W), str(H))
    cli("goto", url)
    cli("run-code", WAIT)
    cli("screenshot", "--filename", out)
    mask = np.array(Image.open(out).convert("L")) > 128
    mask[:60, :340] = False
    return mask


def hausdorff(a, poly_line, geom, floor):
    """Largest distance in metres between our outline and the photo's roof and front edge."""
    cx, cz, zmin, xmax = geom
    rows = [(r, np.where(a[r])[0][-1]) for r in range(H) if a[r].any()]
    cols = [(np.where(a[:, c])[0][0], c) for c in range(W) if a[:, c].any()]
    ring = np.array(rows + cols)
    xs = cx + (ring[:, 1] - W / 2) / S
    zs = cz - (ring[:, 0] - H / 2) / S
    keep = (xs > -xmax + 0.05) & (xs < 0.05) & (zs > zmin + 0.2) & ~((zs < floor) & (xs < -0.6))
    ours = np.stack([xs[keep], zs[keep]], axis=1)
    line = []
    for (x0, z0), (x1, z1) in pairwise(poly_line):
        n = max(2, round(np.hypot(x1 - x0, z1 - z0) / 0.01))
        line.extend(zip(np.linspace(x0, x1, n), np.linspace(z0, z1, n), strict=True))
    line = np.array(line)
    line = line[(line[:, 0] > -xmax + 0.05) & (line[:, 1] > zmin + 0.2)]
    if len(ours) == 0 or len(line) == 0:
        return 9.99, "no outline"
    ours = ours[:: max(1, len(ours) // 800)]
    line = line[:: max(1, len(line) // 800)]
    d = np.sqrt(((ours[:, None, :] - line[None, :, :]) ** 2).sum(-1))
    o2p, p2o = d.min(axis=1), d.min(axis=0)
    if o2p.max() >= p2o.max():
        k = o2p.argmax()
        return o2p[k], f"our outline at x {ours[k][0]:.2f} z {ours[k][1]:.2f}"
    k = p2o.argmax()
    return p2o[k], f"photo outline at x {line[k][0]:.2f} z {line[k][1]:.2f}"


def side(o):
    s = o["side"]
    zmin, xmax = s["zmin"], s["xmax"]
    cx, cz = -4.0, 2.5
    ours = shoot(o["model"], f"{cx},{cz},0", str(OUT / f"fit_{o['tag']}_side_sil.png"))
    xs = (np.arange(W) - W / 2) / S + cx
    zs = cz - (np.arange(H) - H / 2) / S
    box = (
        (xs[None, :] <= 0.05) & (xs[None, :] >= -xmax) & (zs[:, None] >= zmin) & (zs[:, None] <= 5)
    )
    poly = [(-x, z) for x, z in s["top"] + s["front"]] + [(-xmax, zmin)]
    img = Image.new("L", (W, H), 0)
    ImageDraw.Draw(img).polygon(
        [((x - cx) * S + W / 2, (cz - z) * S + H / 2) for x, z in poly], fill=255
    )
    ref = np.array(img) > 0
    a, b = ours & box, ref & box
    iou = (a & b).sum() / max(1, (a | b).sum())
    dev, where = hausdorff(
        a, [(-x, z) for x, z in s["top"] + s["front"]], (cx, cz, zmin, xmax), s.get("body_floor", 0)
    )
    ov = np.full((H, W, 3), 255, np.uint8)
    ov[a & ~b] = (230, 60, 60)
    ov[b & ~a] = (60, 120, 230)
    ov[a & b] = (120, 120, 120)
    Image.fromarray(ov).save(OUT / f"fit_{o['tag']}_side.png")
    return iou, dev, where


if __name__ == "__main__":
    outline = json.loads(Path(sys.argv[1]).read_text())
    iou, dev, where = side(outline)
    print(f"{outline['tag']} side IoU {iou:.3f}, largest deviation {dev:.2f} m ({where})")
