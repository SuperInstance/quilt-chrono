# quilt-chrono

**Time is a dimension.** The spreadsheet made computation multi-dimensional across
*space* — a grid of cells feeding each other. quilt-chrono adds the missing axis:
every cell read is a **reading**, every write a **writing**, every push and pull
flows through an append-only time ledger — so the sheet can be replayed, diffed,
projected, and rewound to any instant, like footage with a playhead.

> Readings and writings, pushes and pulls flow actively and elegantly and visually
> in whatever projection you need for the display and controls of the application.

## The spreadsheet with a playhead

A normal reactive sheet answers one question: *what is the value of cell X?*
quilt-chrono answers five:

| question | projection |
|---|---|
| what did the sheet look like at time `t`? | `stateAt(ledger, t)` |
| what changed between `t1` and `t2`? | `diff(ledger, t1, t2)` |
| what flowed, from where to where, how much? | `flowMap(ledger, t1, t2)` |
| show me | `renderSVG(ledger, t1, t2)` / `renderTable(ledger, t1, t2)` |
| take me back | `snapshot(t)` → `restore(snap)` |

The engine is tiny on purpose: **value / formula / ai cells, dirty-marking, pull
evaluation, push edges with transforms, and a tide** — min-interval throttling where
propagation attempts between crests are *held* (and journaled as such) and the latest
value rides the next crest.

## Quickstart

```bash
npm test        # 37/37 green, node --test, zero network
npm run example # the tide demo: 9 cells, 40 steps -> examples/tide/outputs/
```

Ten lines of sheet:

```js
import { Chrono } from 'quilt-chrono/src/flow.js';
import { stateAt, renderSVG } from 'quilt-chrono/src/projection.js';

const sheet = new Chrono({ name: 'demo' });
sheet.value('sensor.raw', 60);
sheet.value('cal.gain', 2);
sheet.formula('calibrated', ['sensor.raw', 'cal.gain'], (raw, gain) => raw * gain);
sheet.value('display', null);
sheet.push('calibrated', 'display');          // double-entry flow: read + write, one flow_id
sheet.write('sensor.raw', 61, { by: 'agent:world' });
console.log(sheet.pull('calibrated'));        // 122 — and a reading is now in the ledger
const svg = renderSVG(sheet.ledger, null, null); // the sheet, alive on a time axis
```

## The ledger (quilt.chrono.entry/v1)

Append-only jsonl. Entries are frozen at append; corrections are **compensating
entries** (`cause: "correction"`, `corrects: <seq>`) — the original entry stays
byte-intact forever. No deletions, no edits. That is organ law (wave-64/65): *a
rewind does not erase — it appends.*

```jsonc
{
  "seq": 238,                    // gapless, 0-based
  "ts_utc": "2026-09-21T14:13:38.000Z",  // strictly increasing
  "op": "write",                 // "read" | "write"
  "cell": "sensor.raw",
  "value": 115.08,
  "by": "agent:world",           // the cell or agent that caused this
  "cause": "step",               // init|set|step|pull|push|evaluate|push-throttled|tide-flush|correction|restore
  "pushed": false,
  "flow_id": "flow-237-12",      // links ONE flow's entries together
  "edge": "sensor.raw->sink.log",// present on push-flow entries (incl. throttled)
  "corrects": null               // set on compensating entries
}
```

**Double-entry spirit.** A push that writes `B` because `A` changed records BOTH the
source read and the sink write under one `flow_id` — the write's cause is provably
the read, in the ledger, forever. A formula evaluation is the same law generalized:
`n` dependency reads linked to the `1` result write. `ledger.balanced()` checks it:
every flowed write must have ≥ 1 paired read. Unpaired *reads* are legal and honest
(direct pulls, tide-held attempts); unpaired *writes* are a hole in the causal fabric
and fail the check.

## The tide

Push edges may declare `minIntervalMs`. Propagation attempted inside the interval is
**held** — journaled as a `push-throttled` read on the source, with no sink write —
and the *latest* value rides the next crest (or `engine.flushTide()` forces it out of
band as `tide-flush`). Time-throttled propagation, not lossy dropping: the sheet
shows the holds, not just the landings.

## Rewind (with the organ protocol, not instead of it)

`snapshot(engine, t)` → hash-pinned `quilt.chrono.snapshot/v1` (canonical-JSON sha256
over the cell states). `restore(snap, { spec })` → a NEW engine booted from it:
re-registered formulas/edges from the spec, seeded values marked *clean* (history,
not future — nothing re-evaluates until something moves again), optionally journaling
the boot as `cause: "restore"` writes. Snapshots are tamper-evident: a mutated
snapshot refuses to boot (`RESTORE_HASH_MISMATCH`).

Custody, hash-chain verification, and signed checkpoints are deliberately **NOT
reimplemented** here — `quilt-jev-toolkit`'s organ protocol owns that
(`src/organ/snapshot.mjs`, `src/organ/rewind.mjs`, `src/organ/checkpoint.mjs`). A
chrono snapshot is exactly the replay *seed* the organ checkpoint machinery signs;
DESIGN.md §4 maps the two.

## Examples/tide outputs (deterministic: fixed clock, seeded noise)

| file | what it is |
|---|---|
| `ledger.jsonl` | 547 entries — the whole 40-step life of the sheet |
| `state-at-20.json` | the sheet at the instant of the step-20 correction |
| `diff-t10-t30.json` | what changed across steps 10→30 |
| `flowmap.json` / `flowmap.svg` | the flow graph + the rendered time-lane SVG |
| `table.md` | the same window as a markdown projection |
| `snapshot-at-20.json` | hash-pinned stable point (post-correction) |
| `run-receipt.json` | counts, tip hash, balance verdict, story beats |

Story beats: step 18 a sensor spike (fault) → step 20 the operator **corrects
history** with a compensating entry (never deletes; the ripple flows through the
same push edges as any write). `sink.alert` runs behind a 5 s tide — see its crest
marks vs `sink.display`'s in the SVG.

## Live smoke (optional, budgeted)

`CHRONO_LIVE_SMOKE=1 node examples/tide/run.mjs` routes the `voice` ai cell through
the typesafe systemone backend — **≤ 2 calls, self-imposed**, receipted to
`receipts/live-smoke.json` (honest FAIL receipt on network error; the local demo
still finishes). Default is a local backend: tests and CI never touch the network.

## Layout

```
src/flow.js        the reactive core: cells, dirty-marking, pull, push, tide
src/ledger.js      the time ledger: append-only, frozen, double-entry, jsonl
src/projection.js  stateAt / diff / flowMap / renderSVG / renderTable (pure views)
src/rewind.js      snapshot / restore (hash-pinned, organ-compatible seeds)
examples/tide/     40 simulated steps of a 9-cell sheet
tests/             37 node --test tests, no network
scripts/keyscan.mjs  fleet-standard secret scanner (run before every push)
```
