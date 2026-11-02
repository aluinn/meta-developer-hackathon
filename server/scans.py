import os
import uuid
from pathlib import Path

import trimesh
from fastapi import APIRouter, File, HTTPException, UploadFile

SCANS_DIR = Path(os.environ.get("SCANS_DIR") or Path(__file__).parent / "scans")  # set SCANS_DIR to use a mounted disk
ALLOWED_EXTENSIONS = {".glb", ".obj"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
TARGET_TRIANGLES = 50_000
CHUNK_BYTES = 1024 * 1024

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
    original_path = scan_dir / f"original{ext}"

    try:
        _save_limited(file, original_path)
        mesh = _load_mesh(original_path)
        triangles_before = len(mesh.faces)
        if triangles_before > TARGET_TRIANGLES:
            mesh = mesh.simplify_quadric_decimation(face_count=TARGET_TRIANGLES)
        mesh.export(scan_dir / "simplified.glb")
    except Exception:
        _remove_dir(scan_dir)
        raise

    return {
        "scan_id": scan_id,
        "triangles_before": triangles_before,
        "triangles_after": len(mesh.faces),
    }


def _save_limited(file: UploadFile, dest: Path) -> None:
    """Copy the upload to disk in chunks, stopping if it passes the size limit."""
    written = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(CHUNK_BYTES):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File is larger than 100MB.")
            out.write(chunk)


def _load_mesh(path: Path) -> trimesh.Trimesh:
    try:
        mesh = trimesh.load(path, force="mesh")
    except Exception as exc:
        raise HTTPException(422, f"Could not read the mesh: {exc}") from exc
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise HTTPException(422, "The file contains no triangles.")
    return mesh


def _remove_dir(path: Path) -> None:
    for child in path.iterdir():
        child.unlink()
    path.rmdir()
