"""Run the slow part (label the furniture, then work out roles) in the background, so no single web request has to last a minute or two.

    POST /scan/{scan_id}/process   starts the job (returns at once)
    GET  /scan/{scan_id}/status    progress: which step, and how far through it

Why: the free host is slow (labelling took about 100 s there), and hosting layers often cut a request off at about 100 s. The website now starts the job and
checks the status every couple of seconds. Only one job runs at a time (the 512 MB host cannot take two), and the rest wait in line.
Jobs live in memory: if the server restarts, the status endpoint answers 404 and the website tells the person to try again.
The work itself runs in a separate process per job (labelling/worker.py) so its memory is returned to the operating system when it ends.
"""
import asyncio
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from labels import clean_prompts
from labelling.types import PROMPTS
from scans import SCANS_DIR, SERVER_DIR

log = logging.getLogger("jobs")
router = APIRouter()


JOB_TIMEOUT_S = 10 * 60


@dataclass
class Job:
    state: str = "queued"  # queued | running | done | error
    step: str = "queued"  # queued | rendering | labelling | roles | done
    done: int = 0
    total: int = 0
    error_kind: str | None = None  # no_key | no_objects | ai_service | out_of_memory | failed
    error: str | None = None
    started: float = field(default_factory=time.time)
    task: asyncio.Task | None = field(default=None, repr=False)

    def to_dict(self, scan_id: str) -> dict:
        percent = round(100 * self.done / self.total) if self.total else 0
        return {
            "scan_id": scan_id, "state": self.state, "step": self.step, "done": self.done, "total": self.total, "percent": percent,
            "error_kind": self.error_kind, "error": self.error, "elapsed_s": round(time.time() - self.started, 1),
        }


JOBS: dict[str, Job] = {}
_locks: dict[int, asyncio.Lock] = {}


def heavy_lock() -> asyncio.Lock:
    """One lock per running event loop (a lock made at import would be tied to the wrong loop in tests)."""
    return _locks.setdefault(id(asyncio.get_running_loop()), asyncio.Lock())


class ProcessRequest(BaseModel):
    prompts: list[str] | None = Field(default=None, description="What to look for. Default: the broad list in labelling/types.py.")


def _scan_dir(scan_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    return SCANS_DIR / scan_id


async def _run(scan_id: str, job: Job, prompts: list[str]) -> None:
    """Run the labelling and roles in a separate process (labelling/worker.py) and follow the progress lines it prints."""
    scan_dir = SCANS_DIR / scan_id
    async with heavy_lock():
        job.state, job.step = "running", "rendering"
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "labelling.worker", "process", str(scan_dir), json.dumps(prompts),
            stdout=asyncio.subprocess.PIPE, cwd=SERVER_DIR,  # stderr is inherited, so its logs reach the host's log
        )
        final: dict | None = None
        try:
            async with asyncio.timeout(JOB_TIMEOUT_S):
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    try:
                        event = json.loads(raw)
                    except ValueError:
                        continue  # not one of ours
                    if event.get("event") == "step":
                        job.step, job.done, job.total = event["step"], event["done"], event["total"]
                    elif event.get("event") in ("done", "error"):
                        final = event
                await proc.wait()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            job.state, job.error_kind, job.error = "error", "failed", "Took too long."
            return
        if final and final["event"] == "done":
            job.step, job.done, job.total, job.state = "done", 1, 1, "done"
        elif final:
            job.state, job.error_kind, job.error = "error", final.get("kind", "failed"), final.get("message")
        else:
            # No final line: the process died. SIGKILL (-9) is how the host stops a process that uses too much memory.
            log.error("worker for %s died with exit code %s", scan_id, proc.returncode)
            job.state, job.error_kind = "error", "out_of_memory" if proc.returncode == -9 else "failed"
            job.error = "The worker process was stopped (probably out of memory)." if proc.returncode == -9 else "The worker process crashed."


@router.post("/scan/{scan_id}/process", status_code=202)
async def process(scan_id: str, req: ProcessRequest | None = None) -> dict:
    scan_dir = _scan_dir(scan_id)
    if not (scan_dir / "simplified.glb").exists():
        raise HTTPException(404, "No such scan. Upload it with POST /scan first.")
    existing = JOBS.get(scan_id)
    if existing and existing.state in ("queued", "running"):
        return existing.to_dict(scan_id)  # already on its way: do not start a second one
    prompts = clean_prompts(req.prompts if req and req.prompts else PROMPTS)
    job = Job()
    JOBS[scan_id] = job
    job.task = asyncio.create_task(_run(scan_id, job, prompts))  # keep the reference so the task is not garbage-collected
    return job.to_dict(scan_id)


@router.get("/scan/{scan_id}/status")
def status(scan_id: str) -> dict:
    _scan_dir(scan_id)
    job = JOBS.get(scan_id)
    if job is None:
        raise HTTPException(404, "No job for this scan (the server may have restarted). Start one with POST /scan/{scan_id}/process.")
    return job.to_dict(scan_id)
