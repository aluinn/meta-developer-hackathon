---
title: Show low-confidence objects differently in the 3D view
labels: [enhancement]
---

## Context
Every object in `world.json` has a `confidence` from 0 to 1 (the lower of how sure SAM is of the label and how sure Muse Spark is of the role; about 0.3 means a fallback guess). The web app validates it but never shows it, so a guessed object looks as certain as a clear one.

## Task
In the viewer, make objects below a threshold (start with 0.5) visibly less certain, for example a dashed outline or a "?" on the label, and show the confidence in the Work-mode object list. Add a line to the legend explaining it.

## Acceptance
- Objects at or above the threshold look exactly as before.
- Low-confidence objects are distinguishable without relying on colour alone.
- The Work-mode list shows each object's confidence as a percentage.
- Works with `shared/example_world.json` and the ready-made rooms; screenshots in the PR.
- Types pass (`npx tsc --noEmit`), no `any`.

## Pointers
- `web/src/world.ts`: `confidence` is validated here
- `web/src/roomScene.ts`, `web/src/labelSprite.ts`: how boxes and labels are drawn
- `web/src/legend.ts`, `web/src/roles.ts`: colour key
- `web/src/screens.ts`: the object list (`setWorkInfo`)
