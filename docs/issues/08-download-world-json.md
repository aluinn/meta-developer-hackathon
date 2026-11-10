---
title: Add a "Download world.json" button on the results screen
labels: [enhancement]
---

## Context
The README describes `world.json` as the handover file, and the idea of exporting worlds for other tools is on the roadmap. Today the only way to get the file is from the server's `GET /world/{id}` or from the repo's examples.

## Task
Add a button on the results screen that downloads the world currently shown (including after a layout change) as `world.json`, using a Blob and a temporary link (no new dependency). Name the file after the room title.

## Acceptance
- Works for uploaded scans and for the ready-made rooms.
- After accepting a layout change, the downloaded file contains the new positions.
- The downloaded file validates against `shared/world.schema.json`.
- Button is keyboard accessible and styled like the existing ones.

## Pointers
- `web/src/main.ts`: the current `world` and `screens.setResultsSummary`
- `web/src/screens.ts`: results screen buttons
- `web/src/world.ts`: the `World` type
- `shared/world.schema.json`
