"""Offline test of A3 with NO Meta API calls: fake room -> fake SAM (from the A2 test) -> fake Muse Spark -> world.json.

The fake Muse Spark returns JSON with deliberate flaws (invalid role, missing object, confidence 1.4)
and goes through the real parser, so this tests our fallbacks and the schema check, not Muse Spark itself.

    python scripts/test_world_synthetic.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

import trimesh
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import labels  # noqa: E402
from labelling.pipeline import label_scan  # noqa: E402
from labelling.roles import parse_answers  # noqa: E402
from labelling.world import SCHEMA_PATH, build_world  # noqa: E402
from main import app  # noqa: E402
from test_labelling_synthetic import FakeSam, build_room  # noqa: E402


class FakeMuse:
    async def assign(self, annotated_views_png, objects):
        assert 1 <= len(annotated_views_png) <= 8 and annotated_views_png[0][:4] == b"\x89PNG"
        entries = [
            {"id": "sofa_1", "role": "climbable", "confidence": 0.9, "reason": "low and sturdy"},
            {"id": "bookshelf_1", "role": "fixed", "confidence": 1.4, "reason": "tall"},  # confidence out of range
            {"id": "table_1", "role": "movable", "confidence": 0.8, "reason": "light table"},
            {"id": "chair_1", "role": "flying", "confidence": 0.9, "reason": "?"},  # invalid role
            {"id": "rug_1", "role": "passable", "confidence": 0.95, "reason": "flat"},
            # door_1 missing on purpose
        ]
        return parse_answers(json.dumps({"objects": entries}))


def main() -> None:
    scan_id = "ab" * 16
    scan_dir = Path(tempfile.mkdtemp(prefix="a3test_")) / scan_id
    scan_dir.mkdir(parents=True)
    room = build_room()
    room.export(scan_dir / "original.glb")
    trimesh.Trimesh(room.vertices, room.faces, process=False).export(scan_dir / "simplified.glb")
    asyncio.run(label_scan(scan_dir, FakeSam(), labeller_name="fake-colour-sam"))
    world = asyncio.run(build_world(scan_dir, FakeMuse()))

    failures = []
    roles = {o["id"]: o for o in world["objects"]}
    detail = json.loads((scan_dir / "roles_detail.json").read_text())
    if len(world["objects"]) != 6:
        failures.append(f"expected 6 objects, got {len(world['objects'])}")
    if roles["bookshelf_1"]["confidence"] > 1:
        failures.append("confidence above 1 was not clamped")
    if detail["chair_1"]["source"] != "fallback" or roles["chair_1"]["role"] != "movable":
        failures.append("invalid role 'flying' did not fall back to the label default")
    if detail["door_1"]["source"] != "fallback" or roles["door_1"]["role"] != "passable":
        failures.append("missing door did not fall back")
    if roles["door_1"]["confidence"] > 0.3:
        failures.append("fallback confidence should be low")
    for name in ("spawn", "goal"):
        x, y, z = world[name]
        if abs(y - world["room"]["floor_y"]) > 1e-6:
            failures.append(f"{name} not on the floor")
        for o in world["objects"]:
            if o["role"] != "passable" and abs(x - o["position"][0]) < o["size"][0] / 2 and abs(z - o["position"][2]) < o["size"][2] / 2:
                failures.append(f"{name} is inside {o['id']}")
    dx, dz = world["spawn"][0] - world["goal"][0], world["spawn"][2] - world["goal"][2]
    if (dx * dx + dz * dz) ** 0.5 < 3:
        failures.append("spawn and goal are less than 3 m apart")

    # GET /world/{scan_id}
    labels.SCANS_DIR = scan_dir.parent
    client = TestClient(app)
    got = client.get(f"/world/{scan_id}")
    if got.status_code != 200 or got.json() != world:
        failures.append("GET /world did not return the saved world.json")
    if client.get("/world/" + "cd" * 16).status_code != 404:
        failures.append("unknown scan should be 404")
    if client.get("/world/..%2F..%2Fetc").status_code not in (400, 404):
        failures.append("path traversal attempt was not rejected")

    print(json.dumps(world, indent=1)[:1500], "...")
    print("schema:", SCHEMA_PATH)
    print("FAIL: " + "; ".join(failures) if failures else "PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
