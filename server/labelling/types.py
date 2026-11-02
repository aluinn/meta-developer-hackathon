from dataclasses import dataclass
from typing import Protocol

import numpy as np

# What A2 asks SAM to look for when the caller does not say. One broad list for living rooms, bedrooms and bathrooms,
# because the website cannot ask the user what kind of room it is. 12 prompts x 8 views = 96 SAM calls (about $0.24, about a minute).
PROMPTS = ["sofa", "armchair", "chair", "table", "desk", "bed", "rug", "door", "bookshelf", "toilet", "sink", "bathtub"]


@dataclass(frozen=True)
class Detection:
    view_index: int
    prompt: str
    confidence: float
    mask: np.ndarray  # (H, W) bool, same size as the rendered image


class Segmenter(Protocol):
    """Anything that can find `prompt` in a PNG image. SamClient is the real one."""

    async def segment(self, view_index: int, png: bytes, prompt: str) -> list[Detection]: ...
