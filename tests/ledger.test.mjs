// tests/ledger.test.mjs — the time ledger: double-entry linking, append-only
// law, compensating corrections, monotonic time, persistence fail-closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ledger, Clock, loadLedger, ledgerError } from '../src/ledger.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-ledger-'));
const clockAt = (ms) => new Clock({ startMs: ms });

test('push flow records BOTH the source read and the sink write, linked by flow_id', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  const { flow_id, read, write } = led.recordFlow({ from: 'a', to: 'b', value: 42, by: 'engine:wire' });
  assert.equal(read.flow_id, flow_id);
  assert.equal(write.flow_id, flow_id);
  assert.equal(read.op, 'read');
  assert.equal(write.op, 'write');
  assert.equal(read.cell, 'a');
  assert.equal(write.cell, 'b');
  assert.equal(write.value, 42);
  assert.equal(read.pushed, true);
  assert.equal(write.pushed, true);
  assert.equal(read.edge, 'a->b');
  // 8+ assertions on the linking alone; the balance law closes the set
  assert.deepEqual(led.balanced(), { ok: true, unbalancedWrites: [], orphanReads: [] });
});

test('seqs are gapless from 0 and ts_utc is strictly increasing', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  for (let i = 0; i < 25; i++) {
    led.append({ op: i % 2 ? 'read' : 'write', cell: 'c', value: i, by: 'agent:t' });
  }
  led.entries.forEach((e, i) => assert.equal(e.seq, i));
  for (let i = 1; i < led.entries.length; i++) {
    assert.ok(led.entries[i].ts_utc > led.entries[i - 1].ts_utc, `ts regressed at ${i}`);
  }
  // and the ISO strings parse back to the moments they claim
  assert.equal(Date.parse(led.entries[0].ts_utc), 1700000000001); // clamp: strictly after base
});

test('a pull records a reading; direct set records a writing with flow_id null', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'x', value: 1, by: 'agent:t', cause: 'init' });
  const r = led.append({ op: 'read', cell: 'x', value: 1, by: 'agent:t', cause: 'pull' });
  assert.equal(r.op, 'read');
  assert.equal(r.flow_id, null);
  assert.equal(r.pushed, false);
  const w = led.append({ op: 'write', cell: 'x', value: 2, by: 'agent:t', cause: 'set' });
  assert.equal(w.flow_id, null);
  assert.equal(led.balanced().ok, true);
});

test('tide: a throttled attempt is a read with NO sink write — and the ledger stays balanced', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.recordThrottled({ from: 'a', to: 'b', value: 7, by: 'engine' });
  const e = led.entries[0];
  assert.equal(e.op, 'read');
  assert.equal(e.cause, 'push-throttled');
  assert.equal(e.edge, 'a->b');
  // the throttle lives in its own flow bucket; nothing is unbalanced
  const f = led.flowIndex().get(e.flow_id);
  assert.equal(f.throttled.length, 1);
  assert.equal(f.writes.length, 0);
  const b = led.balanced();
  assert.equal(b.ok, true);
  assert.equal(b.unbalancedWrites.length, 0);
});

test('double-entry balance FAILS closed: a flowed write with no paired read is unbalanced', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'b', value: 1, by: 'a', cause: 'push', pushed: true, flow_id: 'flow-ghost' });
  const b = led.balanced();
  assert.equal(b.ok, false);
  assert.deepEqual(b.unbalancedWrites, [{ flow_id: 'flow-ghost', writes: [0] }]);
});

test('append-only: values are frozen at append; mutating the caller cannot rewrite history', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  const v = { n: 1, tags: ['a'] };
  const e = led.append({ op: 'write', cell: 'x', value: v, by: 'agent:t' });
  v.n = 999;
  v.tags.push('injected');
  assert.equal(e.value.n, 1);
  assert.deepEqual(e.value.tags, ['a']);
  assert.ok(Object.isFrozen(e));
});

test('corrections are compensating entries: the original entry stays byte-intact', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'sensor', value: 100, by: 'agent:t', cause: 'set' });
  const before = JSON.stringify(led.entries[0]);
  const fix = led.correct(0, { value: 37.5, by: 'agent:operator' });
  assert.equal(JSON.stringify(led.entries[0]), before, 'original was rewritten — append-only violated');
  assert.equal(fix.cause, 'correction');
  assert.equal(fix.corrects, 0);
  assert.equal(fix.cell, 'sensor');
  assert.equal(fix.value, 37.5);
  assert.equal(led.entries.length, 2); // nothing deleted
});

test('correcting a READ is refused fail-closed (correct the source with a write instead)', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  led.append({ op: 'read', cell: 'x', value: 1, by: 'agent:t', cause: 'pull' });
  assert.throws(() => led.correct(0, { value: 2 }), (e) => e.code === 'LEDGER_CORRECT_READ');
});

test('persistence: jsonl round-trip; appends to a loaded file continue seq and time', () => {
  const dir = tmp();
  const file = path.join(dir, 'ledger.jsonl');
  const led = new Ledger({ clock: clockAt(1700000000000), file });
  led.append({ op: 'write', cell: 'a', value: 1, by: 'agent:t', cause: 'init' });
  led.recordFlow({ from: 'a', to: 'b', value: 5, by: 'engine' });
  const raw1 = fs.readFileSync(file, 'utf8');
  assert.equal(raw1.split('\n').filter((l) => l.trim()).length, 3);

  const reloaded = loadLedger(file);
  assert.equal(reloaded.entries.length, 3);
  assert.deepEqual(reloaded.entries.map((e) => e.seq), [0, 1, 2]);
  assert.equal(reloaded.flowIndex().size, 1);
  reloaded.append({ op: 'write', cell: 'c', value: 9, by: 'agent:t', cause: 'set' });
  const raw2 = fs.readFileSync(file, 'utf8');
  assert.ok(raw2.startsWith(raw1), 'reload+append rewrote the file prefix — append-only violated');
  assert.equal(reloaded.entries[3].seq, 3);
  assert.ok(reloaded.entries[3].ts_utc > reloaded.entries[2].ts_utc);
});

test('fail-closed loads: a gapped file is LEDGER_GAP, a time-regressing file is LEDGER_TIME_REGRESS', () => {
  const dir = tmp();
  const gapped = path.join(dir, 'gapped.jsonl');
  fs.writeFileSync(gapped, [
    JSON.stringify({ seq: 0, ts_utc: '2026-01-01T00:00:00.000Z', op: 'write', cell: 'a', value: 1, by: 'x', cause: 'set', pushed: false, flow_id: null, edge: null, corrects: null }),
    JSON.stringify({ seq: 5, ts_utc: '2026-01-01T00:00:01.000Z', op: 'write', cell: 'a', value: 2, by: 'x', cause: 'set', pushed: false, flow_id: null, edge: null, corrects: null }),
  ].join('\n'));
  assert.throws(() => loadLedger(gapped), (e) => e.code === 'LEDGER_GAP');

  const regressing = path.join(dir, 'regressing.jsonl');
  fs.writeFileSync(regressing, [
    JSON.stringify({ seq: 0, ts_utc: '2026-01-01T00:00:05.000Z', op: 'write', cell: 'a', value: 1, by: 'x', cause: 'set', pushed: false, flow_id: null, edge: null, corrects: null }),
    JSON.stringify({ seq: 1, ts_utc: '2026-01-01T00:00:01.000Z', op: 'write', cell: 'a', value: 2, by: 'x', cause: 'set', pushed: false, flow_id: null, edge: null, corrects: null }),
  ].join('\n'));
  assert.throws(() => loadLedger(regressing), (e) => e.code === 'LEDGER_TIME_REGRESS');
});

test('bad entries are refused at the gate', () => {
  const led = new Ledger({ clock: clockAt(1700000000000) });
  assert.throws(() => led.append({ op: 'delete', cell: 'a', value: 1, by: 'x' }), (e) => e.code === 'LEDGER_BAD_OP');
  assert.throws(() => led.append({ op: 'write', cell: '', value: 1, by: 'x' }), (e) => e.code === 'LEDGER_BAD_CELL');
  assert.throws(() => led.append({ op: 'write', cell: 'a', value: 1, by: 'x', cause: 'vibes' }), (e) => e.code === 'LEDGER_BAD_CAUSE');
  assert.throws(() => led.append({ op: 'write', cell: 'a', value: 1n, by: 'x' }), (e) => e.code === 'LEDGER_UNSERIALIZABLE');
});
