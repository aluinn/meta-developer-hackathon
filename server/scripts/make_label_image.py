"""Draw labels.json onto the rendered views: 3D boxes projected into each camera, plus a top-down plan.

    python scripts/make_label_image.py scans/<scan_id>
Writes scans/<scan_id>/labels_overview.png
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.annotate import colour_for, draw_boxes  # noqa: E402
from labelling.render import IMAGE_HEIGHT, IMAGE_WIDTH  # noqa: E402


def main(scan_dir: Path) -> None:
    data = json.loads((scan_dir / "labels.json").read_text())
    cams = data["cameras"]
    tiles = []
    for cam in cams:
        img = Image.open(scan_dir / "views" / f"view_{cam['view']}.png").convert("RGB")
        draw_boxes(img, cam, data["objects"])
        draw = ImageDraw.Draw(img)
        draw.text((4, 4), f"view {cam['view']}", fill=(0, 0, 0))
        tiles.append(img)

    # Top-down plan (x right, z down), 480px square.
    size, margin = 480, 30
    plan = Image.new("RGB", (size, size), (245, 245, 245))
    draw = ImageDraw.Draw(plan)
    boxes = [(o["bbox"]["min"], o["bbox"]["max"]) for o in data["objects"]]
    cam_xz = [(c["position"][0], c["position"][2]) for c in cams]
    xs = [b[0][0] for b in boxes] + [b[1][0] for b in boxes] + [p[0] for p in cam_xz]
    zs = [b[0][2] for b in boxes] + [b[1][2] for b in boxes] + [p[1] for p in cam_xz]
    x0, z0 = min(xs), min(zs)
    scale = (size - 2 * margin) / max(max(xs) - x0, max(zs) - z0, 1e-6)
    to_px = lambda x, z: (margin + (x - x0) * scale, margin + (z - z0) * scale)  # noqa: E731
    for obj in data["objects"]:
        lo, hi = obj["bbox"]["min"], obj["bbox"]["max"]
        colour = colour_for(obj["label"])
        draw.rectangle([*to_px(lo[0], lo[2]), *to_px(hi[0], hi[2])], outline=colour, width=2)
        draw.text(to_px(lo[0], lo[2]), f"{obj['label']} {obj['confidence']:.2f}", fill=colour)
    for k, (x, z) in enumerate(cam_xz):
        px, pz = to_px(x, z)
        draw.ellipse([px - 4, pz - 4, px + 4, pz + 4], fill=(0, 0, 0))
        draw.text((px + 6, pz - 5), str(k), fill=(0, 0, 0))
    draw.text((4, 4), "top-down plan (black dots = cameras)", fill=(0, 0, 0))

    cols = 3
    rows = -(-(len(tiles) + 1) // cols)
    sheet = Image.new("RGB", (cols * IMAGE_WIDTH // 2, rows * IMAGE_HEIGHT // 2), (255, 255, 255))
    for n, tile in enumerate(tiles + [plan]):
        sheet.paste(tile.resize((IMAGE_WIDTH // 2, IMAGE_HEIGHT // 2)), ((n % cols) * IMAGE_WIDTH // 2, (n // cols) * IMAGE_HEIGHT // 2))
    out = scan_dir / "labels_overview.png"
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
