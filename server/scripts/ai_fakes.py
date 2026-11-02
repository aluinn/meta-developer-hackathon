"""Test doubles for the worker process (labelling/worker.py). Not used in production.

The worker runs in its own process, so tests cannot patch it. Instead the test sets ROOM_WORLD_AI_FACTORY=ai_fakes and PYTHONPATH to this
folder, and the worker takes its "AI clients" from here. FAKE_MODE chooses the behaviour; FAKE_LOG (optional) records when each worker
starts and ends, to prove that only one runs at a time.
"""
import asyncio
import atexit
import os
import signal
import time

import openai

from labelling.sam import MissingApiKey
from test_labelling_synthetic import FakeSam
from test_world_synthetic import FakeMuse

MODE = os.environ.get("FAKE_MODE", "ok")


def _log(what: str) -> None:
    path = os.environ.get("FAKE_LOG")
    if path:
        with open(path, "a") as f:
            f.write(f"{what} {os.getpid()} {time.time():.3f}\n")


class SlowSam(FakeSam):
    """The fake colour-based SAM: 4 requests at a time like the real client, with the failures FAKE_MODE asks for."""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Semaphore(4)
        self.calls = 0

    async def segment(self, view_index, png, prompt):
        self.calls += 1
        if MODE.startswith("flaky:") and self.calls % int(MODE.split(":")[1]) == 0:
            raise openai.APIConnectionError(request=None)  # a dropped connection, after the client's own retries
        async with self.gate:
            await asyncio.sleep(float(os.environ.get("FAKE_DELAY", "0.03")))
        return [] if MODE in ("empty", "light") else await super().segment(view_index, png, prompt)


class SlowMuse(FakeMuse):
    async def assign(self, annotated_views_png, objects):
        await asyncio.sleep(0.2)
        return await super().assign(annotated_views_png, objects)


def make_segmenter():
    _log("start")
    atexit.register(_log, "end")
    if MODE == "no_key":
        raise MissingApiKey("MODEL_API_KEY is not set.")
    if MODE == "ai_down":
        raise openai.OpenAIError("pretend the AI service is down")
    if MODE == "bug":
        raise RuntimeError("something else broke")
    if MODE == "die":
        os.kill(os.getpid(), signal.SIGKILL)  # what the host does to a process that uses too much memory
    if MODE == "hang":
        time.sleep(3600)
    return SlowSam()


def make_assigner():
    return SlowMuse()
