// tests/flow.test.mjs — the reactive core: pulls, dirty-marking, push flows,
// the tide (bounded-rate propagation), ai cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chrono } from '../src/flow.js';
import { Clock } from '../src/ledger.js';

const clockAt = (ms, stepMs = 1000) => new Clock({ startMs: ms, stepMs });

test('write journals a writing; pull journals a reading; values flow', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('a', 1);
  engine.pull('a', { by: 'agent:t' });
  engine.write('a', 2, { by: 'agent:t' });
  const w = engine.ledger.entries.find((e) => e.op === 'write' && e.cause === 'set');
  const r = engine.ledger.entries.find((e) => e.op === 'read' && e.cause === 'pull');
  assert.equal(w.value, 2);
  assert.equal(r.value, 1);
  assert.equal(engine.pull('a', { by: 'agent:t' }), 2);
});

test('formula pulls lazily; the evaluation is ONE flow: n dep reads -> 1 result write, one flow_id', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('x', 3);
  engine.value('y', 4);
  engine.formula('sum', ['x', 'y'], (a, b) => a + b);
  const out = engine.pull('sum', { by: 'agent:t' });
  assert.equal(out, 7);
  const flows = [...engine.ledger.flowIndex().values()];
  assert.equal(flows.length, 1);
  const f = flows[0];
  assert.equal(f.reads.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].value, 7);
  assert.ok(f.reads.every((r) => r.flow_id === f.writes[0].flow_id));
});

test('dirty-marking: a dep write dirties the formula; pull re-evaluates; unchanged values write nothing', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('x', 3);
  engine.formula('sq', ['x'], (v) => v * v);
  assert.equal(engine.pull('sq', { by: 'agent:t' }), 9);
  engine.write('x', 5, { by: 'agent:t' });
  const sqCell = engine.cells.get('sq');
  assert.equal(sqCell.dirty, true);
  assert.equal(engine.pull('sq', { by: 'agent:t' }), 25);
  // pull again: clean, no new evaluation
  const writesBefore = engine.ledger.entries.filter((e) => e.op === 'write' && e.cell === 'sq').length;
  engine.pull('sq', { by: 'agent:t' });
  const writesAfter = engine.ledger.entries.filter((e) => e.op === 'write' && e.cell === 'sq').length;
  assert.equal(writesBefore, writesAfter);
  // unchanged evaluation: dirty but same value -> dep reads journaled, no result write
  engine.write('x', 5, { by: 'agent:t' }); // same value
  engine.pull('sq', { by: 'agent:t' });
  const writesFinal = engine.ledger.entries.filter((e) => e.op === 'write' && e.cell === 'sq').length;
  assert.equal(writesFinal, writesAfter);
});

test('push fires on write: sink updated, flow receipt links source read + sink write', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('a', 1);
  engine.value('b', null);
  engine.push('a', 'b', { by: 'engine:wire' });
  engine.write('a', 11, { by: 'agent:t' });
  assert.equal(engine.cells.get('b').value, 11);
  const flow = [...engine.ledger.flowIndex().values()].at(-1);
  assert.equal(flow.reads.length, 1);
  assert.equal(flow.writes.length, 1);
  assert.equal(flow.reads[0].cell, 'a');
  assert.equal(flow.writes[0].cell, 'b');
  assert.equal(flow.writes[0].value, 11);
  assert.equal(flow.writes[0].cause, 'push');
  assert.equal(flow.writes[0].pushed, true);
});

test('push cascades through chains and transforms values', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('a', null);
  engine.value('b', null);
  engine.value('c', null);
  engine.push('a', 'b', { transform: (v) => v * 2, by: 'w' });
  engine.push('b', 'c', { transform: (v) => v + 1, by: 'w' });
  engine.write('a', 10, { by: 'agent:t' });
  assert.equal(engine.cells.get('b').value, 20);
  assert.equal(engine.cells.get('c').value, 21);
});

test('push algebra is guarded: no writes into formulas, no cycles, no ghost cells', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('a', 1);
  engine.formula('f', ['a'], (v) => v);
  assert.throws(() => engine.push('a', 'f'), (e) => e.code === 'PUSH_TARGET_NOT_SINK');
  assert.throws(() => engine.push('a', 'a'), (e) => e.code === 'PUSH_CYCLE');
  engine.value('b', null);
  engine.push('a', 'b', { by: 'w' });
  assert.throws(() => engine.push('b', 'a'), (e) => e.code === 'PUSH_CYCLE');
  assert.throws(() => engine.push('a', 'ghost'), (e) => e.code === 'NO_SUCH_CELL');
});

test('THE TIDE: bounded-rate propagation holds values between crests; the latest wins', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000, 1000) }); // 1s per step
  engine.value('raw', null);
  engine.value('alert', null);
  engine.push('raw', 'alert', { by: 'w', minIntervalMs: 5000 }); // 5s tide
  const held = [];
  for (let step = 1; step <= 12; step++) {
    engine.tick();
    engine.write('raw', step, { by: 'agent:t' });
    held.push(engine.cells.get('alert').value);
  }
  // crests at steps 1, 6, 11 -> between crests the sink holds the last landed value
  assert.equal(held[0], 1);
  assert.equal(held[4], 1, 'step 5 is inside the 5s interval: the tide held');
  assert.equal(held[5], 6, 'step 6 rides the crest');
  assert.equal(held[9], 6);
  assert.equal(held[10], 11);
  // the ledger shows the tide honestly: throttled attempts carry no writes
  const throttled = engine.ledger.entries.filter((e) => e.cause === 'push-throttled');
  assert.equal(throttled.length, 9); // steps 2,3,4,5,7,8,9,10,12
  const pushes = engine.ledger.entries.filter((e) => e.op === 'write' && e.cell === 'alert' && e.cause === 'push');
  assert.equal(pushes.length, 3); // crests only (plus the init write, cause "init")
});

test('flushTide lands every held value out of band (force), journaled as tide-flush', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000, 1000) });
  engine.value('raw', null);
  engine.value('alert', null);
  engine.push('raw', 'alert', { by: 'w', minIntervalMs: 60000 });
  engine.tick();
  engine.write('raw', 5, { by: 'agent:t' }); // first attempt: the initial crest fires
  assert.equal(engine.cells.get('alert').value, 5);
  engine.tick();
  engine.write('raw', 6, { by: 'agent:t' }); // inside the interval: held
  assert.equal(engine.cells.get('alert').value, 5);
  const landed = engine.flushTide({ force: true, by: 'engine:tide' });
  assert.equal(landed.length, 1);
  assert.equal(landed[0].cause, 'tide-flush');
  assert.equal(landed[0].value, 6);
  assert.equal(engine.cells.get('alert').value, 6);
});

test('ai cells journal their readings and writings like any cell (offline backend)', async () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('temp', 71);
  engine.ai('voice', {
    deps: ['temp'],
    backend: ({ values }) => Promise.resolve(`temp is ${values[0]}`),
  });
  const out = await engine.pull('voice', { by: 'agent:greeter' });
  assert.equal(out, 'temp is 71');
  const flows = [...engine.ledger.flowIndex().values()];
  assert.equal(flows.length, 1);
  assert.equal(flows[0].reads[0].cell, 'temp');
  assert.equal(flows[0].writes[0].cell, 'voice');
  assert.equal(flows[0].writes[0].value, 'temp is 71');
  // a dep write dirties the ai cell; the next pull re-evaluates (still one flow each)
  engine.write('temp', 80, { by: 'agent:t' });
  const out2 = await engine.pull('voice', { by: 'agent:greeter' });
  assert.equal(out2, 'temp is 80');
  assert.equal(engine.ledger.flowIndex().size, 2);
});

test('ai deps must be pulled first (async evaluation is explicit, not silent)', async () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('x', 1);
  engine.ai('ai1', { deps: ['x'], backend: async ({ values }) => values[0] });
  engine.formula('uses_ai', ['ai1'], (v) => v);
  await engine.pull('ai1', { by: 'agent:t' }); // clean now
  engine.write('x', 2, { by: 'agent:t' });     // dirties ai1 AND uses_ai
  assert.throws(() => engine.pull('uses_ai', { by: 'agent:t' }), (e) => e.code === 'CELL_DEP_UNEVALUATED');
});

test('correct() ripples: compensating entry + live core brought forward + edges fire', () => {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('raw', 0);
  engine.value('log', null);
  engine.push('raw', 'log', { by: 'w', transform: (v) => `raw=${v}` });
  engine.write('raw', 99, { by: 'agent:t' }); // the fault
  const badSeq = engine.ledger.lastWrite('raw').seq;
  const fix = engine.correct(badSeq, 42, { by: 'agent:operator' });
  assert.equal(fix.cause, 'correction');
  assert.equal(fix.corrects, badSeq);
  assert.equal(engine.cells.get('raw').value, 42);
  assert.equal(engine.cells.get('log').value, 'raw=42'); // the push rode the correction
  // the bad entry is still in the ledger, untouched
  assert.equal(engine.ledger.entries[badSeq].value, 99);
});
