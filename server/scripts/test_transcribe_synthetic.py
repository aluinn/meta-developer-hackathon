"""Offline test of POST /transcribe with NO Meta API calls.

Checks audio conversion (browser-style stereo 48 kHz WAV -> mono 16 kHz) and that the request we would send
matches Meta's documented format. The actual transcription is faked, so this does not test Meta's service.

    python scripts/test_transcribe_synthetic.py
"""
import io
import json
import os
import sys
import wave
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import transcribe  # noqa: E402
from main import app  # noqa: E402


def make_wav(rate: int, channels: int, seconds: float = 1.0) -> bytes:
    t = np.arange(int(rate * seconds)) / rate
    tone = (np.sin(2 * np.pi * 440 * t) * 12000).astype("<i2")
    data = np.repeat(tone[:, None], channels, axis=1).ravel()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels), w.setsampwidth(2), w.setframerate(rate)
        w.writeframes(data.tobytes())
    return out.getvalue()


def wav_info(data: bytes) -> tuple[int, int, int, int]:
    with wave.open(io.BytesIO(data)) as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


class FakeResponse:
    status_code = 200
    text = ""

    def json(self):
        return {"sessionId": "s", "transcript": "move the table next to the sofa", "audioDurationMs": 1000, "turns": []}


def main() -> None:
    failures: list[str] = []
    os.environ["MODEL_API_KEY"] = "test-key-not-real"

    # conversion
    for rate, ch in ((48000, 2), (44100, 1), (16000, 1), (24000, 1)):
        got = wav_info(transcribe.normalise_audio(make_wav(rate, ch)))
        print(f"  {rate} Hz, {ch} ch -> channels={got[0]} width={got[1]} rate={got[2]} frames={got[3]}")
        if got[:3] != (1, 2, 16000) or abs(got[3] - 16000) > 20:
            failures.append(f"{rate}Hz/{ch}ch did not convert to mono 16-bit 16kHz ~1s")

    # the request we would send to Meta
    captured = {}

    def fake_post(url, headers, files, timeout):
        captured.update(url=url, headers=headers, files=files, timeout=timeout)
        return FakeResponse()

    transcribe.requests.post = fake_post
    client = TestClient(app)
    r = client.post("/transcribe", files={"audio": ("clip.wav", make_wav(48000, 2), "audio/wav")})
    print("  response:", r.status_code, r.json())
    if r.status_code != 200 or r.json() != {"transcript": "move the table next to the sofa", "duration_ms": 1000}:
        failures.append("unexpected /transcribe response")
    if captured.get("url") != "https://api.meta.ai/v1/asr/transcribe":
        failures.append("wrong URL")
    if captured["headers"].get("Authorization") != "Bearer test-key-not-real":
        failures.append("missing bearer auth")
    settings = json.loads(captured["files"]["request"][1])
    print("  request part:", settings)
    if settings != {"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"}:
        failures.append("request settings differ from the documented format")
    if captured["files"]["request"][2] != "application/json" or wav_info(captured["files"]["audio"][1])[:3] != (1, 2, 16000):
        failures.append("request/audio parts are wrong")
    if "test-key-not-real" in r.text:
        failures.append("the key leaked into the response")

    # error paths
    r = client.post("/transcribe", files={"audio": ("clip.webm", b"\x1a\x45\xdf\xa3 not wav", "audio/webm")})
    print("  webm without ffmpeg:", r.status_code, r.json()["detail"][:70])
    if r.status_code != 415:
        failures.append("non-WAV without ffmpeg should be 415")
    if client.post("/transcribe", files={"audio": ("e.wav", b"", "audio/wav")}).status_code != 400:
        failures.append("empty file should be 400")
    if client.post("/transcribe", files={"audio": ("big.wav", b"\0" * (33 * 1024 * 1024), "audio/wav")}).status_code != 413:
        failures.append("over 32MB should be 413")

    class Upstream429(FakeResponse):
        status_code = 429
        text = '{"type":"rate_limit"}'

    transcribe.requests.post = lambda *a, **k: Upstream429()
    r = client.post("/transcribe", files={"audio": ("clip.wav", make_wav(16000, 1), "audio/wav")})
    print("  upstream 429 ->", r.status_code)
    if r.status_code != 502 or "test-key-not-real" in r.text:
        failures.append("upstream errors should be 502 without leaking the key")

    del os.environ["MODEL_API_KEY"]
    if client.post("/transcribe", files={"audio": ("clip.wav", make_wav(16000, 1), "audio/wav")}).status_code != 503:
        failures.append("missing key should be 503")

    print("FAIL: " + "; ".join(failures) if failures else "PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
