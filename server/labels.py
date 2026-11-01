import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException

from labelling.pipeline import label_scan
from labelling.sam import MissingApiKey, SamClient
from scans import SCANS_DIR

load_dotenv()  # reads .env if present; the key is never printed or returned

router = APIRouter()


@router.post("/scan/{scan_id}/label")
async def label(scan_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    scan_dir = SCANS_DIR / scan_id
    if not (scan_dir / "simplified.glb").exists():
        raise HTTPException(404, "No such scan. Upload it with POST /scan first.")
    try:
        sam = SamClient()
    except MissingApiKey as exc:
        raise HTTPException(503, str(exc)) from exc
    return await label_scan(scan_dir, sam, labeller_name="sam-3.1")
