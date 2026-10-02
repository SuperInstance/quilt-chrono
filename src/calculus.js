// quilt-chrono — src/calculus.js (lane 72-c)
//
// DERIVED CELLS — the calculus moves upstream. Far shore (quilt-far-shore R2,
// 9e1517f) proved on fixtures that the derivative out-detects the threshold
// alarm on the wave-67 incidents and that d/dt∫flow == flow exactly; the
// principal's directive: these are NEW CONCEPTUAL OBJECTS the time-dimension
// quilt should compute NATIVELY. This file is that directive, operationalized:
// rate / accum / lag as pure folds over the ledger's flows, every derived
// series a PROJECTION (renderable, sealable), partials obeying the chrono law
// (incremental append == recompute-from-genesis).
//
// What "flow" means here: a flowId is a CELL ID whose numeric writes form the
// flow — its value over time, read-only off the ledger (pushed writes, evaluate
// writes, sets, corrections: every write to the cell is a sample; reads are
// observations, not transitions — organ law). Time is the ledger's own
// dimension: `unit:"seq"` reads t off the entry seq (the gapless tick count),
// `unit:"ts"` reads t off ts_utc (Date.parse / scale, so window w is w real
// time units).
//
// Semantics are the registered far-shore law (spec/primitives-v2.md §B,
// sealed in fleet-seeds preregister-71d.json before the R2 run), ported
// verbatim — the arithmetic is NOT re-derived here, it is inherited:
//   rate(t_i)  = (V_i − V_{i−w}) / w   — V at w TIME units back,
//                                        last-known-value carried over gaps;
//                                        |ΔV| < deadband → 0 exactly (ε law)
//   accum      = level: trapezoid over real in-window readings (carried
//                observations are rate's law, not the integral's)
//                | flow: directional sum in (t1, t2]
//   lag        = Pearson argmax over k = 0..maxLag
// Zero model calls, zero network — pure local computation over the ledger.

import { ledgerError } from './ledger.js';
import { buildChain, chainTip } from './seal.js';

/** The registered deadband ε (far-shore's isDegenerate spread law). Every
 *  operator takes `deadband` — ε is configurable PER PROJECTION. */
export const DEADBAND_EPSILON = 0.04;

export const DERIVED_SCHEMA = 'quilt.chrono.derived/v1';

// ---------------------------------------------------------------------------
// Streams — (t, v) sampled read-only off the ledger
// ---------------------------------------------------------------------------

/**
 * The flow of cell `flowId`: its numeric writes as [{t, v, ts, seq}].
 *   unit "seq" (default) — t = entry.seq (the ledger's gapless tick count)
 *   unit "ts"            — t = Date.parse(entry.ts_utc) / scale (real time;
 *                          scale 1000 → seconds)
 * Window is (t1, t2] — the same half-open law projections use for flows.
 * Fail-closed: a flowId with NO entries in the ledger throws
 * CALCULUS_NO_SUCH_FLOW (a typo must not read as an empty flow); a cell that
 * exists but wrote no numbers returns [] (an honest dry flow).
 */
export function flowStream(ledger, flowId, { t1 = null, t2 = null, unit = 'seq', scale = 1 } = {}) {
  if (!ledger || !Array.isArray(ledger.entries)) {
    throw ledgerError('CALCULUS_BAD_INPUT', 'flowStream needs a Ledger (or {entries})');
  }
  if (unit !== 'seq' && unit !== 'ts') {
    throw ledgerError('CALCULUS_BAD_UNIT', `flowStream: unit ${JSON.stringify(unit)} not registered (seq | ts)`);
  }
  if (!(Number.isFinite(scale) && scale > 0)) {
    throw ledgerError('CALCULUS_BAD_SCALE', `flowStream: scale must be a positive number, got ${JSON.stringify(scale)}`);
  }
  let mentioned = false;
  const out = [];
  for (const e of ledger.entries) {
    if (e.cell !== flowId) continue;
    mentioned = true;
    if (e.op !== 'write' || typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
    const t = unit === 'ts' ? Date.parse(e.ts_utc) / scale : e.seq;
    if (t1 !== null && t1 !== undefined && !(t > t1)) continue;
    if (t2 !== null && t2 !== undefined && !(t <= t2)) continue;
    out.push({ t, v: e.value, ts: e.ts_utc, seq: e.seq });
  }
  if (!mentioned) {
    throw ledgerError('CALCULUS_NO_SUCH_FLOW', `flowStream: no cell ${JSON.stringify(flowId)} in the ledger — a typo'd flow id must not read as an empty flow`);
  }
  return out;
}

/** Flow-capable cells: [{flowId, n}] — cells with ≥1 finite numeric write. */
export function flowsOf(ledger) {
  const counts = new Map();
  for (const e of ledger.entries) {
    if (e.op === 'write' && typeof e.value === 'number' && Number.isFinite(e.value)) {
      counts.set(e.cell, (counts.get(e.cell) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([flowId, n]) => ({ flowId, n }))
    .sort((a, b) => (a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Operators — the registered §B law verbatim. Pure over samples; the
// ledger-facing wrappers (rate/accum/lag) are flowStream + one of these.
// ---------------------------------------------------------------------------

function applyNulls(samples, nulls) {
  const out = [];
  let last = null;
  for (const s of samples) {
    let v = s.v;
    if (v === null || v === undefined) {
      if (nulls === 'skip') continue;
      v = last; // carry: hold last-known-value
      if (v === null || v === undefined) continue; // nothing known yet → no reading
      out.push({ ...s, v, carried: true });
      continue;
    }
    last = v;
    out.push({ ...s, v });
  }
  return out;
}

/**
 * rate — the derivative cell. rate(t_i) = (V_i − V_{i−w}) / w with V read at
 * w TIME units back, last-known-value carried over gaps (spec B3.1's own
 * worked example is the authoritative reading: rate(T17) = (V(17) − V(15))/2
 * = 0 with V(15) carried from T10; rate(T23) = (0.10 − 0.42)/2 = −0.16).
 * A reading exists iff a known value exists at or before t−w (warmup → null,
 * the honest no-history case). |ΔV| < deadband → 0 exactly (the ε law).
 */
export function rateOf(samples, { window = 2, deadband = DEADBAND_EPSILON, nulls = 'carry' } = {}) {
  if (!(Number.isFinite(window) && window > 0)) {
    throw ledgerError('CALCULUS_BAD_WINDOW', `rate: window must be a positive number, got ${JSON.stringify(window)}`);
  }
  const s = applyNulls(samples, nulls);
  const out = [];
  let back = null; // last known value at or before t−w, advanced as t moves
  let bi = 0;
  for (let i = 0; i < s.length; i++) {
    while (bi < s.length && s[bi].t <= s[i].t - window) { back = s[bi]; bi++; }
    if (!back) { out.push({ ...s[i], value: null, delta: null, back_t: null }); continue; }
    const dV = s[i].v - back.v;
    out.push({ ...s[i], value: Math.abs(dV) < deadband ? 0 : dV / window, delta: dV, back_t: back.t });
  }
  return out;
}

/**
 * accum — the integral cell. mode "level": last-known-value trapezoid over
 * consecutive in-window REAL readings (nulls are absent samples — the
 * trapezoid spans across them; carry lives in rate). mode "flow": directional
 * sum of declared amounts in (t1, t2] (pushes +, pulls −). Window required:
 * an integral without bounds is not a number, it is a guess.
 */
export function accumOf(samples, { window: { t1, t2 } = {}, mode = 'level' } = {}) {
  if (t1 === undefined || t2 === undefined) {
    throw ledgerError('CALCULUS_BAD_WINDOW', 'accum needs window {t1, t2} — an integral without bounds is a guess');
  }
  if (mode === 'flow') {
    let sum = 0;
    const parts = [];
    for (const s of samples) {
      if (s.t > t1 && s.t <= t2 && typeof s.v === 'number') { sum += s.v; parts.push({ t: s.t, amount: s.v }); }
    }
    return { value: sum, parts, unit: 'flow' };
  }
  const s = samples.filter((x) => typeof x.v === 'number' && !x.carried && x.t > t1 && x.t <= t2); // real readings only — carried observations are rate's law, not the integral's (spec B3.2 arithmetic)
  let value = 0;
  const breakdown = [];
  for (let i = 1; i < s.length; i++) {
    const seg = ((s[i - 1].v + s[i].v) / 2) * (s[i].t - s[i - 1].t);
    value += seg;
    breakdown.push({ from: s[i - 1].t, to: s[i].t, seg });
  }
  return { value, breakdown, unit: 'level' };
}

/**
 * accumSeries — accum as a RUNNING series (the projection/overlay form): the
 * cumulative integral evaluated at each sample. level: trapezoid segments
 * between consecutive real readings; flow: running directional sum.
 */
export function accumSeries(samples, { mode = 'level' } = {}) {
  if (mode === 'flow') {
    let total = 0;
    const out = [];
    for (const s of samples) {
      if (typeof s.v !== 'number') continue;
      total += s.v;
      out.push({ ...s, value: total, seg: s.v });
    }
    return out;
  }
  const real = samples.filter((x) => typeof x.v === 'number' && !x.carried);
  const out = [];
  let value = 0;
  let prev = null;
  for (const s of real) {
    let seg = 0;
    if (prev) { seg = ((prev.v + s.v) / 2) * (s.t - prev.t); value += seg; }
    out.push({ ...s, value, seg });
    prev = s;
  }
  return out;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/**
 * lag — which lag k best aligns flow W to flow V (Pearson argmax over the
 * common support at each k). The registered B3.3 law verbatim.
 */
export function lagOf(vSamples, wSamples, { maxLag = 2, minSupport = 0, nulls = 'skip', tick = null } = {}) {
  const v = applyNulls(vSamples, nulls);
  const w = applyNulls(wSamples, nulls);
  // Cross-cell alignment happens on the LEDGER'S TICK GRID (`tick`): two cells
  // written in the same clock tick differ by the ledger's honest sub-second
  // clamp (+1ms per in-tick append), so raw-ts equality would call the same
  // instant different and no lag could ever align interleaved cells. tick=null
  // keeps exact matching — the registered §B law over exact streams,
  // byte-compatible with the sealed far-shore run; the ledger-facing lag()
  // derives tick from clock.stepMs automatically (chrono-native: the tick is
  // the ledger's resolution, the clamp is ordering within the tick).
  const q = tick ? (t) => Math.round(t / tick) : (t) => t;
  const corrs = [];
  for (let k = 0; k <= maxLag; k++) {
    const xs = [], ys = [];
    for (const s of w) {
      const prev = v.find((x) => q(x.t) === q(s.t - k));
      if (prev && prev.v !== null) { xs.push(prev.v); ys.push(s.v); }
    }
    const c = pearson(xs, ys);
    corrs.push({ k, corr: c, support: xs.length, reported: xs.length >= Math.max(minSupport, 2) && c !== null });
  }
  let argmax = null, best = -Infinity;
  for (const c of corrs) {
    if (c.reported && c.corr !== null && c.corr > best) { best = c.corr; argmax = c.k; }
  }
  return { corrs, argmax_lag: argmax };
}

// ---------------------------------------------------------------------------
// Ledger-facing operators — rate(flowId), accum(flowId, window), lag(flowId, k)
// over the ledger's flows. Read-only: nothing here mutates the ledger.
// ---------------------------------------------------------------------------

export function rate(ledger, flowId, opts = {}) {
  return rateOf(flowStream(ledger, flowId, opts), opts);
}

export function accum(ledger, flowId, opts = {}) {
  return accumOf(flowStream(ledger, flowId, opts), opts);
}

export function lag(ledger, flowV, flowW, opts = {}) {
  const o = { ...opts };
  if (o.tick == null && o.unit === 'ts' && ledger?.clock?.stepMs > 0) {
    o.tick = ledger.clock.stepMs / (opts.scale ?? 1); // the ledger's own resolution, in t units
  }
  return lagOf(flowStream(ledger, flowV, opts), flowStream(ledger, flowW, opts), o);
}

// ---------------------------------------------------------------------------
// Detectors — fixed pre-run in the sealed far-shore claims (P3); the incident
// re-proof upstream inherits them verbatim.
// ---------------------------------------------------------------------------

/** Plain level alarm: V(t) > k × mean(nonzero values of the stream). */
export function thresholdAlarm(stream, { k = 2 } = {}) {
  const nz = stream.filter((s) => typeof s.v === 'number' && s.v !== 0).map((s) => s.v);
  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const thr = k * mean;
  const flags = stream.filter((s) => typeof s.v === 'number' && s.v > thr).map((s) => s.t);
  return { threshold: thr, mean_nonzero: mean, flags };
}

/** The derivative's flags: every reading that moved (|rate| > 0 exactly). */
export function derivativeFlags(rateOut) {
  return rateOut.filter((r) => r.value !== null && Math.abs(r.value) > 0).map((r) => r.t);
}

// ---------------------------------------------------------------------------
// Incremental law — partials keyed (cell, op, window, seq). The partial is an
// observation (cache), never a transition: recompute-from-genesis equality is
// the custody test (the chrono law — a rewind does not erase, it replays).
// ---------------------------------------------------------------------------

export function deepCopy(x) { return JSON.parse(JSON.stringify(x === undefined ? null : x)); }
export function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export class Fold {
  constructor(cell, op, params, stepFn) {
    this.key = `${cell}|${op}|${JSON.stringify(params.window ?? {})}`;
    this.params = params; this.stepFn = stepFn;
    this.lastSeq = null; this.partial = null; this.observations = [];
  }
  append(sample) {
    this.lastSeq = sample.seq ?? sample.t;
    this.partial = this.stepFn(this.partial, sample, this.params);
    this.observations.push({ seq: this.lastSeq, partial: deepCopy(this.partial) });
    return this.partial;
  }
  static recompute(cell, op, params, stepFn, samples) {
    const f = new Fold(cell, op, params, stepFn);
    for (const s of samples) f.append(s);
    return f;
  }
}

/** rate fold-step: backward difference over w TIME units back with the
 *  last-known-value carry — the registered B3.1 arithmetic (NOT the sample-
 *  index shortcut far-shore receipted and superseded pre-score). The partial
 *  carries `back` (newest sample at or before t−w) and `buf` (the pending
 *  samples not yet eligible as a back) — exactly the stream law's monotone
 *  bi pointer, in fold form. */
export function rateFoldStep(partial, sample, { window = 2, deadband = DEADBAND_EPSILON } = {}) {
  const buf = partial?.buf ?? [];
  let back = partial?.back ?? null;
  let bi = 0;
  while (bi < buf.length && buf[bi].t <= sample.t - window) { back = buf[bi]; bi += 1; }
  const rest = buf.slice(bi);
  let value = null, delta = null;
  if (back) {
    delta = sample.v - back.v;
    value = Math.abs(delta) < deadband ? 0 : delta / window;
  }
  return { back, buf: [...rest, { t: sample.t, v: sample.v }], t: sample.t, value, delta, back_t: back ? back.t : null };
}

/** flow-accum fold-step: directional running sum. */
export function flowAccumFoldStep(partial, sample) {
  return { total: (partial?.total ?? 0) + (typeof sample.v === 'number' ? sample.v : 0) };
}

// ---------------------------------------------------------------------------
// Conservation (mission-directed, preregistered as far-shore P4a): d/dt of the
// integral == the original flow, exactly (≤1e-9), for flow-mode accum.
// ---------------------------------------------------------------------------

export function conservation(flowSamples, { deadband = 0 } = {}) {
  const flow = flowSamples.filter((s) => typeof s.v === 'number');
  let running = 0;
  const integral = flow.map((s) => { running += s.v; return { t: s.t, v: running }; });
  const d = rateOf(integral, { window: 1, deadband, nulls: 'skip' });
  let maxErr = 0, worst = null;
  for (let i = 1; i < d.length; i++) {
    const err = Math.abs((d[i].value ?? NaN) - flow[i].v);
    if (!(err <= 1e-9)) { if (err > (worst?.err ?? -1)) worst = { t: flow[i].t, err }; }
    if (err > maxErr) maxErr = err;
  }
  return { holds: maxErr <= 1e-9, maxErr, worst, n: flow.length };
}

// ---------------------------------------------------------------------------
// Derived projections — each derived series is a PROJECTION: a pure view of
// the ledger that materializes as its own append-only entry list (a chrono
// ledger in its own right: loadLedger() reads it back), carrying PER-ENTRY
// provenance into the source chain (row lineage + the source chain tip), so a
// seal over a derived series inherits the source ledger's integrity.
// ---------------------------------------------------------------------------

/** The derived cell's id: rate(latency.ms,w=2), accum(spend,flow), … */
export function derivedCellId(flowId, op, params = {}) {
  if (op === 'rate') return `rate(${flowId},w=${params.window ?? 2})`;
  if (op === 'accum') return `accum(${flowId},${params.mode ?? 'level'})`;
  if (op === 'lag') return `lag(${flowId},k=${params.k ?? '?'})`;
  throw ledgerError('CALCULUS_BAD_OP', `derivedCellId: op ${JSON.stringify(op)} not registered (rate | accum | lag)`);
}

/**
 * Materialize a derived series as a projection: pure over the ledger, no
 * mutation, entries shaped like quilt.chrono.entry/v1 writes PLUS a `derived`
 * provenance block (schema quilt.chrono.derived/v1):
 *   of            the source flowId
 *   op/window/mode/deadband/unit/scale  the exact derivation parameters
 *   t             the sample's time in the derivation's units
 *   sourceSeq     the seq of the source write this sample was read from
 *   sourceLinkHash  the hash of the SOURCE chain link at sourceSeq (row lineage)
 *   sourceTipHash the tip of the WHOLE source chain at projection time — the
 *                 projection anchors the entire ledger, so tampering ANY row
 *                 (measured or not) breaks the provenance.
 * Because the source chain hash covers every entry byte, a derived seal is
 * custody-grade: verifyCustody over the derived chain + verifyDerivedProvenance
 * against the source = the derivative of a signed ledger is signed.
 */
export function derivedProjection(ledger, spec = {}) {
  const { flowId, op = 'rate', window = 2, deadband = DEADBAND_EPSILON, mode = 'level', unit = 'seq', scale = 1 } = spec;
  if (!flowId) throw ledgerError('CALCULUS_BAD_SPEC', 'derivedProjection needs spec.flowId');
  if (op !== 'rate' && op !== 'accum') {
    throw ledgerError('CALCULUS_BAD_OP', `derivedProjection: op ${JSON.stringify(op)} not projectable (rate | accum)`);
  }
  const stream = flowStream(ledger, flowId, { unit, scale });
  const series = op === 'rate'
    ? rateOf(stream, { window, deadband })
    : accumSeries(stream, { mode });
  const links = buildChain(ledger.entries);
  const tip = chainTip(links);
  const cell = derivedCellId(flowId, op, op === 'rate' ? { window } : { mode });
  const entries = series.map((r, i) => Object.freeze({
    seq: i,
    ts_utc: r.ts,
    op: 'write',
    cell,
    value: r.value,
    by: 'chrono:calculus',
    cause: 'evaluate',
    pushed: false,
    flow_id: null,
    edge: `${flowId}->${cell}`,
    corrects: null,
    derived: {
      schema: DERIVED_SCHEMA,
      of: flowId,
      op,
      window: op === 'rate' ? window : null,
      mode: op === 'accum' ? mode : null,
      deadband: op === 'rate' ? deadband : null,
      unit, scale,
      t: r.t,
      sourceSeq: r.seq,
      sourceTs: r.ts,
      sourceLinkHash: links[r.seq].hash,
      sourceTipHash: tip,
    },
  }));
  return { cell, op, spec: { flowId, op, window, deadband, mode, unit, scale }, series, entries, sourceTipHash: tip };
}

/**
 * Verify derived entries against their source — the courtroom for "the
 * projection inherits the ledger's integrity". Fail-closed, named:
 *   PROVENANCE_BAD_ENTRY      an entry carries no quilt.chrono.derived/v1 block
 *   PROVENANCE_TIP_MISMATCH   the source chain's tip no longer matches the
 *                             provenance anchor — the ledger moved under the
 *                             projection (ANY row tamper lands here)
 *   PROVENANCE_SOURCE_MISMATCH  a row-level anchor broke: the source link at
 *                             sourceSeq does not re-hash, or is not the
 *                             claimed write to `of` at the claimed instant
 */
export function verifyDerivedProvenance(derivedEntries, sourceEntries) {
  const list = sourceEntries && Array.isArray(sourceEntries.entries) ? sourceEntries.entries : sourceEntries;
  if (!Array.isArray(list)) throw ledgerError('CALCULUS_BAD_INPUT', 'verifyDerivedProvenance needs the source Ledger or entries array');
  const links = buildChain(list);
  const tip = chainTip(links);
  const short = (h) => (typeof h === 'string' ? h.slice(0, 12) + '…' : h);
  for (const e of derivedEntries) {
    const d = e?.derived;
    if (!d || d.schema !== DERIVED_SCHEMA) {
      throw ledgerError('PROVENANCE_BAD_ENTRY', `derived seq ${e?.seq}: entry carries no ${DERIVED_SCHEMA} provenance`);
    }
    if (d.sourceTipHash !== tip) {
      throw ledgerError('PROVENANCE_TIP_MISMATCH',
        `derived seq ${e.seq}: provenance pins source tip ${short(d.sourceTipHash)}, the source chain now tips ${short(tip)} — the ledger moved under the projection`);
    }
    const link = links[d.sourceSeq];
    if (!link || link.hash !== d.sourceLinkHash) {
      throw ledgerError('PROVENANCE_SOURCE_MISMATCH',
        `derived seq ${e.seq}: source link at seq ${d.sourceSeq} does not re-hash to the provenance anchor — row tamper`);
    }
    const src = list[d.sourceSeq];
    if (!src || src.op !== 'write' || src.cell !== d.of || src.ts_utc !== e.ts_utc) {
      throw ledgerError('PROVENANCE_SOURCE_MISMATCH',
        `derived seq ${e.seq}: source entry ${d.sourceSeq} is not the claimed write to ${JSON.stringify(d.of)} at ${e.ts_utc}`);
    }
  }
  return { ok: true, n: derivedEntries.length, sourceTipHash: tip };
}
