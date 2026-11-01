"""A4 part 1: POST /transcribe, audio from the browser -> transcript via Muse Voice Transcribe.

From https://dev.meta.ai/docs/api-reference/voice/transcribe and /voice/schemas:
POST https://api.meta.ai/v1/asr/transcribe, multipart/form-data with a JSON `request` part
({"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"}) and an
`audio` part. Only WAV is accepted: RIFF/WAVE, mono 16-bit PCM at 16 or 24 kHz, up to 10 minutes
and 32 MB. The transcript is in the response field `transcript`.

Browsers usually record WebM/Ogg/MP4, not WAV, so we normalise here.
"""
import asyncio
import io
import json
import math
import os
import shutil
import subprocess
import wave

import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import APIRouter, File, HTTPException, UploadFile
from scipy.signal import resample_poly

load_dotenv()

URL = "https://api.meta.ai/v1/asr/transcribe"
MODEL = "muse-voice-transcribe-1.0"
TARGET_RATE = 16_000
MAX_UPLOAD_BYTES = 32 * 1024 * 1024  # Meta's request limit
MAX_SECONDS = 10 * 60
CHUNK_BYTES = 1024 * 1024

router = APIRouter()


class UnsupportedAudio(Exception):
    pass


def is_wav(data: bytes) -> bool:
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def normalise_audio(data: bytes) -> bytes:
    """Return mono 16-bit PCM WAV at 16 kHz, or raise UnsupportedAudio."""
    if not is_wav(data):
        return _convert_with_ffmpeg(data)
    try:
        with wave.open(io.BytesIO(data)) as src:
            channels, width, rate, frames = src.getnchannels(), src.getsampwidth(), src.getframerate(), src.getnframes()
            raw = src.readframes(frames)
    except (wave.Error, EOFError):
        return _convert_with_ffmpeg(data)  # e.g. float WAV, which Python's wave module can't read
    if width != 2:
        return _convert_with_ffmpeg(data)
    if frames / max(rate, 1) > MAX_SECONDS:
        raise UnsupportedAudio("Audio is longer than 10 minutes.")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != TARGET_RATE:
        g = math.gcd(rate, TARGET_RATE)
        samples = resample_poly(samples, TARGET_RATE // g, rate // g)
    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(TARGET_RATE)
        dst.writeframes(np.clip(samples, -32768, 32767).astype("<i2").tobytes())
    return out.getvalue()


def _convert_with_ffmpeg(data: bytes) -> bytes:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise UnsupportedAudio(
            "Only 16-bit PCM WAV is supported on this server (ffmpeg is not installed). "
            "Record or convert to WAV in the browser before uploading."
        )
    result = subprocess.run(  # fixed argument list, no shell
        [ffmpeg, "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(TARGET_RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1", "-f", "wav", "pipe:1"],
        input=data, capture_output=True, timeout=120,
    )
    if result.returncode != 0 or not result.stdout:
        raise UnsupportedAudio("Could not read that audio file.")
    return result.stdout


def _post_to_meta(wav: bytes, api_key: str) -> requests.Response:
    request = {"model": MODEL, "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"}
    return requests.post(
        URL,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        files={"request": (None, json.dumps(request), "application/json"), "audio": ("audio.wav", wav, "audio/wav")},
        timeout=120,
    )


async def meta_transcribe(wav: bytes, api_key: str) -> dict:
    try:
        response = await asyncio.to_thread(_post_to_meta, wav, api_key)
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not reach the transcription service: {type(exc).__name__}") from exc
    if response.status_code != 200:
        # Meta's error body has a type/code; never echo request headers (the key lives there).
        raise HTTPException(502, f"Transcription service returned {response.status_code}: {response.text[:300]}")
    return response.json()


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict:
    api_key = os.environ.get("MODEL_API_KEY")
    if not api_key:
        raise HTTPException(503, "MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")

    data = bytearray()
    while chunk := await audio.read(CHUNK_BYTES):
        data += chunk
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio is larger than 32MB.")
    if not data:
        raise HTTPException(400, "The audio file is empty.")

    try:
        wav = await asyncio.to_thread(normalise_audio, bytes(data))
    except UnsupportedAudio as exc:
        raise HTTPException(415, str(exc)) from exc
    result = await meta_transcribe(wav, api_key)
    return {"transcript": result.get("transcript", ""), "duration_ms": result.get("audioDurationMs")}
