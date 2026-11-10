---
title: Send min_clearance_m from the website so the layout agent keeps the route wide enough
labels: [enhancement]
---

## Context
`POST /layout` accepts an optional `min_clearance_m` (0.3 to 1.5). When given, the server measures the widest person who can still walk from spawn to goal and refuses proposals that squeeze the route, retrying once with a plain-English reason. The website never sends it (no match in `web/src`), so the layout agent can make a route narrower than the person you are planning for.

## Task
Send `min_clearance_m` from the Work-mode layout flow, using the person width chosen in the clearance panel (or a default when none is chosen). Show the response's `clearance_before_m` and `clearance_after_m` next to the change list.

## Acceptance
- The request body includes `min_clearance_m` when a person width is selected, and omits it otherwise (old behaviour unchanged).
- The UI shows before and after widths when the server returns them, and handles `null`.
- The fake server in `web/src/api.ts` and `web/scripts/test-api.ts` cover the new field.
- A refused proposal (422) still shows the existing plain-English message.
- `npx tsc --noEmit` and the web tests pass; manual check against a running server noted in the PR.

## Pointers
- `web/src/api.ts`: `getLayout` builds the request body
- `web/src/layoutAgentPanel.ts` and `web/src/clearancePanel.ts`: where the width lives
- `server/layout.py`: `LayoutRequest.min_clearance_m`; `server/labelling/clearance.py`
- `docs/architecture.md`: "A4 contracts"
