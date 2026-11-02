"""Offline test of A6 (scan-versus-simulation score) with NO Meta API calls.

A fake room is scanned (A2 with a fake colour-based SAM), turned into a world (A3 with a fake Muse Spark), then scored.
We also damage the world on purpose and check that the score reacts. The fake SAM finds objects by colour, so this tests our
rendering, matching and maths, not how SAM behaves on real furniture.

    python scripts/test_score_synthetic.py
"""
import asyncio
import copy
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import trimesh
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import score as score_api  # noqa: E402
from labelling.match_score import score_scan  # noqa: E402
from labelling.pipeline import label_scan  # noqa: E402
from labelling.world import build_world  # noqa: E402
from main import app  # noqa: E402
from test_labelling_synthetic import FakeSam, build_room  # noqa: E402
from test_world_synthetic import FakeMuse  # noqa: E402

SCAN_ID = "ab" * 16


def sam(seed: int = 7) -> FakeSam:
    """A fake SAM with different random noise from the one used to label the scan, like two real SAM runs would differ."""
    fake = FakeSam()
    fake.rng = np.random.default_rng(seed)
    return fake


def show(title: str, result: dict) -> None:
    print(f"\n{title}: overall {result['overall_percent']}%  (unmatched scan detections: {len(result['unmatched_scan_detections'])})")
    for o in result["objects"]:
        print(f"  {o['id']:12s} {str(o['score_percent']):>6}%  in {o['views_compared']} views")


def main() -> None:
    failures: list[str] = []
    root = Path(tempfile.mkdtemp(prefix="a6test_"))
    scan_dir = root / SCAN_ID
    scan_dir.mkdir()
    room = build_room()
    room.export(scan_dir / "original.glb")
    trimesh.Trimesh(room.vertices, room.faces, process=False).export(scan_dir / "simplified.glb")
    asyncio.run(label_scan(scan_dir, FakeSam(), labeller_name="fake-colour-sam"))
    world = asyncio.run(build_world(scan_dir, FakeMuse()))
    original_world_text = (scan_dir / "world.json").read_text()

    # 1. a faithful world scores high
    good = asyncio.run(score_scan(scan_dir, sam(), "sam_on_render"))
    show("FAITHFUL WORLD", good)
    if good["overall_percent"] is None or good["overall_percent"] < 75:
        failures.append(f"a faithful world should score at least 75%, got {good['overall_percent']}")
    if len([o for o in good["objects"] if o["score_percent"] is not None]) < 4:
        failures.append("too few objects were scorable")

    # 2. move the table 1.2 m: its score must collapse, others stay
    moved = copy.deepcopy(world)
    for o in moved["objects"]:
        if o["id"] == "table_1":
            o["position"] = [1.2, o["position"][1], -1.8]
    (scan_dir / "world.json").write_text(json.dumps(moved))
    bad = asyncio.run(score_scan(scan_dir, sam()))
    show("TABLE MOVED 1.2 m (world no longer matches the scan)", bad)
    table = next(o for o in bad["objects"] if o["id"] == "table_1")["score_percent"]
    table_before = next(o for o in good["objects"] if o["id"] == "table_1")["score_percent"]
    if table is None or table_before is None or not (table < 0.2 * table_before):
        failures.append(f"moving the table should cut its score sharply ({table_before} -> {table})")
    if not bad["overall_percent"] < good["overall_percent"]:
        failures.append("overall score should drop when an object is in the wrong place")
    sofa_after = next(o for o in bad["objects"] if o["id"] == "sofa_1")["score_percent"]
    if sofa_after is None or sofa_after < 60:
        failures.append("an untouched object's score should stay high")

    # 3. delete the sofa from the world: SAM still sees it in the scan, so it shows up as unmatched
    missing = copy.deepcopy(world)
    missing["objects"] = [o for o in missing["objects"] if o["id"] != "sofa_1"]
    (scan_dir / "world.json").write_text(json.dumps(missing))
    gone = asyncio.run(score_scan(scan_dir, sam()))
    show("SOFA MISSING FROM THE WORLD", gone)
    if not any(u["label"] == "sofa" for u in gone["unmatched_scan_detections"]):
        failures.append("a sofa in the scan but not in the world should be reported as unmatched")

    # 3b. silhouette method (the default): needs no SAM at all
    (scan_dir / "world.json").write_text(original_world_text)
    sil = asyncio.run(score_scan(scan_dir))
    show("SILHOUETTE METHOD, faithful world (no API calls)", sil)
    if sil["method_name"] != "silhouette" or sil["overall_percent"] is None or sil["overall_percent"] < 80:
        failures.append(f"silhouette score of a faithful world should be at least 80%, got {sil['overall_percent']}")
    (scan_dir / "world.json").write_text(json.dumps(moved))
    sil_bad = asyncio.run(score_scan(scan_dir))
    t_good = next(o for o in sil["objects"] if o["id"] == "table_1")["score_percent"]
    t_bad = next(o for o in sil_bad["objects"] if o["id"] == "table_1")["score_percent"]
    print(f"silhouette: table {t_good}% -> {t_bad}% after moving it 1.2 m")
    if t_bad is None or t_good is None or t_bad > 0.2 * t_good:
        failures.append("silhouette: moving the table should cut its score sharply")
    (scan_dir / "world.json").write_text(json.dumps(missing))
    if not any(u["label"] == "sofa" for u in asyncio.run(score_scan(scan_dir))["unmatched_scan_detections"]):
        failures.append("silhouette: a missing sofa should be reported as unmatched")

    # 4. endpoint: caching, refresh, errors
    (scan_dir / "world.json").write_text(original_world_text)
    score_api.SCANS_DIR = root
    score_api.make_segmenter = lambda: sam()
    client = TestClient(app)
    time.sleep(0.05)
    first = client.get(f"/score/{SCAN_ID}?method=sam_on_render")
    second = client.get(f"/score/{SCAN_ID}?method=sam_on_render")
    third = client.get(f"/score/{SCAN_ID}?method=sam_on_render&refresh=true")
    if client.get(f"/score/{SCAN_ID}").json().get("cached") is not False:
        failures.append("asking for another method must not be served from the other method's cache")
    if client.get(f"/score/{SCAN_ID}?method=nonsense").status_code != 422:
        failures.append("an unknown method should be 422")
    print("\nendpoint: first cached=%s, second cached=%s, refresh cached=%s, overall=%s%%" % (first.json().get("cached"), second.json().get("cached"), third.json().get("cached"), first.json().get("overall_percent")))
    if (first.status_code, first.json()["cached"], second.json()["cached"], third.json()["cached"]) != (200, False, True, False):
        failures.append("caching/refresh behaviour is wrong")
    if client.get(f"/score/{'cd' * 16}").status_code != 404 or client.get("/score/not-hex").status_code != 400:
        failures.append("unknown scan should be 404 and a bad id 400")
    (scan_dir / "score.json").unlink()
    score_api.make_segmenter = score_api.SamClient
    saved = os.environ.pop("MODEL_API_KEY", None)
    try:
        if client.get(f"/score/{SCAN_ID}?method=sam_on_render&refresh=true").status_code != 503:
            failures.append("sam_on_render with no key should be 503")
        if client.get(f"/score/{SCAN_ID}?refresh=true").status_code != 200:
            failures.append("the silhouette method needs no key and should work without one")
    finally:
        if saved:
            os.environ["MODEL_API_KEY"] = saved

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
