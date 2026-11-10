---
title: Test /transcribe on real speech and on browser audio formats
labels: [enhancement]
---

## Context
`docs/architecture.md` records that `/transcribe` was proven only with a generated WAV tone (which gives an empty transcript). Real speech and WebM/Ogg/MP4 audio, which is what browsers record, were untested. The server converts WAV itself and needs `ffmpeg` for the other formats, otherwise it answers 415. The web app records WAV in the browser (`web/src/wavRecorder.ts`, `wavEncode.ts`), so the ffmpeg path may never be used in practice.

## Task
Check the real behaviour and record the result: send a short spoken sentence as WAV, then as WebM and Ogg (with and without `ffmpeg` installed), and note what comes back. Add an offline test for the format-detection and 415 path using the existing fake model, and update the docs with what you found. This needs a `MODEL_API_KEY` for the real-speech part; the offline test does not.

## Acceptance
- A short table in `docs/architecture.md` (or a new doc) listing format, ffmpeg present or not, and the outcome.
- An offline test that covers a non-WAV upload with no ffmpeg returning 415.
- No audio of anyone's voice but your own is committed, and no keys.

## Pointers
- `server/transcribe.py`: conversion and the 415
- `server/scripts/test_transcribe_synthetic.py`: existing offline test
- `web/src/wavRecorder.ts`, `web/src/wavEncode.ts`
- `Dockerfile`: installs `ffmpeg`
