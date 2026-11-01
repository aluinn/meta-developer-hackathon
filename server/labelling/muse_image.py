"""A5: before/after room images with Muse Image, plus the character image.

From https://dev.meta.ai/docs (api-reference/images/edit-image, create-image, schemas; cookbook/image-editing-with-reasoning):
  POST https://api.meta.ai/v1/images/edits        JSON {model, prompt, images:[{image_url}], n, size, output_format}
  POST https://api.meta.ai/v1/images/generations  JSON {model, prompt, n, size, output_format}
Response: {"data": [{"b64_json": ...}]}. `size` only sets the aspect ratio. Billed $0.01 per image.
Muse Image only sees the photo and our words, so we describe each move in plain language, anchored on other objects.
"""
import base64
import io
import math
import time

import numpy as np
import requests
from PIL import Image

from .geometry import half_extents

EDIT_URL = "https://api.meta.ai/v1/images/edits"
GENERATE_URL = "https://api.meta.ai/v1/images/generations"
MODEL = "muse-image-1.0"
MAX_SIDE = 1024
MOVE_TOLERANCE_M = 0.005
MOVE_TOLERANCE_RAD = 0.005
CHANGE_THRESHOLD = 40  # per-pixel colour difference (0-255) that counts as "changed"
TOO_MUCH_CHANGE = 0.35  # heuristic: moved furniture rarely covers more than this share of a photo
RETRY_STATUS = {429, 503}


class ImageApiError(RuntimeError):
    pass


class WorldMismatch(ValueError):
    pass


# ---------- what moved, in words ----------

def find_moves(old: dict, new: dict) -> list[tuple[dict, dict]]:
    """Pairs (old object, new object) for objects whose position or rotation changed."""
    old_by_id = {o["id"]: o for o in old["objects"]}
    new_by_id = {o["id"]: o for o in new["objects"]}
    if old_by_id.keys() != new_by_id.keys():
        raise WorldMismatch("The old and new worlds must contain the same objects; only moves are supported.")
    moves = []
    for obj_id, before in old_by_id.items():
        after = new_by_id[obj_id]
        if (before["label"], before["size"], before["role"]) != (after["label"], after["size"], after["role"]):
            raise WorldMismatch(f"{obj_id} differs in label, size or role; only moves are supported.")
        moved = math.dist(before["position"], after["position"]) > MOVE_TOLERANCE_M
        turned = abs(before["rotation_y"] - after["rotation_y"]) > MOVE_TOLERANCE_RAD
        if moved or turned:
            moves.append((before, after))
    return moves


def _gap(a: dict, b: dict) -> float:
    ahx, ahz = half_extents(a)
    bhx, bhz = half_extents(b)
    dx = max(0.0, abs(a["position"][0] - b["position"][0]) - ahx - bhx)
    dz = max(0.0, abs(a["position"][2] - b["position"][2]) - ahz - bhz)
    return math.hypot(dx, dz)


def describe_place(obj: dict, world: dict, ignore_ids: set[str]) -> str:
    """Camera-independent description of where an object is: room position plus nearby objects."""
    bounds = world["room"]["bounds"]
    hx, hz = half_extents(obj)
    x, _, z = obj["position"]
    wall_gaps = [x - hx - bounds["min"][0], bounds["max"][0] - (x + hx), z - hz - bounds["min"][2], bounds["max"][2] - (z + hz)]
    near_walls = sum(g < 0.4 for g in wall_gaps)
    span_x, span_z = bounds["max"][0] - bounds["min"][0], bounds["max"][2] - bounds["min"][2]
    central = abs(x - (bounds["min"][0] + bounds["max"][0]) / 2) < 0.2 * span_x and abs(z - (bounds["min"][2] + bounds["max"][2]) / 2) < 0.2 * span_z
    if near_walls >= 2:
        where = "in a corner of the room"
    elif near_walls == 1:
        where = "against a wall"
    elif central:
        where = "in the middle of the room"
    else:
        where = "in the open floor area"

    others = [o for o in world["objects"] if o["id"] != obj["id"] and o["id"] not in ignore_ids]
    on_top = [o for o in others if o["role"] == "passable" and _gap(obj, o) == 0 and abs(o["position"][0] - x) < half_extents(o)[0] and abs(o["position"][2] - z) < half_extents(o)[1]]
    parts = [where]
    if on_top:
        parts.append(f"on the {on_top[0]['label']}")
    nearby = sorted((o for o in others if o not in on_top), key=lambda o: _gap(obj, o))[:2]
    for o in nearby:
        gap = _gap(obj, o)
        if gap < 0.05:
            parts.append(f"touching the {o['label']}")
        elif gap < 0.5:
            parts.append(f"right next to the {o['label']}")
        elif gap < 2.0:
            parts.append(f"about {gap:.1f} m from the {o['label']}")
    return ", ".join(parts)


def build_edit_prompt(old: dict, new: dict, moves: list[tuple[dict, dict]]) -> str:
    moved_ids = {b["id"] for b, _ in moves}
    lines = []
    for before, after in moves:
        text = f"- the {before['label']}: now {describe_place(before, old, moved_ids)}. Move it so it is {describe_place(after, new, moved_ids)}"
        distance = math.dist(before["position"], after["position"])
        if distance > MOVE_TOLERANCE_M:
            text += f" (about {distance:.1f} m from where it is now)"
        turn = math.degrees(after["rotation_y"] - before["rotation_y"])
        if abs(turn) > 1:
            text += f", and turn it by about {turn:.0f} degrees"
        lines.append(text + ".")
    return (
        "Edit this photo of a room by moving ONLY the following furniture:\n"
        + "\n".join(lines)
        + "\n\nKeep EVERYTHING else exactly as it is in the photo: the same camera angle and framing, walls, floor, ceiling, "
        "windows, doors, lighting, colours, textures, and every other object in its current position. "
        "Do not add, remove, resize or restyle anything. Show each moved object at its original size with natural shadows, "
        "and show the floor or wall that was hidden behind it where it used to be. "
        "If a moved object or its new place is not visible in the photo, leave that object unchanged."
    )


# ---------- photo in, comparison out ----------

def prepare_photo(data: bytes) -> Image.Image:
    """Open a phone photo (JPEG/PNG/WebP), fix its rotation, and shrink it to MAX_SIDE."""
    from PIL import ImageOps
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return img


def png_bytes(img: Image.Image) -> bytes:
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def changed_fraction(before: Image.Image, after: Image.Image) -> float | None:
    """Share of pixels that differ clearly. None if the aspect ratio changed too much to compare."""
    if abs(before.width / before.height - after.width / after.height) > 0.05:
        return None
    a = np.asarray(before.resize((256, 256 * before.height // before.width or 1)), dtype=np.int16)
    b = np.asarray(after.convert("RGB").resize(a.shape[1::-1]), dtype=np.int16)
    return float((np.abs(a - b).max(axis=2) > CHANGE_THRESHOLD).mean())


# ---------- Meta calls ----------

def _post(url: str, api_key: str, body: dict) -> dict:
    last = ""
    for attempt in range(3):
        try:
            response = requests.post(url, headers={"Authorization": f"Bearer {api_key}"}, json=body, timeout=180)
        except requests.RequestException as exc:
            raise ImageApiError(f"Could not reach the image service: {type(exc).__name__}") from exc
        if response.status_code == 200:
            return response.json()
        last = f"{response.status_code}: {response.text[:300]}"
        if response.status_code not in RETRY_STATUS:
            break
        time.sleep(2 ** attempt)  # docs: retryable failures return 503; back off
    raise ImageApiError(f"Image service returned {last}")


def _first_image(result: dict) -> Image.Image:
    try:
        return Image.open(io.BytesIO(base64.b64decode(result["data"][0]["b64_json"]))).convert("RGB")
    except (KeyError, IndexError, ValueError, OSError) as exc:
        raise ImageApiError("The image service returned no usable image.") from exc


def edit_photo(photo: Image.Image, prompt: str, api_key: str) -> Image.Image:
    body = {
        "model": MODEL,
        "prompt": prompt,
        "images": [{"image_url": "data:image/png;base64," + base64.b64encode(png_bytes(photo)).decode()}],
        "n": 1,
        "size": f"{photo.width}x{photo.height}",
        "output_format": "png",
    }
    return _first_image(_post(EDIT_URL, api_key, body))


def generate_image(prompt: str, api_key: str, size: str = "1024x1024") -> Image.Image:
    body = {"model": MODEL, "prompt": prompt, "n": 1, "size": size, "output_format": "png"}
    return _first_image(_post(GENERATE_URL, api_key, body))


def white_background_to_transparent(img: Image.Image, tolerance: int = 18) -> Image.Image:
    """Muse Image ignores a transparent-background request, so key out near-white pixels connected to the border."""
    from scipy import ndimage
    rgb = np.asarray(img.convert("RGB"), dtype=np.int16)
    near_white = (255 - rgb).max(axis=2) <= tolerance
    labels, _ = ndimage.label(near_white)
    border = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    background = np.isin(labels, list(border))
    alpha = np.where(background, 0, 255).astype(np.uint8)
    out = Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha]), "RGBA")
    return out
