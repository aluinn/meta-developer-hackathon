"""Offline test of POST /scan, which loads and simplifies the scan in a separate worker process (labelling/worker.py).

    python scripts/test_upload_synthetic.py
"""
import io
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import scans  # noqa: E402
from main import app  # noqa: E402


def textured_sphere(texture_size=(7000, 3000)) -> bytes:
    """A sphere with a big (compressible) texture, like a phone scan."""
    w, h = texture_size
    pixels = np.dstack([np.tile(np.linspace(0, 255, w, dtype=np.uint8), (h, 1)), np.tile(np.linspace(0, 255, h, dtype=np.uint8)[:, None], (1, w)), np.full((h, w), 90, np.uint8)])
    mesh = trimesh.creation.icosphere(subdivisions=4)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(1).random((len(mesh.vertices), 2)), image=Image.fromarray(pixels))
    return mesh.export(file_type="glb")


def main() -> None:
    failures: list[str] = []
    root = Path(tempfile.mkdtemp(prefix="upload_"))
    scans.SCANS_DIR = root
    client = TestClient(app)

    def post(name: str, data: bytes):
        return client.post("/scan", files={"file": (name, data, "application/octet-stream")})

    # 1. a textured scan: the texture is shrunk in a compact original.glb, and a simplified.glb is written
    big = textured_sphere()
    r = post("room.glb", big)
    print(f"textured .glb ({len(big) / 1e6:.1f} MB): HTTP {r.status_code} {r.json()}")
    if r.status_code != 200:
        failures.append(f"textured upload failed: {r.status_code} {r.text[:200]}")
    else:
        d = root / r.json()["scan_id"]
        files = sorted(p.name for p in d.iterdir())
        tex = trimesh.load(d / "original.glb", force="mesh").visual.material.baseColorTexture
        print("  files:", files, "| texture in original.glb:", tex.size)
        if files != ["original.glb", "simplified.glb"]:
            failures.append(f"unexpected files: {files}")
        if max(tex.size) > 2048:
            failures.append("the saved original should have a shrunk texture")
        if (d / "original.glb").stat().st_size > len(big):
            failures.append("the compact original.glb should not be bigger than the upload")
        if r.json()["triangles_before"] != r.json()["triangles_after"]:
            failures.append("a small mesh should not be simplified")

    # 2. an .obj is converted: original.glb exists and original.obj is gone
    obj = trimesh.creation.icosphere(subdivisions=3).export(file_type="obj")
    r = post("room.obj", obj.encode() if isinstance(obj, str) else obj)
    d = root / r.json().get("scan_id", "none")
    print(f".obj: HTTP {r.status_code}, files {sorted(p.name for p in d.iterdir()) if d.exists() else None}")
    if r.status_code != 200 or sorted(p.name for p in d.iterdir()) != ["original.glb", "simplified.glb"]:
        failures.append("an .obj upload should end up as original.glb + simplified.glb")

    # 3. a big mesh is simplified to 50,000 triangles
    r = post("huge.glb", trimesh.creation.icosphere(subdivisions=7).export(file_type="glb"))
    print(f"327k-triangle mesh: {r.json()}")
    if r.status_code != 200 or r.json()["triangles_before"] != 327680 or r.json()["triangles_after"] != 50000:
        failures.append("a 327,680-triangle mesh should be simplified to 50,000")

    # 4. bad files: clear errors, and nothing left behind
    before = {p.name for p in root.iterdir()}
    for name, data, status, needle in (("bad.glb", b"this is not a mesh", 422, "read"), ("empty.obj", b"# nothing here\n", 422, ""), ("room.usdz", b"x", 400, "glb"), ("noext", b"x", 400, "glb")):
        r = post(name, data)
        print(f"  {name:10s} -> HTTP {r.status_code}: {r.json().get('detail', '')[:70]}")
        if r.status_code != status or needle not in r.json().get("detail", "").lower():
            failures.append(f"{name}: expected {status} mentioning '{needle}', got {r.status_code} {r.text[:100]}")
    if {p.name for p in root.iterdir()} != before:
        failures.append("failed uploads must not leave folders behind")

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
