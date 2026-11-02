"""How wide is the best route from spawn to goal? (Used by POST /layout when `min_clearance_m` is given.)

The website has its own, richer clearance check (web/src/clearance.ts, which draws the route). This is a smaller Python version of the same
idea so the server can refuse a layout that squeezes the route too much, and tell the model why:

1. A 5 cm grid over the floor. Fixed, movable and climbable objects block; passable ones (rugs, doors) do not; objects whose
   underside is more than 2 m above the floor (a high shelf) are walked under. Room walls block.
2. Every free cell gets its distance to the nearest blocked cell (its "clearance").
3. The route that keeps the MOST clearance (widest-path search, not the shortest) is found; the narrowest point on it, doubled,
   is the widest person who can get through.
Accuracy: the grid is 5 cm, so a width is right to about 5 to 10 cm (it tends to read a little narrow). The 50 cm around the spawn and the goal do not count (that is where the person stands, possibly tucked into a corner), the same rule
the website uses. Gaps wider than 1.2 m are reported as 1.2 m.
"""
import heapq
import math
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

CELL_M = 0.05
MAX_CELLS = 250_000  # a huge room gets coarser cells so the search stays quick
HEAD_HEIGHT_M = 2.0
SNAP_LIMIT_M = 0.5
MAX_REPORTED_M = 1.2
COMFORT_M = 0.6  # the route prefers to stay this far from furniture when it costs little
_IGNORED = 10.0  # clearance given to free cells next to spawn and goal, so they never count as the narrowest point


@dataclass(frozen=True)
class RouteWidth:
    """`width_m`: the widest person who can walk spawn -> goal (0.0 if nobody can). `narrowest_at`: where on the best route it is tightest (x, z)."""

    width_m: float
    narrowest_at: tuple[float, float] | None


def _blocks(obj: dict, floor_y: float) -> bool:
    if obj["role"] == "passable":
        return False
    height = obj["size"][1]
    bottom = obj["position"][1] - height / 2 - floor_y
    top = bottom + height
    return top > 0.05 and bottom <= HEAD_HEIGHT_M


def _grid(world: dict) -> tuple[np.ndarray, float, float, float]:
    """(blocked[z, x], cell size, min x, min z). A one-cell border of blocked cells stands for the walls."""
    lo, hi = world["room"]["bounds"]["min"], world["room"]["bounds"]["max"]
    cell = CELL_M
    while math.ceil((hi[0] - lo[0]) / cell) * math.ceil((hi[2] - lo[2]) / cell) > MAX_CELLS:
        cell *= 2
    nx, nz = math.ceil((hi[0] - lo[0]) / cell), math.ceil((hi[2] - lo[2]) / cell)
    xs = lo[0] + (np.arange(nx) + 0.5) * cell
    zs = lo[2] + (np.arange(nz) + 0.5) * cell
    xx, zz = np.meshgrid(xs, zs)
    blocked = np.zeros((nz, nx), dtype=bool)
    floor_y = world["room"]["floor_y"]
    for obj in world["objects"]:
        if not _blocks(obj, floor_y):
            continue
        cx, _, cz = obj["position"]
        w, _, d = obj["size"]
        c, s = math.cos(obj["rotation_y"]), math.sin(obj["rotation_y"])
        dx, dz = xx - cx, zz - cz
        # three.js turns a box anticlockwise (seen from above) by rotation_y; undo that to get the point in the box's own frame
        u = dx * c - dz * s
        v = dx * s + dz * c
        blocked |= (np.abs(u) <= w / 2) & (np.abs(v) <= d / 2)
    return blocked, cell, lo[0], lo[2]


def route_width(world: dict) -> RouteWidth:
    blocked, cell, min_x, min_z = _grid(world)
    nz, nx = blocked.shape
    padded = np.pad(~blocked, 1, constant_values=False)  # walls
    clearance = (ndimage.distance_transform_edt(padded)[1:-1, 1:-1] - 0.5) * cell  # metres from a cell's centre to the nearest obstacle's edge
    clearance = np.where(blocked, 0.0, np.maximum(clearance, 0.0))

    def cell_of(point: list[float]) -> tuple[int, int]:
        return int((point[2] - min_z) / cell), int((point[0] - min_x) / cell)

    def nearest_open(point: list[float]) -> tuple[int, int] | None:
        """The roomiest free cell within SNAP_LIMIT_M of the point (the point can be inside furniture on real scans)."""
        r = int(SNAP_LIMIT_M / cell)
        j0, i0 = cell_of(point)
        best, best_cell = 0.0, None
        for j in range(max(0, j0 - r), min(nz, j0 + r + 1)):
            for i in range(max(0, i0 - r), min(nx, i0 + r + 1)):
                if math.hypot(j - j0, i - i0) * cell <= SNAP_LIMIT_M and clearance[j, i] > best:
                    best, best_cell = clearance[j, i], (j, i)
        return best_cell

    start, goal = nearest_open(world["spawn"]), nearest_open(world["goal"])
    if start is None or goal is None:
        return RouteWidth(0.0, None)

    # The 50 cm around spawn and goal are ignored when looking for the narrowest point.
    jj, ii = np.mgrid[0:nz, 0:nx]
    for point in (world["spawn"], world["goal"]):
        j0, i0 = cell_of(point)
        near = np.hypot(jj - j0, ii - i0) * cell <= SNAP_LIMIT_M
        clearance = np.where(near & (clearance > 0), _IGNORED, clearance)

    # Widest path: pop the cell with the best "narrowest point so far" first.
    best = np.zeros((nz, nx))
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    best[start] = clearance[start]
    heap = [(-best[start], start)]
    while heap:
        negative, (j, i) = heapq.heappop(heap)
        if -negative < best[j, i]:
            continue
        if (j, i) == goal:
            break
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nj, ni = j + dj, i + di
                if (dj or di) and 0 <= nj < nz and 0 <= ni < nx and clearance[nj, ni] > 0:
                    through = min(-negative, clearance[nj, ni])
                    if through > best[nj, ni]:
                        best[nj, ni] = through
                        parent[(nj, ni)] = (j, i)
                        heapq.heappush(heap, (-through, (nj, ni)))
    if best[goal] <= 0:
        return RouteWidth(0.0, None)

    # Many routes tie for "widest". Pick a natural one among them (shortest, but keeping away from furniture where it can),
    # so the "tightest point" we report is the real squeeze and not a spot where an arbitrary tied route happens to touch a wall.
    needed = best[goal] - 1e-9
    cost = {start: 0.0}
    parent = {}
    heap = [(0.0, start)]
    while heap:
        c, (j, i) = heapq.heappop(heap)
        if c > cost.get((j, i), math.inf):
            continue
        if (j, i) == goal:
            break
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nj, ni = j + dj, i + di
                if (dj or di) and 0 <= nj < nz and 0 <= ni < nx and clearance[nj, ni] >= needed:
                    step = math.hypot(dj, di) * (1 + 2 * max(0.0, COMFORT_M - clearance[nj, ni]))
                    if c + step < cost.get((nj, ni), math.inf):
                        cost[(nj, ni)] = c + step
                        parent[(nj, ni)] = (j, i)
                        heapq.heappush(heap, (c + step, (nj, ni)))

    # Walk back along that route to find where it is tightest (the start and goal areas do not count).
    narrowest, where = _IGNORED, goal
    node = goal
    while True:
        if clearance[node] < narrowest:
            narrowest, where = clearance[node], node
        if node == start:
            break
        node = parent[node]
    if narrowest >= _IGNORED:
        return RouteWidth(MAX_REPORTED_M, None)
    return RouteWidth(min(2 * narrowest, MAX_REPORTED_M), (round(min_x + (where[1] + 0.5) * cell, 2), round(min_z + (where[0] + 0.5) * cell, 2)))


def clearance_problem(width: RouteWidth, needed_m: float) -> str | None:
    """A plain-English sentence for the model when the route is too narrow, or None if it is wide enough."""
    if width.width_m + 1e-9 >= needed_m:
        return None
    needed_cm = round(needed_m * 100)
    if width.width_m <= 0:
        return f"there is no route from spawn to goal at all, and it must be at least {needed_cm} cm wide everywhere."
    x, z = width.narrowest_at or (0.0, 0.0)
    return f"the route from spawn to goal is only {math.floor(width.width_m * 100)} cm wide near x={x}, z={z}, but it must be at least {needed_cm} cm wide everywhere."
