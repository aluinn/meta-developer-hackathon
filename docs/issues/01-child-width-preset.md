---
title: Add a "child" person preset to the clearance check
labels: [good first issue]
---

## Context
The clearance check offers three preset widths (walking 0.5 m, walker 0.7 m, wheelchair 0.85 m) plus a slider from 0.4 to 1.2 m. A narrower preset would help check rooms for small children, and the code is built so adding one is mostly a data change.

## Task
Add a `child` entry to `PERSON_WIDTHS` and show it as a button in the clearance panel. Pick a sensible width (the slider's minimum is 0.4 m, so stay at or above that) and say in a code comment that it is an estimate, like the others.

## Acceptance
- A "Child" button appears next to Walking, Walker and Wheelchair and runs the check at its width.
- `personLabel()` returns "Child" for that width.
- `web/scripts/test-clearance.ts` has a check for the new preset.
- `cd web && npx tsc --noEmit` and the web tests pass.
- Screenshot of the new button in the PR.

## Pointers
- `web/src/clearance.ts`: `PERSON_WIDTHS`, `personLabel`, `WIDTH_SLIDER`
- `web/src/clearancePanel.ts`: `KINDS` is built from `PERSON_WIDTHS`, so check the buttons still lay out well
- `docs/clearance.md`: update the presets row
