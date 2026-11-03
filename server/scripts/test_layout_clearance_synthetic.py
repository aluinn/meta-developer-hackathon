"""Offline test of POST /layout's optional `min_clearance_m`, with NO Meta API calls.

The "model" is a scripted stand-in written by us (NOT Muse Spark), as in test_layout_synthetic.py: it returns fixed proposals, one per
attempt. This tests our clearance check, the retry with plain-English feedback, and the response fields, not the model's ideas.

    python scripts/test_layout_clearance_synthetic.py
"""
import json
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import layout as layout_api  # noqa: E402
from labelling.clearance import route_width  # noqa: E402
from labelling.layout import Move, Proposal  # noqa: E402
from main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = json.loads((ROOT / "shared" / "example_world.json").read_text())
SCAN_ID = "ab" * 16


def obj(id, label, role, x, z, w, d, h=2.0):
    return {"id": id, "label": label, "role": role, "confidence": 1.0, "position": [x, h / 2, z], "size": [w, h, d], "rotation_y": 0}


def room(objects, spawn=(-2.5, 0.0), goal=(2.5, 0.0)):
    return {
        "version": 1, "source_scan": "test",
        "room": {"bounds": {"min": [-3, 0, -2.5], "max": [3, 2.5, 2.5]}, "floor_y": 0},
        "objects": objects, "spawn": [spawn[0], 0.0, spawn[1]], "goal": [goal[0], 0.0, goal[1]],
    }


# A wall across the room at x = 0 with a 0.62 m doorway (z from -0.31 to 0.31). The north part is a movable wardrobe plus a fixed end.
GAP_WORLD = room([
    obj("wall_south", "wall", "fixed", 0.0, -1.405, 0.2, 2.19),
    obj("wardrobe_1", "wardrobe", "movable", 0.0, 0.81, 0.2, 1.0),
    obj("wall_north", "wall", "fixed", 0.0, 1.905, 0.2, 1.19),
])


class Scripted:
    def __init__(self, script):
        self.script, self.calls, self.feedback = script, 0, []

    async def propose(self, world, goal, problems):
        self.feedback.append(problems)
        proposal = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return proposal


def ask(client, script, world=GAP_WORLD, **extra):
    stand_in = Scripted(script)
    layout_api.make_proposer = lambda: stand_in
    return client.post("/layout", json={"scan_id": SCAN_ID, "goal": "make room for a wheelchair", "world": world, **extra}), stand_in


def main() -> None:
    layout_api.SCANS_DIR = Path(tempfile.mkdtemp(prefix="clearance_test_"))
    client = TestClient(app)
    failures: list[str] = []
    ok = lambda cond, what: failures.append(what) if not cond else print(f"  ok   {what}")  # noqa: E731

    print("route_width on its own")
    gap = route_width(GAP_WORLD)
    ok(abs(gap.width_m - 0.62) < 0.1, f"a 0.62 m doorway measures {gap.width_m:.2f} m")
    ok(gap.narrowest_at is not None and abs(gap.narrowest_at[0]) < 0.15 and abs(gap.narrowest_at[1]) < 0.4, f"and the tightest point is in the doorway {gap.narrowest_at}")
    ok(route_width(room([])).width_m == 1.2, "an empty room is as wide as it is ever reported (1.2 m)")
    sealed = room([obj("a", "wall", "fixed", 0.0, 0.0, 0.2, 5.0)])
    ok(route_width(sealed).width_m == 0.0, "a wall across the whole room: nobody gets through (0)")
    ok(abs(route_width(room([obj("w1", "wall", "fixed", 0, -1.4, 0.2, 2.2), obj("w2", "wall", "fixed", 0, 1.4, 0.2, 2.2)])).width_m - 0.6) < 0.1, "a 0.6 m doorway between two walls")
    rug = room([obj("rug", "rug", "passable", 0.0, 0.0, 0.2, 5.0)])
    ok(route_width(rug).width_m == 1.2, "a passable rug across the room does not block")
    high = room([{**obj("shelf", "shelf", "fixed", 0.0, 0.0, 0.2, 5.0, 0.4), "position": [0.0, 2.6, 0.0]}])
    ok(route_width(high).width_m == 1.2, "a shelf whose underside is above 2 m is walked under")
    ok(route_width(EXAMPLE).width_m > 0.8, f"the example room is roomy: {route_width(EXAMPLE).width_m:.2f} m")
    turned = room([{**obj("d", "desk", "fixed", 0.0, 0.0, 0.2, 5.0), "rotation_y": 3.14159 / 2}])
    ok(route_width(turned).width_m > 0, "a long box turned a quarter turn lies along x (the route can go round it)")

    print("\nPOST /layout with min_clearance_m")
    # 1. a proposal that makes the doorway narrower (wardrobe 10 cm into it): refused twice, and the second ask is told why in words
    worse = Proposal([Move("wardrobe_1", 0.0, 0.71, "keep", "nudged")], "")
    response, model = ask(client, [worse], min_clearance_m=0.9)
    ok(response.status_code == 422 and model.calls == 2, f"a proposal that leaves a 52 cm gap is refused after one retry (HTTP {response.status_code}, asked {model.calls}x)")
    ok(model.feedback[1] and "cm wide near" in model.feedback[1][0] and "at least 90 cm" in model.feedback[1][0], f"the retry is told in words: {model.feedback[1]}")
    ok(response.status_code == 422 and "cm wide" in response.json()["detail"]["problems"][0], "and the 422 lists the problem")

    # 2. the retry fixes it: slide the wardrobe out of the doorway line
    better = Proposal([Move("wardrobe_1", 1.5, 0.8, "keep", "Out of the doorway, against the east side.")], "")
    response, model = ask(client, [worse, better], min_clearance_m=0.9)
    body = response.json()
    ok(response.status_code == 200 and body["attempts"] == 2, f"worse first, better second: accepted on attempt {body.get('attempts')}")
    ok(abs(body["clearance_before_m"] - 0.62) < 0.1 and body["clearance_after_m"] >= 0.9, f"clearance before {body['clearance_before_m']:.2f} m, after {body['clearance_after_m']:.2f} m")

    # 3. accepted first time
    response, model = ask(client, [better], min_clearance_m=0.9)
    ok(response.status_code == 200 and response.json()["attempts"] == 1 and model.calls == 1, "a good proposal is accepted first time")

    # 4. nothing proposed, and the route is already too narrow: refused (the room cannot meet the need)
    response, model = ask(client, [Proposal([], "Nothing to move.")], min_clearance_m=0.9)
    ok(response.status_code == 422, "no changes and a 62 cm doorway cannot meet 90 cm: refused")

    # 5. a smaller need is already met: no change is fine
    response, _ = ask(client, [Proposal([], "")], min_clearance_m=0.5)
    ok(response.status_code == 200, "a 50 cm need is met by the 62 cm doorway as it is")

    # 6. without min_clearance_m nothing changes: the narrowing proposal is accepted and the fields are null
    response, _ = ask(client, [worse])
    body = response.json()
    ok(response.status_code == 200 and body["clearance_before_m"] is None and body["clearance_after_m"] is None, "without min_clearance_m the old behaviour: accepted, clearance fields null")

    # 7. bad values
    for bad in (0.1, 5, -1):
        response, _ = ask(client, [better], min_clearance_m=bad)
        ok(response.status_code == 422, f"min_clearance_m={bad} is refused (422)")

    # 8. the other geometry checks still come first
    outside = Proposal([Move("wardrobe_1", 5.0, 0.0, "keep", "x")], "")
    response, model = ask(client, [outside], min_clearance_m=0.9)
    ok(response.status_code == 422 and "stick out" in response.json()["detail"]["problems"][0], "a move outside the room is still refused for that reason")

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
