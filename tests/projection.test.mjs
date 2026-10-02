// tests/projection.test.mjs — projections as pure views: stateAt vs
// hand-computed states, diff, flowMap, SVG + markdown rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger, Clock } from '../src/ledger.js';
import { Chrono } from '../src/flow.js';
import { stateAt, diff, flowMap, renderSVG, renderTable, resolveBound } from '../src/projection.js';

const clockAt = (ms, stepMs = 0) => new Clock({ startMs: ms, stepMs });

/** Hand-built ledger with known contents (5 entries). */
function handLedger() {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'a', value: 1, by: 'init', cause: 'init' });   // seq 0
  led.append({ op: 'write', cell: 'b', value: 2, by: 'init', cause: 'init' });   // seq 1
  led.append({ op: 'read', cell: 'a', value: 1, by: 'watcher', cause: 'pull' }); // seq 2
  led.append({ op: 'write', cell: 'a', value: 3, by: 'agent', cause: 'set' });   // seq 3
  led.append({ op: 'write', cell: 'c', value: 30, by: 'agent', cause: 'set' });  // seq 4
  return led;
}

test('stateAt replays entries <= t and matches the hand-computed sheet', () => {
  const led = handLedger();
  // by seq
  assert.deepEqual(stateAt(led, 1).cells, { a: 1, b: 2 });
  assert.deepEqual(stateAt(led, 3).cells, { a: 3, b: 2 });
  assert.deepEqual(stateAt(led, 4).cells, { a: 3, b: 2, c: 30 });
  // by ISO string
  assert.deepEqual(stateAt(led, led.entries[3].ts_utc).cells, { a: 3, b: 2 });
  // before the first entry: empty sheet
  assert.deepEqual(stateAt(led, '1999-01-01T00:00:00.000Z').cells, {});
  // open end: everything
  assert.deepEqual(stateAt(led, null).cells, { a: 3, b: 2, c: 30 });
  // the counts tell the reading/writing story
  const st = stateAt(led, 4);
  assert.equal(st.writes, 4);
  assert.equal(st.reads, 1);
});

test('diff(t1, t2) is the per-cell change list between two times', () => {
  const led = handLedger();
  const d = diff(led, 1, 4);
  assert.deepEqual(d.changes, [
    { cell: 'a', from: 1, to: 3, writes: 1 },
    { cell: 'c', from: null, to: 30, writes: 1 },
  ]);
  assert.equal(d.unchanged, 1); // b
  const same = diff(led, 4, 4);
  assert.deepEqual(same.changes, []);
  assert.equal(same.unchanged, 3);
});

test('flowMap counts edges from ACTUAL flows: pushes 1:1, evaluate flows fan out to deps', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000, 1000) });
  engine.value('raw', null);
  engine.value('disp', null);
  engine.value('gain', 2);
  engine.formula('cal', ['raw', 'gain'], (r, g) => r * g);
  engine.push('cal', 'disp', { by: 'w' });
  engine.tick(); engine.write('raw', 10, { by: 'agent' }); engine.pull('cal', { by: 'w' }); // cal=20, disp=20
  engine.tick(); engine.write('raw', 20, { by: 'agent' }); engine.pull('cal', { by: 'w' }); // cal=40, disp=40

  const fm = flowMap(engine.ledger, 0, null);
  const edge = (f, t) => fm.edges.find((e) => e.from === f && e.to === t);
  // 2 push flows cal->disp carrying 20 and 40
  assert.equal(edge('cal', 'disp').count, 2);
  assert.equal(edge('cal', 'disp').volume, 60);
  // 2 evaluate flows fan out to each dep edge (the causal fan-out is documented)
  assert.equal(edge('raw', 'cal').count, 2);
  assert.equal(edge('gain', 'cal').count, 2);
  assert.equal(edge('raw', 'cal').volume, 60);
  // totals: 2 evaluate flows + 2 push flows; writes in window = 8
  // (raw's init write is seq 0, and the window (t1=0, t2] opens AFTER it)
  assert.equal(fm.flows, 4);
  assert.equal(fm.writes, 8);
});

test('flowMap window bounds are honest: entries outside (t1, t2] are invisible', () => {
  const led = handLedger();
  led.recordFlow({ from: 'a', to: 'b', value: 9, by: 'w' }); // seq 5,6
  const all = flowMap(led, 0, null);
  assert.equal(all.edges.find((e) => e.from === 'a' && e.to === 'b').count, 1);
  const early = flowMap(led, 0, 2); // window ends at seq 2 (a read) — no flows yet
  assert.equal(early.edges.length, 0);
  const late = flowMap(led, 2, 4); // only the seq-3/4 direct writes: no flow edges
  assert.equal(late.edges.length, 0);
  assert.equal(late.writes, 2);
});

test('renderSVG draws the actual ledger: lanes, write marks, read ticks, push arcs, all escaped', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000, 1000) });
  engine.value('<raw & <sinister>>', 0); // hostile cell id: everything must escape
  engine.value('disp', null);
  engine.push('<raw & <sinister>>', 'disp', { by: 'w' });
  engine.tick(); engine.write('<raw & <sinister>>', 5, { by: 'agent' });
  engine.tick(); engine.write('<raw & <sinister>>', 6, { by: 'agent' });

  const svg = renderSVG(engine.ledger, null, null, { title: 'tide & <marks>' });
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  // lanes exist for every cell, with hostile text escaped
  assert.ok(svg.includes('&lt;raw &amp; &lt;sinister&gt;&gt;'));
  assert.ok(svg.includes('>disp<'));
  // every write entry in the window is a mark; every read entry is a tick
  const writes = engine.ledger.entries.filter((e) => e.op === 'write').length;
  const reads = engine.ledger.entries.filter((e) => e.op === 'read').length;
  assert.equal(svg.split('class="wr"').length - 1, writes);
  assert.equal(writes, 7); // 2 init + 3 disp pushes + 2 raw sets
  // arcs = push flows (registration fire + one per write) = 3
  assert.equal(svg.split('class="arc"').length - 1, 3);
  assert.ok(reads >= 3);
  // the title escaped
  assert.ok(svg.includes('tide &amp; &lt;marks&gt;'));
  // no raw injection possible through any cell id
  assert.ok(!svg.includes('<script'));
});

test('renderTable is a markdown projection with the flow edges in it', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000, 1000) });
  engine.value('raw', null);
  engine.value('disp', null);
  engine.push('raw', 'disp', { by: 'w' });
  engine.tick(); engine.write('raw', 5, { by: 'agent' });
  const md = renderTable(engine.ledger, null, null);
  assert.ok(md.startsWith('# '));
  assert.ok(md.includes('| cell | writes | reads |'));
  assert.ok(md.includes('| from | to | count |'));
  assert.ok(md.includes('| raw | disp | 1 |')); // one push flow: the step write (registration skipped, raw was null)
  assert.ok(md.includes('`5`')); // value at t2 in the activity table
});

test('resolveBound: exact ts, seq numbers, ISO instants between entries, and objects', () => {
  const led = handLedger();
  assert.equal(resolveBound(led, 3).seq, 3);
  assert.equal(resolveBound(led, led.entries[3].ts_utc).seq, 3);
  // ISO strings are fixed-width; appending a char stays inside the same-ms
  // ordering window, so this instant is strictly between seq 3 and seq 4
  assert.equal(resolveBound(led, led.entries[3].ts_utc + 'x').seq, 3);
  assert.deepEqual(resolveBound(led, { seq: 2 }), { ts: led.entries[2].ts_utc, seq: 2 });
  assert.deepEqual(resolveBound(led, { ts: led.entries[1].ts_utc }), { ts: led.entries[1].ts_utc, seq: 1 });
  assert.equal(resolveBound(led, '1999-01-01T00:00:00.000Z').seq, -1);
  assert.throws(() => resolveBound(led, 99), /out of range/);
  assert.throws(() => resolveBound(led, true), /cannot resolve/);
});
