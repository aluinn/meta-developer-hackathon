"""Offline test of A2 (render -> project -> vote -> boxes) with NO Meta API calls.

Builds a fake living room, renders it, and uses a fake "SAM" that finds objects by
colour, with deliberate mistakes (a wrong label in one view, a false patch in another).
This tests our code, not SAM itself.

    python scripts/test_labelling_synthetic.py
"""
import asyncio
import io
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.pipeline import label_scan  # noqa: E402
from labelling.types import Detection  # noqa: E402

# label -> (centre, size, colour). Same layout as shared/example_world.json.
FURNITURE = {
    "sofa": ([-1.8, 0.4, -1.8], [2.0, 0.8, 0.9], (230, 30, 30)),
    "bookshelf": ([2.8, 1.0, -1.0], [0.3, 2.0, 1.2], (30, 200, 30)),
    "table": ([0.0, 0.2, 0.0], [1.1, 0.4, 0.6], (40, 40, 240)),
    "chair": ([1.5, 0.45, 1.2], [0.5, 0.9, 0.5], (240, 220, 30)),
    "rug": ([0.0, 0.02, 1.0], [2.0, 0.04, 1.2], (230, 30, 230)),
    "door": ([0.0, 1.0, 2.45], [0.9, 2.0, 0.1], (30, 220, 220)),
}
SHELL = {  # room shell: floor and walls
    "floor": ([0, -0.05, 0], [6.0, 0.1, 5.0], (150, 135, 110)),
    "wall_n": ([0, 1.25, -2.55], [6.0, 2.5, 0.1], (175, 175, 175)),
    "wall_s": ([0, 1.25, 2.55], [6.0, 2.5, 0.1], (175, 175, 175)),
    "wall_w": ([-3.05, 1.25, 0], [0.1, 2.5, 5.0], (175, 175, 175)),
    "wall_e": ([3.05, 1.25, 0], [0.1, 2.5, 5.0], (175, 175, 175)),
}


def build_room() -> trimesh.Trimesh:
    parts = []
    for centre, size, colour in [*SHELL.values(), *FURNITURE.values()]:
        box = trimesh.creation.box(extents=size)
        box.apply_translation(centre)
        box = box.subdivide_to_size(0.2)
        box.visual.vertex_colors = np.tile([*colour, 255], (len(box.vertices), 1))
        parts.append(box)
    return trimesh.util.concatenate(parts)


class FakeSam:
    """Finds objects by chromaticity (colour hue, ignoring shading) and makes some mistakes."""

    def __init__(self):
        self.reference = {name: np.array(c, float) / np.linalg.norm(c) for name, (_, _, c) in FURNITURE.items()}
        self.reference["wall"] = np.array([175.0] * 3) / np.linalg.norm([175.0] * 3)
        self.reference["floor"] = np.array([150.0, 135, 110]) / np.linalg.norm([150.0, 135, 110])
        self.rng = np.random.default_rng(0)

    async def segment(self, view_index: int, png: bytes, prompt: str) -> list[Detection]:
        rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), float)
        norm = np.linalg.norm(rgb, axis=2, keepdims=True)
        chroma = rgb / np.maximum(norm, 1e-6)
        names = list(self.reference)
        dist = np.stack([np.linalg.norm(chroma - self.reference[n], axis=2) for n in names])
        classified = np.array(names)[dist.argmin(axis=0)]
        classified[(rgb == 200).all(axis=2)] = "background"

        out = []
        truth = prompt
        if view_index == 3 and prompt == "bed":
            truth = "sofa"  # MISTAKE 1: in view 3 the sofa is called a "bed"
        if view_index == 5 and prompt == "chair":
            truth = "wall"  # MISTAKE 2: in view 5 a wall patch is called a "chair"
        if view_index == 3 and prompt == "sofa":
            return []  # ...and the real "sofa" detection is missing there
        mask_all = classified == truth
        blobs, count = ndimage.label(mask_all)
        for k in range(1, count + 1):
            blob = blobs == k
            if blob.sum() < 40:
                continue
            blob &= self.rng.random(blob.shape) > 0.1  # 10% of pixels dropped
            out.append(Detection(view_index, prompt, float(self.rng.uniform(0.7, 0.95)), blob))
        if truth == "wall":
            out = out[:1]
        return out


def test_patch_merging() -> list[str]:
    """Real scans are patchy: one object can arrive as several disconnected patches. Close ones must merge, far ones must not."""
    import numpy as np
    from labelling.vote import group_objects

    def patch(x):
        box = trimesh.creation.box(extents=[0.3, 0.3, 0.3]).subdivide_to_size(0.05)
        box.apply_translation([x, 0, 0])
        return box

    problems = []
    for name, xs, expected in (("two overlapping patches", [0.0, 0.2], 1), ("two patches 2 m apart", [0.0, 2.0], 2), ("three in a chain", [0.0, 0.2, 0.4], 1)):
        mesh = trimesh.util.concatenate([patch(x) for x in xs])
        found = group_objects(mesh, np.zeros(len(mesh.faces), dtype=int), np.ones(len(mesh.faces)), ["toilet"])
        print(f"  merge test, {name}: {len(found)} object(s)")
        if len(found) != expected:
            problems.append(f"{name}: expected {expected} object(s), got {len(found)}")
    return problems


def main() -> None:
    scan_dir = Path(tempfile.mkdtemp(prefix="a2test_")) / "scan"
    scan_dir.mkdir()
    room = build_room()
    room.export(scan_dir / "original.glb")
    simple = trimesh.Trimesh(room.vertices, room.faces, process=False)
    simple.export(scan_dir / "simplified.glb")  # no colours, like A1's output

    result = asyncio.run(label_scan(scan_dir, FakeSam(), labeller_name="fake-colour-sam"))

    print(f"{len(result['objects'])} objects found")
    failures = test_patch_merging()
    found = {o["label"]: o for o in result["objects"]}
    for name, (centre, size, _) in FURNITURE.items():
        obj = found.get(name)
        if obj is None:
            failures.append(f"missing: {name}")
            continue
        err = np.abs(np.array(obj["position"]) - centre)
        print(f"  {name:10s} conf={obj['confidence']:.2f} centre error (m) = {err.round(2).tolist()} size={obj['size']}")
        if err.max() > 0.35:
            failures.append(f"{name}: centre off by {err.max():.2f}m")
    extras = [o["id"] for o in result["objects"] if o["label"] not in FURNITURE or o["id"].endswith("_2")]
    if extras:
        failures.append(f"unexpected objects: {extras}")
    if "bed" in found:
        failures.append("the wrong 'bed' label was NOT rejected by voting")
    print("scan dir:", scan_dir)
    print("FAIL: " + "; ".join(failures) if failures else "PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
