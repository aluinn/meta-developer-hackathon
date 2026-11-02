"""POST /character: a player describes a character; Muse Image draws it (about $0.01 each); we send back a transparent 512 px PNG.

Protection for the credits and the server: the description is checked and limited (labelling/character.py), each visitor and the whole server
have hourly limits, and the drawing runs in a worker process (labelling/worker.py) under the same lock as the scan jobs, so it never overlaps one
(the 512 MB host cannot take both). If a scan is being processed, the answer is "busy, try again in a minute".
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from jobs import heavy_lock
from labelling.character import build_prompt, clean_description
from scans import SERVER_DIR

PER_VISITOR_HOURLY = int(os.environ.get("CHARACTER_PER_VISITOR_HOURLY", 8))
GLOBAL_HOURLY = int(os.environ.get("CHARACTER_GLOBAL_HOURLY", 40))
MIN_SECONDS_BETWEEN = float(os.environ.get("CHARACTER_MIN_SECONDS_BETWEEN", 8))
DRAW_TIMEOUT_S = 150
LOCK_WAIT_S = 3

router = APIRouter()
_recent_by_visitor: dict[str, deque[float]] = defaultdict(deque)
_recent_all: deque[float] = deque()


class CharacterRequest(BaseModel):
    description: str = Field(max_length=300, description='e.g. "a sleepy red panda wearing a tiny hat"')


def _visitor(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()  # the host's proxy puts the real address here
    return forwarded or (request.client.host if request.client else "unknown")


def _spend_allowance(visitor: str) -> None:
    """Raise 429 if this visitor (or everyone together) has asked too often; otherwise count this request."""
    now = time.time()
    for queue in (_recent_all, _recent_by_visitor[visitor]):
        while queue and now - queue[0] > 3600:
            queue.popleft()
    mine = _recent_by_visitor[visitor]
    if mine and now - mine[-1] < MIN_SECONDS_BETWEEN:
        wait = int(MIN_SECONDS_BETWEEN - (now - mine[-1])) + 1
        raise HTTPException(429, f"Slow down a little: you can make another character in {wait} seconds.")
    if len(mine) >= PER_VISITOR_HOURLY:
        raise HTTPException(429, "You've made a lot of characters this hour. Please try again later.")
    if len(_recent_all) >= GLOBAL_HOURLY:
        raise HTTPException(429, "The character maker is very busy right now. Please try again later.")
    mine.append(now)
    _recent_all.append(now)


@router.post("/character")
async def make_character(req: CharacterRequest, request: Request) -> Response:
    try:
        description = clean_description(req.description)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    lock = heavy_lock()
    if lock.locked():
        raise HTTPException(503, "The server is busy with another job. Try again in a minute.")
    _spend_allowance(_visitor(request))

    folder = Path(tempfile.mkdtemp(prefix="character_"))
    out = folder / "character.png"
    try:
        try:
            await asyncio.wait_for(lock.acquire(), LOCK_WAIT_S)
        except TimeoutError as exc:
            raise HTTPException(503, "The server is busy with another job. Try again in a minute.") from exc
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "labelling.worker", "character", str(out), json.dumps(build_prompt(description)),
                stdout=asyncio.subprocess.PIPE, cwd=SERVER_DIR,
            )
            try:
                async with asyncio.timeout(DRAW_TIMEOUT_S):
                    stdout, _ = await proc.communicate()
            except TimeoutError as exc:
                proc.kill()
                await proc.wait()
                raise HTTPException(502, "Drawing took too long. Please try again.") from exc
        finally:
            lock.release()

        final = None
        for line in stdout.decode(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("event") in ("done", "error"):
                final = event
        if final and final["event"] == "done" and out.exists():
            return Response(out.read_bytes(), media_type="image/png", headers={"Cache-Control": "no-store"})
        if final and final.get("kind") == "no_key":
            raise HTTPException(503, "The server is not set up to draw characters yet (no API key).")
        if final and final.get("kind") == "ai_service":
            raise HTTPException(502, "The drawing service had a problem. Please try again in a moment.")
        raise HTTPException(502, "Could not draw that character. Please try again.")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
