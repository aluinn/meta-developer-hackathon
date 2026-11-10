# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project does not yet use versioned releases.

## [Unreleased]

### Added
- Real screenshots in `docs/assets/`, a restructured README, and community files (contributing guide, code of conduct, security policy, citation file, issue and pull request templates, Dependabot).

## [0.1.0] - 2026-11-04

First complete version, built for the Meta Global AI Developer Hackathon (Indie track).

### Added
- Server pipeline: scan upload and simplification, SAM 3.1 furniture labelling projected onto the 3D mesh, Muse Spark roles, `world.json` output validated against `shared/world.schema.json`.
- Layout agent (`POST /layout`) with code-checked moves, an optional `min_clearance_m` route check, voice transcription (`POST /transcribe`), before and after pictures (`POST /render`) and the scan match score (`GET /score/{scan_id}`).
- Web app: upload and results screens, 3D viewer, Game mode (Rapier physics, race course on the real scan), Work mode (clearance check, layout panel), character maker.
- Ready-made rooms: Zac's room and a studio apartment (real scans), a made-up example room, and a narrow-gap room.
- Drag and drop upload; background jobs with progress; one worker process per job to fit a 512 MB host.
- Docker image and Render Blueprint serving the site and API together.
- Offline test suites for server (fake AI answers) and web logic.

### Fixed
- Memory peaks on large scans (shared texture budget).
- Race gates, boxes and hazards now sit on open floor in real scans.
