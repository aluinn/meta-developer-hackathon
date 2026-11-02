"""Offline test of POST /layout with NO Meta API calls.

The "model" here is a scripted stand-in written by us (NOT Muse Spark): for each goal it returns a fixed
list of proposals, in order, one per attempt. So this tests our validation, retry and response code, not
whether Muse Spark's ideas are any good. Uses shared/example_world.json.

    python scripts/test_layout_synthetic.py
"""
import json
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import layout as layout_api  # noqa: E402
from labelling.layout import Move, Proposal  # noqa: E402
from main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORLD = json.loads((ROOT / "shared" / "example_world.json").read_text())
SCAN_ID = "ab" * 16


class Scripted:
    """Returns the proposals in `script` one per attempt, and records the feedback it was given."""

    def __init__(self, script):
        self.script, self.calls, self.feedback = script, 0, []

    async def propose(self, world, goal, problems):
        self.feedback.append(problems)
        proposal = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        return proposal


GOALS = {
    # 1: valid first time
    "Make more open floor space in the middle of the room for a wheelchair": [
        Proposal([
            Move("table_1", 0.9, -2.0, "keep", "Tucked into the back corner so the centre of the room is free."),
            Move("chair_1", 2.4, 1.9, "keep", "Moved to the front-right corner, out of the walking route."),
        ], "The sofa and bookshelf are not movable, so they stay."),
    ],
    # 2: first attempt overlaps the sofa -> rejected -> retry succeeds
    "Put the table next to the sofa and keep the path from the door clear": [
        Proposal([Move("table_1", -1.8, -1.6, "keep", "Right beside the sofa.")], ""),
        Proposal([Move("table_1", -1.8, -0.9, "keep", "In front of the sofa with a small gap, nothing near the door.")], ""),
    ],
    # 3: the user's own example; there is no desk and no window in the room data, so the honest answer is "nothing"
    "add a desk by the window, keep the path to the door clear": [
        Proposal([], "I can't add a desk: objects can't be added, only moved. The room data also has no window, so I can't place anything by one."),
    ],
}


def run(client, goal, script):
    stand_in = Scripted(script)
    layout_api.make_proposer = lambda: stand_in
    response = client.post("/layout", json={"scan_id": SCAN_ID, "goal": goal, "world": WORLD})
    return response, stand_in


def main() -> None:
    layout_api.SCANS_DIR = Path(tempfile.mkdtemp(prefix="a4test_"))
    (layout_api.SCANS_DIR / SCAN_ID).mkdir()
    client = TestClient(app)
    failures: list[str] = []

    for goal, script in GOALS.items():
        response, stand_in = run(client, goal, script)
        print(f"\n=== GOAL: {goal}")
        if response.status_code != 200:
            failures.append(f"{goal!r}: HTTP {response.status_code} {response.text[:200]}")
            continue
        body = response.json()
        print(f"attempts: {body['attempts']}   spawn->goal walkable (before/after): {body['spawn_to_goal_walkable']}")
        for c in body["changes"]:
            print(f"  {c['id']}: {c['from']['position']} -> {c['to']['position']}   {c['reason']}")
        if not body["changes"]:
            print("  (no changes)")
        print(f"  notes: {body['notes']}")
        if stand_in.feedback[1:]:
            print("  feedback the retry received:", stand_in.feedback[1])
        unchanged = [o for o in WORLD["objects"] if o["id"] not in {c["id"] for c in body["changes"]}]
        new = {o["id"]: o for o in body["world"]["objects"]}
        if any(new[o["id"]] != o for o in unchanged):
            failures.append(f"{goal!r}: an object that was not moved changed")
    # expectations per goal
    r1, _ = run(client, list(GOALS)[0], GOALS[list(GOALS)[0]])
    g1 = r1.json()
    if g1["attempts"] != 1 or len(g1["changes"]) != 2:
        failures.append("goal 1 should succeed first time with 2 changes")
    r2, s2 = run(client, list(GOALS)[1], GOALS[list(GOALS)[1]])
    if r2.json()["attempts"] != 2 or not s2.feedback[1] or "overlap" not in " ".join(s2.feedback[1]):
        failures.append("goal 2 should need a retry, with overlap feedback")
    r3, _ = run(client, list(GOALS)[2], GOALS[list(GOALS)[2]])
    if r3.json()["changes"] or r3.json()["world"] != WORLD:
        failures.append("goal 3 should change nothing")
    if not (layout_api.SCANS_DIR / SCAN_ID / "layout.json").exists():
        failures.append("layout.json was not saved for A5")

    # --- rejection cases: every one must be refused (422) after the retry, and change nothing
    print("\n=== REJECTION CASES")
    bad = {
        "moving a fixed object": Move("bookshelf_1", 0.0, 0.0, "keep", "x"),
        "moving a climbable object": Move("sofa_1", 0.0, -1.0, "keep", "x"),
        "outside the room": Move("chair_1", 3.5, 0.0, "keep", "x"),
        "overlapping a fixed object": Move("chair_1", 2.4, -1.0, "keep", "x"),
        "overlapping another solid object": Move("chair_1", -1.8, -1.8, "keep", "x"),
        "unknown object": Move("desk_1", 0.0, 0.0, "keep", "x"),
        "non-numeric position": Move("chair_1", "left", 0.0, "keep", "x"),
        "turning into a wall": Move("chair_1", 2.9, 0.0, "90", "x"),
    }
    for name, move in bad.items():
        response, stand_in = run(client, "test", [Proposal([move], "")])
        ok = response.status_code == 422 and stand_in.calls == 2
        print(f"  {'ok ' if ok else 'BAD'} {name}: HTTP {response.status_code}, model asked {stand_in.calls}x"
              + (f", problem: {response.json()['detail']['problems'][0]}" if response.status_code == 422 else ""))
        if not ok:
            failures.append(f"'{name}' was not rejected twice")
    # allowed: overlapping a passable object (rug) is fine
    response, _ = run(client, "test", [Proposal([Move("table_1", 0.0, 1.0, "keep", "on the rug")], "")])
    if response.status_code != 200:
        failures.append("moving onto a passable rug should be allowed")
    # bad input
    if client.post("/layout", json={"scan_id": SCAN_ID, "goal": "x" * 3, "world": {"version": 1}}).status_code != 422:
        failures.append("an invalid world should be 422")
    if client.post("/layout", json={"scan_id": "../etc", "goal": "test"}).status_code != 422:
        failures.append("a bad scan_id should be 422")
    # no key -> 503 (real client, no env var)
    import os
    layout_api.make_proposer = layout_api.MuseLayoutClient
    saved = os.environ.pop("MODEL_API_KEY", None)
    try:
        if client.post("/layout", json={"scan_id": SCAN_ID, "goal": "test", "world": WORLD}).status_code != 503:
            failures.append("missing key should be 503")
    finally:
        if saved:
            os.environ["MODEL_API_KEY"] = saved

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
