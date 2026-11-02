import json
import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from jsonschema import ValidationError, validate
from pydantic import BaseModel, Field

from labelling.layout import LayoutRejected, MuseLayoutClient, propose_layout, spawn_to_goal_walkable
from labelling.sam import MissingApiKey
from labelling.world import SCHEMA_PATH
from scans import SCANS_DIR

load_dotenv()

router = APIRouter()


class LayoutRequest(BaseModel):
    scan_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    goal: str = Field(min_length=3, max_length=500, description='e.g. "put the table next to the sofa, keep the path to the door clear"')
    world: dict | None = Field(default=None, description="The current world.json. If omitted, the scan's saved world.json is used.")
    min_clearance_m: float | None = Field(
        default=None, ge=0.3, le=1.5, description="Optional: the narrowest the route from spawn to goal may be, in metres (e.g. 0.9 for a wheelchair). A proposal that squeezes it further is refused."
    )


def make_proposer():
    return MuseLayoutClient()


@router.post("/layout")
async def layout(req: LayoutRequest) -> dict:
    scan_dir = SCANS_DIR / req.scan_id
    world = req.world
    if world is None:
        path = scan_dir / "world.json"
        if not path.exists():
            raise HTTPException(404, "No world.json for this scan. Send `world` in the request, or run POST /scan/{scan_id}/world first.")
        world = json.loads(path.read_text())
    try:
        validate(world, json.loads(SCHEMA_PATH.read_text()))
    except ValidationError as exc:
        raise HTTPException(422, f"world does not match shared/world.schema.json: {exc.message}") from exc

    try:
        proposer = make_proposer()
    except MissingApiKey as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        result = await propose_layout(world, req.goal, proposer, req.min_clearance_m)
    except LayoutRejected as exc:
        raise HTTPException(422, {"message": "Muse Spark's layout was rejected twice; nothing was changed.", "problems": exc.problems}) from exc

    response = {
        "scan_id": req.scan_id,
        "goal": req.goal,
        "world": result.world,
        "changes": result.changes,
        "notes": result.notes,
        "attempts": result.attempts,
        "spawn_to_goal_walkable": {"before": spawn_to_goal_walkable(world), "after": spawn_to_goal_walkable(result.world)},
        # widest person who could walk spawn -> goal, in metres (capped at 1.2); null unless min_clearance_m was given
        "clearance_before_m": result.clearance_before_m,
        "clearance_after_m": result.clearance_after_m,
    }
    if scan_dir.is_dir():
        (scan_dir / "layout.json").write_text(json.dumps(response, indent=2))  # latest proposal, for the before/after render (A5)
    return response
