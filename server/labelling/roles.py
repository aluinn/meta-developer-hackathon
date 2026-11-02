"""Ask Muse Spark what role each labelled object plays (fixed / movable / climbable / passable).

Written from https://dev.meta.ai/docs (models, cookbook/vision-input, api-reference/responses/schemas):
POST https://api.meta.ai/v1/responses, model "muse-spark-1.3", images as `input_image` parts,
structured output via `text.format` (json_schema). The key comes from MODEL_API_KEY.
"""
import base64
import io
import json
import os
from dataclasses import dataclass
from typing import Protocol

from openai import AsyncOpenAI
from PIL import Image

from .sam import BASE_URL, MissingApiKey

MODEL = "muse-spark-1.3"  # standard mode (the "-contributor" variants let Meta train on our data)
ROLES = ["fixed", "movable", "climbable", "passable"]

# Used only when the model gives no valid answer for an object. Deliberately low confidence.
FALLBACK_ROLES = {
    "sofa": "climbable", "bed": "climbable", "armchair": "climbable", "table": "movable", "desk": "movable",
    "chair": "movable", "bookshelf": "fixed", "rug": "passable", "door": "passable",
    "toilet": "fixed", "sink": "fixed", "bathtub": "fixed",
}
FALLBACK_CONFIDENCE = 0.3

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "role": {"type": "string", "enum": ROLES},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["id", "role", "confidence", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objects"],
    "additionalProperties": False,
}

PROMPT = """You are helping turn a scan of a real room into a physics world for a game and a layout planner.
The images are views of the scanned room. Coloured boxes mark detected objects, each tagged with its id.
All numbers are metres, y-axis up. "height_above_floor" is how high the object's lowest point is.

Give every object exactly one role:
- fixed: will not move and cannot be stood on (walls, tall bookshelves, built-in units).
- movable: a person could push or rearrange it (chairs, small tables, lamps, light furniture).
- climbable: a sturdy, fairly low surface a small character could jump onto and stand on (sofas, beds).
- passable: can be walked over or through (rugs, doorways, open doors).

The labels come from an automatic detector and can be wrong; use the images and sizes to judge.
Also give a confidence from 0 to 1 for the role and a one-sentence reason.
Return one entry per object id, no extras.

Objects:
{objects}
"""


@dataclass(frozen=True)
class RoleAnswer:
    role: str
    confidence: float
    reason: str


class RoleAssigner(Protocol):
    async def assign(self, annotated_views_png: list[bytes], objects: list[dict]) -> dict[str, RoleAnswer]: ...


class MuseSparkClient:
    def __init__(self, api_key: str | None = None):
        api_key = api_key or os.environ.get("MODEL_API_KEY")
        if not api_key:
            raise MissingApiKey("MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")
        self._client = AsyncOpenAI(base_url=BASE_URL, api_key=api_key, timeout=120, max_retries=2)  # images in, JSON out: slower than SAM

    async def assign(self, annotated_views_png: list[bytes], objects: list[dict]) -> dict[str, RoleAnswer]:
        content: list[dict] = [{"type": "input_text", "text": PROMPT.format(objects=json.dumps(objects, indent=1))}]
        for png in annotated_views_png:
            content.append({"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(png).decode()})
        response = await self._client.responses.create(
            model=MODEL,
            input=[{"role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": "object_roles", "schema": RESPONSE_SCHEMA, "strict": True}},
        )
        return parse_answers(response.output_text)


def parse_answers(text: str) -> dict[str, RoleAnswer]:
    """Parse the model's JSON. Bad entries are skipped here and handled by resolve_roles."""
    try:
        entries = json.loads(text).get("objects", [])
    except (json.JSONDecodeError, AttributeError):
        return {}
    answers = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("role") not in ROLES or not isinstance(entry.get("id"), str):
            continue
        try:
            confidence = min(max(float(entry.get("confidence", 0)), 0.0), 1.0)
        except (TypeError, ValueError):
            continue
        answers[entry["id"]] = RoleAnswer(entry["role"], confidence, str(entry.get("reason", "")))
    return answers


def resolve_roles(objects: list[dict], answers: dict[str, RoleAnswer]) -> dict[str, tuple[RoleAnswer, str]]:
    """One valid role per object: the model's answer, else a low-confidence label-based default."""
    resolved = {}
    for obj in objects:
        if obj["id"] in answers:
            resolved[obj["id"]] = (answers[obj["id"]], "muse-spark")
        else:
            role = FALLBACK_ROLES.get(obj["label"], "fixed")
            resolved[obj["id"]] = (RoleAnswer(role, FALLBACK_CONFIDENCE, "no valid answer from the model; default for this label"), "fallback")
    return resolved


def png_bytes(img: Image.Image) -> bytes:
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()
