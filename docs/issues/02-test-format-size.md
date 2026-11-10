---
title: Add unit tests for formatSize
labels: [good first issue]
---

## Context
`web/src/format.ts` turns a byte count into text like "2.4 MB" for the upload screen. No test script covers it (the other logic in `web/scripts/` is tested with plain Node and no framework).

## Task
Create `web/scripts/test-format.ts` in the same style as `test-clearance.ts` (a small `check()` helper, prints ok/FAIL, exits non-zero on failure). Cover the edges: 0 bytes, 1023 bytes, 1024 bytes, just under 1 MB, exactly 1 MB, and a size over 1 GB.

## Acceptance
- `cd web && node scripts/test-format.ts` passes and exits non-zero if a case fails.
- No new dependencies.
- If a case shows odd output (for example "1024.0 KB"), describe it in the PR; fix it only if the fix is small.

## Pointers
- `web/src/format.ts`
- `web/scripts/test-clearance.ts`: the `check` helper pattern to copy
