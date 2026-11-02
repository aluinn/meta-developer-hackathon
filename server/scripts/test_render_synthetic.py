"""Offline test of A5 (POST /render and the character helpers) with NO Meta API calls.

The photo is a render of the synthetic room (stand-in for a real photo). The "image model" is a fake that returns the
photo with a small patch painted on it, so this tests our request format, prompt, checks and file handling, not
whether Muse Image edits well.

    python scripts/test_render_synthetic.py
"""
import base64
import copy
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_character  # noqa: E402
import photo_render  # noqa: E402
from labelling import muse_image  # noqa: E402
from labelling.render import make_cameras, render_view  # noqa: E402
from main import app  # noqa: E402
from test_labelling_synthetic import build_room  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OLD = json.loads((ROOT / "shared" / "example_world.json").read_text())
SCAN_ID = "ab" * 16
KEY = "test-key-not-real"


def moved_world() -> dict:
    new = copy.deepcopy(OLD)
    for o in new["objects"]:
        if o["id"] == "table_1":
            o["position"] = [-1.8, 0.2, -0.9]
        if o["id"] == "chair_1":
            o["position"], o["rotation_y"] = [2.4, 0.45, 1.9], 0.97
    return new


def photo_jpeg() -> bytes:
    room = build_room()
    colours = np.asarray(room.visual.vertex_colors)[:, :3]
    view = render_view(room, colours, make_cameras(room)[2])
    big = Image.fromarray(view.rgb).resize((3000, 2250))  # phone-sized
    out = io.BytesIO()
    big.save(out, format="JPEG")
    return out.getvalue()


class FakeResponse:
    def __init__(self, status=200, body=None, text=""):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        return self._body


def b64_png(img: Image.Image) -> str:
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


def post(client, photo, old=OLD, new=None, scan_id=SCAN_ID):
    return client.post("/render", data={"scan_id": scan_id, "old_world": json.dumps(old), "new_world": json.dumps(new or moved_world())},
                       files={"photo": ("room.jpg", photo, "image/jpeg")})


def main() -> None:
    failures: list[str] = []
    os.environ["MODEL_API_KEY"] = KEY
    photo_render.SCANS_DIR = Path(tempfile.mkdtemp(prefix="a5test_"))
    client = TestClient(app)
    photo = photo_jpeg()
    captured: dict = {}

    # --- what moved, in words
    moves = muse_image.find_moves(OLD, moved_world())
    prompt = muse_image.build_edit_prompt(OLD, moved_world(), moves)
    print("=== PROMPT that would be sent to Muse Image ===\n" + prompt + "\n")
    if [b["id"] for b, _ in moves] != ["table_1", "chair_1"]:
        failures.append("expected table_1 and chair_1 to be detected as moved")
    for needle in ("ONLY", "sofa", "turn it by about", "Keep EVERYTHING else"):
        if needle not in prompt:
            failures.append(f"prompt is missing {needle!r}")
    if "table_1" in prompt or "[" in prompt:
        failures.append("prompt should use plain words, not ids or coordinates")

    # --- fake image service
    def fake_post(url, headers, json, timeout):  # noqa: A002
        captured.update(url=url, headers=headers, body=json)
        sent = Image.open(io.BytesIO(base64.b64decode(json["images"][0]["image_url"].split(",", 1)[1]))).convert("RGB")
        edited = sent.copy()
        edited.paste((255, 0, 255), (100, 100, 200, 180))  # a small patch changed
        return FakeResponse(body={"created": 1, "data": [{"b64_json": b64_png(edited)}]})

    muse_image.requests.post = fake_post
    r = post(client, photo)
    print("=== /render response ===")
    print(json.dumps({k: v for k, v in r.json().items() if k != "prompt"}, indent=1) if r.status_code == 200 else r.text)
    if r.status_code != 200:
        failures.append(f"/render failed: {r.status_code}")
    else:
        body = r.json()
        sent = captured["body"]
        if captured["url"] != "https://api.meta.ai/v1/images/edits" or captured["headers"]["Authorization"] != f"Bearer {KEY}":
            failures.append("wrong URL or auth header")
        if (sent["model"], sent["n"], sent["output_format"]) != ("muse-image-1.0", 1, "png") or sent["size"] != "1024x768":
            failures.append(f"unexpected request fields: {({k: v for k, v in sent.items() if k not in ('images', 'prompt')})}")
        if not sent["images"][0]["image_url"].startswith("data:image/png;base64,"):
            failures.append("photo not sent as a base64 data URL")
        if KEY in r.text:
            failures.append("the key leaked into the response")
        if not (0 < body["changed_fraction"] < 0.05) or body["likely_changed_too_much"]:
            failures.append(f"changed_fraction looks wrong: {body['changed_fraction']}")
        before = client.get(body["before_url"])
        after = client.get(body["after_url"])
        if before.status_code != 200 or after.status_code != 200 or before.headers["content-type"] != "image/png":
            failures.append("could not fetch before/after images")
        elif Image.open(io.BytesIO(before.content)).size != (1024, 768):
            failures.append("photo was not shrunk to 1024 wide")
    if client.get(f"/render/{'cd' * 16}/before").status_code != 404:
        failures.append("missing render should be 404")
    if client.get(f"/render/{SCAN_ID}/../../x").status_code not in (400, 404):
        failures.append("path traversal not rejected")

    # --- model that rewrites the whole picture, and one that changes the aspect ratio
    noise = Image.fromarray(np.random.default_rng(1).integers(0, 255, (768, 1024, 3), dtype=np.uint8))
    muse_image.requests.post = lambda *a, **k: FakeResponse(body={"data": [{"b64_json": b64_png(noise)}]})
    r = post(client, photo)
    print(f"whole-picture rewrite: changed_fraction={r.json()['changed_fraction']} likely_changed_too_much={r.json()['likely_changed_too_much']}")
    if r.json()["likely_changed_too_much"] is not True:
        failures.append("a rewritten picture was not flagged")
    square = Image.new("RGB", (1024, 1024), (10, 10, 10))
    muse_image.requests.post = lambda *a, **k: FakeResponse(body={"data": [{"b64_json": b64_png(square)}]})
    r = post(client, photo)
    if r.json()["changed_fraction"] is not None:
        failures.append("a different aspect ratio should give changed_fraction None")

    # --- retry on 503, then success; hard failure -> 502 without leaking the key
    calls = {"n": 0}

    def flaky(url, headers, json, timeout):  # noqa: A002
        calls["n"] += 1
        return FakeResponse(503, text="busy") if calls["n"] < 3 else fake_post(url, headers, json, timeout)

    muse_image.requests.post = flaky
    muse_image.time.sleep = lambda s: None
    if post(client, photo).status_code != 200 or calls["n"] != 3:
        failures.append("503 should be retried and then succeed")
    muse_image.requests.post = lambda *a, **k: FakeResponse(400, text="bad prompt")
    r = post(client, photo)
    if r.status_code != 502 or KEY in r.text:
        failures.append("upstream 400 should be 502 without the key")

    # --- bad input
    muse_image.requests.post = fake_post
    added = copy.deepcopy(OLD)
    added["objects"].append({**OLD["objects"][0], "id": "sofa_2"})
    resized = copy.deepcopy(moved_world())
    resized["objects"][0]["size"] = [3.0, 0.8, 0.9]
    cases = {
        "nothing moved": post(client, photo, new=OLD),
        "object added": post(client, photo, new=added),
        "object resized": post(client, photo, new=resized),
        "invalid world": post(client, photo, new={"version": 1}),
        "not an image": post(client, b"this is not a photo"),
        "bad scan_id": post(client, photo, scan_id="../etc"),
    }
    expect = {"nothing moved": 422, "object added": 422, "object resized": 422, "invalid world": 422, "not an image": 415, "bad scan_id": 422}
    for name, resp in cases.items():
        print(f"  {name}: HTTP {resp.status_code}")
        if resp.status_code != expect[name]:
            failures.append(f"{name}: expected {expect[name]}, got {resp.status_code}")
    if post(client, b"\0" * (16 * 1024 * 1024)).status_code != 413:
        failures.append("photo over 15MB should be 413")
    del os.environ["MODEL_API_KEY"]
    if post(client, photo).status_code != 503:
        failures.append("missing key should be 503")

    # --- character helpers
    disc = Image.new("RGB", (200, 200), "white")
    from PIL import ImageDraw
    d = ImageDraw.Draw(disc)
    d.ellipse([40, 40, 160, 160], fill=(240, 200, 30), outline=(30, 30, 30), width=4)
    d.ellipse([90, 90, 110, 110], fill=(255, 255, 255))  # white eye highlight, must stay
    cut = muse_image.white_background_to_transparent(disc)
    alpha = np.asarray(cut)[:, :, 3]
    if alpha[2, 2] != 0 or alpha[100, 100] != 255 or alpha[60, 100] != 255:
        failures.append("background keying wrong (corner should be clear, eye and body kept)")
    chars_prompt = make_character.read_prompt()
    print("character prompt:", chars_prompt[:90], "...")
    if "original" not in chars_prompt or "\n" in chars_prompt or len(chars_prompt) < 200:
        failures.append("could not read the character prompt")

    print("\nFAIL: " + "; ".join(failures) if failures else "\nPASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
