// calculus.test.mjs — the calculus moves upstream (lane 72-c).
//
// Far shore (quilt-far-shore R2 @ 9e1517f) proved on the wave-67 battery that
// the derivative out-detects the threshold alarm on all three incidents and
// that d/dt∫flow == flow exactly. This suite RE-PROOFS that upstream, in
// chrono's own law: the fixture is a real chrono LEDGER embedding the wave-67
// incident shape (greeter silences at T6/T13, refunder raw-fallback at T22 —
// the answer.source writes carry the fallback markers, the distress cell goes
// SILENT on failed turns exactly as the battery did), the operators come from
// src/calculus.js, the derived series are projections (renderable, sealable),
// and the seals are organ-exact (src/seal.js).
//
// DATA PROVENANCE: the embedded per-turn vectors are the REAL wave-67 battery
// readings (quilt-storefront runs/live-session-2.jsonl, receipted through
// far-shore R2 results/R2.json) — latency.ms per turn, refunder distress
// (0.42/0.42/0.10, the spec B3.1 registered samples), per-turn spend.
// ZERO model calls, zero network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ledger, Clock, loadLedger } from '../src/ledger.js';
import {
  flowStream, flowsOf,
  rateOf, accumOf, accumSeries, lagOf, rate, accum, lag,
  thresholdAlarm, derivativeFlags, conservation,
  Fold, rateFoldStep, flowAccumFoldStep, deepEqual,
  derivedProjection, derivedCellId, verifyDerivedProvenance,
  DEADBAND_EPSILON as EPS, DERIVED_SCHEMA,
} from '../src/calculus.js';
import { renderSVG } from '../src/projection.js';
import { seal, verifySeal, verifyCustody, buildChain, chainTip, readChainSidecar } from '../src/seal.js';

// ---------------------------------------------------------------------------
// the wave-67 battery, embedded verbatim (24 turns; provenance in the header)
// ---------------------------------------------------------------------------
const TURNS = 24;
const LAT = [3914, 0, 0, 0, 0, 5344, 0, 0, 0, 3921, 0, 262, 4865, 0, 0, 0, 3909, 0, 0, 240, 0, 4617, 3911, 228];
const SOURCE = ['deepinfra-chat', 'lookup', 'lookup', 'lookup', 'lookup', 'fail-closed', 'lookup', 'lookup', 'lookup',
  'deepinfra-chat', 'lookup', 'lookup', 'fail-closed', 'lookup', 'lookup', 'lookup', 'deepinfra-chat', 'lookup',
  'lookup', 'lookup', 'lookup', 'fallback', 'deepinfra-chat', 'lookup'];
const DIS = { 10: 0.42, 17: 0.42, 23: 0.10 }; // real distress reads; T6/T13 greeter silences, T22 raw-fallback → silence
const COST = [0.00003499, 0, 0, 0, 0, 0, 0, 0, 0, 0.00003569, 0, 0, 0, 0, 0, 0, 0.00005628, 0, 0, 0, 0, 0, 0.00004845, 0];
const INCIDENTS = [6, 13, 22]; // R3-receipted positions: greeter silences T6/T13, refunder fail-closed T22
const RECEIPTED_LAT_FLAGS = [3, 6, 8, 10, 12, 13, 14, 15, 17, 19, 20, 22, 23, 24]; // far-shore R2 receipt

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-calculus-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** The wave-67 incident shape as a chrono ledger: one 1s tick per turn on the
 *  Unix epoch (t == the turn number in seconds), latency.ms lands exactly on
 *  the turn's second boundary, later cells clamp +1ms each (the ledger's
 *  honest sub-second resolution when cells interleave), answer.source carries
 *  the fallback markers, refunder.distress goes silent on failed turns,
 *  usage.cost is the real spend flow. Deterministic clock → byte-reproducible. */
function incidentLedger({ name = 'wave67-fixture', file = null } = {}) {
  const ledger = new Ledger({
    name,
    clock: new Clock({ startMs: 0, stepMs: 1000 }),
  });
  if (file) ledger.attach(file);
  for (let turn = 1; turn <= TURNS; turn++) {
    ledger.clock.advance(); // the clock lands exactly on the turn's second boundary
    ledger.append({ op: 'write', cell: 'latency.ms', value: LAT[turn - 1], by: 'battery', cause: 'set' });
    ledger.append({ op: 'write', cell: 'answer.source', value: SOURCE[turn - 1], by: 'battery', cause: 'set' });
    if (DIS[turn] !== undefined) {
      ledger.append({ op: 'write', cell: 'refunder.distress', value: DIS[turn], by: 'refunder.joint', cause: 'set' });
    }
    ledger.append({ op: 'write', cell: 'usage.cost', value: COST[turn - 1], by: 'battery', cause: 'set' });
  }
  return ledger;
}

const TS = { unit: 'ts', scale: 1000 }; // t in seconds: 1..24 — the turns
const within = (flag, onset) => Math.abs(flag - onset) <= 2;

// ---------------------------------------------------------------------------
// streams over the ledger's flows
// ---------------------------------------------------------------------------
test('flowStream reads the flow off the ledger: ts unit lands on the turns, seq unit on the entry seq', () => {
  const ledger = incidentLedger();
  const lat = flowStream(ledger, 'latency.ms', TS);
  assert.equal(lat.length, TURNS);
  assert.deepEqual(lat.map((s) => s.t), Array.from({ length: TURNS }, (_, i) => i + 1));
  assert.deepEqual(lat.map((s) => s.v), LAT);
  const latSeq = flowStream(ledger, 'latency.ms');
  assert.deepEqual(latSeq.slice(0, 3).map((s) => s.t), [0, 3, 6]); // seq ticks: 3 entries on a turn without distress
  const dis = flowStream(ledger, 'refunder.distress', TS);
  assert.equal(dis.length, 3); // the failed turns are SILENCES, not zeros
  assert.deepEqual(dis.map((s) => Math.round(s.t)), [10, 17, 23]); // +2ms clamp: distress writes third in the turn
  assert.deepEqual(flowsOf(ledger).map((f) => f.flowId), ['latency.ms', 'refunder.distress', 'usage.cost']);
});

test('flowStream fail-closed: a typo\u2019d flow id throws CALCULUS_NO_SUCH_FLOW, a string-only cell reads as a dry flow', () => {
  const ledger = incidentLedger();
  assert.throws(() => flowStream(ledger, 'latency.ms '), (e) => e.code === 'CALCULUS_NO_SUCH_FLOW');
  assert.deepEqual(flowStream(ledger, 'answer.source', TS), []); // exists, wrote no numbers — honest dry flow
});

// ---------------------------------------------------------------------------
// the deadband law (far-shore P1, re-proofed ledger-borne; ε per projection)
// ---------------------------------------------------------------------------
function jitterLedger() {
  const ledger = new Ledger({ name: 'deadband-law', clock: new Clock({ startMs: Date.UTC(2026, 0, 1), stepMs: 1000 }) });
  for (let i = 0; i < 64; i++) {
    ledger.clock.advance();
    ledger.append({ op: 'write', cell: 'const.v', value: 0.5, by: 't', cause: 'set' });
    ledger.append({ op: 'write', cell: 'jit.half', value: 0.5 + (i % 2 === 1 ? EPS / 2 : 0), by: 't', cause: 'set' });
    ledger.append({ op: 'write', cell: 'jit.double', value: 0.5 + (i % 2 === 0 ? -2 * EPS : 2 * EPS), by: 't', cause: 'set' });
  }
  return ledger;
}
const defined = (out) => out.map((r) => r.value).filter((v) => v !== null); // warmup has no backward window (spec B.2)

test('deadband law P1a: rate over a constant flow is exactly 0 for every window', () => {
  const ledger = jitterLedger();
  for (const w of [1, 2, 4]) {
    const vals = defined(rate(ledger, 'const.v', { ...TS, window: w }));
    assert.ok(vals.length > 0 && vals.every((v) => Math.abs(v) <= 1e-9), `window ${w}`);
  }
});

test('deadband law P1b: \u00b1\u03b5/2 jitter stays 0 \u2014 the deadband holds', () => {
  const ledger = jitterLedger();
  for (const w of [1, 2, 4]) {
    const vals = defined(rate(ledger, 'jit.half', { ...TS, window: w }));
    assert.ok(vals.length > 0 && vals.every((v) => v === 0), `window ${w}`);
  }
});

test('deadband law P1c: \u00b12\u03b5 jitter oscillates \u2014 the honest sensitivity boundary', () => {
  const ledger = jitterLedger();
  assert.ok([1, 2, 4].some((w) => rate(ledger, 'jit.double', { ...TS, window: w }).some((r) => r.value !== null && r.value !== 0)));
});

test('\u03b5 is configurable per projection: deadband 0 wakes \u00b1\u03b5/2, deadband 1 silences \u00b12\u03b5', () => {
  const ledger = jitterLedger();
  assert.ok([1, 2, 4].some((w) => rate(ledger, 'jit.half', { ...TS, window: w, deadband: 0 }).some((r) => r.value !== null && r.value !== 0)));
  for (const w of [1, 2, 4]) {
    const vals = defined(rate(ledger, 'jit.double', { ...TS, window: w, deadband: 1 }));
    assert.ok(vals.length > 0 && vals.every((v) => v === 0), `window ${w}`);
  }
});

// ---------------------------------------------------------------------------
// accum — the integral cell (spec B3.2 arithmetic, on the fixture)
// ---------------------------------------------------------------------------
test('accum level over the fixture\u2019s distress flow: (5,24] = 4.50 within 1e-9 (2.94 + 1.56)', () => {
  const ledger = incidentLedger();
  const a = accum(ledger, 'refunder.distress', { ...TS, window: { t1: 5, t2: 24 }, mode: 'level' });
  assert.equal(a.unit, 'level');
  assert.deepEqual(a.breakdown.map((b) => [Math.round(b.from), Math.round(b.to)]), [[10, 17], [17, 23]]); // real readings only — silences are absent samples (spans rounded off the +2ms clamp)
  assert.ok(Math.abs(a.value - 4.5) < 1e-9, `accum=${a.value}`);
  const running = accumSeries(flowStream(ledger, 'refunder.distress', TS));
  assert.equal(running.length, 3);
  assert.deepEqual(running.map((r) => r.value)[0], 0);
  assert.ok(Math.abs(running[1].value - 2.94) < 1e-9 && Math.abs(running[2].value - 4.5) < 1e-9);
});

test('accum rejects an unbounded window (an integral without bounds is a guess)', () => {
  const ledger = incidentLedger();
  assert.throws(() => accum(ledger, 'usage.cost', { ...TS }), (e) => e.code === 'CALCULUS_BAD_WINDOW');
});

// ---------------------------------------------------------------------------
// conservation — d/dt ∫ flow == flow, exactly (far-shore P4, upstream)
// ---------------------------------------------------------------------------
test('conservation on the REAL spend flow: d/dt of the running sum == usage.cost, max err \u2264 1e-9', () => {
  const ledger = incidentLedger();
  const spend = flowStream(ledger, 'usage.cost'); // seq ticks — integer t, spacing 3\u20134 (the interleaved ledger\u2019s honest shape)
  const c = conservation(spend);
  assert.equal(c.holds, true);
  assert.ok(c.maxErr <= 1e-9, `maxErr=${c.maxErr}`);
  const total = accum(ledger, 'usage.cost', { window: { t1: -1, t2: Infinity }, mode: 'flow' });
  assert.ok(Math.abs(total.value - 0.00017541) < 1e-15, `total=${total.value}`);
  assert.equal(total.parts.length, TURNS); // the law: every numeric reading is a part (zeros read as "no spend this turn")
  assert.equal(total.parts.filter((p) => p.amount !== 0).length, 4); // the four model turns carried the spend
});

test('conservation on a synthetic signed flow (pushes +, pulls \u2212): holds exactly', () => {
  const pattern = [1, -1, 2, 0, -3, 1];
  const flow = Array.from({ length: 24 }, (_, i) => ({ t: i + 1, v: pattern[i % pattern.length] }));
  const c = conservation(flow);
  assert.equal(c.holds, true);
  assert.ok(c.maxErr <= 1e-9);
});

// ---------------------------------------------------------------------------
// lag — the alignment cell (spec B3.3 arithmetic, ledger-borne)
// ---------------------------------------------------------------------------
test('lag over two fixture cells: the shifted indicator pair aligns at k=1 with corr 1.0', () => {
  const ledger = new Ledger({ name: 'lag-law', clock: new Clock({ startMs: Date.UTC(2026, 0, 1), stepMs: 1000 }) });
  const V = [0, 0, 1, 1, 1, 0, 0];
  const W = [0, 0, 0, 1, 1, 1, 0];
  for (let i = 0; i < 7; i++) {
    ledger.clock.advance();
    ledger.append({ op: 'write', cell: 'signal.v', value: V[i], by: 't', cause: 'set' });
    ledger.append({ op: 'write', cell: 'signal.w', value: W[i], by: 't', cause: 'set' });
  }
  const l = lag(ledger, 'signal.v', 'signal.w', { ...TS, maxLag: 2 }); // tick auto-derived from clock.stepMs
  assert.equal(l.argmax_lag, 1);
  assert.ok(Math.abs(l.corrs.find((c) => c.k === 1).corr - 1.0) < 1e-9);
  // the raw-ts law (tick null) cannot align clamped cells — the tick grid is
  // the ledger's own resolution (the +1ms in-tick clamp, receipted above)
  assert.equal(lagOf(flowStream(ledger, 'signal.v', TS), flowStream(ledger, 'signal.w', TS), { maxLag: 2 }).argmax_lag, null);
});

// ---------------------------------------------------------------------------
// THE INCIDENTS USE-CASE — the wave-67 re-proof, upstream, in chrono's law
// ---------------------------------------------------------------------------
test('RE-PROOF: rate() flags all three wave-67 incidents within \u22642 turns \u2014 with the receipted flag lists', () => {
  const ledger = incidentLedger();
  const latRate = rate(ledger, 'latency.ms', { ...TS, window: 2, deadband: EPS });
  const disRate = rate(ledger, 'refunder.distress', { ...TS, window: 2, deadband: EPS });
  assert.deepEqual(derivativeFlags(latRate), RECEIPTED_LAT_FLAGS); // byte-for-byte the far-shore R2 receipt
  assert.deepEqual(derivativeFlags(disRate).map((t) => Math.round(t)), [23]); // the distress crash read at T23 = −0.16 (round to the turn: the +2ms in-tick clamp)
  const flagged = INCIDENTS.filter((onset) =>
    derivativeFlags(latRate).some((f) => within(f, onset)) || derivativeFlags(disRate).some((f) => within(f, onset)));
  assert.deepEqual(flagged, INCIDENTS); // 3/3
  // the receipted magnitudes: T6 (2672.0), T13 (2432.5), distress crash \u22120.16
  assert.ok(Math.abs(latRate.find((r) => r.t === 6).value - 2672.0) < 1e-9);
  assert.ok(Math.abs(latRate.find((r) => r.t === 13).value - 2432.5) < 1e-9);
  assert.ok(Math.abs(disRate.find((r) => Math.round(r.t) === 23).value - (-0.16)) < 1e-9);
  assert.ok(Math.abs(latRate.find((r) => r.t === 22).value - 2188.5) < 1e-9); // (4617 \u2212 240)/2 \u2014 flagged exactly at T22
});

test('RE-PROOF: the plain threshold alarm flags NONE of the three incidents on the same flows', () => {
  const ledger = incidentLedger();
  const latThr = thresholdAlarm(flowStream(ledger, 'latency.ms', TS), { k: 2 });
  const disThr = thresholdAlarm(flowStream(ledger, 'refunder.distress', TS), { k: 2 });
  assert.ok(Math.abs(latThr.threshold - 6242.2) < 1e-9, `latency bar ${latThr.threshold}`); // above the max spike 5344
  assert.ok(Math.abs(disThr.threshold - (2 * (0.42 + 0.42 + 0.10) / 3)) < 1e-9);
  assert.deepEqual(latThr.flags, []);
  assert.deepEqual(disThr.flags, []);
  const flagged = INCIDENTS.filter((onset) =>
    latThr.flags.some((f) => within(f, onset)) || disThr.flags.some((f) => within(f, onset)));
  assert.equal(flagged.length, 0); // 0/3 — the level\u2019s blindspot is exactly where the incidents live
});

// ---------------------------------------------------------------------------
// the Fold — incremental append == recompute-from-genesis (the chrono law)
// ---------------------------------------------------------------------------
test('Fold partials equal recompute-from-genesis at EVERY prefix, live-folded while the ledger appends', () => {
  const ledger = new Ledger({
    name: 'wave67-fixture',
    clock: new Clock({ startMs: Date.UTC(2026, 9, 2, 6, 2, 6, 0), stepMs: 1000 }),
  });
  const fold = new Fold('latency.ms', 'rate', { window: 2, deadband: EPS }, rateFoldStep);
  const samples = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    ledger.clock.advance();
    for (const partial of [
      { op: 'write', cell: 'latency.ms', value: LAT[turn - 1], by: 'battery', cause: 'set' },
      { op: 'write', cell: 'answer.source', value: SOURCE[turn - 1], by: 'battery', cause: 'set' },
      { op: 'write', cell: 'usage.cost', value: COST[turn - 1], by: 'battery', cause: 'set' }, // the battery's spend rides too — the flow-accum fold needs it below
    ]) {
      const e = ledger.append(partial);
      if (e.cell === 'latency.ms') {
        const sample = { t: Date.parse(e.ts_utc) / 1000, v: e.value, ts: e.ts_utc, seq: e.seq };
        samples.push(sample);
        fold.append(sample); // the fold rides the appends — an observation, never a transition
      }
    }
  }
  const params = { window: 2, deadband: EPS };
  for (let k = 0; k < samples.length; k++) {
    const rec = Fold.recompute('latency.ms', 'rate', params, rateFoldStep, samples.slice(0, k + 1)); // genesis replay
    if (!deepEqual(fold.observations[k].partial, rec.partial)) {
      assert.fail(`prefix ${k}: incremental partial drifted from recompute-from-genesis`);
    }
  }
  const batch = rateOf(samples, params);
  assert.deepEqual(fold.observations.map((o) => o.partial.value), batch.map((r) => r.value));
  const base = samples[0].t - 1; // the fold fixture's clock is a real calendar epoch: flags normalize to relative turns
  assert.deepEqual(derivativeFlags(batch).map((t) => t - base), RECEIPTED_LAT_FLAGS); // the fold's law == the stream's law
  const flowFold = new Fold('usage.cost', 'accum-flow', {}, flowAccumFoldStep);
  for (const s of flowStream(ledger, 'usage.cost', TS)) flowFold.append(s);
  const recF = Fold.recompute('usage.cost', 'accum-flow', {}, flowAccumFoldStep, flowStream(ledger, 'usage.cost', TS));
  assert.ok(deepEqual(flowFold.partial, recF.partial));
  assert.ok(Math.abs(flowFold.partial.total - 0.00017541) < 1e-15);
});

// ---------------------------------------------------------------------------
// derived projections — the series as a chrono ledger with provenance
// ---------------------------------------------------------------------------
test('derivedProjection materializes the derivative as a ledger-shaped series with per-entry provenance', () => {
  const ledger = incidentLedger();
  const proj = derivedProjection(ledger, { flowId: 'latency.ms', op: 'rate', window: 2, deadband: EPS, ...TS });
  assert.equal(proj.cell, 'rate(latency.ms,w=2)');
  assert.equal(proj.entries.length, TURNS);
  assert.deepEqual(proj.entries.map((e) => e.seq), proj.entries.map((_, i) => i)); // gapless 0..n-1
  for (let i = 1; i < proj.entries.length; i++) assert.ok(proj.entries[i].ts_utc > proj.entries[i - 1].ts_utc);
  assert.equal(proj.entries[0].op, 'write');
  assert.equal(proj.entries[0].cause, 'evaluate');
  assert.equal(proj.entries[0].by, 'chrono:calculus');
  const links = buildChain(ledger.entries);
  const tip = chainTip(links);
  for (const e of proj.entries) {
    assert.equal(e.derived.schema, DERIVED_SCHEMA);
    assert.equal(e.derived.of, 'latency.ms');
    assert.equal(e.derived.window, 2);
    assert.equal(e.derived.sourceTipHash, tip); // anchored to the WHOLE source chain
    assert.equal(e.derived.sourceLinkHash, links[e.derived.sourceSeq].hash); // and to the exact row
    assert.equal(ledger.entries[e.derived.sourceSeq].cell, 'latency.ms');
  }
  const verdict = verifyDerivedProvenance(proj.entries, ledger);
  assert.deepEqual(verdict, { ok: true, n: TURNS, sourceTipHash: tip });
  assert.equal(derivedCellId('usage.cost', 'accum', { mode: 'flow' }), 'accum(usage.cost,flow)');
});

// ---------------------------------------------------------------------------
// SEAL INTEROP — the derivative of a signed ledger is itself custody-grade
// ---------------------------------------------------------------------------
function sealDerivedProjection(dir, { alg = undefined } = {}) {
  const srcFile = path.join(dir, 'wave67.jsonl');
  const ledger = incidentLedger({ file: srcFile });
  const sourceSeal = seal(ledger, { key: 'hmac-key-72c', name: 'wave67' }); // sidecar written next to the ledger
  const proj = derivedProjection(ledger, { flowId: 'latency.ms', op: 'rate', window: 2, deadband: EPS, ...TS });
  const derivedFile = path.join(dir, 'derived.jsonl');
  fs.writeFileSync(derivedFile, proj.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const derivedLedger = loadLedger(derivedFile); // the derived series IS a chrono ledger
  const derivedSeal = seal(derivedLedger, {
    key: alg === 'Ed25519' ? keygen().privateKeyPem : 'hmac-key-72c',
    alg,
    name: 'wave67-derived',
  });
  return { ledger, srcFile, sourceSeal, proj, derivedFile, derivedLedger, derivedSeal };
}
const keygen = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};

test('SEAL INTEROP (HMAC): a rate projection seals and verifies — sidecar, chain, manifest, second witness', () => {
  const dir = tmpdir();
  try {
    const { sourceSeal, derivedLedger, derivedSeal } = sealDerivedProjection(dir);
    // the derived sidecar verifies as a chain; the seal anchors its tip
    const side = readChainSidecar(derivedSeal.chainFile);
    assert.equal(side.tipHash, derivedSeal.checkpoint.hash);
    const v = verifyCustody(derivedSeal.checkpoint, 'hmac-key-72c', { chainFile: derivedSeal.chainFile, entries: derivedLedger.entries });
    assert.equal(v.ok, true);
    assert.equal(v.seq, derivedLedger.entries.length - 1);
    assert.equal(v.manifestHash, derivedSeal.checkpoint.manifestHash);
    // the source ledger is sealed too — the projection inherits BOTH
    verifyCustody(sourceSeal.checkpoint, 'hmac-key-72c', { chainFile: sourceSeal.chainFile, entries: sourceSeal.links.map((l) => l.op) });
    assert.equal(derivedSeal.checkpoint.manifest.cells[0].id, 'rate(latency.ms,w=2)');
  } finally { cleanup(dir); }
});

test('SEAL INTEROP (Ed25519, v3): the derived series seals under a NAMED signer and verifies under the public key', () => {
  const dir = tmpdir();
  try {
    const srcFile = path.join(dir, 'wave67.jsonl');
    const ledger = incidentLedger({ file: srcFile });
    const proj = derivedProjection(ledger, { flowId: 'latency.ms', op: 'rate', window: 2, deadband: EPS, ...TS });
    const derivedFile = path.join(dir, 'derived.jsonl');
    fs.writeFileSync(derivedFile, proj.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const derivedLedger = loadLedger(derivedFile);
    const { publicKeyPem, privateKeyPem } = keygen();
    const cp = seal(derivedLedger, { key: privateKeyPem, alg: 'Ed25519', name: 'wave67-derived' }).checkpoint;
    assert.equal(cp.alg, 'Ed25519');
    const v = verifySeal(cp, publicKeyPem); // the key HOLDS the trust
    assert.equal(v.ok, true);
  } finally { cleanup(dir); }
});

test('SEAL INTEROP: tamper the underlying ledger row \u2192 the derived seal STILL catches it via the chain', () => {
  const dir = tmpdir();
  try {
    const { srcFile, sourceSeal, proj, derivedSeal } = sealDerivedProjection(dir);

    // --- tamper: flip one latency value (T13\u2019s 4865 \u2192 9999) in the source jsonl ---
    const lines = fs.readFileSync(srcFile, 'utf8').trim().split('\n');
    const i = lines.findIndex((l) => { const e = JSON.parse(l); return e.cell === 'latency.ms' && e.value === 4865; });
    assert.ok(i > 0, 'fixture row not found');
    const tamperedEntry = JSON.parse(lines[i]);
    tamperedEntry.value = 9999;
    lines[i] = JSON.stringify(tamperedEntry);
    const tamperedFile = path.join(dir, 'wave67-tampered.jsonl');
    fs.writeFileSync(tamperedFile, lines.join('\n') + '\n');
    const tampered = loadLedger(tamperedFile);

    // 1. the SOURCE seal catches the row tamper (chain vs ledger divergence)
    assert.throws(
      () => verifyCustody(sourceSeal.checkpoint, 'hmac-key-72c', { chainFile: sourceSeal.chainFile, entries: tampered.entries }),
      (e) => e.code === 'CHAIN_ENTRY_MISMATCH',
    );

    // 2. recompute the derivative FROM THE TAMPERED LEDGER — the sealed derived
    //    chain no longer describes it: CHAIN_ENTRY_MISMATCH via the second witness
    const tamperedProj = derivedProjection(tampered, { flowId: 'latency.ms', op: 'rate', window: 2, deadband: EPS, ...TS });
    assert.notEqual(tamperedProj.sourceTipHash, proj.sourceTipHash); // the tip moved under the projection
    assert.throws(
      () => verifyCustody(derivedSeal.checkpoint, 'hmac-key-72c', { links: derivedSeal.links, entries: tamperedProj.entries }),
      (e) => e.code === 'CHAIN_ENTRY_MISMATCH',
    );

    // 3. the provenance names it too: the projection\u2019s anchor to the source broke
    assert.throws(
      () => verifyDerivedProvenance(proj.entries, tampered),
      (e) => e.code === 'PROVENANCE_TIP_MISMATCH',
    );
    // and the honest pair still verifies, right beside it
    assert.deepEqual(verifyDerivedProvenance(proj.entries, loadLedger(srcFile)), { ok: true, n: TURNS, sourceTipHash: proj.sourceTipHash });
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// the overlay — the calculus, visually, in the projection
// ---------------------------------------------------------------------------
test('renderSVG rate overlay: the derivative rides the latency lane with flag diamonds at every receipted incident turn', () => {
  const ledger = incidentLedger();
  const svg = renderSVG(ledger, null, null, {
    renderedAt: '2026-10-02T06:03:00.000Z',
    overlay: { cell: 'latency.ms', mode: 'rate', window: 2, deadband: EPS, ...TS },
  });
  assert.match(svg, /<polyline class="overlay" points="[^"]+" fill="none" stroke="#ffa657"/);
  assert.match(svg, /overlay: rate\(latency\.ms,w=2\) &#949;=0\.04/);
  const flags = svg.match(/class="flag"/g) ?? [];
  assert.equal(flags.length, RECEIPTED_LAT_FLAGS.length); // 14 moved readings, 3 of them the incidents
  const pts = svg.match(/<polyline class="overlay" points="([^"]+)"/)[1].split(' ');
  assert.equal(pts.length, TURNS - 2); // warmup (no backward window yet) is honestly absent
  const diamonds = [...svg.matchAll(/rotate\(45 ([\d.]+) /g)].map((m) => Number(m[1]));
  const t9 = Date.parse(ledger.entries[ledger.entries.length - 1].ts_utc);
  const X = (sec) => 168 + ((sec * 1000) / t9) * (980 - 168 - 28); // the sheet's OWN axis: a null t1 spans [epoch 0, last ts]
  for (const onset of INCIDENTS) {
    assert.ok(diamonds.some((dx) => Math.abs(dx - X(onset)) < 3), `no flag diamond near T${onset}`);
  }
});

test('renderSVG accum overlay: the running spend rides the usage.cost lane', () => {
  const ledger = incidentLedger();
  const svg = renderSVG(ledger, null, null, {
    renderedAt: '2026-10-02T06:03:00.000Z',
    overlay: { cell: 'usage.cost', mode: 'accum', accMode: 'flow', ...TS },
  });
  assert.match(svg, /<polyline class="overlay" points="[^"]+" fill="none" stroke="#7ee787"/);
  assert.match(svg, /overlay: accum\(usage\.cost,flow\)/);
  const pts = svg.match(/<polyline class="overlay" points="([^"]+)"/)[1].split(' ');
  assert.equal(pts.length, TURNS); // the staircase spans every reading — zeros are honest "no spend this turn" points
  const ys = pts.map((p) => Number(p.split(',')[1]));
  assert.equal(Math.min(...ys), ys[ys.length - 1]); // the running total ends at its peak (spend only adds)
});

test('overlay determinism: double run is BYTE-EQUAL (pinned renderedAt; the only unpinned byte is the footer stamp)', () => {
  const ledger = incidentLedger();
  const opts = { renderedAt: '2026-10-02T06:03:00.000Z', overlay: { cell: 'latency.ms', mode: 'rate', window: 2, deadband: EPS, ...TS } };
  const a = renderSVG(ledger, null, null, opts);
  const b = renderSVG(incidentLedger(), null, null, opts); // a FRESH equal ledger, second run
  assert.equal(Buffer.byteLength(a), Buffer.byteLength(b));
  assert.equal(a, b); // byte-equal, not just same-length
  const plain = { renderedAt: '2026-10-02T06:03:00.000Z' };
  assert.equal(renderSVG(ledger, null, null, plain), renderSVG(incidentLedger(), null, null, plain));
});

test('overlay fail-closed: a typo\u2019d cell throws CALCULUS_NO_SUCH_FLOW, a flow-less cell throws CALCULUS_NO_FLOW_DATA', () => {
  const ledger = incidentLedger();
  assert.throws(
    () => renderSVG(ledger, null, null, { overlay: { cell: 'latency .ms', mode: 'rate', ...TS } }),
    (e) => e.code === 'CALCULUS_NO_SUCH_FLOW',
  );
  assert.throws(
    () => renderSVG(ledger, null, null, { overlay: { cell: 'answer.source', mode: 'rate', ...TS } }),
    (e) => e.code === 'CALCULUS_NO_FLOW_DATA',
  );
  assert.throws(
    () => renderSVG(ledger, null, null, { overlay: { cell: 'latency.ms', mode: 'integral', ...TS } }),
    (e) => e.code === 'CALCULUS_BAD_OP',
  );
});
