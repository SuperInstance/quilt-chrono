# tide-demo — projection table

window: `begin` → `2026-09-21T14:14:00.016Z` · flows: 134 · writes: 180 · reads: 335 · tide-held: 32

## Cell activity

| cell | writes | reads | first activity | last activity | value at t2 |
|------|-------:|------:|----------------|---------------|-------------|
| cal.gain | 1 | 40 | 2026-09-21T14:13:20.002Z | 2026-09-21T14:14:00.006Z | `2` |
| cal.offset | 1 | 40 | 2026-09-21T14:13:20.003Z | 2026-09-21T14:14:00.007Z | `1` |
| health | 3 | 42 | 2026-09-21T14:13:21.016Z | 2026-09-21T14:14:00.015Z | `"HOT"` |
| sensor.calibrated | 40 | 162 | 2026-09-21T14:13:21.004Z | 2026-09-21T14:14:00.016Z | `173.6` |
| sensor.raw | 41 | 81 | 2026-09-21T14:13:20.001Z | 2026-09-21T14:14:00.005Z | `86.28` |
| sink.alert | 9 | 0 | 2026-09-21T14:13:20.005Z | 2026-09-21T14:13:56.015Z | `138.6` |
| sink.display | 41 | 0 | 2026-09-21T14:13:20.004Z | 2026-09-21T14:14:00.012Z | `173.6` |
| sink.log | 42 | 0 | 2026-09-21T14:13:20.006Z | 2026-09-21T14:14:00.003Z | `"raw=86.28"` |
| voice | 2 | 2 | 2026-09-21T14:13:30.017Z | 2026-09-21T14:13:45.021Z | `"reading 73.3 — nominal; tide flows."` |

## Flow edges (pushes and evaluate flows)

| from | to | count | volume (&#124;v&#124;) | tide-held |
|------|----|------:|-------:|----------:|
| sensor.raw | sink.log | 41 | 0 | 0 |
| cal.gain | sensor.calibrated | 40 | 5300 | 0 |
| cal.offset | sensor.calibrated | 40 | 5300 | 0 |
| sensor.calibrated | sink.display | 40 | 5300 | 0 |
| sensor.raw | sensor.calibrated | 40 | 5300 | 0 |
| sensor.calibrated | sink.alert | 8 | 1005.2 | 32 |
| sensor.calibrated | health | 3 | 0 | 0 |
| health | voice | 2 | 0 | 0 |
| sensor.calibrated | voice | 2 | 0 | 0 |
