# Performance

What was measured, on what, and how to reproduce it. Only the parts that run on your own machine without an API key are measured here.

## Machine

Apple M1 Pro, 8 cores, 16 GB, macOS (Darwin 24.6), Node v24.20.0, Python 3.12.10. Median of 20 runs after 3 warm-up runs, on 2026-11-10.

## Clearance check, in the browser's code (TypeScript, run under Node)

`cd web && node scripts/bench-clearance.ts`

| World | Objects | Grid (cells) | Build floor map (ms) | Check, walking 0.5 m (ms) | Check, wheelchair 0.85 m (ms) |
|---|---|---|---|---|---|
| shared/example_world.json | 6 | 120 x 100 | 9.0 | 7.0 | 6.2 |
| shared/real_world_01.json (bathroom scan) | 2 | 37 x 44 | 1.0 | 0.6 | 0.5 |
| examples/zac-room (real scan) | 2 | 105 x 64 | 3.8 | 3.7 | 3.0 |
| examples/studio-apartment (real scan) | 2 | 83 x 148 | 7.2 | 6.1 | 5.5 |
| src/clearance_test_world.json (narrow gap) | 6 | 120 x 100 | 8.0 | 10.4 | 4.4 |

## Route-width check on the server (Python)

`cd server && source .venv/bin/activate && python scripts/bench_clearance.py`

| World | Objects | Widest person (m) | route_width (ms) |
|---|---|---|---|
| shared/example_world.json | 6 | 1.19 | 27.9 |
| shared/real_world_01.json (bathroom scan) | 2 | 1.20 | 2.1 |
| examples/zac-room (real scan) | 2 | 1.05 | 24.0 |
| examples/studio-apartment (real scan) | 2 | 1.20 | 37.7 |
| src/clearance_test_world.json (narrow gap) | 6 | 0.75 | 66.6 |

The narrow-gap room has a 77 cm gap, and the server reads 0.75 m, which matches the documented behaviour of reading a little narrow.

## What this does not measure

- The AI steps (SAM, Muse Spark, Muse Image, transcription) and scan simplification were **not** benchmarked here: they need an API key, money or large inputs. The project docs report about 45 s and about $0.25 for one scan, and 30 to 100 s for a layout on the free host. Those are the team's own earlier figures, not re-measured.
- Frame rate in play mode, and anything on a phone.
- Timings are on small worlds (2 to 6 boxes). Real rooms with many more objects would take longer.
