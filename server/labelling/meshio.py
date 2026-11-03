"""Load an uploaded scan without blowing up memory.

A phone scan can carry a huge texture image (the bathroom scan has 8192 x 2560 pixels). trimesh unpacks it to raw pixels and makes
several copies while building one mesh, which took 574 MB on a 4 MB file and crashed the 512 MB server on Render. We shrink every
texture to MAX_TEXTURE_PX on its longest side right after loading, before anything copies it. SAM only needs ~640 px images, so
the colours it sees are not affected in any way that matters.
"""
import math

import trimesh
from PIL import Image

MAX_TEXTURE_PX = 2048
MIN_TEXTURE_PX = 512
TEXTURE_BUDGET_PX = 1024 * 1024  # pixels in all of a scan's textures together
_TEXTURE_ATTRS = ("baseColorTexture", "emissiveTexture", "normalTexture", "occlusionTexture", "metallicRoughnessTexture", "image")


def shrink_textures(geometry: trimesh.parent.Geometry, max_px: int = MAX_TEXTURE_PX) -> None:
    material = getattr(getattr(geometry, "visual", None), "material", None)
    if material is None:
        return
    for attr in _TEXTURE_ATTRS:
        image = getattr(material, attr, None)
        if isinstance(image, Image.Image) and max(image.size) > max_px:
            image.thumbnail((max_px, max_px), Image.LANCZOS)  # in place, keeps the aspect ratio


def load_mesh(path) -> trimesh.Trimesh:
    """Load a .glb/.obj as a single mesh, with textures shrunk. Raises whatever trimesh raises for unreadable files."""
    loaded = trimesh.load(path)
    parts = list(loaded.geometry.values()) if isinstance(loaded, trimesh.Scene) else [loaded]
    # Merging several textured parts into one mesh packs all their textures together, so share one budget between them:
    # a scan with three 4096 px textures peaked at 1.1 GB with a flat 2048 px limit each (now about 260 MB).
    per_part = MAX_TEXTURE_PX if len(parts) <= 1 else max(MIN_TEXTURE_PX, min(MAX_TEXTURE_PX, int(math.sqrt(TEXTURE_BUDGET_PX / len(parts)))))
    for geometry in parts:
        shrink_textures(geometry, per_part)
    return loaded.to_mesh() if isinstance(loaded, trimesh.Scene) else loaded
