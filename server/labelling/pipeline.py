"""A2: render views -> SAM -> project masks to 3D -> vote -> labelled objects."""
import asyncio
import io
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from .render import Camera, View, make_cameras, render_view, vertex_colors_from_original
from .types import PROMPTS, Detection, Segmenter
from .vote import group_objects, vote_faces


def _png(rgb: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return buffer.getvalue()


def load_mesh_and_colours(scan_dir: Path) -> tuple[trimesh.Trimesh, np.ndarray, str]:
    mesh = trimesh.load(scan_dir / "simplified.glb", force="mesh")
    original_path = next(scan_dir.glob("original.*"), None)
    colors, colour_source = np.full((len(mesh.vertices), 3), 170, dtype=np.uint8), "none"
    if original_path is not None:
        original = trimesh.load(original_path, force="mesh")
        colors, colour_source = vertex_colors_from_original(mesh, original)
    return mesh, colors, colour_source


def render_views(scan_dir: Path) -> tuple[trimesh.Trimesh, list[View], str]:
    mesh, colors, colour_source = load_mesh_and_colours(scan_dir)
    views = [render_view(mesh, colors, cam, i) for i, cam in enumerate(make_cameras(mesh))]
    return mesh, views, colour_source


def save_masks(views_dir: Path, detections: list[Detection]) -> None:
    """Keep every SAM mask (A6 compares against them). Key: v<view>__<prompt>__<n>__c<confidence x1000>."""
    masks = {f"v{d.view_index}__{d.prompt}__{i}__c{round(d.confidence * 1000)}": d.mask for i, d in enumerate(detections)}
    np.savez_compressed(views_dir / "masks.npz", **masks)


def load_masks(scan_dir: Path) -> list[Detection]:
    path = scan_dir / "views" / "masks.npz"
    if not path.exists():
        raise FileNotFoundError("This scan has no saved masks. Run POST /scan/{scan_id}/label again.")
    detections = []
    with np.load(path) as data:
        for key in data.files:
            view, prompt, _, conf = key.split("__")
            detections.append(Detection(int(view[1:]), prompt, int(conf[1:]) / 1000, data[key]))
    return detections


async def label_scan(scan_dir: Path, segmenter: Segmenter, labeller_name: str, prompts: list[str] = PROMPTS) -> dict:
    mesh, views, colour_source = await asyncio.to_thread(render_views, scan_dir)
    png_by_view = {v.index: _png(v.rgb) for v in views}

    results = await asyncio.gather(*(
        segmenter.segment(v.index, png_by_view[v.index], prompt) for v in views for prompt in prompts
    ))
    detections: list[Detection] = [d for group in results for d in group]

    face_labels, agreement = vote_faces(mesh, views, detections, prompts)
    objects = group_objects(mesh, face_labels, agreement, prompts)

    views_dir = scan_dir / "views"
    views_dir.mkdir(exist_ok=True)
    save_masks(views_dir, detections)
    for v in views:
        (views_dir / f"view_{v.index}.png").write_bytes(png_by_view[v.index])
        np.save(views_dir / f"view_{v.index}_face_id.npy", v.face_id)

    output = {
        "scan_id": scan_dir.name,
        "labeller": labeller_name,
        "prompts": prompts,
        "units": "metres, y-up",
        "colour_source": colour_source,
        "cameras": [{"view": v.index, **v.camera.to_dict()} for v in views],
        "detections_per_view": {
            str(v.index): [
                {"prompt": d.prompt, "confidence": round(d.confidence, 3), "pixels": int(d.mask.sum())}
                for d in detections if d.view_index == v.index
            ]
            for v in views
        },
        "objects": [o.to_dict() for o in objects],
    }
    (scan_dir / "labels.json").write_text(json.dumps(output, indent=2))
    return output


def revote_scan(scan_dir: Path) -> dict:
    """Redo the 3D voting and object grouping from the saved masks. Costs nothing: no SAM calls."""
    labels = json.loads((scan_dir / "labels.json").read_text())
    mesh = trimesh.load(scan_dir / "simplified.glb", force="mesh")
    views = [
        View(c["view"], Camera.from_dict(c), np.zeros((1, 1, 3), dtype=np.uint8), np.load(scan_dir / "views" / f"view_{c['view']}_face_id.npy"))
        for c in labels["cameras"]
    ]
    prompts = labels["prompts"]
    face_labels, agreement = vote_faces(mesh, views, load_masks(scan_dir), prompts)
    labels["objects"] = [o.to_dict() for o in group_objects(mesh, face_labels, agreement, prompts)]
    (scan_dir / "labels.json").write_text(json.dumps(labels, indent=2))
    return labels
