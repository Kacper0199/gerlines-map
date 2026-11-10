import json
import math
import sys


def camera(pose):
    """view=exact parameters of a camera placed from hand estimates, nose tip at the origin.

    pose keys: distance (metres from the nose tip), theta_deg (angle off the train axis), height,
    fpx (focal length in pixels), width and image_height (pixels), nose_px (image column of the
    nose centre line), side (-1 or 1: the side of the track the camera stands on, it sees the
    opposite side wall), dy_px (how far the horizon lies below the image centre).
    """
    distance, theta_deg, height = pose["distance"], pose["theta_deg"], pose["height"]
    fpx, width, image_height = pose["fpx"], pose["width"], pose["image_height"]
    nose_px, side, dy_px = pose["nose_px"], pose.get("side", -1), pose.get("dy_px", 0.0)
    theta = math.radians(theta_deg)
    cx, cz = distance * math.cos(theta), side * distance * math.sin(theta)
    norm = math.hypot(cx, cz)
    d0 = (-cx / norm, -cz / norm)
    right = (-d0[1], d0[0])
    off = math.atan((nose_px - width / 2) / fpx)
    d = (
        d0[0] * math.cos(off) - right[0] * math.sin(off),
        d0[1] * math.cos(off) - right[1] * math.sin(off),
    )
    reach = 50
    ct = (cx + d[0] * reach, height + reach * math.tan(math.atan(dy_px / fpx)), cz + d[1] * reach)
    vfov = math.degrees(2 * math.atan((image_height / 2) / fpx))
    return {
        "cp": f"{cx:.3f},{height:.3f},{cz:.3f}",
        "ct": f"{ct[0]:.3f},{ct[1]:.3f},{ct[2]:.3f}",
        "fov": f"{vfov:.4f}",
    }


if __name__ == "__main__":
    print(json.dumps(camera(json.loads(sys.argv[1]))))
