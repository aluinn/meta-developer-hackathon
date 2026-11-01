"""A2: render views -> SAM -> project masks to 3D -> vote -> labelled objects."""
import asyncio
import io
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from .render import View, make_cameras, render_view, vertex_colors_from_original
from .types import PROMPTS, Detection, Segmenter
from .vote import group_objects, vote_faces


def _png(rgb: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return buffer.getvalue()


def render_views(scan_dir: Path) -> tuple[trimesh.Trimesh, list[View], str]:
    mesh = trimesh.load(scan_dir / "simplified.glb", force="mesh")
    original_path = next(scan_dir.glob("original.*"), None)
    colors, colour_source = np.full((len(mesh.vertices), 3), 170, dtype=np.uint8), "none"
    if original_path is not None:
        original = trimesh.load(original_path, force="mesh")
        colors, colour_source = vertex_colors_from_original(mesh, original)
    views = [render_view(mesh, colors, cam, i) for i, cam in enumerate(make_cameras(mesh))]
    return mesh, views, colour_source


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
