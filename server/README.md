# Server (FastAPI)

Needs Python 3.11 or newer. Run all commands from inside `server/`.

## First-time setup (virtual environment)

A virtual environment ("venv") is a private box of Python packages for this
project, so it doesn't mess with the rest of your computer.

Mac:

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt

Windows (PowerShell):

    py -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -r requirements.txt

You'll see `(.venv)` at the start of your terminal line when it's active.
Activate it again each time you open a new terminal.

## Run

    uvicorn main:app --reload --port 8000

Then open http://localhost:8000/health. You should see `{"status":"ok"}`.
Auto-generated docs: http://localhost:8000/docs

## Upload a scan (A1)

`POST /scan` takes a `.glb` or `.obj` file (max 100MB), saves it under `server/scans/`
(git-ignored), simplifies it to about 50,000 triangles and returns
`{"scan_id", "triangles_before", "triangles_after"}`.

With the server running, in a second terminal (venv active):

    python scripts/upload_test.py path/to/room.glb
    python scripts/upload_test.py --make-test-mesh     # no scan handy? uses a generated sphere

## Label a scan (A2)

Needs `MODEL_API_KEY` in `.env` (see below). `POST /scan/{scan_id}/label` renders the
simplified mesh from 8 virtual cameras, asks SAM 3.1 for sofa, bookshelf, table, chair,
rug, door, bed and desk in each view, projects the masks onto the 3D surface, votes
for one label per surface and writes `scans/<scan_id>/labels.json` (objects with
bounding boxes in metres, plus every camera's position and orientation).

    python scripts/make_label_image.py scans/<scan_id>   # draws the result: labels_overview.png

Test the geometry and voting offline (no API calls, no key needed):

    python scripts/test_labelling_synthetic.py

`POST /scan/{scan_id}/label` takes an optional JSON body to choose what to look for, e.g.
`{"prompts": ["toilet", "sink", "bathtub"]}` (short noun phrases, up to 16; the default is a broad list: sofa, armchair, chair, table, desk, bed, rug, door, bookshelf, toilet, sink, bathtub, which costs about $0.24 per scan).
Every SAM mask is saved, so `python scripts/revote.py scans/<scan_id>` redoes the 3D voting for free if you change the voting code.

## Make a world.json (A3)

After labelling, `POST /scan/{scan_id}/world` shows the labelled views to Muse Spark
(`muse-spark-1.3`), which gives each object a role (fixed / movable / climbable / passable)
and a confidence. The server writes `scans/<scan_id>/world.json`, checked against
`shared/world.schema.json`, and `GET /world/{scan_id}` returns it. Role reasons are
saved in `roles_detail.json`.

    python scripts/make_world.py <scan_id>
    python scripts/make_world.py <scan_id> --out ../shared/real_world_01.json

Offline test (no API calls): `python scripts/test_world_synthetic.py`

Notes: `rotation_y` is always 0 for now (A2 boxes are axis-aligned). An object's
`confidence` is the lower of A2's label confidence and Muse Spark's role confidence.
If the model gives no valid role for an object, a default for its label is used at
confidence 0.3 (see `roles_detail.json`, `"source": "fallback"`).

## Voice and layout (A4)

`POST /transcribe` takes an `audio` file (multipart) and returns `{"transcript", "duration_ms"}` using
`muse-voice-transcribe-1.0`. Meta only accepts mono 16-bit PCM WAV: we convert any 16-bit PCM WAV ourselves, and
WebM/Ogg/MP4 only if `ffmpeg` is installed (otherwise 415).

`POST /layout` takes `{"scan_id", "goal", "world"?}`, asks Muse Spark to move **movable** objects only, rejects
proposals that leave the room or overlap other solid objects (one retry), and returns a new valid world.json plus a
reason per change. See `docs/architecture.md` for the exact response.

Offline tests (no key, no API calls): `python scripts/test_layout_synthetic.py`, `python scripts/test_transcribe_synthetic.py`

## Before/after images and the character (A5)

`POST /render` (multipart: `scan_id`, `photo`, `old_world`, `new_world`) asks `muse-image-1.0` to move only the objects that
changed between the two worlds, and returns `before_url` / `after_url` plus a `changed_fraction` sanity check. Costs $0.01 per call.
`python scripts/make_character.py` generates the original character from `docs/character-prompt.md` into `web/public/assets/`.

Offline test (no key): `python scripts/test_render_synthetic.py`

## Score (A6)

`GET /score/{scan_id}`: how well `world.json` matches the scanned room (each world box's outline vs SAM's mask of the real object, per object). Free, no API calls.
`?method=sam_on_render` (about $0.16) runs SAM on the render of the boxes instead, but SAM does not recognise plain boxes on real scans. The result is saved in `score.json`; add `?refresh=true` to recompute.
Offline test: `python scripts/test_score_synthetic.py`

## CORS and deployment

The web app's address must be in `ALLOWED_ORIGINS` (default: `http://localhost:5173`, so local development works). To deploy, see `../docs/deployment.md`.

## Secrets

Never put API keys in code. Copy `../.env.example` to `.env` (in `server/` or the repo root), fill in your own
values, and read them with `os.environ`. `.env` is git-ignored.
