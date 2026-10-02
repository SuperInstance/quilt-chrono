# quilt-chrono — DESIGN

Time as a first-class dimension of the quilt. This doc is the design pass: the
problem, three alternatives with the honest reasons one won, the algebra of
projections, and the mapping to the organ protocol (cited, not reimplemented).

## 1. The problem

A reactive sheet is a *spatial* machine: cells feed cells, and at any instant the
sheet has exactly one state — the current one. Everything before "now" is lost.
That is wrong for the quilt the principal is building, in two ways:

1. **Play-tested runs must leave real logs that can be rewound.** A run is adjusted
   along the way; the WHY of each adjustment becomes new cells. You cannot compile
   the why into cells if the log that justified it is a smeared diff of snapshots.
2. **Display and controls need projections, not just "current value".** The same
   run should be viewable as a table, a lane diagram with arcs, a flow graph with
   volumes, a diff, a state at an arbitrary instant — *whatever projection the
   display needs*, all derived from one substrate, never maintained separately.

So the substrate must record **every reading and every writing** — not just writes
(a plain audit log) and not just state (a plain spreadsheet), but the causal fabric
between them.

## 2. Ideation — three architectures, one verdict

### Alternative A — snapshot-per-step

Every tick, freeze the entire sheet state: an array of `state[s]`, `s = 0..N`.
Time-travel = index into the array. Diff = compare two snapshots.

- **For:** dead-simple replay (it's just an array lookup); trivially immutable.
- **Against:**
  - **No causes.** A snapshot says `sensor.raw = 115.08`; it cannot say *who wrote
    it*, *because of what read*, or *which push carried it*. The moment you add
    cause fields to snapshots you have reinvented the event log, twice as big.
  - **Readings vanish.** A read leaves no trace in state. Half the mission
    statement — "readings and writings flow" — is unrepresentable.
  - **Space is O(cells × steps)** even when nothing changed; sparse deltas decay
    into exactly the event log we were avoiding, plus a base.
  - **Time resolution is the step.** The tide, throttled attempts, and
    correction-vs-ripple ordering all happen *inside* a step.

### Alternative B — event-ledger replay (CHOSEN)

One append-only jsonl of entries `{seq, ts_utc, op: read|write, cell, value, by,
cause, pushed, flow_id, …}`. State at `t` is a **replay** of writes ≤ t; flows and
projections are folds over the same entries.

- **For:**
  - Both halves of the mission are first-class: `op` is literally
    `read | write`.
  - **Causality is representable**: `flow_id` links the source read to the sink
    write — double-entry. The write's cause is provably the read, in the ledger,
    forever. Alternative A cannot express this at any size.
  - **Append-only is the fleet's law already** (wave-64/65 organ law: never
    delete; corrections are compensating entries). The ledger is the same law at
    sheet granularity, and it composes with organ custody instead of
    reimplementing it (see §4).
  - **One substrate, N projections** — table, SVG, flow map, diff, state are all
    pure folds. No projection can drift from the truth because there is only one
    truth.
  - Replay of ≤ t is O(entries ≤ t) and each entry is tiny; for interactive
    sheets this is sub-millisecond, and §4's checkpoints make it O(tail) for
    very long histories.
- **Against (honest):** replay is not O(1) like array indexing; projections must
  be careful with window semantics (solved once, in §3); a naked event log needs
  the double-entry discipline to avoid becoming an unstructured firehose — which
  is why `flow_id` and `balanced()` are part of the core, not an afterthought.

### Alternative C — CRDT (multi-writer merge)

Treat cells as CRDT registers; time emerges from vector-clock merges. Built for
offline/diverged replicas merging without a coordinator.

- **For:** the quilt is multi-agent; concurrent writes to one cell are real.
- **Against (for *this* repo):**
  - CRDTs answer *convergence*, not *narration*. A merge history is a poor
    projection substrate: causality is per-replica clocks, wall-time ordering is
    lost, and "show the arc from A to B at second 14" is unnatural.
  - The quilt's concurrency model is closer to orchestrated flows (pushes under
    sheet law) than to peer replicas. When true offline-replica merge is needed,
    it belongs at the *organ storage* layer, not inside the display substrate.
  - The ledger does not preclude it: a CRDT layer can sit above and journal its
    merges as compensating entries.

**Verdict: B.** A is the degenerate case of B (snapshots are derivable — and
indeed `snapshot(t)` *is* a projection of the ledger here). C solves a problem the
quilt doesn't have yet while failing the one it does: making time narratable.

### The arena decision (why the core is born-journaled, not vendored)

`quilt-arena/engine` (`/home/z/my-project/download/quilt-arena/engine/engine.js`)
is the fleet's existing pull-reactive core (value/formula/ai/router cells,
dirty-marking, declared deps). chrono keeps its philosophy *compatible* (pull
evaluation, declared deps, dependents graph) but writes the core fresh, because
chrono needs the core **born journaled**: every read and write must hit the ledger
at the exact moment it happens, with flow receipts and tide throttling the arena
core has no hooks for. Wrapping the arena would mean instrumenting 100% of its
mutation surface from outside — a worse copy of born-journaled. The swap path
stays open: the ledger algebra (§3) does not care which core feeds it.

## 3. Projection algebra

All projections are pure folds over entries. Windows are `(t1, t2]` for
change-flavored views (a change needs a before and an after); `stateAt` replays
`≤ t`. Bounds resolve to `{ts, seq}` pairs — by seq number, exact ISO instant, an
instant *between* entries (clamps down), or null (open end). Schemas: ledger
entries are `quilt.chrono.entry/v1`; snapshots are `quilt.chrono.snapshot/v1`.

Let `W(t)` = writes ≤ t, `S(t)` = last-write-wins fold of `W(t)` (the state).

- **`stateAt(t) = S(t)`** — the sheet at the playhead.
- **`diff(t1, t2)`** — per-cell `S(t1) → S(t2)` change list, with write counts in
  the window. Composition law: `diff(t, t) = ∅`; chaining diffs across contiguous
  windows reconstructs the whole (per cell, last state wins — this is why diff
  carries `from`/`to` values, not just "changed").
- **`flowMap(t1, t2)`** — the *causal* projection: edges `{from, to, count,
  volume, throttled}` built by joining each flowed write to its flow's reads via
  `flow_id`. An evaluate flow with n deps fans out to n edges (documented
  fan-out, not noise: each dep really did cause part of the write). Direct sets
  and inits have `flow_id = null` and appear only in counts — honestly causeless
  from the ledger's point of view.
- **`renderSVG / renderTable`** — the same folds, laid out. SVG: cells are lanes
  on a time axis, writes are dots, reads are ticks, tide-holds are hollow
  triangles, pushes/evaluations are arcs from read lane to write lane. All
  dynamic text escaped; zero dependencies; self-contained file.
- **`snapshot(t)`** — `S(t)` plus provenance (`at`, `state_hash`,
  `ledger_entries_below`), hash-pinned by canonical-JSON sha256.

The algebra property that matters: **every view is a function of the entries, so
two projections can never disagree.** If the SVG shows an arc, there is a
`flow_id` in the jsonl that proves it; if the table shows a value, `stateAt`
replays to it byte-for-byte. That is the "elegantly and visually in whatever
projection you need" clause, operationalized as one substrate + pure folds.

## 4. Mapping to the organ protocol (cite, don't reimplement)

`quilt-jev-toolkit` (`src/organ/`) already owns durable-state custody for the
fleet: `manifest.mjs` (boot manifests), `boot.mjs` (the courtroom), `snapshot.mjs`
+ `rewind.mjs` (state capture and time-travel with replay), `checkpoint.mjs`
(signed checkpoints, partial custody, O(tail) boot), `nest.mjs` (organs in
organs). Its laws — append-only receipts, compensating double-entry credits,
rewind-without-erasure, hash-pinned state — are the same laws this ledger obeys,
on purpose.

Division of custody, one line each:

| concern | owner |
|---|---|
| sheet-time narration: reads/writes/flows/throttle/corrections | **quilt-chrono ledger** (this repo) |
| state replay ≤ t, diff, flowMap, SVG/table | **quilt-chrono projections** |
| hash-chain verification of the receipt history | organ (`boot.mjs` courtroom) |
| signed checkpoints, partial custody, O(tail) boot | organ (`checkpoint.mjs`) |
| nesting one sheet's custody inside another | organ (`nest.mjs`) |

Concretely: `snapshot(engine, t)` produces exactly the **replay seed** the organ
checkpoint machinery signs — `{cells, state_hash, at:{ts,seq}}` is the seed's
content-addressed claim, and `restore(snap)` is boot-from-checkpoint with the
formulas re-registered from a spec. That future lane arrived: §4b is the
signed-custody glue, and `ledger.tipHash()` (sha256 over the canonical jsonl)
remains the O(n) whole-file fingerprint — the seal adds the *incremental,
organ-verifiable* anchor (`chainTip`) beside it.

### 4b. Signed custody — the seal (lane 67-a)

The wave-66 hand-off asked for: "hash-chain the chrono jsonl and hand tipHash
to quilt-jev-toolkit's checkpoint.mjs — the seed shape already matches." The
claim was verified against the actual code before believing it: organ seed is
`{seq, cells:{id:{kind,value}}}`, chrono snapshot carries `cells:{id:{value,kind}}`
+ `at.seq` — *shape*-true, but not drop-in (the seed is exactly two fields, and
a full organ `boot()` additionally replays `applyOp`-shaped receipts, which
chrono entries are not). So the glue was built at the layer that CAN match
exactly — the checkpoint document itself — and made byte-exact rather than
similar.

**What was built** (`src/seal.js`, stdlib-only, zero deps):

1. **The chain sidecar** `<ledger>.chain.jsonl` — one link per entry,
   `{seq, op: <chrono entry verbatim>, prev, hash}`, `hash =
   sha256(canonicalJson({seq, op, prev}))` anchored at `GENESIS`. The brief's
   formula (`h = sha256(prev_h || canonical(entry))`) is subsumed by the organ
   receipt formula (`makeReceipt` in organ `manifest.mjs`): prev AND entry AND
   position are all covered, and the link IS an organ receipt — the organ
   toolkit's own `verifyChain`/`receiptHash` verify the sidecar unmodified.
   The sidecar writer is append-only by construction (byte-prefix check →
   `CHAIN_REWRITE_REFUSED`; never extend a broken chain; create-only on
   first write). The original ledger bytes are never opened for writing.
2. **The seal** — `seal(ledger, {key, seq?, chainFile?, organId?, supersedes?})`
   derives the prefix state (fold of writes ≤ seq; reads are observations, not
   transitions), wraps it in a `quilt.organ.manifest/v1` (per-cell
   `sha256Json({kind:'value', value})` stateHashes, `state.cellsSha256`,
   `receiptRange [0..seq]`, `genesis {seq:0, prevHash:'GENESIS'}`), and signs
   the organ triple `canonical({hash, manifestHash, seq})` with HMAC-SHA256
   under the caller's key — the exact `checkpointSigningPayload` bytes of
   organ `boot.mjs`. The emitted document has NO chrono-specific fields.
3. **The courtroom** — `verifySeal` (structure + signature, organ codes
   `CHECKPOINT_SIGNATURE_REQUIRED/MALFORMED/INVALID`) and `verifyCustody`
   (chain re-hash → boundary anchor → manifest re-hash to the SIGNED
   manifestHash → state replay from the chain → optional ledger witness).
   `restore(snap, {custody})` runs it BEFORE materializing anything.

**Alternatives considered (the ideation pass for this slice):**

- **In-band chaining** (append `h`/`prev` columns to the ledger entries
  themselves): rejected — it rewrites the entry schema (`quilt.chrono.entry/v1`
  is sealed and consumed by projections), breaks byte-compatibility with every
  existing ledger, and makes the ledger unusable without the hasher. The
  sidecar keeps the original bytes sovereign; the chain can be re-derived,
  verified, or thrown away without touching history.
- **A chrono-native signature format** ("quilt.chrono.seal/v1", our own
  fields): rejected — this is exactly how parallel standards start. The organ
  protocol already owns signed custody with named fail-closed codes and a
  spec; matching it byte-for-byte means every organ verifier (and every future
  organ tool) accepts chrono seals for free. Proven: the interop tests call
  the organ's real `verifySignedCheckpoint`, `verifyChain`, `validateManifest`,
  `computeManifestHash` on chrono output.
- **Import organ code at runtime** (`import from '../quilt-jev-toolkit/...'`):
  rejected — cross-repo file imports break standalone use and pin a sibling
  checkout. Instead: the ~60 lines of law (canonicalJson, sha256, HMAC, the
  triple) are re-derived with citations, and the interop tests import the
  sibling IF PRESENT (skip-if-absent) to prove byte-equality — equivalence is
  tested, not assumed.

**Honest scope (inherited, spec §8.3):** the signature vouches for the PREFIX —
boundary chainTip, anchored manifest, state at seq. Post-boundary entries are
chain-guarded (any byte flip at any offset is named); a fully re-hashed tail is
a different fork, not a detectable forgery — the organ spec says the same about
its own checkpoints. Re-sealing tightens the window; Ed25519 "who vouches" is
the organ v3 path and this format refuses unknown algs today.

**One inherited defect found and fixed:** `loadLedger()` documented "further
appends continue the file" but never wired the file handle — a loaded ledger
silently dropped persistence. Fixed additively (`ledger.file = file`); appends
now extend the file append-only as documented, which is also what makes
load → seal → append → re-seal honest on disk.

**Parked for a later lane:** a full organ `boot()` of a chrono ledger needs an
organ-side chrono-op adapter (the three-function adaptation point
`quiltApply/applyOp/stateOf` is already documented in organ `toyQuilt.mjs`);
edges in the seal manifest (a bare-ledger seal proves values; flow edges are a
projection concern); an O(tail) `stateAt` booting from the sealed seed.

## 5. Honest residuals

- **Replay is O(entries ≤ t).** Fine for interactive sheets; for 10M-entry
  histories the organ checkpoint seed is the answer (§4), not reinvented here.
- **AI cells must be pulled explicitly** when a dependency is dirty
  (`CELL_DEP_UNEVALUATED`): async evaluation is visible, never silently hidden in
  a sync pull. This is a deliberate friction — model calls are real spends.
- **Throttle holds are per-edge, latest-wins.** Intermediate values between
  crests are journaled as `push-throttled` reads (nothing is lost from the
  ledger) but do not write the sink. A coalescing accumulator transform is the
  user's escape hatch.
- **Corrections correct writes, not reads** (`LEDGER_CORRECT_READ`): a
  mis-observation is fixed by writing the right value at the source and letting
  the ripple flow — correcting a read would fork reality.
- **No wall-clock dependency in outputs**: the Clock is injectable and the demo
  runs a deterministic simulated clock, so replayed runs are byte-reproducible
  (modulo the SVG footer's render timestamp).
