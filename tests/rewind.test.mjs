// tests/rewind.test.mjs — snapshot/restore round-trips, hash-pinned
// snapshots, restoration journaling.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chrono } from '../src/flow.js';
import { Clock, Ledger } from '../src/ledger.js';
import { snapshot, restore, snapshotNow } from '../src/rewind.js';
import { stateAt } from '../src/projection.js';

const clockAt = (ms, stepMs = 1000) => new Clock({ startMs: ms, stepMs });

/** A small sheet with a formula and a push edge, lived through 6 steps. */
function livedSheet() {
  const engine = new Chrono({ clock: clockAt(1700000000000) });
  engine.value('raw', null);
  engine.value('disp', null);
  engine.formula('cal', ['raw'], (r) => r * 2 + 1);
  engine.push('cal', 'disp', { by: 'w' });
  for (let i = 1; i <= 6; i++) {
    engine.tick();
    engine.write('raw', i * 10, { by: 'agent:t' });
    engine.pull('cal', { by: 'agent:t' });
  }
  return engine;
}

test('snapshot(t) equals stateAt(t) and is hash-pinned', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8, { note: 'stable point' });
  const st = stateAt(engine.ledger, 8);
  assert.equal(snap.kind, 'quilt.chrono.snapshot/v1');
  assert.equal(snap.at.seq, 8);
  for (const [id, v] of Object.entries(st.cells)) {
    assert.equal(snap.cells[id].value, v);
  }
  assert.equal(snap.cells.cal.kind, 'formula');
  assert.match(snap.state_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snap.note, 'stable point');
});

test('RESTORE round-trip: snapshot -> restore (no spec) -> values equal the original state', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8);
  const engine2 = restore(snap);
  for (const [id, cellSnap] of Object.entries(snap.cells)) {
    assert.equal(engine2.cells.get(id).value, cellSnap.value);
    // restored state is history: nothing re-evaluates on boot
    assert.equal(engine2.cells.get(id).dirty, false);
  }
  // and a pull returns the restored value without re-evaluation
  assert.equal(engine2.pull('cal', { by: 'agent:t' }), snap.cells.cal.value);
});

test('RESTORE with spec: formulas re-registered; a new write re-evaluates FORWARD correctly', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8);
  const spec = {
    cells: {
      cal: { kind: 'formula', deps: ['raw'], fn: (r) => r * 2 + 1 },
    },
    edges: [{ from: 'cal', to: 'disp', by: 'w' }],
  };
  const engine2 = restore(snap, { spec });
  assert.equal(engine2.cells.get('cal').kind, 'formula');
  // forward motion: the restored engine lives on and the flow algebra still holds
  engine2.write('raw', 999, { by: 'agent:t' });
  assert.equal(engine2.pull('cal', { by: 'agent:t' }), 1999);
  assert.equal(engine2.cells.get('disp').value, 1999); // the restored push edge fired
});

test('the FULL round-trip: two engines, same inputs, same states (evaluate == original)', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8);
  const spec = { cells: { cal: { kind: 'formula', deps: ['raw'], fn: (r) => r * 2 + 1 } }, edges: [{ from: 'cal', to: 'disp', by: 'w' }] };
  const engine2 = restore(snap, { spec });
  // identical future inputs -> identical states (the replay law)
  for (const v of [70, 80, 90]) {
    engine.tick(); engine.write('raw', v, { by: 'agent:t' }); engine.pull('cal', { by: 'agent:t' });
    engine2.tick(); engine2.write('raw', v, { by: 'agent:t' }); engine2.pull('cal', { by: 'agent:t' });
    assert.deepEqual(engine2.state(), engine.state());
  }
});

test('snapshots are tamper-evident: a mutated snapshot refuses to boot', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8);
  const forged = JSON.parse(JSON.stringify(snap));
  forged.cells.raw.value = -1; // history forgery
  assert.throws(() => restore(forged), (e) => e.code === 'RESTORE_HASH_MISMATCH');
  const malformed = { cells: {} };
  assert.throws(() => restore(malformed), (e) => e.code === 'RESTORE_BAD_SNAPSHOT');
});

test('restoration into a live ledger is itself journaled (cause "restore")', () => {
  const engine = livedSheet();
  const snap = snapshot(engine, 8);
  const bootLedger = new Ledger({ clock: clockAt(1700000099000) });
  restore(snap, { ledger: bootLedger });
  const restoreWrites = bootLedger.entries.filter((e) => e.cause === 'restore');
  assert.equal(restoreWrites.length, Object.keys(snap.cells).length);
  assert.equal(bootLedger.balanced().ok, true);
});

test('snapshot works on a bare ledger (no engine) and defaults to now', () => {
  const engine = livedSheet();
  const bare = snapshot(engine.ledger, 4);
  // at seq 4 only raw and disp have been written (cal's first write is seq 5)
  assert.equal(bare.cells.raw.value, 10);
  assert.equal(bare.cells.disp.value, null);
  assert.equal(bare.cells.cal, undefined);
  assert.equal(bare.cells.raw.kind, 'value'); // no engine: kinds default to value
  const now = snapshotNow(engine);
  assert.equal(now.at.seq, engine.ledger.entries.length - 1);
});
