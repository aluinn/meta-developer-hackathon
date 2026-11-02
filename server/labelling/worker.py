"""Heavy work in a SEPARATE PROCESS, so its memory goes back to the operating system when it finishes.

Why: Python does not hand freed memory back, so on the 512 MB host the second scan crashed the whole server (the first job left about
350 MB behind; the second pushed it over the limit). A process that exits returns everything. The web server stays small, and each
job starts clean.

    python -m labelling.worker prepare <scan_dir>                 turn the uploaded file into original.glb (small texture) + simplified.glb
    python -m labelling.worker process <scan_dir> '<prompts json>'  label the furniture (A2), then work out roles (A3)

It talks to the server by printing one JSON object per line on stdout (anything else on stdout is ignored), e.g.
    {"event": "step", "step": "labelling", "done": 12, "total": 96}   {"event": "done"}   {"event": "error", "kind": "no_key", "message": "..."}
Logs go to stderr. If this process is killed (out of memory), there is no final event and the server reports that.
"""
import asyncio
import importlib
import json
import logging
import os
import sys
from pathlib import Path

import trimesh
from dotenv import load_dotenv
from openai import OpenAIError

from .meshio import load_mesh
from .sam import MissingApiKey

TARGET_TRIANGLES = 50_000
log = logging.getLogger("worker")


def emit(**event) -> None:
    print(json.dumps(event), flush=True)


def prepare(scan_dir: Path) -> None:
    original = next(scan_dir.glob("original.*"))
    try:
        mesh = load_mesh(original)
    except Exception as exc:  # a corrupt or unsupported file: trimesh raises many different errors
        emit(event="error", kind="unreadable", message=f"Could not read the mesh: {exc}")
        return
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        emit(event="error", kind="unreadable", message="The file contains no triangles.")
        return
    before = len(mesh.faces)
    # Keep a compact copy of the scan WITH its (shrunk) colours: later steps load it, and the upload may carry a huge texture.
    compact = scan_dir / "original.glb"
    mesh.export(compact)
    if original != compact:
        original.unlink()
    simplified = mesh.simplify_quadric_decimation(face_count=TARGET_TRIANGLES) if before > TARGET_TRIANGLES else mesh
    simplified.export(scan_dir / "simplified.glb")
    emit(event="prepared", triangles_before=before, triangles_after=len(simplified.faces))


def make_character(out_path: Path, prompt: str) -> None:
    """Draw a character with Muse Image, remove the white background and save a 512 px transparent PNG."""
    from PIL import Image
    from .muse_image import ImageApiError, generate_image, white_background_to_transparent

    try:
        factory = os.environ.get("ROOM_WORLD_AI_FACTORY")
        if factory:  # tests only
            image = importlib.import_module(factory).generate_image(prompt)
        else:
            key = os.environ.get("MODEL_API_KEY")
            if not key:
                emit(event="error", kind="no_key", message="MODEL_API_KEY is not set.")
                return
            image = generate_image(prompt, key)
        picture = white_background_to_transparent(image)
        picture.thumbnail((512, 512), Image.LANCZOS)
        picture.save(out_path, optimize=True)
        emit(event="done")
    except ImageApiError as exc:
        log.error("image service error: %s", exc)
        emit(event="error", kind="ai_service", message="The image service had a problem.")
    except Exception as exc:
        log.exception("drawing failed")
        emit(event="error", kind="failed", message=type(exc).__name__)


def _ai_clients():
    """The real Meta clients, or (for tests only) the ones from the module named in ROOM_WORLD_AI_FACTORY."""
    name = os.environ.get("ROOM_WORLD_AI_FACTORY")
    if name:
        module = importlib.import_module(name)
        return module.make_segmenter, module.make_assigner
    from .roles import MuseSparkClient
    from .sam import SamClient
    return SamClient, MuseSparkClient


async def process(scan_dir: Path, prompts: list[str]) -> None:
    from .pipeline import label_scan
    from .world import build_world

    make_segmenter, make_assigner = _ai_clients()
    try:
        sam, assigner = make_segmenter(), make_assigner()
        await label_scan(scan_dir, sam, labeller_name="sam-3.1", prompts=prompts,
                         on_step=lambda step, done, total: emit(event="step", step=step, done=done, total=total))
        emit(event="step", step="roles", done=0, total=1)
        await build_world(scan_dir, assigner)
        emit(event="done")
    except MissingApiKey as exc:
        emit(event="error", kind="no_key", message=str(exc))
    except ValueError as exc:
        emit(event="error", kind="no_objects" if "no objects" in str(exc).lower() else "failed", message=str(exc))
    except OpenAIError as exc:  # the Meta API said no (rate limit, outage, bad request)
        log.exception("AI service error")
        emit(event="error", kind="ai_service", message=type(exc).__name__)
    except Exception as exc:
        log.exception("processing failed")
        emit(event="error", kind="failed", message=type(exc).__name__)


def main(argv: list[str]) -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    load_dotenv()
    command, scan_dir = argv[1], Path(argv[2])
    if command == "prepare":
        prepare(scan_dir)
    elif command == "process":
        asyncio.run(process(scan_dir, json.loads(argv[3])))
    elif command == "character":  # character <out.png> <prompt json>; argv[2] is the output file, not a scan folder
        make_character(scan_dir, json.loads(argv[3]))
    else:
        raise SystemExit(f"unknown command {command!r}")


if __name__ == "__main__":
    main(sys.argv)
