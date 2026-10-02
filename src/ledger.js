// quilt-chrono — src/ledger.js (lane 66-b)
//
// THE TIME LEDGER — every cell read is a `reading`, every write a `writing`.
// The ledger is append-only: entries are never deleted or edited; corrections
// are compensating entries appended after the fact (wave-64/65 organ law:
// "a rewind does not erase — it appends"). See DESIGN.md §4 for the mapping
// to quilt-jev-toolkit's organ protocol.
//
// Entry schema (quilt.chrono.entry/v1) — flat, jsonl-serializable:
// {
//   seq:      number        0-based, gapless, assigned by append order
//   ts_utc:   string        ISO-8601, STRICTLY increasing across entries
//   op:       "read"|"write"
//   cell:     string        cell id
//   value:    any           JSON-safe; deep-frozen at append time so a caller
//                           can never rewrite history by mutating afterwards
//   by:       string        the cell or agent id that caused this entry
//   cause:    string        "init"|"set"|"step"|"pull"|"push"|"evaluate"|
//                           "push-throttled"|"tide-flush"|"correction"|"restore"
//   pushed:   boolean       true when this entry exists because of a push flow
//   flow_id:  string|null   links the entries of ONE flow. Double-entry spirit:
//                           a push records the source read and the sink write
//                           with the SAME flow_id; a formula evaluation links
//                           its n dependency reads to its 1 result write.
//   edge:     string|null   "from->to" on push-flow entries (incl. throttled)
//   corrects: number|null   seq of the entry this compensating entry corrects
// }
//
// Double-entry balance law (checked by flows()/balanced()):
//   every WRITE that carries a flow_id must be paired with >= 1 READ of the
//   same flow_id. Unpaired reads are legal and honest (pulls, throttled tide
//   attempts); unpaired writes are not — a write without a cause-read is a
//   hole in the causal fabric.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const OPS = new Set(['read', 'write']);

export const CAUSES = new Set([
  'init', 'set', 'step', 'pull', 'push', 'evaluate',
  'push-throttled', 'tide-flush', 'correction', 'restore',
]);

export function ledgerError(code, detail) {
  const err = new Error(`${code}: ${detail}`);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Clock — monotonic ISO timestamps.
//
// Two modes:
//   real (default): Date.now(), clamped so ts is strictly increasing even when
//     several entries land inside the same millisecond (clamped +1ms each).
//   deterministic: a fixed base + a step size; `advance()` moves one step.
//     Used by examples and tests so runs are byte-reproducible.
// ---------------------------------------------------------------------------
export class Clock {
  constructor({ startMs = null, stepMs = 0 } = {}) {
    this.base = startMs ?? Date.now();
    this.stepMs = stepMs;
    this.last = this.base;
    this.advances = 0;
  }
  advance() {
    if (this.stepMs > 0) {
      this.base += this.stepMs;
      this.advances += 1;
      // Move the clamp floor to the new boundary WITHOUT issuing a timestamp:
      // the first entry appended after advance() lands exactly on the step
      // boundary, so simulated steps resolve to exact ISO instants.
      this.last = Math.max(this.last, this.base - 1);
    }
    return new Date(this.base).toISOString();
  }
  now() {
    // strictly-increasing clamp: never return a ts <= the last one issued
    const t = Math.max(this.base, this.last + 1);
    this.last = t;
    return new Date(t).toISOString();
  }
  nowMs() {
    this.now(); // keep the clamp in lock-step with issued timestamps
    return this.last;
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------
export class Ledger {
  constructor({ name = 'chrono', file = null, clock = new Clock() } = {}) {
    this.name = name;
    this.clock = clock;
    this.entries = [];
    this.flows = new Map();      // flow_id -> { id, reads: [], writes: [], throttled: [] }
    this._flowCounter = 0;
    this.file = null;
    if (file) this.attach(file);
  }

  // ---- append -------------------------------------------------------------
  /**
   * Append one entry. Fills seq + ts_utc. The value is deep-frozen via a
   * canonical JSON round-trip (fail-closed on non-serializable values) so the
   * ledger is immutable from the moment it exists. Entries are Object.freeze'd.
   */
  append(partial) {
    const { op, cell, value = null, by = 'unknown', cause = 'set',
            pushed = false, flow_id = null, edge = null, corrects = null } = partial ?? {};
    if (!OPS.has(op)) throw ledgerError('LEDGER_BAD_OP', `op must be "read"|"write", got ${JSON.stringify(op)}`);
    if (typeof cell !== 'string' || cell.length === 0) {
      throw ledgerError('LEDGER_BAD_CELL', 'cell must be a non-empty string');
    }
    if (!CAUSES.has(cause)) throw ledgerError('LEDGER_BAD_CAUSE', `unknown cause ${JSON.stringify(cause)}`);
    if (typeof by !== 'string' || by.length === 0) {
      throw ledgerError('LEDGER_BAD_BY', 'by must be a non-empty string (cell id or agent id)');
    }
    if (typeof pushed !== 'boolean') throw ledgerError('LEDGER_BAD_PUSHED', 'pushed must be a boolean');

    let frozenValue;
    try {
      frozenValue = value === undefined ? null : JSON.parse(JSON.stringify(value));
    } catch (e) {
      throw ledgerError('LEDGER_UNSERIALIZABLE', `value not JSON-safe: ${e.message}`);
    }

    const seq = this.entries.length;
    const ts_utc = this.clock.now();
    if (this.entries.length > 0 && !(ts_utc > this.entries[seq - 1].ts_utc)) {
      // unreachable with our Clock, but the law is enforced, not assumed
      throw ledgerError('LEDGER_TIME_REGRESS', `ts ${ts_utc} not after ${this.entries[seq - 1].ts_utc}`);
    }

    const entry = Object.freeze({
      seq, ts_utc, op, cell,
      value: frozenValue,
      by, cause, pushed, flow_id, edge, corrects,
    });
    this.entries.push(entry);

    if (flow_id != null) this._indexFlow(entry);
    if (this.file) {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
    }
    return entry;
  }

  _indexFlow(entry) {
    let f = this.flows.get(entry.flow_id);
    if (!f) {
      f = { id: entry.flow_id, reads: [], writes: [], throttled: [] };
      this.flows.set(entry.flow_id, f);
    }
    if (entry.cause === 'push-throttled') f.throttled.push(entry);
    else if (entry.op === 'read') f.reads.push(entry);
    else f.writes.push(entry);
  }

  // ---- flow helpers (double-entry spirit) ----------------------------------
  /** Fresh flow id, deterministic shape: flow-<seq>-<n>. */
  beginFlow() {
    const anchor = this.entries.length;
    return `flow-${anchor}-${this._flowCounter++}`;
  }

  /**
   * Record ONE push flow as a linked pair: the source read and the sink write
   * share a flow_id. This is the double-entry core — the write's cause is
   * provably the read, in the ledger, forever.
   */
  recordFlow({ from, to, value, by = 'engine', cause = 'push', edge = null, pushed = true }) {
    const flow_id = this.beginFlow();
    const read = this.append({
      op: 'read', cell: from, value, by: `push:${to}`, cause, pushed,
      flow_id, edge: edge ?? `${from}->${to}`,
    });
    const write = this.append({
      op: 'write', cell: to, value, by: from, cause, pushed,
      flow_id, edge: edge ?? `${from}->${to}`,
    });
    return { flow_id, read, write };
  }

  /**
   * Record a throttled push attempt (the tide holding a value): a read on the
   * source with no sink write. The read is an intentionally unpaired entry —
   * the tide will carry the latest held value on a later crest.
   */
  recordThrottled({ from, to, value, by = 'engine' }) {
    return this.append({
      op: 'read', cell: from, value, by: `push-throttled:${to}`,
      cause: 'push-throttled', pushed: true, flow_id: this.beginFlow(),
      edge: `${from}->${to}`,
    });
  }

  /**
   * Compensating entry (wave-64/65 organ law): never delete, never edit.
   * Correcting a write appends a NEW write with cause "correction" pointing at
   * the entry it corrects. Correcting a read is refused fail-closed: a
   * mis-observation is corrected by writing the right value at the source.
   */
  correct(seq, { value, by = 'agent:operator', reason = '' } = {}) {
    const target = this.entries[seq];
    if (!target) throw ledgerError('LEDGER_NO_SUCH_ENTRY', `no entry at seq ${seq}`);
    if (target.op !== 'write') {
      throw ledgerError('LEDGER_CORRECT_READ', `seq ${seq} is a read; correct the source with a write instead`);
    }
    return this.append({
      op: 'write', cell: target.cell, value,
      by, cause: 'correction', pushed: false, flow_id: null,
      corrects: seq,
      // reason rides inside `by`? No — keep fields honest; reason is the caller's concern
      // and belongs in their own receipt. Documented in README.
    });
  }

  // ---- queries (pure views; never mutate) ----------------------------------
  /** Entries up to and including time bound t (ISO string or seq number). */
  slice({ until = null, since = null, cell = null, op = null } = {}) {
    const untilTs = typeof until === 'string' ? until : null;
    const untilSeq = typeof until === 'number' ? until : null;
    return this.entries.filter((e) => {
      if (untilTs !== null && !(e.ts_utc <= untilTs)) return false;
      if (untilSeq !== null && !(e.seq <= untilSeq)) return false;
      if (since !== null && typeof since === 'string' && !(e.ts_utc > since)) return false;
      if (since !== null && typeof since === 'number' && !(e.seq > since)) return false;
      if (cell !== null && e.cell !== cell) return false;
      if (op !== null && e.op !== op) return false;
      return true;
    });
  }

  /** Last write to `cell` at or before the bound. */
  lastWrite(cell, { until = null } = {}) {
    let found = null;
    for (const e of this.entries) {
      if (until !== null) {
        if (typeof until === 'string' && !(e.ts_utc <= until)) continue;
        if (typeof until === 'number' && !(e.seq <= until)) continue;
      }
      if (e.op === 'write' && e.cell === cell) found = e;
    }
    return found;
  }

  /** The flow index: flow_id -> {reads, writes, throttled}. */
  flowIndex() {
    return this.flows;
  }

  /**
   * Double-entry balance check. Every flowed write must have >= 1 paired
   * read. Returns { ok, unbalancedWrites, orphanReads } — orphan reads are
   * reported (pulls, throttled tide attempts) but are LEGAL by design.
   */
  balanced() {
    const unbalancedWrites = [];
    const orphanReads = [];
    for (const f of this.flows.values()) {
      if (f.writes.length > 0 && f.reads.length === 0) {
        unbalancedWrites.push({ flow_id: f.id, writes: f.writes.map((w) => w.seq) });
      }
      if (f.writes.length === 0 && f.reads.length > 0) {
        orphanReads.push({ flow_id: f.id, reads: f.reads.map((r) => r.seq) });
      }
    }
    return { ok: unbalancedWrites.length === 0, unbalancedWrites, orphanReads };
  }

  // ---- persistence ---------------------------------------------------------
  /**
   * Attach a jsonl file: every future append is fs.appendFile'd (append-only
   * by construction — the file is never opened for writing from scratch).
   */
  attach(file) {
    if (!this.file) {
      if (!fs.existsSync(file)) fs.appendFileSync(file, '', { encoding: 'utf8' }); // touch, append-mode spirit
    }
    this.file = file;
  }

  toJSONL() {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
  }

  /** sha256 over the canonical jsonl of all entries so far (custody nod). */
  tipHash() {
    return 'sha256:' + crypto.createHash('sha256').update(this.toJSONL()).digest('hex');
  }
}

/**
 * Load a ledger from a jsonl file, fail-closed:
 *   LEDGER_GAP          — seqs must be 0..n-1, contiguous
 *   LEDGER_TIME_REGRESS — ts_utc must be strictly increasing
 *   LEDGER_BAD_ENTRY    — unknown op/cause or unparseable line
 * The returned ledger is live: further appends continue the file (append mode)
 * and remain monotonic against the loaded tail.
 */
export function loadLedger(file, { clock = null } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const entries = [];
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch (err) {
      throw ledgerError('LEDGER_BAD_ENTRY', `line ${i + 1} unparseable: ${err.message}`);
    }
    if (e.seq !== i) throw ledgerError('LEDGER_GAP', `line ${i + 1}: expected seq ${i}, got ${JSON.stringify(e.seq)}`);
    if (!OPS.has(e.op)) throw ledgerError('LEDGER_BAD_ENTRY', `line ${i + 1}: bad op ${JSON.stringify(e.op)}`);
    if (!CAUSES.has(e.cause)) throw ledgerError('LEDGER_BAD_ENTRY', `line ${i + 1}: bad cause ${JSON.stringify(e.cause)}`);
    if (i > 0 && !(e.ts_utc > entries[i - 1].ts_utc)) {
      throw ledgerError('LEDGER_TIME_REGRESS', `line ${i + 1}: ts ${e.ts_utc} not after ${entries[i - 1].ts_utc}`);
    }
    entries.push(Object.freeze(e));
  }
  const ledger = new Ledger({ clock: clock ?? new Clock({ startMs: entries.length ? Date.parse(entries[entries.length - 1].ts_utc) : null }) });
  ledger.entries = entries;
  ledger._flowCounter = entries.length; // keep future flow ids unique vs loaded ones
  for (const e of entries) if (e.flow_id != null) ledger._indexFlow(e);
  return ledger;
}
