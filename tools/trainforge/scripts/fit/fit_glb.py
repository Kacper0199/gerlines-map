"""Silhouette fit of a car nose against digitised outlines.

Renders the triangles written by dump-glb.ts orthographically from the side (setback s, height z),
the front (lateral y, height z) and the top (s, y) at a fixed scale, compares each silhouette with
the outline in an outline.yaml, and reports silhouette IoU and the largest deviation in metres per
view over the nose region (the first `region_m` metres behind the tip). With `tip_z_min_m` the tip
is the forward-most point at or above that height, so buffers and couplers ahead of the body are
left out as they are in the photo.

usage: uv run --with opencv-python-headless,numpy,pyyaml python fit_glb.py <tris.f32> <outline.yaml>
       [--out prefix] [--json out.json] [--label text]
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import yaml

PX = 100.0


def load_tris(path):
    return np.fromfile(path, dtype=np.float32).reshape(-1, 3, 3).astype(np.float64)


def px(value):
    return round(value * PX)


def raster(polys, bounds):
    (u0, u1), (v0, v1) = bounds
    m = np.zeros((px(v1 - v0) + 1, px(u1 - u0) + 1), np.uint8)
    for p in polys:
        q = np.stack([(p[:, 0] - u0) * PX, (v1 - p[:, 1]) * PX], 1).round().astype(np.int32)
        if len(q) == 3:
            cv2.fillConvexPoly(m, q, 1)
        else:
            cv2.fillPoly(m, [q], 1)
    return m


def mirrored(half):
    """Polygon from half widths [[a, w], ...] sorted by a, mirrored about w = 0."""
    h = sorted(half, key=lambda p: p[0])
    return np.array([(a, w) for a, w in h] + [(a, -w) for a, w in reversed(h)], float)


def boundary(m):
    e = cv2.morphologyEx(m, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    return e & (m > 0)


def deviation(model, ref, cut):
    """Largest distance in metres from a boundary pixel of either mask to the other boundary."""
    bm, br = boundary(model) & cut, boundary(ref) & cut
    dm = cv2.distanceTransform((~boundary(model)).astype(np.uint8), cv2.DIST_L2, 5)
    dr = cv2.distanceTransform((~boundary(ref)).astype(np.uint8), cv2.DIST_L2, 5)
    a = dr[bm] if bm.any() else np.array([0.0])
    b = dm[br] if br.any() else np.array([0.0])
    on, mask, dist = ("model", bm, dr) if a.max() >= b.max() else ("reference", br, dm)
    where = None
    if mask.any():
        ys, xs = np.where(mask)
        k = int(np.argmax(dist[mask]))
        where = (int(xs[k]), int(ys[k]), on)
    worst = max(a.max(), b.max())
    return worst / PX, np.percentile(np.concatenate([a, b]), 95) / PX, where


def overlay(model, ref, path, label):
    img = np.full((*model.shape, 3), 255, np.uint8)
    img[(model > 0) & (ref == 0)] = (230, 160, 60)
    img[(model == 0) & (ref > 0)] = (60, 60, 230)
    img[(model > 0) & (ref > 0)] = (200, 200, 200)
    img[boundary(ref) | (cv2.morphologyEx(ref, cv2.MORPH_GRADIENT, np.ones((3, 3))) > 0)] = (
        0,
        0,
        180,
    )
    for i in range(0, img.shape[1], int(PX)):
        img[:, i] = (img[:, i] * 0.85).astype(np.uint8)
    for j in range(img.shape[0] - 1, -1, -int(PX)):
        img[j, :] = (img[j, :] * 0.85).astype(np.uint8)
    cv2.putText(img, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1)
    cv2.imwrite(path, img)


def views(tris, ref):
    """Model and reference masks per view: (model, reference, horizontal origin) by view name."""
    region = float(ref.get("region_m", 8.0))
    zcut = float(ref.get("side_z_cut_m", 0.0))
    above = tris[:, :, 2] >= float(ref.get("tip_z_min_m", -1.0))
    s = tris[:, :, 0][above].max() - tris[:, :, 0]
    y, z = tris[:, :, 1], tris[:, :, 2]
    near = np.where(s.min(1) <= region)[0]
    zmax = max(z.max(), 4.6)
    out = {}
    if ref.get("side"):
        side = ref["side"]
        poly = np.array(side["upper"] + list(reversed(side["lower"])), float)
        bounds = ((0.0, region), (zcut, zmax))
        out["side"] = (
            raster([np.stack([s[i], z[i]], 1) for i in near], bounds),
            raster([poly], bounds),
        )
    for view in ("front", "top"):
        spec = ref.get(view)
        if not spec:
            continue
        half = max(np.abs(y).max(), *(w for _, w in spec["half_widths"])) + 0.1
        if view == "front":
            bounds = ((-half, half), (float(spec.get("z_cut_m", zcut)), zmax))
            pts = [np.stack([y[i], z[i]], 1) for i in near]
        else:
            bounds = ((0.0, region), (-half, half))
            pts = [np.stack([s[i], y[i]], 1) for i in near]
        out[view] = (raster(pts, bounds), raster([mirrored(spec["half_widths"])], bounds))
    return out, zmax, region, zcut


def kept(view, shape, ref, zmax):
    keep = np.ones(shape, bool)
    if view == "side":
        for s0, s1, z0, z1 in ref.get("side_exclude", []):
            keep[max(0, px(zmax - z1)) : max(0, px(zmax - z0)) + 1, max(0, px(s0)) : px(s1) + 1] = (
                False
            )
    return keep


def located(view, where, shape, zmax):
    if not where:
        return None
    x, y, who = where
    if view == "side":
        return {"s": round(x / PX, 2), "z": round(zmax - y / PX, 2), "on": who}
    if view == "front":
        return {"y": round(x / PX - shape[1] / PX / 2, 2), "z": round(zmax - y / PX, 2), "on": who}
    return {"s": round(x / PX, 2), "y": round(shape[0] / PX / 2 - y / PX, 2), "on": who}


def compare(view, mm, mr, ref, frame):
    zmax, region, zcut = frame
    keep = kept(view, mm.shape, ref, zmax)
    inter = (mm.astype(bool) & mr.astype(bool) & keep).sum()
    union = ((mm.astype(bool) | mr.astype(bool)) & keep).sum()
    cut = cv2.erode(keep.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    if view in ("side", "top"):
        cut[:, px(region - 0.03) :] = False
    if view == "side" and zcut > 0:
        cut[-4:, :] = False
    dmax, d95, where = deviation(mm, mr, cut)
    report = {
        "iou": round(float(inter / max(union, 1)), 4),
        "max_dev_m": round(float(dmax), 3),
        "p95_dev_m": round(float(d95), 3),
        "worst_at": located(view, where, mm.shape, zmax),
    }
    return report, keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tris")
    ap.add_argument("outline")
    ap.add_argument("--out")
    ap.add_argument("--json")
    ap.add_argument("--label", default="")
    a = ap.parse_args()
    with Path(a.outline).open() as f:
        ref = yaml.safe_load(f)
    masks, zmax, region, zcut = views(load_tris(a.tris), ref)
    report = {}
    for view, (mm, mr) in masks.items():
        report[view], keep = compare(view, mm, mr, ref, (zmax, region, zcut))
        if a.out:
            r = report[view]
            text = f"{a.label} {view} IoU {r['iou']:.3f} max {r['max_dev_m']:.2f} m"
            overlay(mm * keep, mr * keep, f"{a.out}-{view}.png", text)
    print(json.dumps(report))
    if a.json:
        with Path(a.json).open("w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
