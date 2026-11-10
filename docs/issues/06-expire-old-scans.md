---
title: Delete old scans from the server automatically
labels: [enhancement]
---

## Context
Every upload creates a folder `server/scans/<id>/` (original, simplified mesh, rendered views, masks, `world.json`). The code removes partial uploads and old characters (`server/characters.py` uses `shutil.rmtree`), but nothing removes finished scans, so a long-running host slowly fills its disk. Scans may also be of private rooms, so keeping them forever is not ideal either.

## Task
Add an expiry: on startup and then periodically, delete scan folders older than a configurable age (for example `SCAN_MAX_AGE_HOURS`, default something like 24). Never delete a scan with a job that is queued or running.

## Acceptance
- New setting documented in `.env.example` and `docs/deployment.md`.
- An offline test (see `server/scripts/test_upload_synthetic.py` for the style) creates fake old and new folders and checks only the old one is removed, and that an active job's scan is kept.
- Behaviour when `SCANS_DIR` is a mounted disk is unchanged apart from the cleanup.
- `SECURITY.md` is updated to mention retention.

## Pointers
- `server/scans.py`: upload, `SCANS_DIR`
- `server/jobs.py`: which scans have active jobs
- `server/characters.py`: existing cleanup pattern
