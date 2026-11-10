# Roadmap

Ideas, not promises. Everything below comes from limits the project already documents ([README FAQ](README.md#faq), [docs/architecture.md](docs/architecture.md)) or from checking the code. Pick one up through an issue; see [CONTRIBUTING.md](CONTRIBUTING.md) and the drafts in [docs/issues/](docs/issues/).

## Next: close the gaps we know about

- **Use the clearance-aware layout check from the website.** The server's `POST /layout` accepts `min_clearance_m` and retries when a route is too narrow, but the web app does not send it yet.
- **Test the parts never run for real.** `/render` needs a real room photo, and `/transcribe` has only been run on a test tone, not on speech or on WebM/Ogg/MP4 audio (documented in `docs/architecture.md`).
- **Browser-level tests in CI.** Web logic is tested with plain Node scripts; there is no automated check of the screens themselves.
- **Faster layouts.** A layout takes 30 to 100 seconds on the free host.

## Later: make scans richer

- **More furniture found.** Only objects the models can name are found, and the ready-made real scans each show 2. Ask for more kinds of objects and handle more of the room (windows are not in the room data today).
- **Better shapes than boxes.** Objects are boxes; a tighter fit would improve clearance and the match score.
- **Add or remove furniture in a layout.** Today only movable objects move; nothing can be added or removed.

## Ideas

- More people presets and a saved list of favourite widths.
- Share a finished room as a link.
- Export a world for a game engine.

## Not planned

User accounts, databases and committing scan files are out of scope for this project.
