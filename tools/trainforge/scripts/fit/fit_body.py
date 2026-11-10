"""Fit harness for streamlined noses (WP-5.1 R11).

Rasterises a car body dumped by dump-body.ts orthographically (side, front, top) and through a
matched pinhole camera, and compares the silhouettes with digitised reference outlines: IoU and the
largest deviation in metres. Run with
`uv run --with opencv-python-headless,numpy,pyyaml python fit_body.py <body.json> <refs.yaml>`.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import yaml

MPP = 0.01
NOSE = 8.0

SLOT_RGB = {
    "window": (52, 60, 70),
    "glass": (70, 84, 96),
    "mask": (40, 44, 48),
    "stripe": (200, 20, 30),
    "light": (240, 238, 228),
    "tail": (190, 20, 28),
    "underframe": (70, 72, 74),
    "skirt": (120, 124, 128),
    "equipment": (150, 154, 158),
    "roof": (226, 228, 230),
    "mode": (226, 228, 230),
    "doors": (210, 212, 214),
}
DEFAULT_RGB = (236, 238, 240)


@dataclass
class Body:
    tris: np.ndarray
    slots: list[str]
    length: float
    width: float
    height: float

    @property
    def tip(self) -> float:
        return float(self.tris[:, :, 0].max())


def load_body(path: str) -> Body:
    d = json.loads(Path(path).read_text())
    tris = np.asarray(d["positions"], dtype=np.float64).reshape(-1, 3, 3)
    return Body(tris, d["slots"], d["length"], d["width"], d["height"])


def raster(
    polys: list[np.ndarray], origin: tuple[float, float], size: tuple[int, int]
) -> np.ndarray:
    """Fills polygons given in metres (a, b) into a mask: column from a, row from b downwards."""
    mask = np.zeros((size[1], size[0]), np.uint8)
    pts = [
        np.round(
            np.stack([(p[:, 0] - origin[0]) / MPP, (origin[1] - p[:, 1]) / MPP], 1) * 4
        ).astype(np.int32)
        for p in polys
    ]
    for poly in pts:
        cv2.fillPoly(mask, [poly], 255, lineType=cv2.LINE_8, shift=2)
    return mask


VIEWS = {
    "side": ((0, 2), (-NOSE - 0.5, 4.6), (int((NOSE + 1.0) / MPP), int(4.8 / MPP))),
    "front": ((1, 2), (-1.7, 4.6), (int(3.4 / MPP), int(4.8 / MPP))),
    "top": ((0, 1), (-NOSE - 0.5, 1.7), (int((NOSE + 1.0) / MPP), int(3.4 / MPP))),
}


def body_mask(body: Body, view: str, slots: set[str] | None = None) -> np.ndarray:
    """Orthographic silhouette of the first NOSE metres, x measured back from the tip (negative)."""
    axes, origin, size = VIEWS[view]
    tris = body.tris.copy()
    tris[:, :, 0] -= body.tip
    keep = tris[:, :, 0].max(axis=1) >= -NOSE
    keep &= np.array([s not in SHELL_EXCLUDE for s in body.slots])
    if slots is not None:
        keep &= np.array([s in slots for s in body.slots])
    polys = [t[:, axes] for t in tris[keep]]
    mask = raster(polys, origin, size)
    if view in ("side", "top"):
        cut = round((-NOSE - origin[0]) / MPP)
        mask[:, :cut] = 0
    return mask


def outline_mask(points: list[list[float]], view: str) -> np.ndarray:
    _, origin, size = VIEWS[view]
    mask = raster([np.asarray(points, np.float64)], origin, size)
    if view in ("side", "top"):
        cut = round((-NOSE - origin[0]) / MPP)
        mask[:, :cut] = 0
    return mask


def boundary(mask: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(mask)
    cv2.drawContours(out, contours, -1, 255, 1)
    return out


def compare(a: np.ndarray, b: np.ndarray, scale: float = MPP, ignore_cut: int = 0) -> dict:
    """IoU and the largest boundary distance between two masks; scale converts pixels to metres."""
    inter = np.logical_and(a > 0, b > 0).sum()
    union = np.logical_or(a > 0, b > 0).sum()
    ba, bb = boundary(a), boundary(b)
    if ignore_cut:
        ba[:, : ignore_cut + 2] = 0
        bb[:, : ignore_cut + 2] = 0
    da = cv2.distanceTransform(255 - bb, cv2.DIST_L2, 5)
    db = cv2.distanceTransform(255 - ba, cv2.DIST_L2, 5)
    dev_a = da[ba > 0]
    dev_b = db[bb > 0]
    worst = max(dev_a.max() if dev_a.size else 0, dev_b.max() if dev_b.size else 0)
    where = None
    if dev_a.size and dev_a.max() >= worst:
        ys, xs = np.nonzero(ba)
        i = int(np.argmax(da[ba > 0]))
        where = (int(xs[i]), int(ys[i]))
    elif dev_b.size:
        ys, xs = np.nonzero(bb)
        i = int(np.argmax(db[bb > 0]))
        where = (int(xs[i]), int(ys[i]))
    return {"iou": float(inter / max(union, 1)), "dev_m": float(worst * scale), "where_px": where}


def px_to_m(view: str, where: tuple[int, int] | None) -> tuple[float, float] | None:
    if where is None:
        return None
    _, origin, _ = VIEWS[view]
    return (round(origin[0] + where[0] * MPP, 2), round(origin[1] - where[1] * MPP, 2))


# ---- perspective ------------------------------------------------------------------------------


@dataclass
class Camera:
    f: float
    cx: float
    cy: float
    width: int
    height: int
    position: tuple[float, float, float]
    target: tuple[float, float, float]
    roll_deg: float = 0.0

    def rotation(self) -> np.ndarray:
        c = np.asarray(self.position, float)
        fwd = np.asarray(self.target, float) - c
        fwd /= np.linalg.norm(fwd)
        up = np.array([0.0, 0.0, 1.0])
        right = np.cross(fwd, up)
        right /= np.linalg.norm(right)
        down = np.cross(fwd, right)
        r = math.radians(self.roll_deg)
        cr, sr = math.cos(r), math.sin(r)
        right, down = right * cr + down * sr, -right * sr + down * cr
        return np.stack([right, down, fwd])

    def project(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        rot = self.rotation()
        cam = (pts - np.asarray(self.position, float)) @ rot.T
        z = cam[..., 2]
        u = self.cx + self.f * cam[..., 0] / z
        v = self.cy + self.f * cam[..., 1] / z
        return np.stack([u, v], -1), z


SHELL_EXCLUDE = {"underframe"}


def render(body: Body, cam: Camera, light=(0.4, -0.7, 0.6)) -> tuple[np.ndarray, np.ndarray]:
    """Flat-shaded painter's render and the shell's silhouette (underframe boxes left out)."""
    uv, z = cam.project(body.tris)
    order = np.argsort(-z.mean(axis=1))
    img = np.zeros((cam.height, cam.width, 3), np.uint8)
    mask = np.zeros((cam.height, cam.width), np.uint8)
    n = np.cross(body.tris[:, 1] - body.tris[:, 0], body.tris[:, 2] - body.tris[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    to_cam = np.asarray(cam.position, float) - body.tris.mean(axis=1)
    facing = np.sign((n * to_cam).sum(axis=1))
    n *= facing[:, None]
    lv = np.asarray(light, float)
    lv /= np.linalg.norm(lv)
    shade = 0.55 + 0.45 * np.clip(n @ lv, 0, 1)
    for i in order:
        if (z[i] <= 0.1).any():
            continue
        pts = np.round(uv[i] * 4).astype(np.int32)
        rgb = SLOT_RGB.get(body.slots[i], DEFAULT_RGB)
        col = tuple(int(c * shade[i]) for c in rgb[::-1])
        cv2.fillPoly(img, [pts], col, lineType=cv2.LINE_AA, shift=2)
        if body.slots[i] not in SHELL_EXCLUDE:
            cv2.fillPoly(mask, [pts], 255, shift=2)
    return img, mask


def load_refs(path: str) -> dict:
    return yaml.safe_load(Path(path).read_text())


def camera_from(ref: dict) -> Camera:
    c = ref["camera"]
    return Camera(
        c["f"],
        c["cx"],
        c["cy"],
        c["width"],
        c["height"],
        tuple(c["position"]),
        tuple(c["target"]),
        c.get("roll_deg", 0.0),
    )


def photo_mask(ref: dict, cam: Camera) -> np.ndarray:
    mask = np.zeros((cam.height, cam.width), np.uint8)
    cv2.fillPoly(mask, [np.asarray(ref["silhouette_px"], np.int32)], 255)
    return mask


def main() -> None:
    body = load_body(sys.argv[1])
    refs = load_refs(sys.argv[2])
    out = {}
    for view in ("side", "front", "top"):
        r = refs.get("ortho", {}).get(view)
        if not r:
            continue
        a = body_mask(body, view)
        b = outline_mask(r, view)
        res = compare(a, b)
        res["where_m"] = px_to_m(view, res.pop("where_px"))
        out[view] = res
    print(json.dumps(out))


if __name__ == "__main__":
    main()
