"""A6: scan-versus-simulation match score.

Idea: if world.json is a faithful copy of the scanned room, what it draws should line up with what SAM found in the scan. So we
  1. rebuild the room from world.json alone (floor, walls, and every object as a box),
  2. render it from the same cameras A2 used on the scan,
  3. compare each object, per view, with the masks SAM produced on the scan (saved by A2), as intersection-over-union (IoU).
Two ways to get the "simulation" side of the comparison:
  - "silhouette" (default): the box's own outline in the render. Free (no API calls) and works on real scans.
  - "sam_on_render": run SAM on the render of the boxes and compare SAM's masks. Costs 64 SAM calls, and on a real scan SAM does not
    recognise plain boxes as furniture (tested on a real bathroom: every object scored 0%), so it only works on renders that look real.
Per object: the average IoU over the views where it is clearly visible. Overall: the average over objects.
Caveats are listed in docs/architecture.md.
"""
import asyncio
import json
from pathlib import Path

import numpy as np
import trimesh

from .geometry import half_extents
from .pipeline import _png, load_masks, load_mesh_and_colours
from .render import Camera, render_view
from .types import Detection, Segmenter

MIN_VISIBLE_PX = 300  # an object must cover at least this many pixels in a view to be judged there
MIN_CONFIDENCE = 0.5  # ignore weak SAM detections on both sides
WALL_THICKNESS = 0.1
COLOUR_MARGIN = 0.05  # metres around an object's box when sampling the scan's colour for it
SHELL_BOXES = 5  # floor + four walls come first in the simulated mesh


def _box(centre, size, rotation_y: float, colour) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    box = trimesh.creation.box(extents=size)
    box.apply_transform(trimesh.transformations.rotation_matrix(rotation_y, [0, 1, 0]))
    box.apply_translation(centre)
    return box.vertices, box.faces, np.tile(np.array(colour, dtype=np.uint8), (len(box.vertices), 1))


def _median_colour(colours: np.ndarray, mask: np.ndarray, fallback=(170, 170, 170)):
    return tuple(int(c) for c in np.median(colours[mask], axis=0)) if mask.any() else fallback


def build_simulated_room(
    world: dict, scan_mesh: trimesh.Trimesh, scan_colours: np.ndarray, scan_boxes: dict[str, dict]
) -> tuple[trimesh.Trimesh, np.ndarray, np.ndarray]:
    """The room as world.json describes it. Returns (mesh, vertex colours, owner) where owner[face] is the index of the
    world object the face belongs to, or -1 for the floor and walls.

    Each object is coloured from the scan where A2 found it (`scan_boxes`, by object id), NOT where world.json puts it: an object
    in the wrong place must still look like itself so that being in the wrong place is penalised, not hidden."""
    lo, hi = np.array(world["room"]["bounds"]["min"]), np.array(world["room"]["bounds"]["max"])
    floor_y = world["room"]["floor_y"]
    verts = scan_mesh.vertices
    floor_colour = _median_colour(scan_colours, verts[:, 1] <= floor_y + 0.05)
    near_wall = (np.abs(verts[:, 0] - lo[0]) < 0.05) | (np.abs(verts[:, 0] - hi[0]) < 0.05) | (np.abs(verts[:, 2] - lo[2]) < 0.05) | (np.abs(verts[:, 2] - hi[2]) < 0.05)
    wall_colour = _median_colour(scan_colours, near_wall & (verts[:, 1] > floor_y + 0.1))

    width, depth, height = hi[0] - lo[0], hi[2] - lo[2], hi[1] - floor_y
    cx, cz, t = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2, WALL_THICKNESS
    wall_y = floor_y + height / 2
    parts = [
        _box([cx, floor_y - t / 2, cz], [width, t, depth], 0, floor_colour),
        _box([cx, wall_y, lo[2] - t / 2], [width + 2 * t, height, t], 0, wall_colour),
        _box([cx, wall_y, hi[2] + t / 2], [width + 2 * t, height, t], 0, wall_colour),
        _box([lo[0] - t / 2, wall_y, cz], [t, height, depth], 0, wall_colour),
        _box([hi[0] + t / 2, wall_y, cz], [t, height, depth], 0, wall_colour),
    ]
    for obj in world["objects"]:
        found = scan_boxes.get(obj["id"])
        if found:
            box_lo, box_hi = np.array(found["min"]) - COLOUR_MARGIN, np.array(found["max"]) + COLOUR_MARGIN
        else:  # an object A2 never saw: fall back to where world.json puts it
            hx, hz = half_extents(obj)
            centre, half = np.array(obj["position"]), np.array([hx, obj["size"][1] / 2, hz]) + COLOUR_MARGIN
            box_lo, box_hi = centre - half, centre + half
        inside = ((verts >= box_lo) & (verts <= box_hi)).all(axis=1)
        parts.append(_box(obj["position"], obj["size"], obj["rotation_y"], _median_colour(scan_colours, inside)))

    vertices, faces, colours, owner, offset = [], [], [], [], 0
    for k, (v, f, c) in enumerate(parts):
        vertices.append(v)
        faces.append(f + offset)
        colours.append(c)
        owner.append(np.full(len(f), k - SHELL_BOXES if k >= SHELL_BOXES else -1))
        offset += len(v)
    mesh = trimesh.Trimesh(np.vstack(vertices), np.vstack(faces), process=False)
    return mesh, np.vstack(colours), np.concatenate(owner)


def _by_view_and_label(detections: list[Detection]) -> dict[tuple[int, str], list[np.ndarray]]:
    grouped: dict[tuple[int, str], list[np.ndarray]] = {}
    for d in detections:
        if d.confidence >= MIN_CONFIDENCE:
            grouped.setdefault((d.view_index, d.prompt), []).append(d.mask)
    return grouped


def _best_overlap(masks: list[np.ndarray], region: np.ndarray) -> np.ndarray | None:
    """The mask that overlaps `region` most (the SAM instance that is this object), or None."""
    best, best_area = None, 0
    for mask in masks:
        area = int((mask & region).sum())
        if area > best_area:
            best, best_area = mask, area
    return best


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = int((a | b).sum())
    return float((a & b).sum() / union) if union else 0.0


METHODS = ("silhouette", "sam_on_render")


async def score_scan(scan_dir: Path, segmenter: Segmenter | None = None, method: str = "silhouette") -> dict:
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}")
    if method == "sam_on_render" and segmenter is None:
        raise ValueError("sam_on_render needs a segmenter (SAM client)")
    labels = json.loads((scan_dir / "labels.json").read_text())
    world = json.loads((scan_dir / "world.json").read_text())
    prompts = labels["prompts"]
    scan_masks = _by_view_and_label(load_masks(scan_dir))

    scan_mesh, scan_colours, colour_source = await asyncio.to_thread(load_mesh_and_colours, scan_dir)
    sim_mesh, sim_colours, owner = build_simulated_room(world, scan_mesh, scan_colours, {o["id"]: o["bbox"] for o in labels["objects"]})
    cameras = {c["view"]: Camera.from_dict(c) for c in labels["cameras"]}
    sim_views = await asyncio.to_thread(lambda: {i: render_view(sim_mesh, sim_colours, cam, i) for i, cam in cameras.items()})

    sim_masks: dict[tuple[int, str], list[np.ndarray]] = {}
    if method == "sam_on_render":
        png = {i: _png(v.rgb) for i, v in sim_views.items()}
        results = await asyncio.gather(*(segmenter.segment(i, png[i], p) for i in sim_views for p in prompts))
        sim_masks = _by_view_and_label([d for group in results for d in group])

    objects = []
    for k, obj in enumerate(world["objects"]):
        per_view = []
        for view_index, view in sim_views.items():
            region = (view.face_id >= 0) & (owner[np.maximum(view.face_id, 0)] == k)
            if int(region.sum()) < MIN_VISIBLE_PX:
                continue
            candidates = scan_masks.get((view_index, obj["label"]), [])
            scan_mask = _best_overlap(candidates, region)
            if method == "silhouette":
                if not candidates:
                    continue  # SAM saw no such object in the scan from here (hidden, or out of frame): nothing to compare against
                if scan_mask is None:
                    scan_mask = max(candidates, key=lambda m: int(m.sum()))  # something like it is there, just not where the box is: a miss
            sim_mask = region if method == "silhouette" else _best_overlap(sim_masks.get((view_index, obj["label"]), []), region)
            if scan_mask is None and sim_mask is None:
                continue  # neither saw it here: nothing to compare
            iou = 0.0 if scan_mask is None or sim_mask is None else _iou(scan_mask, sim_mask)
            per_view.append({"view": view_index, "iou": round(iou, 3), "seen_in_scan": scan_mask is not None, "seen_in_simulation": sim_mask is not None})
        score = round(100 * float(np.mean([v["iou"] for v in per_view])), 1) if per_view else None
        objects.append({"id": obj["id"], "label": obj["label"], "score_percent": score, "views_compared": len(per_view), "per_view": per_view})

    # things SAM saw in the scan that no world object accounts for
    unmatched = []
    for (view_index, label), masks in scan_masks.items():
        view = sim_views.get(view_index)
        if view is None:
            continue
        for mask in masks:
            if int(mask.sum()) < MIN_VISIBLE_PX:
                continue
            covered = any(
                int((mask & ((view.face_id >= 0) & (owner[np.maximum(view.face_id, 0)] == k))).sum()) > 0.3 * int(mask.sum())
                for k, obj in enumerate(world["objects"]) if obj["label"] == label
            )
            if not covered:
                unmatched.append({"view": view_index, "label": label, "pixels": int(mask.sum())})

    scored = [o["score_percent"] for o in objects if o["score_percent"] is not None]
    result = {
        "scan_id": scan_dir.name,
        "method_name": method,
        "overall_percent": round(float(np.mean(scored)), 1) if scored else None,
        "objects": objects,
        "unmatched_scan_detections": unmatched,
        "warnings": ([] if colour_source != "none" else ["The scan had no colour, so SAM saw grey renders; scores are less meaningful."])
        + ([] if scored else ["No object was visible and detected in enough views to score."]),
        "method": (
            "each box's outline in a render of world.json compared with SAM's mask of that object on the scan, as IoU averaged over views"
            if method == "silhouette"
            else "SAM masks on renders of world.json compared with SAM masks on the scan, per object, as IoU averaged over views"
        ) + " (see docs/architecture.md)",
    }
    (scan_dir / "score.json").write_text(json.dumps(result, indent=2))
    return result
