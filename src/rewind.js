// quilt-chrono — src/rewind.js (lane 66-b)
//
// REWIND TO A STABLE POINT — the playhead moves; the ledger does not.
//
//   snapshot(engineOrLedger, t) -> the full cell state at t, hash-pinned
//   restore(snapshot, opts)     -> boot a NEW engine instance from it
//
// Integration with the organ protocol (quilt-jev-toolkit/src/organ/): this
// module deliberately does NOT reimplement custody. See DESIGN.md §4 for the
// full mapping. In one line: a chrono snapshot(t) is exactly the replay SEED
// the organ protocol's checkpoint machinery signs, and restore() is
// boot-from-checkpoint; hash-chain verification and signed custody belong to
// the organ, not here.

import crypto from 'node:crypto';
import { stateAt } from './projection.js';
import { Chrono } from './flow.js';
import { Clock, ledgerError } from './ledger.js';

export const SNAPSHOT_SCHEMA = 'quilt.chrono.snapshot/v1';

/** Canonical JSON (sorted keys) — the bytes the state hash pins. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Snapshot the sheet as it existed at time t.
 *
 * Accepts a Chrono engine or a bare Ledger. The snapshot embeds:
 *   - at:        { ts, seq } resolved bound (the playhead position)
 *   - cells:     { id: { value, kind } } from stateAt's replay
 *   - state_hash: sha256 over the canonical cells (custody nod: a snapshot is
 *     a content-addressed claim, the same I1 law the organ protocol uses)
 *   - ledger_tip_seq / ledger_entries_below: how much history produced this
 */
export function snapshot(subject, t = null, { note = '' } = {}) {
  const ledger = subject && subject.ledger ? subject.ledger : subject;
  if (!ledger || !Array.isArray(ledger.entries)) {
    throw ledgerError('SNAPSHOT_BAD_SUBJECT', 'snapshot() needs a Chrono engine or a Ledger');
  }
  const st = stateAt(ledger, t);
  const engine = subject && subject.cells ? subject : null;
  const cells = {};
  for (const [id, value] of Object.entries(st.cells)) {
    const kind = engine?.cells?.get?.(id)?.kind ?? 'value';
    cells[id] = { value, kind };
  }
  const snap = {
    kind: SNAPSHOT_SCHEMA,
    name: ledger.name,
    at: st.asOf,
    cells,
    state_hash: 'sha256:' + crypto.createHash('sha256').update(canonicalJson(cells)).digest('hex'),
    ledger_tip_seq: ledger.entries.length - 1,
    ledger_entries_below: st.asOf.seq + 1,
    note,
  };
  return snap;
}

/**
 * Boot a NEW Chrono engine from a snapshot. Three modes:
 *   - no spec:        restored cells become value cells (formulas lost — the
 *                     snapshot carries values, not code)
 *   - with spec:      { cells: {id: def}, edges: [{from,to,...opts}] } —
 *                     definitions are re-registered, then seeded with the
 *                     snapshot values and marked CLEAN (history, not future:
 *                     nothing re-evaluates until something moves again)
 *   - with ledger:    { ledger } — the restoration is itself journaled into
 *                     the provided ledger as cause "restore" writes (the new
 *                     incarnation's ledger starts from the booted state)
 */
export function restore(snap, { spec = null, ledger = null, clock = null } = {}) {
  if (!snap || snap.kind !== SNAPSHOT_SCHEMA) {
    throw ledgerError('RESTORE_BAD_SNAPSHOT', `expected kind ${SNAPSHOT_SCHEMA}`);
  }
  if (typeof snap.state_hash !== 'string' || !snap.state_hash.startsWith('sha256:')) {
    throw ledgerError('RESTORE_BAD_SNAPSHOT', 'snapshot carries no state_hash');
  }
  // fail-closed: verify the snapshot against its own hash before booting
  const recompute = 'sha256:' + crypto.createHash('sha256').update(canonicalJson(snap.cells)).digest('hex');
  if (recompute !== snap.state_hash) {
    throw ledgerError('RESTORE_HASH_MISMATCH', `snapshot tampered: ${recompute} != ${snap.state_hash}`);
  }

  const engine = new Chrono({ name: `${snap.name}+restored`, ledger, clock: clock ?? new Clock() });

  // 1) re-register definitions (formulas/ais), 2) seed values, 3) mark clean.
  const defs = spec?.cells ?? {};
  for (const id of Object.keys(defs)) {
    engine.define(id, defs[id]);
  }
  for (const [id, cellSnap] of Object.entries(snap.cells)) {
    if (!engine.cells.has(id)) {
      engine.define(id, { kind: 'value', value: cellSnap.value });
    }
    const c = engine.cells.get(id);
    c.value = cellSnap.value;
    c.dirty = false; // restored state is history; it does not re-evaluate on boot
    if (ledger) {
      // journal the restoration into the new incarnation's ledger
      ledger.append({ op: 'write', cell: id, value: cellSnap.value, by: 'engine:restore', cause: 'restore', pushed: false, flow_id: null });
    }
  }
  // wire push edges last (they may fire on write; nothing writes here)
  for (const e of spec?.edges ?? []) {
    engine.push(e.from, e.to, { transform: e.transform, minIntervalMs: e.minIntervalMs ?? 0, by: 'engine:restore', fire: false });
  }
  engine.restoredFrom = { at: snap.at, state_hash: snap.state_hash };
  return engine;
}

/**
 * Convenience: snapshot the CURRENT live state (t = now).
 */
export function snapshotNow(engine, opts = {}) {
  return snapshot(engine, null, opts);
}
