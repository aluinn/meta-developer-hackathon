import asyncio
import json
import os
import re

from dotenv import load_dotenv
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from jsonschema import ValidationError, validate

from labelling.muse_image import (
    TOO_MUCH_CHANGE, ImageApiError, WorldMismatch, build_edit_prompt, changed_fraction, edit_photo, find_moves, png_bytes, prepare_photo,
)
from labelling.world import SCHEMA_PATH
from scans import SCANS_DIR

load_dotenv()

router = APIRouter()
MAX_PHOTO_BYTES = 15 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
SCAN_ID = r"^[0-9a-f]{32}$"


def _parse_world(name: str, text: str) -> dict:
    try:
        world = json.loads(text)
        validate(world, json.loads(SCHEMA_PATH.read_text()))
    except json.JSONDecodeError as exc:
        raise HTTPException(422, f"{name} is not valid JSON.") from exc
    except ValidationError as exc:
        raise HTTPException(422, f"{name} does not match shared/world.schema.json: {exc.message}") from exc
    return world


@router.post("/render")
async def render(
    scan_id: str = Form(..., pattern=SCAN_ID),
    photo: UploadFile = File(...),
    old_world: str = Form(...),
    new_world: str = Form(...),
) -> dict:
    """Before/after images: the photo, and the same photo with only the moved objects changed (Muse Image)."""
    api_key = os.environ.get("MODEL_API_KEY")
    if not api_key:
        raise HTTPException(503, "MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")
    old, new = _parse_world("old_world", old_world), _parse_world("new_world", new_world)
    try:
        moves = find_moves(old, new)
    except WorldMismatch as exc:
        raise HTTPException(422, str(exc)) from exc
    if not moves:
        raise HTTPException(422, "Nothing moved between old_world and new_world, so there is nothing to render.")

    data = bytearray()
    while chunk := await photo.read(CHUNK_BYTES):
        data += chunk
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "Photo is larger than 15MB.")
    try:
        before = prepare_photo(bytes(data))
    except Exception as exc:  # unreadable, HEIC, or a decompression bomb
        raise HTTPException(415, "Could not read the photo. Send a JPEG, PNG or WebP image.") from exc

    prompt = build_edit_prompt(old, new, moves)
    try:
        after = await asyncio.to_thread(edit_photo, before, prompt, api_key)
    except ImageApiError as exc:
        raise HTTPException(502, str(exc)) from exc

    out_dir = SCANS_DIR / scan_id / "render"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "before.png").write_bytes(png_bytes(before))
    (out_dir / "after.png").write_bytes(png_bytes(after))

    fraction = changed_fraction(before, after)
    return {
        "scan_id": scan_id,
        "before_url": f"/render/{scan_id}/before",
        "after_url": f"/render/{scan_id}/after",
        "moved": [{"id": b["id"], "label": b["label"], "from": b["position"], "to": a["position"]} for b, a in moves],
        "changed_fraction": None if fraction is None else round(fraction, 3),
        # Heuristic check that the model left the rest of the photo alone (None = images could not be compared).
        "likely_changed_too_much": None if fraction is None else fraction > TOO_MUCH_CHANGE,
        "prompt": prompt,
    }


@router.get("/render/{scan_id}/{which}")
def get_render(scan_id: str, which: str) -> FileResponse:
    if not re.fullmatch(SCAN_ID[1:-1], scan_id) or which not in ("before", "after"):
        raise HTTPException(400, "Invalid request.")
    path = SCANS_DIR / scan_id / "render" / f"{which}.png"
    if not path.exists():
        raise HTTPException(404, "No render yet. Run POST /render first.")
    return FileResponse(path, media_type="image/png")
