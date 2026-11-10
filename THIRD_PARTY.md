# Third-party software

Check the licence of anything new BEFORE adding it, then list it here.

| Library | Used in | Licence |
|---|---|---|
| three | web | MIT |
| @dimforge/rapier3d-compat | web | Apache-2.0 |
| vite | web (dev tool) | MIT |
| typescript | web (dev tool) | Apache-2.0 |
| @types/three | web (dev tool) | MIT |
| @playwright/test | web (dev tool: end-to-end smoke test, not shipped) | Apache-2.0 |
| fastapi | server | MIT |
| uvicorn | server | BSD-3-Clause |
| jsonschema | server | MIT |
| trimesh | server (load/export meshes) | MIT |
| fast-simplification | server (mesh decimation, used by trimesh) | MIT |
| numpy | server (used by trimesh) | BSD-3-Clause |
| python-multipart | server (file uploads) | Apache-2.0 |
| requests | server (test upload script) | Apache-2.0 |
| openai (Python SDK) | server (talks to Meta's OpenAI-compatible API) | Apache-2.0 |
| meta-sam-parser | server (decodes SAM 3.1 masks) | SAM License (Meta's own: free to use, copy and modify; keep the licence with any redistribution; no reverse engineering) |
| python-dotenv | server (reads .env) | BSD-3-Clause |
| scipy | server (nearest-vertex colour lookup, connected components) | BSD-3-Clause |
| httpx2 | server (pulled in by openai; used by FastAPI's test client in the offline tests) | BSD-3-Clause |
| pillow | server (PNG encoding, result image) | MIT-CMU (permissive) |

All art, models, sounds and text in this repo must be original or clearly
licensed for reuse. Note any exception, with its source and licence, below.

Optional external tool (not bundled, not installed by us): **ffmpeg**, used by `/transcribe` to convert WebM/Ogg/MP4
audio to WAV if it is installed on the server host. ffmpeg is LGPL or GPL depending on the build; check this before
shipping it in a container.

## Assets
- `web/public/assets/character.png` (generated 2026-11-02): original character made with Meta's `muse-image-1.0` from the prompt in
  `docs/character-prompt.md`. No existing character, brand or third-party artwork is used. Check Meta's terms for generated
  images before submission.
