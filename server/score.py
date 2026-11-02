import json
import os
import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException

from labelling.match_score import METHODS, score_scan
from labelling.sam import MissingApiKey, SamClient
from scans import SCANS_DIR

load_dotenv()

router = APIRouter()


def make_segmenter():
    return SamClient()


@router.get("/score/{scan_id}")
async def score(scan_id: str, method: str = "silhouette", refresh: bool = False) -> dict:
    """Scan-versus-simulation match score.

    method=silhouette (default): compares each box's outline in a render of world.json with SAM's mask of that object on the scan. Free.
    method=sam_on_render: runs SAM 64 times (about $0.16) on the render and compares SAM's masks; works only on realistic renders.
    The result is saved and served again until labels.json or world.json change, or until you pass ?refresh=true."""
    if method not in METHODS:
        raise HTTPException(422, f"method must be one of {list(METHODS)}")
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    scan_dir = SCANS_DIR / scan_id
    needed = [scan_dir / "labels.json", scan_dir / "world.json", scan_dir / "views" / "masks.npz"]
    if not all(p.exists() for p in needed):
        raise HTTPException(404, "Needs a labelled scan with a world.json: run POST /scan/{scan_id}/label and /world first (re-run /label if it was labelled before masks were saved).")
    saved = scan_dir / "score.json"
    if saved.exists() and not refresh and saved.stat().st_mtime >= max(p.stat().st_mtime for p in needed):
        cached = json.loads(saved.read_text())
        if cached.get("method_name") == method:
            return {**cached, "cached": True}
    segmenter = None
    if method == "sam_on_render":
        try:
            segmenter = make_segmenter()
        except MissingApiKey as exc:
            raise HTTPException(503, str(exc)) from exc
    return {**await score_scan(scan_dir, segmenter, method), "cached": False}
