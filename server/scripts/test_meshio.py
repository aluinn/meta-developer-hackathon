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

PEAK_LIMIT_MB = 400  # the server has 512 MB in total, Python plus its libraries use about 100, and noise is a worst case (the old code peaked at 574 MB on the real, compressible scan)


def main() -> None:
    failures: list[str] = []
    path = Path(tempfile.mkdtemp(prefix="meshio_")) / "textured.glb"
    texture = Image.fromarray(np.random.default_rng(0).integers(0, 255, (2560, 8192, 3), dtype=np.uint8))
    mesh = trimesh.creation.icosphere(subdivisions=4)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(1).random((len(mesh.vertices), 2)), image=texture)
    mesh.export(path)
    print(f"test scan: {path.stat().st_size / 1e6:.1f} MB on disk, texture 8192x2560, {len(mesh.faces)} triangles")

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
    faces, longest_side, peak = int(out[0]), int(out[1]), int(out[2])
    print(f"after load_mesh: {faces} triangles, texture longest side {longest_side}px, peak memory {peak} MB (limit {PEAK_LIMIT_MB})")
    if faces != len(mesh.faces):
        failures.append("the mesh changed while loading")
    if longest_side > 2048:
        failures.append(f"texture was not shrunk (longest side {longest_side})")
    if peak > PEAK_LIMIT_MB:
        failures.append(f"peak memory {peak} MB is over {PEAK_LIMIT_MB} MB")
    print("FAIL: " + "; ".join(failures) if failures else "PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
