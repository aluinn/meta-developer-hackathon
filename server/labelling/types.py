from dataclasses import dataclass
from typing import Protocol

import numpy as np

PROMPTS = ["sofa", "bookshelf", "table", "chair", "rug", "door", "bed", "desk"]


@dataclass(frozen=True)
class Detection:
    view_index: int
    prompt: str
    confidence: float
    mask: np.ndarray  # (H, W) bool, same size as the rendered image


class Segmenter(Protocol):
    """Anything that can find `prompt` in a PNG image. SamClient is the real one."""

    async def segment(self, view_index: int, png: bytes, prompt: str) -> list[Detection]: ...
