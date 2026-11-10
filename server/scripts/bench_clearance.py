"""Times the server's route-width check (labelling/clearance.py) on every world in the repo.

Run from /server with the venv active: python scripts/bench_clearance.py
Prints a markdown table. Not a test: it only measures.
"""
import json
import platform
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.clearance import route_width  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RUNS = 20
WORLDS = [
    ("shared/example_world.json", "shared/example_world.json"),
    ("shared/real_world_01.json (bathroom scan)", "shared/real_world_01.json"),
    ("examples/zac-room (real scan)", "web/public/examples/zac-room/world.json"),
    ("examples/studio-apartment (real scan)", "web/public/examples/studio-apartment/world.json"),
    ("web/src/clearance_test_world.json (narrow gap)", "web/src/clearance_test_world.json"),
]

print(f"Python {platform.python_version()}, {platform.machine()}, {platform.system()} {platform.release()}")
print(f"Median of {RUNS} runs after 3 warm-up runs, milliseconds.\n")
print("| World | Objects | Widest person (m) | route_width |")
print("|---|---|---|---|")
for name, rel in WORLDS:
    world = json.loads((ROOT / rel).read_text())
    for _ in range(3):
        route_width(world)
    times = []
    for _ in range(RUNS):
        t = time.perf_counter()
        result = route_width(world)
        times.append((time.perf_counter() - t) * 1000)
    print(f"| {name} | {len(world['objects'])} | {result.width_m:.2f} | {statistics.median(times):.1f} |")
