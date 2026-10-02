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
npm test        # 52/52 green, node --test, zero network
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

## Signed custody (the seal — lane 67-a)

The ledger is append-only and tamper-*evident by convention*; the seal makes it
tamper-*evident by cryptography*, without touching a byte of the ledger file.

```js
import { seal, verifyCustody } from 'quilt-chrono/src/seal.js';

const { checkpoint } = seal(sheet.ledger, { key: process.env.CHRONO_SEAL_KEY });
// checkpoint is a quilt.organ.checkpoint — the organ protocol v2 document, EXACTLY:
// { schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256",
//   seq, hash: <chainTip at seq>, manifestHash, sig, manifest }
//   where sig = HMAC-SHA256(key, canonical({hash, manifestHash, seq}))

verifyCustody(checkpoint, key, { chainFile, ledger }); // the courtroom, before boot
```

How it works, in three laws:

1. **The chain lives in a sidecar.** `ledger.chain.jsonl` holds one link per
   ledger entry — `{seq, op: <the chrono entry verbatim>, prev, hash}` where
   `hash = sha256(canonical({seq, op, prev}))`, anchored at `GENESIS`. That is
   the organ receipt formula, so a link **is** an organ receipt whose op is a
   chrono entry: the organ toolkit's own `verifyChain()`/`receiptHash()` verify
   the sidecar unmodified (proven in the test suite against the real organ
   code). The original `ledger.jsonl` bytes are never opened for writing;
   sidecar writes are append-only by construction (`CHAIN_REWRITE_REFUSED`
   otherwise), and a sidecar can only ever be extended.
2. **The seal is the organ's checkpoint, byte-for-byte.** `seal()` derives the
   prefix state (fold of writes ≤ seq), wraps it in a
   `quilt.organ.manifest/v1` (content-addressed `manifestHash`), and signs the
   organ triple `{hash, manifestHash, seq}` with HMAC-SHA256 under the
   caller-provided key. Spec: `quilt-jev-toolkit/docs/REVERSE-ACTUALIZED-SPEC.md`
   §8. No chrono-specific fields are added — drift is how parallel standards
   start. `restore(snap, { custody: { checkpoint, key, chainFile } })` runs the
   full courtroom **before** anything boots.
3. **Honest scope, inherited from the organ spec.** The signature vouches for
   the *prefix*: the boundary chain tip, the anchored manifest, the state at
   `seq`. Post-boundary entries are guarded by the hash chain (any byte flip,
   at any offset, is a named error: `RECEIPT_HASH_MISMATCH`, `CHAIN_GAP`,
   `CHAIN_ENTRY_MISMATCH`); a fully re-hashed tail is a different fork, not a
   detectable forgery — seal again to tighten the window. Wrong key ⇒
   `CHECKPOINT_SIGNATURE_INVALID`; missing key ⇒
   `CHECKPOINT_SIGNATURE_REQUIRED`.

Old seals survive honest growth: append entries, re-seal (identity carried
forward via `organId`, lineage via `supersedes`) — the earlier checkpoint still
verifies at its own boundary.

## Rewind (with the organ protocol, not instead of it)

`snapshot(engine, t)` → hash-pinned `quilt.chrono.snapshot/v1` (canonical-JSON sha256
over the cell states). `restore(snap, { spec })` → a NEW engine booted from it:
re-registered formulas/edges from the spec, seeded values marked *clean* (history,
not future — nothing re-evaluates until something moves again), optionally journaling
the boot as `cause: "restore"` writes. Snapshots are tamper-evident: a mutated
snapshot refuses to boot (`RESTORE_HASH_MISMATCH`).

Custody *law* (the courtroom codes, the boot rules, the nesting rules) remains
**owned** by `quilt-jev-toolkit`'s organ protocol (`src/organ/snapshot.mjs`,
`src/organ/rewind.mjs`, `src/organ/checkpoint.mjs`, `src/organ/boot.mjs`). What
this repo now carries is the glue (see “Signed custody” above): `src/seal.js`
mints organ-EXACT signed checkpoints over the chrono chain — the formats match
byte-for-byte (proven by tests against the organ's own verifiers), no custody
law is re-decided here. A chrono snapshot is exactly the replay *seed* the
organ checkpoint machinery signs; DESIGN.md §4/§4b map the two.

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
src/seal.js        signed custody: chain sidecar + organ-checkpoint-EXACT seals
examples/tide/     40 simulated steps of a 9-cell sheet
tests/             52 node --test tests, no network
scripts/keyscan.mjs  fleet-standard secret scanner (run before every push)
```
