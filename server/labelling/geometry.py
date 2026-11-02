"""Floor-plan geometry shared by the world builder (A3) and the layout agent (A4)."""
import math


def half_extents(obj: dict) -> tuple[float, float]:
    """Half-size in x and z of the axis-aligned box that contains the object after its y-rotation."""
    w, _, d = obj["size"]
    c, s = abs(math.cos(obj["rotation_y"])), abs(math.sin(obj["rotation_y"]))
    return c * w / 2 + s * d / 2, s * w / 2 + c * d / 2


def footprints_overlap(a: dict, b: dict, tolerance: float = 0.01) -> bool:
    """True if the floor footprints overlap by more than `tolerance` metres on both axes."""
    ahx, ahz = half_extents(a)
    bhx, bhz = half_extents(b)
    overlap_x = ahx + bhx - abs(a["position"][0] - b["position"][0])
    overlap_z = ahz + bhz - abs(a["position"][2] - b["position"][2])
    return overlap_x > tolerance and overlap_z > tolerance
