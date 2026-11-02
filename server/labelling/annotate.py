"""Draw projected 3D boxes onto a rendered view. Used for the result image and for Muse Spark."""
import hashlib
import itertools

import numpy as np
from PIL import Image, ImageDraw

from .render import IMAGE_HEIGHT, IMAGE_WIDTH


def colour_for(label: str) -> tuple[int, int, int]:
    h = hashlib.md5(label.encode()).digest()
    return (80 + h[0] % 176, 80 + h[1] % 176, 80 + h[2] % 176)


def project(point, cam: dict):
    """Project a 3D point (metres) into a view. Returns (x, y) pixels or None if behind the camera."""
    rel = np.array(point) - np.array(cam["position"])
    xc, yc, zc = rel @ cam["right"], rel @ cam["up"], rel @ cam["forward"]
    if zc <= 0.05:
        return None
    focal = (IMAGE_WIDTH / 2) / np.tan(np.radians(cam["fov_degrees"]) / 2)
    return IMAGE_WIDTH / 2 + focal * xc / zc, IMAGE_HEIGHT / 2 - focal * yc / zc


def draw_boxes(img: Image.Image, cam: dict, objects: list[dict], text_key: str = "label") -> Image.Image:
    draw = ImageDraw.Draw(img)
    for obj in objects:
        lo, hi = obj["bbox"]["min"], obj["bbox"]["max"]
        corners = list(itertools.product(*zip(lo, hi)))
        pts = [project(c, cam) for c in corners]
        colour = colour_for(obj["label"])
        for i, j in itertools.combinations(range(8), 2):
            if sum(a != b for a, b in zip(corners[i], corners[j])) == 1 and pts[i] and pts[j]:
                draw.line([pts[i], pts[j]], fill=colour, width=2)
        visible = [p for p in pts if p]
        if visible:
            x, y = min(p[0] for p in visible), min(p[1] for p in visible)
            draw.text((max(x, 2), max(y - 11, 2)), str(obj[text_key]), fill=colour)
    return img
