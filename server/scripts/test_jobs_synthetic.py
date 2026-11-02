"""Offline test of the background job system (POST /scan/{id}/process and GET /scan/{id}/status) with NO Meta API calls.

Every job runs in a REAL separate worker process (labelling/worker.py) using the fake AI clients in scripts/ai_fakes.py,
so this also tests the process plumbing: progress lines, failures, a killed worker, a hung worker, one job at a time.

    python scripts/test_jobs_synthetic.py
"""
import itertools
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import trimesh
from fastapi.testclient import TestClient

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS.parent))
sys.path.insert(0, str(SCRIPTS))
import jobs  # noqa: E402
import labels  # noqa: E402
from main import app  # noqa: E402
from test_labelling_synthetic import build_room  # noqa: E402

A, B, C = "ab" * 16, "cd" * 16, "ef" * 16
os.environ["ROOM_WORLD_AI_FACTORY"] = "ai_fakes"
os.environ["PYTHONPATH"] = str(SCRIPTS) + os.pathsep + os.environ.get("PYTHONPATH", "")


def make_scan(root: Path, scan_id: str) -> None:
    d = root / scan_id
    d.mkdir(parents=True)
    room = build_room()
    room.export(d / "original.glb")
    trimesh.Trimesh(room.vertices, room.faces, process=False).export(d / "simplified.glb")


def wait_for(client, scan_id, states, timeout=180):
    seen, end = [], time.time() + timeout
    while time.time() < end:
        s = client.get(f"/scan/{scan_id}/status").json()
        seen.append(s)
        if s["state"] in states:
            return seen
        time.sleep(0.1)
    raise TimeoutError(f"never reached {states}; last: {seen[-1]}")


def main() -> None:
    failures: list[str] = []
    root = Path(tempfile.mkdtemp(prefix="jobs_"))
    for sid in (A, B, C):
        make_scan(root, sid)
    jobs.SCANS_DIR = root
    labels.SCANS_DIR = root  # GET /world/{id} reads from here
    os.environ["SCANS_DIR"] = str(root)

    def run(scan_id=A, mode="ok", **env):
        os.environ["FAKE_MODE"] = mode
        for k, v in env.items():
            os.environ[k] = str(v)
        client.post(f"/scan/{scan_id}/process")
        return wait_for(client, scan_id, {"done", "error"})

    with TestClient(app) as client:  # keeps one event loop alive across requests, so background tasks survive
        # 1. starting returns at once; progress rises through the steps; the finished job leaves a world.json
        os.environ["FAKE_MODE"] = "ok"
        t = time.time()
        r = client.post(f"/scan/{A}/process")
        print(f"POST /process -> HTTP {r.status_code} in {time.time() - t:.2f}s, state {r.json()['state']}")
        if r.status_code != 202 or time.time() - t > 1.5:
            failures.append("starting a job must return 202 straight away")
        seen = wait_for(client, A, {"done", "error"})
        steps = list(dict.fromkeys(s["step"] for s in seen))
        label_progress = [s["done"] for s in seen if s["step"] == "labelling"]
        print("steps seen:", steps, "| labelling progress seen:", label_progress[:3], "...", label_progress[-2:])
        if seen[-1]["state"] != "done":
            failures.append(f"job ended as {seen[-1]}")
        if not {"labelling", "roles"} <= set(steps):
            failures.append(f"expected the labelling and roles steps, saw {steps}")
        if len(set(label_progress)) < 3 or label_progress != sorted(label_progress):
            failures.append("labelling progress should rise steadily")
        world = client.get(f"/world/{A}")
        if world.status_code != 200 or len(world.json()["objects"]) < 4:
            failures.append("the finished job should leave a world.json with objects")

        # 2. starting again while one is running returns the existing job
        log = root / "workers.log"
        os.environ["FAKE_LOG"] = str(log)  # on before B starts, so BOTH workers are recorded (step 3 checks they never overlap)
        os.environ["FAKE_DELAY"] = "0.08"
        first = client.post(f"/scan/{B}/process").json()
        again = client.post(f"/scan/{B}/process").json()
        if first["elapsed_s"] > again["elapsed_s"] or again["state"] not in ("queued", "running"):
            failures.append("a second start on a running scan should return the existing job")

        # 3. only one job at a time: C waits in line, and the two worker processes never overlap
        c_status = client.post(f"/scan/{C}/process").json()
        print(f"second scan while the first is busy: state '{c_status['state']}'")
        if c_status["state"] != "queued":
            failures.append(f"a second scan should wait in line (queued), got {c_status['state']}")
        wait_for(client, B, {"done", "error"})
        wait_for(client, C, {"done", "error"})
        events = [line.split() for line in log.read_text().splitlines()] if log.exists() else []
        by_pid = {}
        for what, pid, ts in events:
            by_pid.setdefault(pid, {})[what] = float(ts)
        spans = sorted((v["start"], v["end"]) for v in by_pid.values() if "start" in v and "end" in v)
        print("worker processes (start, end):", [(round(a % 1000, 1), round(b % 1000, 1)) for a, b in spans])
        if len(spans) != 2 or any(spans[i][1] > spans[i + 1][0] for i in range(len(spans) - 1)):
            failures.append(f"two worker processes overlapped: {spans}")
        os.environ.pop("FAKE_LOG")
        os.environ["FAKE_DELAY"] = "0.03"

        # 4. every kind of failure becomes a clear state, not a crash
        for name, mode, expected in (("no key", "no_key", "no_key"), ("AI service error", "ai_down", "ai_service"), ("unexpected bug", "bug", "failed"),
                                     ("SAM finds nothing", "empty", "no_objects"), ("1 in 2 SAM calls fail", "flaky:2", "ai_service"),
                                     ("worker killed (memory)", "die", "out_of_memory")):
            s = run(mode=mode)[-1]
            print(f"  {name:24s} -> state {s['state']}, kind {s['error_kind']}, message {s['error']!r}")
            if (s["state"], s["error_kind"]) != ("error", expected):
                failures.append(f"{name}: expected error/{expected}, got {s['state']}/{s['error_kind']}")
            if "Traceback" in json.dumps(s):
                failures.append(f"{name}: a traceback leaked into the status")
        s = run(mode="flaky:20")[-1]
        print(f"  1 in 20 SAM calls fail   -> state {s['state']}")
        if s["state"] != "done":
            failures.append(f"losing 5% of the SAM questions should not fail the job, got {s['state']}/{s['error_kind']}")

        # 5. a hung worker is stopped
        jobs.JOB_TIMEOUT_S = 4
        t = time.time()
        s = run(mode="hang")[-1]
        print(f"  hung worker              -> state {s['state']}, kind {s['error_kind']} after {time.time() - t:.0f}s")
        if (s["state"], s["error_kind"]) != ("error", "failed") or time.time() - t > 30:
            failures.append("a hung worker should be killed and reported")
        jobs.JOB_TIMEOUT_S = 600

        # 6. after failures, a new job still succeeds (nothing stays stuck)
        s = run(mode="ok")[-1]
        if s["state"] != "done":
            failures.append("a job started after failed ones should be able to succeed")

        # 7. bad requests
        if client.get(f"/scan/{'12' * 16}/status").status_code != 404:
            failures.append("status of an unknown job should be 404")
        if client.post(f"/scan/{'12' * 16}/process").status_code != 404:
            failures.append("processing an unknown scan should be 404")
        if client.get("/scan/not-hex/status").status_code != 400 or client.post("/scan/..%2F..%2Fx/process").status_code not in (400, 404, 405):
            failures.append("bad scan ids should be rejected")
        if client.post(f"/scan/{A}/process", json={"prompts": ["x" * 80]}).status_code != 422:
            failures.append("over-long prompts should be 422")

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
