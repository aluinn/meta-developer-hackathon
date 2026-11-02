import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

SERVER_DIR = Path(__file__).resolve().parent
SCANS_DIR = Path(os.environ.get("SCANS_DIR") or SERVER_DIR / "scans")  # set SCANS_DIR to use a mounted disk
ALLOWED_EXTENSIONS = {".glb", ".obj"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
PREPARE_TIMEOUT_S = 300

router = APIRouter()


@router.post("/scan")
def upload_scan(file: UploadFile = File(...)) -> dict[str, str | int]:
    # Only the extension of the client's filename is used; we pick the stored name.
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Only .glb or .obj files are accepted.")

    scan_id = uuid.uuid4().hex
    scan_dir = SCANS_DIR / scan_id
    scan_dir.mkdir(parents=True)

    try:
        _save_limited(file, scan_dir / f"original{ext}")
        result = _prepare(scan_dir)
    except Exception:
        _remove_dir(scan_dir)
        raise

    return {"scan_id": scan_id, "triangles_before": result["triangles_before"], "triangles_after": result["triangles_after"]}


@router.get("/scan/{scan_id}/mesh")
def get_scan_mesh(scan_id: str) -> FileResponse:
    """The scan itself (with its colours), for the website's 3D view. It is the compact original.glb the upload step saved."""
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    path = SCANS_DIR / scan_id / "original.glb"
    if not path.exists():
        raise HTTPException(404, "No such scan.")
    return FileResponse(path, media_type="model/gltf-binary")


def _prepare(scan_dir: Path) -> dict:
    """Load and simplify the mesh in a separate process (see labelling/worker.py): a scan with a big texture needs a lot of memory
    while it loads, and a separate process gives all of it back when it exits instead of leaving the web server fat."""
    try:
        run = subprocess.run([sys.executable, "-m", "labelling.worker", "prepare", str(scan_dir)], cwd=SERVER_DIR,
                             capture_output=True, text=True, timeout=PREPARE_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(422, "Processing that scan took too long. Try a smaller or simpler scan.") from exc
    events = []
    for line in run.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass  # not one of ours
    event = events[-1] if events else None
    if event and event.get("event") == "prepared":
        return event
    if event and event.get("event") == "error":
        raise HTTPException(422, event.get("message", "Could not read that scan."))
    raise HTTPException(422, "The server could not process that scan; it may be too large or complex. Try a smaller or simpler scan.")


def _save_limited(file: UploadFile, dest: Path) -> None:
    """Copy the upload to disk in chunks, stopping if it passes the size limit."""
    written = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(CHUNK_BYTES):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File is larger than 100MB.")
            out.write(chunk)


def _remove_dir(path: Path) -> None:
    for child in path.iterdir():
        child.unlink()
    path.rmdir()
