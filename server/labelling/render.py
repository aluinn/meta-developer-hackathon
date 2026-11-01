"""Render a mesh from virtual cameras with a small software rasteriser.

Each view gives a colour image (what SAM sees) and a face-id image (which
triangle is visible at every pixel). The face-id image is what lets us project
a 2D mask back onto the 3D surface: mask pixels -> triangle ids.

Assumes metres and y-up (the glTF convention, and our world.json contract).
"""
from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.spatial import cKDTree

IMAGE_WIDTH = 640
IMAGE_HEIGHT = 480
FOV_DEGREES = 90.0
NUM_VIEWS = 8
CAMERA_HEIGHT_ABOVE_FLOOR = 1.5
CAMERA_RING = 0.6  # camera distance from room centre, as a fraction of the half-extent
NEAR = 0.05
BACKGROUND = (200, 200, 200)


@dataclass(frozen=True)
class Camera:
    position: np.ndarray
    look_at: np.ndarray
    fov_degrees: float = FOV_DEGREES

    def axes(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return (right, up, forward) unit vectors."""
        forward = self.look_at - self.position
        forward = forward / np.linalg.norm(forward)
        right = np.cross(forward, [0.0, 1.0, 0.0])
        right = right / np.linalg.norm(right)
        up = np.cross(right, forward)
        return right, up, forward

    @classmethod
    def from_dict(cls, data: dict) -> "Camera":
        return cls(np.array(data["position"], dtype=float), np.array(data["look_at"], dtype=float), data.get("fov_degrees", FOV_DEGREES))

    def to_dict(self) -> dict:
        right, up, forward = self.axes()
        return {
            "position": self.position.round(4).tolist(),
            "look_at": self.look_at.round(4).tolist(),
            "right": right.round(4).tolist(),
            "up": up.round(4).tolist(),
            "forward": forward.round(4).tolist(),
            "fov_degrees": self.fov_degrees,
        }


@dataclass
class View:
    index: int
    camera: Camera
    rgb: np.ndarray  # (H, W, 3) uint8
    face_id: np.ndarray  # (H, W) int32, -1 where no surface


def make_cameras(mesh: trimesh.Trimesh, count: int = NUM_VIEWS) -> list[Camera]:
    """Place cameras on a ring inside the room, each looking at the room centre."""
    lo, hi = mesh.bounds
    centre = (lo + hi) / 2
    half = (hi - lo) / 2
    eye_y = min(lo[1] + CAMERA_HEIGHT_ABOVE_FLOOR, hi[1] - 0.2)
    target = np.array([centre[0], lo[1] + 0.6 * (hi[1] - lo[1]) / 2 + 0.3, centre[2]])
    cameras = []
    for k in range(count):
        angle = 2 * np.pi * k / count
        eye = np.array([
            centre[0] + CAMERA_RING * half[0] * np.cos(angle),
            eye_y,
            centre[2] + CAMERA_RING * half[2] * np.sin(angle),
        ])
        cameras.append(Camera(position=eye, look_at=target))
    return cameras


GREY = 170


def vertex_colors_from_original(simplified: trimesh.Trimesh, original: trimesh.Trimesh) -> tuple[np.ndarray, str]:
    """Simplification drops colour, so copy it from the nearest original vertex.

    Returns (colours, source) where source says what we found: "vertex_colors",
    "texture" or "none" (grey). SAM works much better on coloured images.
    """
    visual = original.visual
    if visual.kind == "vertex":
        source, name = np.asarray(visual.vertex_colors)[:, :3], "vertex_colors"
    elif visual.kind == "texture":
        source, name = np.asarray(visual.to_color().vertex_colors)[:, :3], "texture"
    else:
        return np.full((len(simplified.vertices), 3), GREY, dtype=np.uint8), "none"
    _, nearest = cKDTree(original.vertices).query(simplified.vertices)
    return source[nearest].astype(np.uint8), name


def render_view(mesh: trimesh.Trimesh, colors: np.ndarray, camera: Camera, index: int = 0) -> View:
    width, height = IMAGE_WIDTH, IMAGE_HEIGHT
    right, up, forward = camera.axes()
    rel = mesh.vertices - camera.position
    xc, yc, zc = rel @ right, rel @ up, rel @ forward
    focal = (width / 2) / np.tan(np.radians(camera.fov_degrees) / 2)
    safe_z = np.where(zc > NEAR, zc, 1.0)
    sx = width / 2 + focal * xc / safe_z
    sy = height / 2 - focal * yc / safe_z
    inv_z = 1.0 / safe_z

    faces = mesh.faces
    in_front = (zc[faces] > NEAR).all(axis=1)
    shade = 0.55 + 0.45 * np.abs(mesh.face_normals @ forward)

    zbuf = np.full((height, width), np.inf, dtype=np.float32)
    fid = np.full((height, width), -1, dtype=np.int32)
    bw0 = np.zeros((height, width), dtype=np.float32)
    bw1 = np.zeros((height, width), dtype=np.float32)
    xs = np.arange(width)
    ys = np.arange(height)

    for fi in np.nonzero(in_front)[0]:
        a, b, c = faces[fi]
        ax, ay, bx, by, cx, cy = sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]
        x0 = max(int(np.floor(min(ax, bx, cx))), 0)
        x1 = min(int(np.ceil(max(ax, bx, cx))), width - 1)
        y0 = max(int(np.floor(min(ay, by, cy))), 0)
        y1 = min(int(np.ceil(max(ay, by, cy))), height - 1)
        if x0 > x1 or y0 > y1:
            continue
        area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if abs(area) < 1e-9:
            continue
        px = xs[x0:x1 + 1] + 0.5
        py = (ys[y0:y1 + 1] + 0.5)[:, None]
        w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
        w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        depth = 1.0 / (w0 * inv_z[a] + w1 * inv_z[b] + w2 * inv_z[c])
        zslice = zbuf[y0:y1 + 1, x0:x1 + 1]
        win = inside & (depth < zslice)
        if not win.any():
            continue
        zslice[win] = depth[win]
        fid[y0:y1 + 1, x0:x1 + 1][win] = fi
        bw0[y0:y1 + 1, x0:x1 + 1][win] = w0[win]
        bw1[y0:y1 + 1, x0:x1 + 1][win] = w1[win]

    rgb = np.empty((height, width, 3), dtype=np.uint8)
    rgb[:] = BACKGROUND
    hit = fid >= 0
    f = faces[fid[hit]]
    w0, w1 = bw0[hit][:, None], bw1[hit][:, None]
    colour = w0 * colors[f[:, 0]] + w1 * colors[f[:, 1]] + (1 - w0 - w1) * colors[f[:, 2]]
    rgb[hit] = np.clip(colour * shade[fid[hit]][:, None], 0, 255).astype(np.uint8)
    return View(index=index, camera=camera, rgb=rgb, face_id=fid)
