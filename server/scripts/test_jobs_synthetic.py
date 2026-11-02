"""Offline test of the background job system (POST /scan/{id}/process and GET /scan/{id}/status) with NO Meta API calls.

Uses the fake colour-based SAM and fake Muse Spark from the other tests, slowed down a little so progress can be watched.

    python scripts/test_jobs_synthetic.py
"""
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

import openai
import trimesh
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import jobs  # noqa: E402
import labels  # noqa: E402
from labelling.sam import MissingApiKey  # noqa: E402
from main import app  # noqa: E402
from test_labelling_synthetic import FakeSam, build_room  # noqa: E402
from test_world_synthetic import FakeMuse  # noqa: E402

A, B, C = "ab" * 16, "cd" * 16, "ef" * 16


class SlowSam(FakeSam):
    """The fake SAM, a little slower, remembering which scan each call was for (to prove only one job runs at a time)."""
    order: list[str] = []

    def __init__(self, delay: float = 0.03, empty: bool = False):
        super().__init__()
        self.delay, self.empty = delay, empty
        self.gate = asyncio.Semaphore(4)  # like the real client: 4 requests at a time, so progress climbs gradually

    async def segment(self, view_index, png, prompt):
        async with self.gate:
            await asyncio.sleep(self.delay)
        SlowSam.order.append(self.scan)
        return [] if self.empty else await super().segment(view_index, png, prompt)


class SlowMuse(FakeMuse):
    async def assign(self, annotated_views_png, objects):
        await asyncio.sleep(0.3)
        return await super().assign(annotated_views_png, objects)


def make_scan(root: Path, scan_id: str) -> None:
    d = root / scan_id
    d.mkdir(parents=True)
    room = build_room()
    room.export(d / "original.glb")
    trimesh.Trimesh(room.vertices, room.faces, process=False).export(d / "simplified.glb")


def wait_for(client, scan_id, states, timeout=120):
    seen, end = [], time.time() + timeout
    while time.time() < end:
        s = client.get(f"/scan/{scan_id}/status").json()
        seen.append(s)
        if s["state"] in states:
            return seen
        time.sleep(0.05)
    raise TimeoutError(f"never reached {states}; last: {seen[-1]}")


def main() -> None:
    failures: list[str] = []
    root = Path(tempfile.mkdtemp(prefix="jobs_"))
    for sid in (A, B, C):
        make_scan(root, sid)
    jobs.SCANS_DIR = root
    labels.SCANS_DIR = root  # GET /world/{id} reads from here
    jobs.make_assigner = lambda: SlowMuse()

    def sam_for(scan_id, **kw):
        def factory():
            sam = SlowSam(**kw)
            sam.scan = scan_id
            return sam
        return factory

    with TestClient(app) as client:  # keeps one event loop alive across requests, so background tasks survive
        # 1. starting returns at once, then progress rises through the steps and the job finishes
        jobs.make_segmenter = sam_for(A)
        t = time.time()
        r = client.post(f"/scan/{A}/process")
        print(f"POST /process -> HTTP {r.status_code} in {time.time() - t:.2f}s, state {r.json()['state']}")
        if r.status_code != 202 or time.time() - t > 1.5:
            failures.append("starting a job must return 202 straight away")
        seen = wait_for(client, A, {"done", "error"})
        steps = [s["step"] for s in seen]
        label_progress = [s["done"] for s in seen if s["step"] == "labelling"]
        print("steps seen:", list(dict.fromkeys(steps)), "| labelling progress seen:", label_progress[:3], "...", label_progress[-2:], f"(of {seen[-1]['total'] if seen[-1]['step'] == 'labelling' else '96'})")
        if seen[-1]["state"] != "done":
            failures.append(f"job ended as {seen[-1]}")
        if not {"labelling", "roles"} <= set(steps):
            failures.append(f"expected to see the labelling and roles steps, saw {set(steps)}")
        if len(set(label_progress)) < 3 or label_progress != sorted(label_progress):
            failures.append("labelling progress should rise steadily")
        world = client.get(f"/world/{A}")
        if world.status_code != 200 or len(world.json()["objects"]) < 4:
            failures.append("the finished job should leave a world.json with objects")

        # 2. starting again while one is running does not start a second job
        jobs.make_segmenter = sam_for(B, delay=0.08)
        first = client.post(f"/scan/{B}/process").json()
        again = client.post(f"/scan/{B}/process").json()
        if first["elapsed_s"] > again["elapsed_s"] or again["state"] not in ("queued", "running"):
            failures.append("a second start on a running scan should return the existing job")

        # 3. only one job at a time: a second scan waits in line, and the two never interleave
        SlowSam.order.clear()
        jobs.make_segmenter = sam_for(C, delay=0.08)  # B is already running with its own fake SAM; C waits for it
        c_status = client.post(f"/scan/{C}/process").json()
        print(f"second scan while the first is busy: state '{c_status['state']}'")
        if c_status["state"] != "queued":
            failures.append(f"a second scan should wait in line (queued), got {c_status['state']}")
        wait_for(client, B, {"done", "error"})
        wait_for(client, C, {"done", "error"})
        groups = [k for k, _ in __import__("itertools").groupby(SlowSam.order)]
        print("order of SAM calls by scan (grouped):", [g[:2] for g in groups])
        if len(groups) != len(set(groups)):
            failures.append(f"two jobs ran at the same time: {groups}")

        # 4. every kind of failure becomes a clear state, not a crash
        def run_to_end(factory, assigner=None):
            jobs.make_segmenter = factory
            jobs.make_assigner = assigner or (lambda: SlowMuse())
            client.post(f"/scan/{A}/process")
            return wait_for(client, A, {"done", "error"})[-1]

        def no_key():
            raise MissingApiKey("MODEL_API_KEY is not set.")

        def ai_down():
            raise openai.OpenAIError("pretend the AI service is down")

        def other_bug():
            raise RuntimeError("something else broke")

        for name, factory, expected in (("no key", no_key, "no_key"), ("AI service error", ai_down, "ai_service"), ("unexpected bug", other_bug, "failed"),
                                       ("SAM finds nothing", sam_for(A, empty=True), "no_objects")):
            s = run_to_end(factory)
            print(f"  {name:18s} -> state {s['state']}, kind {s['error_kind']}, message {s['error']!r}")
            if (s["state"], s["error_kind"]) != ("error", expected):
                failures.append(f"{name}: expected error/{expected}, got {s['state']}/{s['error_kind']}")
            if "Traceback" in json.dumps(s):
                failures.append(f"{name}: a traceback leaked into the status")

        # 4b. a few lost SAM questions must not lose the scan; most of them lost must fail it
        class FlakySam(SlowSam):
            def __init__(self, every: int):
                super().__init__(delay=0.01)
                self.every, self.n = every, 0

            async def segment(self, view_index, png, prompt):
                self.n += 1
                if self.n % self.every == 0:
                    raise openai.APIConnectionError(request=None)  # a dropped connection after the client's own retries
                return await super().segment(view_index, png, prompt)

        def flaky(every):
            def factory():
                sam = FlakySam(every)
                sam.scan = A
                return sam
            return factory

        s = run_to_end(flaky(20))  # 1 in 20 lost (5%)
        print(f"  1 in 20 SAM calls fail     -> state {s['state']}")
        if s["state"] != "done":
            failures.append(f"losing 5% of the SAM questions should not fail the job, got {s['state']}/{s['error_kind']}")
        s = run_to_end(flaky(2))  # every other one lost (50%)
        print(f"  1 in 2 SAM calls fail      -> state {s['state']}, kind {s['error_kind']}")
        if (s["state"], s["error_kind"]) != ("error", "ai_service"):
            failures.append(f"losing half of the SAM questions should fail with ai_service, got {s['state']}/{s['error_kind']}")

        # 5. after a failure, a new job can be started and succeed (it does not stay stuck)
        s = run_to_end(sam_for(A))
        if s["state"] != "done":
            failures.append("a job started after a failed one should be able to succeed")

        # 6. bad requests
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
