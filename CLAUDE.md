# CLAUDE.md

## Project
"Room world": a hackathon project (team of two, beginners) that turns a scan of a
real room into a playable 3D world. The server's AI pipeline turns a scan into
`world.json`; the web app loads it and simulates it with physics.
(BRIEF.md was not available when this file was written. Update this section from it.)

## Who builds what
- **Aluinn: A1 to A6**, server and AI pipeline (`/server`).
- **Zac: Z1 to Z6**, web app and simulation (`/web`).
- Each stays in their own folder to avoid conflicts. Changes to `/shared` need both people to agree.

## Rules (from the brief)
- Public repo. Original assets only. Check licences before adding any library or asset, and list it in THIRD_PARTY.md.
- Never commit keys. Secrets live in `.env` (git-ignored); only `.env.example` with placeholders is committed. Never print or store real keys.
- Small commits with clear messages. Own branch per person, PR into `main`, `main` must always run (see CONTRIBUTING.md).
- Log each session in BUILD_LOG.md (newest first).

## Run
- Web: `cd web && npm install && npm run dev` -> http://localhost:5173
- Server: `cd server && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn main:app --reload --port 8000` -> http://localhost:8000/health

## Conventions
- Web: TypeScript, strict types, small modules in `web/src`, no `any`. Run `npx tsc --noEmit` before committing.
- Server: Python 3.11+, type hints, FastAPI routes in small modules, config via `os.environ`.
- Explain things in plain English; the team is new to this. Prefer simple over clever.
- Don't add dependencies without asking and checking the licence.

## The contract: world.json
`shared/world.schema.json` is the handover between server and web. Server outputs it, web consumes it.
- Units metres, y-axis up. Fields: `version`, `source_scan`, `room{bounds{min,max}, floor_y}`,
  `objects[{id,label,role,confidence,position,size,rotation_y}]`, `spawn`, `goal`.
- `role` is one of `fixed`, `movable`, `climbable`, `passable`. `position` is the box centre; `size` is [w,h,d]; `rotation_y` in radians.
- `shared/example_world.json` must always validate against the schema. Changing the schema means updating the example, both sides, and telling the other person.

## Out of scope
No features were built in the skeleton. Also out of scope: user accounts, databases, deployment/hosting, committing scan files, and anything not needed for the demo.
