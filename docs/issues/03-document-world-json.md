---
title: Document world.json field by field
labels: [good first issue]
---

## Context
`world.json` is the handover between the server and the web app, but its meaning lives in `shared/world.schema.json` and scattered comments. Newcomers who want to produce their own file have to read the schema.

## Task
Write `docs/world-json.md`: a table of every field (type, units, meaning, example), the four roles, and the conventions (metres, y up, `rotation_y` positive = anticlockwise seen from above, `position` is the box centre, `size` is [w, h, d], `floor_y` is not always 0). Include a minimal valid example.

## Acceptance
- Every field in the schema is described.
- The example in the doc validates against `shared/world.schema.json` (say how you checked).
- The README and `docs/architecture.md` link to the new page.
- Do not change the schema: changes to `shared/` need both maintainers' agreement.

## Pointers
- `shared/world.schema.json`, `shared/example_world.json`
- `docs/architecture.md`: the section "The world.json contract"
- `web/src/world.ts`: how the web side validates it
