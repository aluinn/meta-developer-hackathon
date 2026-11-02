import json
import os
import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException

from labelling.match_score import score_scan
from labelling.sam import MissingApiKey, SamClient
from scans import SCANS_DIR

load_dotenv()

router = APIRouter()


def make_segmenter():
    return SamClient()


@router.get("/score/{scan_id}")
async def score(scan_id: str, refresh: bool = False) -> dict:
    """Scan-versus-simulation match score. Runs SAM 64 times (about $0.16) the first time, then serves the saved result
    until labels.json or world.json change, or until you pass ?refresh=true."""
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    scan_dir = SCANS_DIR / scan_id
    needed = [scan_dir / "labels.json", scan_dir / "world.json", scan_dir / "views" / "masks.npz"]
    if not all(p.exists() for p in needed):
        raise HTTPException(404, "Needs a labelled scan with a world.json: run POST /scan/{scan_id}/label and /world first (re-run /label if it was labelled before masks were saved).")
    saved = scan_dir / "score.json"
    if saved.exists() and not refresh and saved.stat().st_mtime >= max(p.stat().st_mtime for p in needed):
        return {**json.loads(saved.read_text()), "cached": True}
    try:
        segmenter = make_segmenter()
    except MissingApiKey as exc:
        raise HTTPException(503, str(exc)) from exc
    return {**await score_scan(scan_dir, segmenter), "cached": False}
