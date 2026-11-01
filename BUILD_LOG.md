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
