"""Run the slow part (label the furniture, then work out roles) in the background, so no single web request has to last a minute or two.

    POST /scan/{scan_id}/process   starts the job (returns at once)
    GET  /scan/{scan_id}/status    progress: which step, and how far through it

Why: the free host is slow (labelling took about 100 s there), and hosting layers often cut a request off at about 100 s. The website now starts the job and
checks the status every couple of seconds. Only one job runs at a time (the 512 MB host cannot take two), and the rest wait in line.
Jobs live in memory: if the server restarts, the status endpoint answers 404 and the website tells the person to try again.
"""
import asyncio
import logging
import re
import time
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException
from openai import OpenAIError
from pydantic import BaseModel, Field

from labels import clean_prompts
from labelling.pipeline import label_scan
from labelling.roles import MuseSparkClient
from labelling.sam import MissingApiKey, SamClient
from labelling.types import PROMPTS
from labelling.world import build_world
from scans import SCANS_DIR

log = logging.getLogger("jobs")
router = APIRouter()


def make_segmenter():
    return SamClient()


def make_assigner():
    return MuseSparkClient()


@dataclass
class Job:
    state: str = "queued"  # queued | running | done | error
    step: str = "queued"  # queued | rendering | labelling | roles | done
    done: int = 0
    total: int = 0
    error_kind: str | None = None  # no_key | no_objects | ai_service | failed
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


def _one_at_a_time() -> asyncio.Lock:
    """One lock per running event loop (a lock made at import would be tied to the wrong loop in tests)."""
    return _locks.setdefault(id(asyncio.get_running_loop()), asyncio.Lock())


class ProcessRequest(BaseModel):
    prompts: list[str] | None = Field(default=None, description="What to look for. Default: the broad list in labelling/types.py.")


def _scan_dir(scan_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", scan_id):
        raise HTTPException(400, "Invalid scan_id.")
    return SCANS_DIR / scan_id


async def _run(scan_id: str, job: Job, prompts: list[str]) -> None:
    scan_dir = SCANS_DIR / scan_id
    async with _one_at_a_time():
        job.state = "running"
        job.step = "rendering"

        def on_step(step: str, done: int, total: int) -> None:
            job.step, job.done, job.total = step, done, total

        try:
            sam, assigner = make_segmenter(), make_assigner()
            await label_scan(scan_dir, sam, labeller_name="sam-3.1", prompts=prompts, on_step=on_step)
            job.step, job.done, job.total = "roles", 0, 1
            await build_world(scan_dir, assigner)
            job.step, job.done, job.total, job.state = "done", 1, 1, "done"
        except MissingApiKey as exc:
            job.state, job.error_kind, job.error = "error", "no_key", str(exc)
        except ValueError as exc:
            kind = "no_objects" if "no objects" in str(exc).lower() else "failed"
            job.state, job.error_kind, job.error = "error", kind, str(exc)
        except OpenAIError as exc:  # the Meta API said no (rate limit, outage, bad request)
            log.exception("AI service error while processing %s", scan_id)
            job.state, job.error_kind, job.error = "error", "ai_service", f"{type(exc).__name__}"
        except Exception as exc:  # anything else: log it for us, give the person a short message
            log.exception("processing %s failed", scan_id)
            job.state, job.error_kind, job.error = "error", "failed", f"{type(exc).__name__}"


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
