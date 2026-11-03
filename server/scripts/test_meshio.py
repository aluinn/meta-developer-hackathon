"""Regression test: a scan with a huge texture must not use huge memory (it crashed the 512 MB server on Render).

Builds a small textured mesh with an 8192 x 2560 texture (like the bathroom scan), then checks in a fresh process that loading it
shrinks the texture and keeps peak memory well under the server's limit.

    python scripts/test_meshio.py
"""
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

SEVERAL_PEAK_LIMIT_MB = 400  # noise textures are a worst case (the real scan peaked at 257 MB); the old code needed over 1000 here
PEAK_LIMIT_MB = 400  # the server has 512 MB in total, Python plus its libraries use about 100, and noise is a worst case (the old code peaked at 574 MB on the real, compressible scan)


def load_in_fresh_process(path: Path) -> tuple[int, int, int]:
    """Load with load_mesh in a new process; return (triangles, longest texture side in px, peak memory in MB)."""
    probe = f"""
import resource, sys
sys.path.insert(0, {str(Path(__file__).resolve().parent.parent)!r})
from labelling.meshio import load_mesh
mesh = load_mesh({str(path)!r})
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
peak_mb = peak / (1024 * 1024) if sys.platform == 'darwin' else peak / 1024
tex = mesh.visual.material.baseColorTexture
print(f'{{len(mesh.faces)}} {{max(tex.size)}} {{peak_mb:.0f}}')
"""
    out = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True, check=True).stdout.split()
    return int(out[0]), int(out[1]), int(out[2])


def main() -> None:
    failures: list[str] = []
    path = Path(tempfile.mkdtemp(prefix="meshio_")) / "textured.glb"
    texture = Image.fromarray(np.random.default_rng(0).integers(0, 255, (2560, 8192, 3), dtype=np.uint8))
    mesh = trimesh.creation.icosphere(subdivisions=4)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(1).random((len(mesh.vertices), 2)), image=texture)
    mesh.export(path)
    print(f"test scan: {path.stat().st_size / 1e6:.1f} MB on disk, texture 8192x2560, {len(mesh.faces)} triangles")

    faces, longest_side, peak = load_in_fresh_process(path)
    print(f"after load_mesh: {faces} triangles, texture longest side {longest_side}px, peak memory {peak} MB (limit {PEAK_LIMIT_MB})")
    if faces != len(mesh.faces):
        failures.append("the mesh changed while loading")
    if longest_side > 2048:
        failures.append(f"texture was not shrunk (longest side {longest_side})")
    if peak > PEAK_LIMIT_MB:
        failures.append(f"peak memory {peak} MB is over {PEAK_LIMIT_MB} MB")

    # Several textured parts (Zac's room scan: three 4096 x 4096 textures) are packed together when merged: that peaked at 1.1 GB.
    several = trimesh.Scene()
    for i in range(3):
        part = trimesh.creation.icosphere(subdivisions=3)
        part.apply_translation([i * 3.0, 0, 0])
        noise = Image.fromarray(np.random.default_rng(10 + i).integers(0, 255, (4096, 4096, 3), dtype=np.uint8))
        part.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(20 + i).random((len(part.vertices), 2)), image=noise)
        several.add_geometry(part)
    several_path = path.parent / "several.glb"
    several.export(several_path)
    faces, longest_side, peak = load_in_fresh_process(several_path)
    print(f"three 4096 px textures: texture longest side {longest_side}px, peak memory {peak} MB (limit {SEVERAL_PEAK_LIMIT_MB})")
    if peak > SEVERAL_PEAK_LIMIT_MB:
        failures.append(f"three-texture scan: peak memory {peak} MB is over {SEVERAL_PEAK_LIMIT_MB} MB")
    print("FAIL: " + "; ".join(failures) if failures else "PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
