import json
import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException

from labelling.pipeline import label_scan
from labelling.roles import MuseSparkClient
from labelling.sam import MissingApiKey, SamClient
from labelling.world import build_world
from scans import SCANS_DIR

load_dotenv()  # reads .env if present; the key is never printed or returned

router = APIRouter()


def _scan_dir(scan_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    return SCANS_DIR / scan_id


@router.post("/scan/{scan_id}/label")
async def label(scan_id: str) -> dict:
    scan_dir = _scan_dir(scan_id)
    if not (scan_dir / "simplified.glb").exists():
        raise HTTPException(404, "No such scan. Upload it with POST /scan first.")
    try:
        sam = SamClient()
    except MissingApiKey as exc:
        raise HTTPException(503, str(exc)) from exc
    return await label_scan(scan_dir, sam, labeller_name="sam-3.1")


@router.post("/scan/{scan_id}/world")
async def make_world(scan_id: str) -> dict:
    """A3: give each labelled object a role with Muse Spark and write world.json."""
    scan_dir = _scan_dir(scan_id)
    if not (scan_dir / "labels.json").exists():
        raise HTTPException(404, "This scan has no labels yet. Run POST /scan/{scan_id}/label first.")
    try:
        assigner = MuseSparkClient()
    except MissingApiKey as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        return await build_world(scan_dir, assigner)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/world/{scan_id}")
def get_world(scan_id: str) -> dict:
    path = _scan_dir(scan_id) / "world.json"
    if not path.exists():
        raise HTTPException(404, "No world.json for this scan yet. Run POST /scan/{scan_id}/world first.")
    return json.loads(path.read_text())
