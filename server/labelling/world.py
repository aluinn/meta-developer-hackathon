"""A3: A2's labelled objects + Muse Spark's roles -> world.json (the contract in shared/world.schema.json)."""
import json
from collections import deque
from pathlib import Path

import numpy as np
import trimesh
from jsonschema import validate
from PIL import Image
from scipy import ndimage

from .annotate import draw_boxes
from .geometry import half_extents
from .roles import RoleAssigner, png_bytes, resolve_roles

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "world.schema.json"
WORLD_VERSION = 1
FLOOR_PERCENTILE = 2  # robust floor height: ignores a few stray low vertices
GRID_STEP = 0.1  # metres, for spawn/goal search
PERSON_RADIUS = 0.3  # keep spawn/goal this far from obstacles and walls
MIN_SIZE = 0.01  # schema needs sizes > 0


def free_floor_grid(bounds_min, bounds_max, objects: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Grid of walkable cells (True = free, indexed [z, x]) plus the x and z coordinates of its axes."""
    xs = np.arange(bounds_min[0] + PERSON_RADIUS, bounds_max[0] - PERSON_RADIUS, GRID_STEP)
    zs = np.arange(bounds_min[2] + PERSON_RADIUS, bounds_max[2] - PERSON_RADIUS, GRID_STEP)
    free = np.ones((len(zs), len(xs)), dtype=bool)
    for obj in objects:
        if obj["role"] == "passable":
            continue
        cx, _, cz = obj["position"]
        hx, hz = half_extents(obj)
        in_x = np.abs(xs - cx) <= hx + PERSON_RADIUS
        in_z = np.abs(zs - cz) <= hz + PERSON_RADIUS
        free[np.ix_(in_z, in_x)] = False
    return free, xs, zs


def pick_spawn_and_goal(bounds_min, bounds_max, objects: list[dict], floor_y: float) -> tuple[list[float], list[float]]:
    """Spawn far from the room centre; goal = the farthest cell you can actually walk to from it."""
    free, xs, zs = free_floor_grid(bounds_min, bounds_max, objects)
    labels, count = ndimage.label(free)
    if count == 0:
        raise ValueError("No free floor space found for a spawn point; the room may be full of objects.")
    largest = 1 + int(np.argmax(ndimage.sum(free, labels, range(1, count + 1))))
    cells = np.argwhere(labels == largest)
    centre = np.array([(bounds_min[2] + bounds_max[2]) / 2, (bounds_min[0] + bounds_max[0]) / 2])
    world_zx = np.stack([zs[cells[:, 0]], xs[cells[:, 1]]], axis=1)
    start = tuple(cells[int(np.argmax(np.linalg.norm(world_zx - centre, axis=1)))])

    dist = {start: 0}
    queue = deque([start])
    while queue:
        z, x = queue.popleft()
        for dz, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nz, nx = z + dz, x + dx
            if 0 <= nz < free.shape[0] and 0 <= nx < free.shape[1] and free[nz, nx] and (nz, nx) not in dist:
                dist[(nz, nx)] = dist[(z, x)] + 1
                queue.append((nz, nx))
    goal = max(dist, key=dist.get)
    to_point = lambda c: [round(float(xs[c[1]]), 3), round(float(floor_y), 3), round(float(zs[c[0]]), 3)]  # noqa: E731
    return to_point(start), to_point(goal)


def annotated_views(scan_dir: Path, labels: dict, count: int = 8) -> list[bytes]:
    out = []
    for cam in labels["cameras"][:count]:
        img = Image.open(scan_dir / "views" / f"view_{cam['view']}.png").convert("RGB")
        out.append(png_bytes(draw_boxes(img, cam, labels["objects"], text_key="id")))
    return out


async def build_world(scan_dir: Path, assigner: RoleAssigner) -> dict:
    labels = json.loads((scan_dir / "labels.json").read_text())
    if not labels["objects"]:
        raise ValueError("A2 found no objects in this scan, so there is nothing to give roles to.")
    mesh = trimesh.load(scan_dir / "simplified.glb", force="mesh")
    bounds_min, bounds_max = mesh.bounds
    floor_y = float(np.percentile(mesh.vertices[:, 1], FLOOR_PERCENTILE))

    brief = [
        {
            "id": o["id"], "label": o["label"], "label_confidence": o["confidence"],
            "position": o["position"], "size": o["size"],
            "height_above_floor": round(o["bbox"]["min"][1] - floor_y, 3),
        }
        for o in labels["objects"]
    ]
    answers = await assigner.assign(annotated_views(scan_dir, labels), brief)
    roles = resolve_roles(labels["objects"], answers)

    objects = []
    for o in labels["objects"]:
        answer, _ = roles[o["id"]]
        objects.append({
            "id": o["id"],
            "label": o["label"],
            "role": answer.role,
            # one number in the contract: as sure as the weaker of "what is it" and "what does it do"
            "confidence": round(min(o["confidence"], answer.confidence), 3),
            "position": o["position"],
            "size": [max(s, MIN_SIZE) for s in o["size"]],
            "rotation_y": 0.0,  # A2 boxes are axis-aligned; no orientation estimate yet
        })

    spawn, goal = pick_spawn_and_goal(bounds_min, bounds_max, objects, floor_y)
    original = next(scan_dir.glob("original.*"), None)
    world = {
        "version": WORLD_VERSION,
        "source_scan": f"{scan_dir.name}/{original.name}" if original else scan_dir.name,
        "room": {
            "bounds": {"min": bounds_min.round(3).tolist(), "max": bounds_max.round(3).tolist()},
            "floor_y": round(floor_y, 3),
        },
        "objects": objects,
        "spawn": spawn,
        "goal": goal,
    }
    validate(world, json.loads(SCHEMA_PATH.read_text()))  # raises if it breaks the contract

    (scan_dir / "world.json").write_text(json.dumps(world, indent=2))
    (scan_dir / "roles_detail.json").write_text(json.dumps({
        o["id"]: {"role": a.role, "confidence": a.confidence, "reason": a.reason, "source": src}
        for o in labels["objects"] for a, src in [roles[o["id"]]]
    }, indent=2))
    return world
