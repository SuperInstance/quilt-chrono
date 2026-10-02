# 72-c death audit — what the dead lane left on the table

Auditor: 72-c-r2 (finisher lane), HEAD f2d0431, baseline 59/59 untouched.

## What 72-c started (forensic state at death)

72-c died **before any commit, push, or worklog entry** — its entire output was
uncommitted working-tree state over a clean f2d0431 (remote tip f2d0431, verify
below). Three dirty files:

1. **src/calculus.js** (new, 458 lines, ~complete) — the upstream port of
   far-shore's proven calculus (R2 @ 9e1517f, sealed law preregister-71d):
   `flowStream`/`flowsOf` (read-only (t,v) sampling, fail-closed
   CALCULUS_NO_SUCH_FLOW), `rateOf`/`accumOf`/`accumSeries`/`lagOf` (the §B
   arithmetic verbatim, deadband ε configurable per projection), ledger-facing
   `rate`/`accum`/`lag`, `thresholdAlarm`/`derivativeFlags` (the sealed P3
   detectors), `Fold` + `rateFoldStep`/`flowAccumFoldStep` (partials ==
   recompute-from-genesis), `conservation` (P4), `derivedProjection` +
   `derivedCellId` + `verifyDerivedProvenance` (the derived series as a
   PROJECTION: ledger-shaped entries carrying per-row sourceLinkHash and the
   whole-chain sourceTipHash). No registered arithmetic was re-derived — the
   headers cite the sealed law. **Adopted as-is.**
2. **tests/calculus.test.mjs** (new, 22 tests) — deadband P1a/b/c + ε-per-
   projection, accum 4.50 = 2.94+1.56, conservation on the real spend flow,
   the incidents re-proof (3/3 vs 0/3, receipted flag lists + magnitudes), Fold
   prefix law, derivedProjection provenance, SEAL INTEROP (HMAC + Ed25519 +
   tamper-the-underlying-row), overlay rendering/determinism/fail-closed.
   State at death: **16/22 green, 6 red.**
3. **src/projection.js** (modified) — `renderSVG` gains `overlay` mode (the
   derived series drawn ON the source cell's lane, flag diamonds on moved
   readings) and a `renderedAt` pin for byte-deterministic double runs.

## The 6 reds, each diagnosed (not retuned — receipted)

| # | test | root cause | verdict |
|---|------|-----------|---------|
| 1 | conservation (real spend flow), `parts.length 24 !== 4` | **test bug**: far-shore's sealed flow-accum law counts EVERY numeric reading as a part (zeros included — verbatim at far-shore src/calculus.js:110); the four spend-bearing turns are the NONZERO parts | fix test to the ported law (24 parts, 4 nonzero), intent preserved |
| 2 | lag argmax `null !== 1` | **real law gap in the port**: cells written in the same clock tick differ by the ledger's honest +1ms in-tick clamp; `lagOf`'s exact `x.t === s.t − k` equality can never align them. Chrono-native fix: cross-cell alignment on the LEDGER'S TICK GRID (`tick`, quantized match); ledger-facing `lag()` auto-derives it from `clock.stepMs`; pure `lagOf` default `tick=null` keeps the sealed exact law byte-compatible | fix source (chrono-native tick grid), documented in-code |
| 3 | RE-PROOF flags `[23.002] vs [23]` | **test bug**: distress is the third in-tick append (+2ms clamp, receipted by the fixture's own flowStream test); flags carry stream t. Compare at turn granularity (Math.round) | fix test, clamp receipted |
| 4 | Fold flags absolute epoch seconds | **test bug**: the Fold fixture's clock is a real calendar epoch (2026-10-02T06:02:06Z); flags are absolute t. Normalize to relative turns via `samples[0].t − 1` | fix test |
| 5 | overlay ε regex | **source bug**: the overlay note emitted a literal `ε` char instead of the XML entity the legend uses everywhere else (`&#949;`) | fix source (one class of byte) |
| 6 | accum overlay `pts 24 !== 4` | **test bug**: the running-total staircase spans every reading (zeros are honest "no spend this turn" points — far-shore's accumSeries flow law); the 4 spend turns are the steps. Also the diamond-x probe assumed a [0,24] window while the sheet's axis maps [first entry ts, last entry ts] | fix test to the law; diamond check now derives x from the ledger's own extent (the honest property: the overlay rides the sheet's axis) |

Net: **zero arithmetic retuned**. Four fixes are fixture-granularity honesty
(the ledger's +1ms/+2ms in-tick clamp and calendar epoch leaking into
turn-indexed expectations), one is an XML-entity byte, one is the single real
law addition (tick-grid alignment), which is additive and defaulted off.

## Addendum — a seventh red was hiding behind #4

Once #4 landed green, the Fold test exposed one more 72-c test bug: the Fold
fixture wrote only latency.ms + answer.source, but its tail folds
usage.cost — fail-closed CALCULUS_NO_SUCH_FLOW (the fail-closed law working
as designed; the earlier flags failure had been masking it). Fix: the
battery's spend rides the Fold fixture's per-turn appends, as it did in the
real battery. FINAL STATE: **81/81 green** (59/59 baseline untouched + 22/22
calculus).

## Adoption decision

The port is 95% faithful and complete; the finisher adopts it wholesale, makes
the six receipts above land green, keeps 59/59 baseline untouched, and commits
with the 72-c credit. Zero model calls used by 72-c (pure local computation)
and by this finisher.
