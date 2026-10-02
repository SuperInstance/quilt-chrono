// quilt-chrono — src/flow.js (lane 66-b)
//
// THE CHRONO ENGINE — a tiny reactive cell core where time is a dimension.
//
// Design stance (see DESIGN.md §2, "the arena decision"): this engine was
// written fresh rather than vendoring @quilt/core (quilt-arena's engine) because
// chrono needs the core to be BORN JOURNALED — every read and write must hit
// the time ledger at the exact moment it happens, with flow receipts and tide
// throttling that the arena core has no hooks for. The philosophy is kept
// compatible: pull-reactive, dirty-marking, declared dependencies, dependents
// graph — so a later lane can swap cores without changing the ledger algebra.
//
// Cell kinds:
//   value    — a stateful sink; written by push flows, `set`, corrections
//   formula  — pure fn over declared deps; evaluated lazily on pull when dirty
//   ai       — like formula, but the fn is an async backend (a soft-joint in
//              miniature); every input read and result write is journaled
//
// Flow algebra:
//   write(c, v)      -> 1 "writing" entry, dependents dirty-marked, push edges
//                        from c fire (tide-aware)
//   pull(c)          -> 1 "reading" entry (+ an evaluate-flow if c was dirty:
//                        n dep reads linked to 1 result write by one flow_id)
//   push(a, b, ...)  -> registers a persistent push EDGE; every propagation is
//                        one flow receipt: source read + sink write, same
//                        flow_id, double-entry linked
//   tide             -> push edges may declare minIntervalMs; propagation
//                        attempted inside the interval is HELD (a throttled
//                        read is journaled, no write) and the LATEST value
//                        rides the next crest — time-throttled propagation.

import { Ledger, Clock, ledgerError } from './ledger.js';

const equal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class Chrono {
  constructor({ name = 'sheet', ledger = null, clock = null } = {}) {
    this.name = name;
    this.ledger = ledger ?? new Ledger({ name, clock: clock ?? new Clock() });
    this.clock = this.ledger.clock;
    this.cells = new Map();      // id -> { id, kind, value, dirty, deps, fn, ... }
    this.dependents = new Map(); // id -> Set(formula/ai ids that declare it)
    this.edges = [];             // push edges: { from, to, transform, minIntervalMs, by, lastFireMs, held }
  }

  // ---- cell definition ------------------------------------------------------
  define(id, def = {}) {
    if (this.cells.has(id)) throw ledgerError('CELL_REDEFINED', `cell ${id} already defined`);
    const kind = def.kind ?? 'value';
    if (!['value', 'formula', 'ai'].includes(kind)) {
      throw ledgerError('CELL_BAD_KIND', `cell ${id}: unknown kind ${JSON.stringify(kind)}`);
    }
    const cell = {
      id, kind,
      value: kind === 'value' ? (def.value ?? null) : null,
      dirty: kind !== 'value',
      deps: [], fn: def.fn ?? null, prompt: def.prompt ?? null,
      backend: def.backend ?? null, minIntervalMs: def.minIntervalMs ?? 0, lastEvalMs: null,
    };
    if (kind === 'formula' || kind === 'ai') {
      cell.deps = [...(def.deps ?? [])];
      if (cell.deps.length === 0) throw ledgerError('CELL_NO_DEPS', `cell ${id}: formula/ai cells declare deps`);
      if (typeof cell.fn !== 'function' && kind === 'formula') {
        throw ledgerError('CELL_NO_FN', `cell ${id}: formula cells need fn`);
      }
      if (typeof cell.backend !== 'function' && kind === 'ai') {
        throw ledgerError('CELL_NO_BACKEND', `cell ${id}: ai cells need backend (async)`);
      }
      for (const dep of cell.deps) {
        if (dep === id) throw ledgerError('CELL_SELF_DEP', `cell ${id} depends on itself`);
        if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
        this.dependents.get(dep).add(id);
      }
    }
    this.cells.set(id, cell);
    this._checkAcyclicFormulas(id);
    if (kind === 'value' && def.value !== undefined) {
      // the genesis write is journaled like any other (cause "init")
      this.ledger.append({ op: 'write', cell: id, value: def.value, by: 'engine:init', cause: 'init', pushed: false, flow_id: null });
    }
    return cell;
  }

  value(id, initial) { return this.define(id, { kind: 'value', value: initial }); }
  formula(id, deps, fn) { return this.define(id, { kind: 'formula', deps, fn }); }
  ai(id, def) { return this.define(id, { ...def, kind: 'ai' }); }

  /** Formula dependency cycles would hang pull; reject at definition time. */
  _checkAcyclicFormulas(startId) {
    const seen = new Set();
    const walk = (id) => {
      if (id === startId && seen.size > 0) {
        throw ledgerError('CELL_DEP_CYCLE', `formula cycle through ${startId}`);
      }
      if (seen.has(id)) return;
      seen.add(id);
      const c = this.cells.get(id);
      for (const d of c?.deps ?? []) walk(d);
    };
    for (const d of this.cells.get(startId).deps) walk(d);
  }

  // ---- the universal API: write / pull / push --------------------------------
  /**
   * Direct write (the agent moves the sheet). Journals one "writing", dirty-
   * marks formula dependents, and fires push edges leaving this cell.
   */
  write(cell, value, { by = 'agent:anon', cause = 'set' } = {}) {
    const c = this._must(cell);
    if (c.kind !== 'value') throw ledgerError('WRITE_NOT_SINK', `${cell} is a ${c.kind}; write sinks, pull formulas`);
    this._writeValue(c, value, { by, cause });
    return value;
  }

  _writeValue(cell, value, { by, cause }) {
    cell.value = value;
    cell.dirty = false;
    this.ledger.append({ op: 'write', cell: cell.id, value, by, cause, pushed: false, flow_id: null });
    this._dirtyDependents(cell.id);
    this._fireEdgesFrom(cell.id, { by });
  }

  _dirtyDependents(id) {
    const stack = [...(this.dependents.get(id) ?? [])];
    while (stack.length) {
      const dep = stack.pop();
      const c = this.cells.get(dep);
      if (!c || c.dirty) continue;
      c.dirty = true;
      for (const next of this.dependents.get(dep) ?? []) stack.push(next);
    }
  }

  /**
   * Pull a reading. Journals one "reading" entry; if the cell is a dirty
   * formula/ai it evaluates first — the evaluation is ONE flow: n dependency
   * reads linked (same flow_id) to the 1 result write when the value changes.
   * Returns a promise for ai cells, the value otherwise.
   */
  pull(cell, { by = 'agent:anon', cause = 'pull' } = {}) {
    const c = this._must(cell);
    if (c.kind === 'value') {
      this.ledger.append({ op: 'read', cell, value: c.value, by, cause, pushed: false, flow_id: null });
      return c.value;
    }
    this.ledger.append({ op: 'read', cell, value: null, by, cause, pushed: false, flow_id: null }); // the request
    if (!c.dirty) {
      return c.kind === 'ai' ? Promise.resolve(c.value) : c.value;
    }
    return this._evaluate(c, { by });
  }

  read(cell, opts) { return this.pull(cell, opts); } // alias: readings and writings, one vocabulary

  /**
   * Correct history the organ way: the ledger appends a compensating entry
   * (never deletes), and the LIVE core is brought forward — the corrected
   * cell takes the new value, dependents are dirty-marked, push edges fire.
   * The ripple is journaled like any other propagation.
   */
  correct(seq, value, { by = 'agent:operator' } = {}) {
    const entry = this.ledger.correct(seq, { value, by });
    const c = this._must(entry.cell);
    if (c.kind === 'value') {
      c.value = value;
      c.dirty = false;
      this._dirtyDependents(c.id);
      this._fireEdgesFrom(c.id, { by });
    } else {
      c.dirty = true; // corrected formula record re-evaluates on next pull
    }
    return entry;
  }

  _evaluate(c, { by }) {
    const flow_id = this.ledger.beginFlow();
    const depValues = c.deps.map((d) => {
      const dv = this._must(d);
      if (dv.kind === 'formula' && dv.dirty) {
        // dependency ordering handled here: a dirty formula dep evaluates
        // first, with its OWN evaluate-flow (causally nested, honestly linked)
        this._evaluate(dv, { by });
      } else if (dv.kind === 'ai' && dv.dirty) {
        throw ledgerError('CELL_DEP_UNEVALUATED', `cell ${c.id}: ai dep ${d} is dirty; pull ${d} first (ai evaluation is async)`);
      }
      const v = dv.value;
      this.ledger.append({
        op: 'read', cell: d, value: v, by: c.id, cause: 'evaluate',
        pushed: false, flow_id, edge: `${d}->${c.id}`,
      });
      return v;
    });
    const finish = (result, changed) => {
      if (changed) {
        c.value = result;
        c.dirty = false;
        c.lastEvalMs = this.clock.nowMs();
        this.ledger.append({
          op: 'write', cell: c.id, value: result, by, cause: 'evaluate',
          pushed: false, flow_id, edge: c.deps.map((d) => d).join('+') + `->${c.id}`,
        });
        this._dirtyDependents(c.id);
        this._fireEdgesFrom(c.id, { by });
      } else {
        c.dirty = false; // unchanged evaluation: dep reads stay honestly unpaired
      }
      return result;
    };
    if (c.kind === 'formula') {
      let out;
      try {
        out = c.fn(...depValues);
      } catch (err) {
        throw ledgerError('EVALUATE_FAILED', `cell ${c.id}: ${err.message}`);
      }
      return finish(out, !equal(out, c.value));
    }
    // ai cell — async backend, journaled exactly like a formula evaluation
    return Promise.resolve()
      .then(() => c.backend({ cell: c.id, deps: c.deps, values: depValues, prompt: c.prompt }))
      .then((out) => finish(out, !equal(out, c.value)));
  }

  /**
   * Declare a persistent push edge. Every propagation over it is one flow
   * receipt (source read + sink write, same flow_id). Bounded-rate edges are
   * the tide: propagation inside the interval is held and the latest value
   * rides the next crest. Fires once immediately if the source holds a value.
   */
  push(from, to, { transform = (v) => v, minIntervalMs = 0, by = 'engine:wire', fire = true } = {}) {
    const f = this._must(from);
    const t = this._must(to);
    if (t.kind !== 'value') throw ledgerError('PUSH_TARGET_NOT_SINK', `${to} is a ${t.kind}; pushes write value sinks`);
    if (from === to) throw ledgerError('PUSH_CYCLE', `push edge ${from}->${to} is a cycle`);
    const edge = { from, to, transform, minIntervalMs, by, lastFireMs: null, held: undefined };
    this._checkEdgeAcyclic(edge);
    this.edges.push(edge);
    if (fire && f.kind === 'value' && f.value !== null) this._fireEdge(edge, { by });
    return edge;
  }

  _checkEdgeAcyclic(newEdge) {
    // walk downstream from the target; reaching the source again = cycle
    const stack = [newEdge.to];
    while (stack.length) {
      const id = stack.pop();
      if (id === newEdge.from) throw ledgerError('PUSH_CYCLE', `push edge ${newEdge.from}->${newEdge.to} closes a cycle`);
      for (const e of this.edges) if (e.from === id) stack.push(e.to);
    }
  }

  _fireEdgesFrom(id, { by }) {
    for (const e of this.edges) {
      if (e.from === id) this._fireEdge(e, { by });
    }
  }

  _fireEdge(edge, { by, force = false }) {
    const src = this._must(edge.from);
    const nowMs = this.clock.nowMs();
    if (!force && edge.minIntervalMs > 0 && edge.lastFireMs !== null && nowMs - edge.lastFireMs < edge.minIntervalMs) {
      edge.held = src.value; // the tide holds the LATEST value
      this.ledger.recordThrottled({ from: edge.from, to: edge.to, value: src.value, by: edge.by });
      return null;
    }
    edge.lastFireMs = nowMs;
    edge.held = undefined;
    const out = edge.transform(src.value);
    const { write } = this.ledger.recordFlow({
      from: edge.from, to: edge.to, value: out,
      by: edge.by, cause: force ? 'tide-flush' : 'push',
      edge: `${edge.from}->${edge.to}`,
    });
    const sink = this._must(edge.to);
    sink.value = write.value;
    sink.dirty = false;
    this._dirtyDependents(sink.id);
    this._fireEdgesFrom(sink.id, { by }); // cascades
    return write;
  }

  /**
   * The tide crest: flush every held edge value that is old enough (or all of
   * them with force). Returns the writes that landed.
   */
  flushTide({ by = 'engine:tide', force = false } = {}) {
    const landed = [];
    for (const e of this.edges) {
      if (e.held === undefined) continue;
      const nowMs = this.clock.nowMs();
      if (!force && e.lastFireMs !== null && nowMs - e.lastFireMs < e.minIntervalMs) continue;
      const held = e.held;
      e.held = undefined;
      e.lastFireMs = nowMs;
      const out = e.transform(held);
      const { write } = this.ledger.recordFlow({
        from: e.from, to: e.to, value: out, by, cause: 'tide-flush',
        edge: `${e.from}->${e.to}`,
      });
      const sink = this._must(e.to);
      sink.value = write.value;
      sink.dirty = false;
      this._dirtyDependents(sink.id);
      this._fireEdgesFrom(sink.id, { by }); // downstream cascade rides the crest
      landed.push(write);
    }
    return landed;
  }

  // ---- helpers ---------------------------------------------------------------
  _must(id) {
    const c = this.cells.get(id);
    if (!c) throw ledgerError('NO_SUCH_CELL', `cell ${JSON.stringify(id)} is not defined`);
    return c;
  }

  /** Advance the deterministic clock one step (simulated time). */
  tick() { return this.clock.advance(); }

  /** Live engine state (values only — a projection, see projection.js). */
  state() {
    const out = {};
    for (const [id, c] of this.cells) out[id] = c.value;
    return out;
  }
}

export { ledgerError };
