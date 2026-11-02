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

## 2026-11-02 - Aluinn (labelling as a background job)
- What I did: on the live site the labelling step was one request of about 100 s, right at the point where hosting layers often cut a request off. Now `POST /scan/{id}/process` starts the job and returns at once, and the website polls `GET /scan/{id}/status` every 2 s (`server/jobs.py`, `web/src/api.ts`). Progress is real ("Looking for furniture… 64%", from the 96 SAM calls finishing). One job at a time (queue) because of the 512 MB host. Also: AI requests now have timeouts (SAM 45 s; the library default was 10 minutes) with 2 retries, and the labelling tolerates a few lost SAM calls (fails only if more than a quarter are lost).
- What worked / what didn't: `test_jobs_synthetic.py` passes (starts in 0.00 s; progress rises; duplicate start returns the same job; a second scan waits in line and never overlaps; no key / AI error / unexpected bug / nothing found each give their own error kind; 1 in 20 lost calls still succeeds, 1 in 2 fails; unknown/bad ids). `web/scripts/test-api.ts` passes (progress messages, job errors, server-restart 404, dropped checks). Real Chrome run on the bathroom scan, locally: longest single request 0.3 s (was about 100 s), 40 progress checks, "2 objects found", no errors, server peak memory 387 MB. That run took 79 s against 47 s before, with a 28 s stall at "99%": the stages after SAM take under 3 s, so it was a straggling Meta API call (which is what the new timeouts bound). NOT yet checked on the live site; the free host's real behaviour is the point of the change.
- AI tools used (and for what): Claude Code, to write the job system and tests and to run the browser check.
- Next: merge, wait for the Render rebuild, run the upload on the live site again.

---

## 2026-11-02 - Aluinn (live upload crashed: "AI service had a problem")
- What I did: you tried the bathroom scan on the live site and got "The AI service had a problem". I reproduced it with curl: the very first step (`POST /scan`) returned Render's own 502 page, not an error from our code, so the process was being killed. Measured the cause locally: the scan has an 8192 x 2560 texture (4 MB file), and `trimesh.load(..., force="mesh")` plus the colour copy peaked at 574 MB, over Render's 512 MB. Fix: `server/labelling/meshio.py` `load_mesh()` shrinks every texture to 2048 px right after loading, used by the upload (A1) and by A2's colour transfer. Peak for the same load: 224 MB; whole upload + label + world run: 379 MB server peak, same result as before (2 objects, 47 s). The website's wording for a proxy 502/503/504 with no message from our server is now "The server is busy or restarting. Wait a minute and try again." (it was wrongly blaming the AI service). Added `scripts/test_meshio.py` (a big-texture scan must shrink and stay under 400 MB) and 3 cases to `web/scripts/test-api.ts`.
- What worked / what didn't: all tests pass; real browser run on the bathroom scan passes. NOT yet verified on the live site (needs this commit merged and Render rebuilt). Headroom is moderate (380 of 512 MB), so a larger scan may still fail; a texture too big to even decode would still crash before the shrink. My earlier live test used a generated mesh with no texture, which is why it did not show this: only a real scan did.
- AI tools used (and for what): Claude Code, to reproduce the failure, measure memory and write the fix.
- Next: merge, wait for the Render rebuild, retry the upload on the live site.

---

## 2026-11-02 - Aluinn (connect the website to the server)
- What I did: the Upload screen now really works. New `web/src/api.ts` (`processScan`: upload, label, world, fetch world.json; relative URLs; plain-English errors; file checks before upload). Small edits to Zac's files: `main.ts` (`onFileChosen` runs `checkScanFile` then `openWorld(..., processScan)`), `screens.ts` (file input accepts `.glb,.obj`, not `.usdz`, which the server rejects), `vite.config.ts` (dev proxy for the API paths). Server default SAM prompts widened to 12 (sofa, armchair, chair, table, desk, bed, rug, door, bookshelf, toilet, sink, bathtub) because the site cannot ask what kind of room it is; fallback roles extended; about $0.24 per scan. Test script `web/scripts/test-api.ts`.
- What worked / what didn't: `node web/scripts/test-api.ts` passes (call order, upload form, 10 error cases). Real end-to-end test in headless Chrome at phone size: chose the real bathroom GLB on the Upload screen, 47 seconds later the Results screen showed "2 objects found" with the 3D room (sink and toilet boxes, Start and Goal markers), 4 API calls all 200, no browser errors; wrong file type and a corrupt .glb give readable messages; the example room still works. NOT done: Layout, voice, render and score are not connected to the UI yet; real iPhone not tried; a furniture scan has not been through the website.
- AI tools used (and for what): Claude Code, to write the code and drive Chrome for the tests.
- Next: Zac: pull before editing `main.ts`/`screens.ts`; connect the Layout tab to `POST /layout`. Me: rescan a furniture room.

---

## 2026-11-02 - Aluinn (first deploy on Render)
- What I did: deployed the all-in-one server to Render (Blueprint from `render.yaml`, branch `main`, free plan; `MODEL_API_KEY` entered in Render's dashboard only, never committed). Tested the live service from here.
- What worked / what didn't: the Docker build worked first time. Live checks: `/health` 200, the website and its JS bundle, `/docs`; scan upload (327,680 -> 50,000 triangles, so numpy/scipy/trimesh work in the image); a real `/layout` call (Muse Spark moved the coffee table next to the sofa, valid, first attempt, walkable before and after); a real `/transcribe` call (stereo 48 kHz WAV accepted and converted; empty transcript for a test tone, as expected). NOT tested live: `/render`, the SAM calls (`/label`, `/score` on a deployed scan), WebM/Ogg audio (needs ffmpeg in the image), anything with real speech. Reminders: free plan sleeps after 15 min and wipes scans; the URL is public and spends credits, so it is NOT written in the repo.
- AI tools used (and for what): Claude Code, to test the live service.
- Next: rescan a furniture room; run the whole chain on the live site; `/render` with a real photo; Zac connects the web app to the API.

---

## 2026-11-02 - Aluinn (one server for site + API)
- What I did: FastAPI now serves the built web app at `/` (mounted last, so the API routes win) when `web/dist` exists. The `Dockerfile` is two stages: build the web app with Node, then the Python image with the site copied in. `.dockerignore` no longer excludes `web/`. Docs updated (`docs/deployment.md`, architecture, README). No CORS needed in production, and no separate Vercel deploy.
- What worked / what didn't: tested locally on one port with no Vite dev server: `/` serves the site, the JS and the lazy physics chunk load, and `/health`, `/world/<id>`, `/score/<id>`, `/docs` and `POST /layout` (422 = API answered) all still reach the API. `npm ci --dry-run` confirms the lockfile is in sync. NOT tested: the Docker build itself (no Docker on this Mac) or a deployed Render service. Zac's web app does not call the API yet; when it does it must use relative URLs, and `web/vite.config.ts` needs a dev proxy.
- AI tools used (and for what): Claude Code, to write and test the change.
- Next: Render deploy; tell Zac about relative URLs and the dev proxy.

---

## 2026-11-02 - Aluinn (first real /score: SAM on the render failed, silhouette works)
- What I did: ran `GET /score` for real on the bathroom (the 64-call SAM-on-render method as specified). Result: every object scored 0%. Looking at the render showed why: SAM was shown plain grey boxes in a plain room and does not recognise them as a toilet or sink (it found both in the real scan, 5 views each). So I added `method=silhouette` (now the default): compare each box's outline in the render of world.json with SAM's mask of that object on the scan (free, no API calls). `method=sam_on_render` is kept as an option.
- What worked / what didn't: bathroom score with the silhouette method: overall 44% (toilet 37.6%, sink 50.7%, stable across views). Low because a box cannot match a toilet, so scores must be read relatively. First version penalised views where SAM saw no toilet at all (28.6%); now those are skipped, and a box is only a miss where SAM saw that object type elsewhere in the view. The offline test passes for both methods (faithful ~85%, moved table 90% -> 0%, missing sofa unmatched). Lesson: my fake SAM in the tests found boxes by colour, so the original method passed tests but failed on real data; the real run was the only thing that showed it. The score endpoint's cache survived a code change (needed `?refresh=true`).
- AI tools used (and for what): Claude Code, to run the real score, look at what SAM was shown, and add the second method.
- Next: rescan a furniture room and run /layout, /render, /score there; deploy to Render.

---

## 2026-11-02 - Aluinn (living room scan: a failure, and what changed)
- What I did: ran the second real scan ("LivingRoom.glb": 99,999 triangles, 4.4 x 6.9 m wide and long but only 1.73 m tall) through A1 (simplified 99,999 -> 49,999: real decimation works) and A2.
- What worked / what didn't: A2 found almost nothing (SAM: a plant in 2 views; no sofa, table or chair, 0 objects). Inspecting the mesh showed why: it is an open-plan room with a vaulted ceiling, big windows and outdoor ground, and a patchy blobby shell; my camera rule (fixed 1.5 m eye height on a ring from the bounding box) put cameras in the roof beams and outside the room. Changes kept: eye height now scales with the room (55% of its height, 0.5 to 1.5 m) and cameras slide along the ring to open space; voting now needs a label from at least 2 views (a surface only one camera sees cannot be cross-checked; my synthetic test's planted wrong 'chair' exposed that single-view labels slipped through). Tried and dropped: choosing camera spots from scanned floor with farthest-point sampling, which made it worse here because the outdoor ground counts as floor. Also suspicious: the scan's scale (a vaulted room only 1.73 m tall), so Polycam may not have produced metric scale (needs a check against a known measurement). Conclusion: rescan a smaller, simpler, closed room.
- AI tools used (and for what): Claude Code, to inspect the mesh, render test views and adjust the camera and voting code.
- Next: rescan a small room with a sofa/chairs/table (closed room, few windows, no outdoors in the scan); check the scale in Polycam; rerun A2 to A4.

---

## 2026-11-02 - Aluinn (first real run: bathroom scan + character)
- What I did: first test with a real API key and a real scan (Polycam GLB, "Three Links bathroom", 25,458 triangles, about 1.8 x 2.4 x 2.2 m, textured). Ran A1 upload, A2 SAM labelling (prompts toilet, sink, bathtub, shower, mirror, cabinet, door, towel) and A3 Muse Spark roles; saved the result as `shared/real_world_01.json` for Zac. Generated the original character with Muse Image (`web/public/assets/character.png`, 512x512, transparent background; prompt and log in `docs/character-prompt.md`). `POST /scan/{id}/label` now takes optional `prompts`; added `scripts/revote.py` (redo 3D voting from saved masks for free).
- What worked / what didn't: the real calls all worked first time: key check, SAM (29 s, streaming + mask decoding + confidence flag), Muse Spark structured output (8 s, valid world.json, sensible reasons), Muse Image. SAM found the toilet (5 views) and sink (5 views) and the projected 3D boxes land on the real fixtures; nothing found for bathtub/shower/mirror/cabinet/door/towel (probably not in the room). BUG found by the real scan: A2 returned the toilet as 9 boxes and the sink as 5, because patches were only joined if their faces touched; fixed by merging same-label patches whose boxes are within 5 cm (now 1 toilet, 1 sink; new unit test). Both objects were given role `fixed`, so this room has nothing movable: `/layout` has nothing to move, and play mode has nothing to climb. NOT yet run for real: `/layout`, `/render`, `/transcribe`, `/score`. Render deploy not done.
- AI tools used (and for what): Claude Code, to run the pipeline, inspect the results and fix the merge bug.
- Next: pick a room with movable furniture (sofa, chairs, table) for the demo; try /layout, /score and /render on it; deploy to Render.

---

## 2026-11-02 - Zac (Z3)
- What I did: play mode. The Play tab opens a full-screen game: a capsule character (original shapes) starts at `spawn` and runs/jumps across the furniture to `goal`; "You made it!" shows the time with Restart; falling below the floor respawns. Physics with Rapier, built from the world.json boxes: floor at `floor_y`, four invisible walls 20 m high, a box collider per non-passable object with the same rotation as the drawn box. Kinematic character controller: walk 4 m/s, jump to about 1.2 m (sofa yes, bookshelf no), auto-steps ledges up to 0.3 m only. Physics steps at a fixed 60 per second; drawing is smoothed between steps. Third-person camera follows behind, rises over the character in tight corners, and can go at most 1 m past the (undrawn) walls. Controls: WASD/arrows + Space; on touch screens a hand-made thumbstick, a Jump button and drag-to-look. Back returns to the 3D view and frees everything. Debug switches in the address: `?colliders` draws the physics colliders in red, `?fps` shows the frame rate. Files: `stage.ts` (shared renderer/room/loop, moved out of `viewer.ts`), `physics.ts`, `motion.ts`, `character.ts`, `input.ts`, `followCamera.ts`, `colliderDebug.ts`, `play.ts`. Rapier is only downloaded when you press Play (big file: 4.3 MB, 1.7 MB compressed). `test_world.json` now has `floor_y` -1.3 and a sofa turned 0.5 rad.
- What worked / what didn't: `npx tsc --noEmit` and `npm run build` pass. Physics checked in Node with the real code: colliders line up with the boxes to 1 cm, including the 90° bookshelf and the 0.5 rad sofa on a -1.3 floor; jump onto the sofa works, bookshelf doesn't, coffee table (0.4 m) isn't auto-climbed, walls hold. Checked in headless Chrome: keyboard run to the goal (example and test room); touch thumbstick + Jump with two fingers in portrait and landscape; 60 fps; no page scroll or text selection; 5 Play/Back round trips leave 1 canvas and 0 leftover HUDs. Fixed on the way: camera squashed inside the character at a corner spawn; Start pole drawn through the character; huge labels up close. NOT tested: a real iPhone (feel of the stick, speed on a real GPU), to do by hand.
- AI tools used (and for what): Claude Code, to write the code, test physics in Node and drive headless Chrome.
- Next: try it on the iPhone; Z4 (clearance check) can reuse `physics.ts` and `motion.ts`.

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

## 2026-11-01 - Zac (Z2)
- What I did: the Results screen now shows the room in 3D with three.js. Floor and faint wall outline from `room.bounds`; each object is a box coloured by role (passable is see-through) with a text label; Start and Goal markers; a colour legend. OrbitControls: one finger rotates, pinch zooms, two fingers pan, mouse works too. Camera fits the whole room and re-fits on rotation until you move it yourself. Files: `viewer.ts` (renderer, camera, controls, loop, clean-up), `roomScene.ts` (World -> 3D objects, no camera/screens so Z3 can reuse it), `labelSprite.ts`, `roles.ts`, `legend.ts`, `dispose.ts`. Empty hook `loadScanMesh()` plus an empty `scan-mesh-layer` for the .glb scan later. `test_world.json` (in `web/src`, dev only): the example with the sofa moved and a plant added; "Use test room (dev only)" button loads it with no code changes.
- What worked / what didn't: `npx tsc --noEmit` and `npm run build` pass. Checked in headless Chrome: example room (6 boxes) and test room (7) both draw; 5 trips Results <-> Upload leave exactly 1 canvas, 0 on Upload; no page scroll; canvas resizes when rotated. Bugs found and fixed on the way: first dev click failed while Vite re-prepared three (now pre-bundled); camera cropped the room on tall phone screens; Goal hid behind the bookshelf; sideways phone left the 3D view tiny. NOT tested: a real iPhone's touch gestures (headless Chrome has no touch), to do by hand. Assumption to confirm with Aluinn: `rotation_y` positive = anticlockwise seen from above (three.js default).
- AI tools used (and for what): Claude Code, to write the code, and to drive headless Chrome for screenshots.
- Next: Z3 (play mode). Agree with Aluinn how the scan mesh reaches the browser (.glb, see chat notes).

---

## 2026-11-01 - Zac (Z1)
- What I did: built the app shell in `web/`. Three screens in one page (Upload, Loading, Results) switched without reloading. "Use example room" loads `shared/example_world.json`, shows Loading for about 1 second, then Results with the object count. Choosing a file only shows its name and size (nothing is uploaded). Results has an empty area for the 3D view (Z2) and Play / Layout tabs that only change which one looks selected. Files: `world.ts` (hand-written World type + checker + loader), `screens.ts`, `format.ts`, `main.ts`, `style.css`, `vite.config.ts` (lets the dev server read `/shared`). No new libraries.
- What worked / what didn't: `npx tsc --noEmit` and `npm run build` pass; the dev server serves the page and the shared file. Not yet clicked through by hand on laptop or iPhone (to do).
- AI tools used (and for what): Claude Code, to write the code and explain each step.
- Next: Z2 (3D viewer that loads world.json).

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
