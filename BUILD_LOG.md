# Build log

Add a new entry at the TOP after each work session. Copy the template.

## Entry format

```
## YYYY-MM-DD - Name (Aluinn / Zac)
- What I did:
- What worked / what didn't:
- AI tools used (and for what):
- Next:
```

---

## 2026-11-01 - Aluinn (A6 + CORS)
- What I did: `GET /score/{scan_id}` (`score.py`, `labelling/match_score.py`): rebuilds the room from world.json (boxes, coloured from where the scan found each object), renders it from A2's cameras, runs SAM on the renders, and compares per-object masks with the masks from the scan as IoU. Returns an overall percentage, per-object scores and unmatched scan detections; cached in `score.json`. A2 now saves every mask (`views/masks.npz`). Method written up in `docs/architecture.md`. CORS added (`ALLOWED_ORIGINS`, default localhost:5173), `SCANS_DIR` setting, `Dockerfile`, `.dockerignore`, `render.yaml`, `docs/deployment.md` (options and recommendation: Render).
- What worked / what didn't: `test_score_synthetic.py` passes: a faithful world ~82% (capped by the fake SAM's pixel noise), a table moved 1.2 m drops to 0% while other objects stay ~82%, a deleted sofa is reported as unmatched, caching/refresh and error codes work. The test caught a flaw in my first design (objects were coloured from the scan at their world.json position, so a misplaced object turned floor-coloured and was skipped instead of penalised); fixed by colouring from where A2 found the object. Checked locally with the Dockerfile's start command: /health ok, CORS allows only the listed origins, uploads go to SCANS_DIR. NOT done: the actual deploy and a test of the deployed /health (needs your Render account and key; Docker is not installed here so the image was not built). Real SAM scores on a real scan are untested.
- AI tools used (and for what): Claude Code, to research hosts and write the code, tests and docs.
- Next: deploy on Render with the steps in docs/deployment.md, send me the URL to test /health, then the real-key testing round.

---

## 2026-11-01 - Aluinn (A5)
- What I did: `POST /render` (`photo_render.py`, `labelling/muse_image.py`): takes a room photo plus old and new world.json, works out which objects moved, describes each move in plain words anchored on nearby objects, and calls Muse Image `POST /v1/images/edits` (JSON `images` array, `size` = photo aspect, png) to move only those. Saves `render/before.png` and `after.png`, served by `GET /render/{scan_id}/before|after`. Adds `changed_fraction` / `likely_changed_too_much` (the cookbook says to check unchanged areas still match). Also `scripts/make_character.py` and `docs/character-prompt.md` for the original character (white background keyed out, since Muse Image ignores transparency).
- What worked / what didn't: offline test passes (exact request fields, prompt wording, 503 retry, 502 without leaking the key, only-moves validation, bad photos, key-out of the white background). Reading the generated prompt showed "touching" was used for a 15 cm gap; fixed. NOT done: running on real photos (none on this Mac, no API key) and the character image itself (needs the key), so `web/public/assets/character.png` does not exist yet. Real Muse Image behaviour (does it move the right object? does it leave the rest alone?) is unknown until a real run.
- AI tools used (and for what): Claude Code, to read the Meta docs and write the code and tests.
- Next: MODEL_API_KEY, then run `make_character.py`, look at the result, and try `/render` on a real photo. Then A6.

---

## 2026-11-01 - Aluinn (A4)
- What I did: `POST /transcribe` (`transcribe.py`): accepts browser audio, converts any 16-bit PCM WAV to mono 16 kHz in Python (Meta accepts only WAV), calls `POST https://api.meta.ai/v1/asr/transcribe` with `muse-voice-transcribe-1.0`. `POST /layout` (`layout.py`, `labelling/layout.py`): Muse Spark proposes x/z (+ optional quarter turn) for movable objects; code rejects non-movable ids, objects outside the room, and overlaps with any non-passable object; one retry with the problems as feedback, else 422; returns a schema-valid world.json, a reason per change and a spawn-to-goal walkability flag. Wrote `docs/architecture.md`.
- What worked / what didn't: offline tests pass (`test_layout_synthetic.py`: 3 goals + 8 rejection cases; `test_transcribe_synthetic.py`: audio conversion and the exact Meta request format). The "model" in the layout test is a scripted stand-in I wrote, so it tests our checks, not Muse Spark's judgement. NOT tested: real Muse Spark/Voice calls (no API key). Found and fixed a bug in my own `shared/example_world.json`: the bookshelf's `rotation_y` of 1.5708 turned it sideways through the east wall; now 0. Browsers do not record WAV, and there is no ffmpeg on this Mac, so webm/ogg/mp4 audio gets a 415 until Zac encodes WAV in the browser or the server host has ffmpeg.
- AI tools used (and for what): Claude Code, to read the Meta docs and write the code and tests.
- Next: MODEL_API_KEY + a real scan to run A1 -> A2 -> A3 -> A4 end to end. Then A5.

---

## 2026-11-01 - Aluinn (A3)
- What I did: `labelling/roles.py` asks Muse Spark (`muse-spark-1.3`, Responses API, `input_image` parts, `text.format` json_schema) for a role + confidence per object, shown the 8 views with the A2 boxes drawn on and tagged with ids. `labelling/world.py` builds world.json (room bounds and floor_y from the mesh, spawn and goal on free floor, farthest walkable cell from spawn) and validates it against `shared/world.schema.json`. Endpoints: `POST /scan/{scan_id}/world`, `GET /world/{scan_id}`. Script: `scripts/make_world.py`.
- What worked / what didn't: offline test passes (fake Muse Spark with an invalid role, a missing object and confidence 1.4: fallbacks and clamping work, output validates, spawn/goal are on free floor and 3m+ apart, GET works, path traversal rejected). NOT tested: the real Muse Spark call (no API key). `shared/real_world_01.json` NOT created: no real scan has been labelled yet; fabricating one would mislead Zac.
- AI tools used (and for what): Claude Code, to read the Meta docs and write the code.
- Next: add MODEL_API_KEY, run upload -> label -> world on a real scan, save with `--out ../shared/real_world_01.json`, commit. Then A4.

---

## 2026-11-01 - Aluinn (A2)
- What I did: built the labelling pipeline in `server/labelling/`. Renders 8 virtual camera views of the simplified mesh (keeps each camera's position/orientation), calls SAM 3.1 per view per prompt (`POST https://api.meta.ai/v1/responses`, model `sam-3.1`), projects masks onto 3D triangles using a per-pixel triangle-id image, votes one label per surface across views, groups surfaces into objects with metre bounding boxes. Endpoint: `POST /scan/{scan_id}/label`. Output: `labels.json`. Also `scripts/make_label_image.py` and `scripts/test_labelling_synthetic.py`.
- What worked / what didn't: offline test on a fake living room with a fake SAM (finds objects by colour, plus a wrong label in one view and a false patch in another) passes: 6/6 objects, centres exact, the wrong "bed" label rejected. See `docs/a2_synthetic_result.png`. NOT tested: the real SAM call (no API key yet) and a real scan (none found on disk). The Muse Spark fallback was not built; projection works by construction, so the fallback is only needed if real SAM output misbehaves. Bug found on the way: colour copying silently fell back to grey; fixed, and `labels.json` now records `colour_source`.
- AI tools used (and for what): Claude Code, to read the Meta docs and write the pipeline.
- Next: add `.env` with MODEL_API_KEY, export a real scan as .glb/.obj, upload via A1, run `/label`, check the result image. Then A3.

---

## 2026-10-31 - Aluinn (A1)
- What I did: added `POST /scan` (.glb/.obj, max 100MB). It saves to `server/scans/<scan_id>/`, simplifies to about 50k triangles (trimesh + fast-simplification) and returns `scan_id`, `triangles_before`, `triangles_after`. Added `server/scripts/upload_test.py`.
- What worked / what didn't: tested with a generated 327,680-triangle sphere (-> 50,000), a small .obj (unchanged), a wrong extension (400), a corrupt file (422) and a 101MB file (413). Not yet run on a real room scan.
- AI tools used (and for what): Claude Code, to write the endpoint and test script.
- Next: run on a real scan, then A2 (SAM 3.1 labelling).

---

## 2026-10-31 - Aluinn
- What I did: created the project skeleton (web, server, shared, docs) and the world.json contract.
- What worked / what didn't: web app and server both start; example world validates against the schema.
- AI tools used (and for what): Claude Code, to scaffold the project.
- Next: Aluinn starts A1 on branch `aluinn/start`; Zac starts Z1.
