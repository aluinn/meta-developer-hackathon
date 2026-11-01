"""Client for Meta's SAM 3.1 (POST https://api.meta.ai/v1/responses, model "sam-3.1").

Written from https://dev.meta.ai/docs/sam/segmenting and /reading-segmentation.
The key comes from the environment (MODEL_API_KEY); it is never logged.
"""
import asyncio
import base64
import io
import os

import numpy as np
from meta_sam_parser import decode_mask_to_raster, image_segmentation_format, parse_responses_stream
from openai import AsyncOpenAI
from PIL import Image

from .types import Detection

BASE_URL = "https://api.meta.ai/v1"
MODEL = "sam-3.1"
MAX_CONCURRENT_REQUESTS = 4


class MissingApiKey(RuntimeError):
    pass


class SamClient:
    def __init__(self, api_key: str | None = None, concurrency: int = MAX_CONCURRENT_REQUESTS):
        api_key = api_key or os.environ.get("MODEL_API_KEY")
        if not api_key:
            raise MissingApiKey("MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")
        self._client = AsyncOpenAI(base_url=BASE_URL, api_key=api_key)
        self._limit = asyncio.Semaphore(concurrency)

    async def segment(self, view_index: int, png: bytes, prompt: str) -> list[Detection]:
        image_url = "data:image/png;base64," + base64.b64encode(png).decode()
        width, height = Image.open(io.BytesIO(png)).size
        async with self._limit:
            async with self._client.responses.stream(
                model=MODEL,
                input=[{
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": image_url},
                    ],
                }],
                metadata={"include_confidence": "true"},
            ) as stream:
                parsed = parse_responses_stream(stream, image_segmentation_format())
                result = await parsed.final_result()

        # One record per object per revision; keep the latest mask of each object.
        latest = {}
        for record in result.records:
            if record.kind == "mask" and (record.object_id not in latest or record.revision >= latest[record.object_id].revision):
                latest[record.object_id] = record

        detections = []
        for record in latest.values():
            raster = np.frombuffer(decode_mask_to_raster(record.mask), dtype=np.uint8)
            raster = raster.reshape(record.mask.height, record.mask.width).astype(bool)
            full = np.zeros((height, width), dtype=bool)
            # Masks are box-local: place the raster at the box's top-left corner.
            left, top = round(record.bounds.left), round(record.bounds.top)
            h = min(raster.shape[0], height - top)
            w = min(raster.shape[1], width - left)
            if h > 0 and w > 0 and left >= 0 and top >= 0:
                full[top:top + h, left:left + w] = raster[:h, :w]
            confidence = record.confidence if record.confidence is not None else 1.0
            detections.append(Detection(view_index, prompt, float(confidence), full))
        return detections
