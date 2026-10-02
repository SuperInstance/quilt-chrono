// quilt-chrono — src/projection.js (lane 66-b)
//
// PROJECTIONS — views of the ledger for display and controls. A projection is
// a pure function over entries: (ledger, t1, t2) -> view. Nothing here
// mutates; nothing here needs the engine. "Readings and writings, pushes and
// pulls flow actively and elegantly and visually in whatever projection you
// need" — this file is that sentence, operationalized.
//
// Time bounds: t may be an ISO string (compare ts_utc), a number (compare
// seq), null (open end). Windows are [t1, t2] for state (inclusive replay)
// and (t1, t2] for flows/diffs (change needs a before and an after).

import crypto from 'node:crypto';
import { flowStream, rateOf, accumSeries, derivedCellId, DEADBAND_EPSILON } from './calculus.js';
import { ledgerError } from './ledger.js';

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------
export function resolveBound(ledger, t) {
  if (t === null || t === undefined) {
    const last = ledger.entries[ledger.entries.length - 1];
    return last ? { ts: last.ts_utc, seq: last.seq } : { ts: null, seq: -1 };
  }
  if (typeof t === 'number') {
    const e = ledger.entries[t];
    if (!e) throw new Error(`projection: seq ${t} out of range (ledger has ${ledger.entries.length})`);
    return { ts: e.ts_utc, seq: e.seq };
  }
  if (typeof t === 'string') {
    const at = ledger.entries.findIndex((e) => e.ts_utc === t);
    if (at === -1) {
      // an ISO instant between entries: bound at the last entry <= t
      let seq = -1;
      let ts = null;
      for (const e of ledger.entries) {
        if (e.ts_utc <= t) { seq = e.seq; ts = e.ts_utc; }
      }
      return { ts, seq }; // ts === null means "before the first entry" (-infinity)
    }
    return { ts: ledger.entries[at].ts_utc, seq: ledger.entries[at].seq };
  }
  if (typeof t === 'object' && (t.ts !== undefined || t.seq !== undefined)) {
    return resolveBound(ledger, t.ts !== undefined ? t.ts : t.seq);
  }
  throw new Error(`projection: cannot resolve time bound ${JSON.stringify(t)}`);
}

/** e is at or before the bound (replay inclusion). ts null = before everything. */
const atOrBefore = (e, bound) => bound.ts !== null && e.ts_utc <= bound.ts;
/** e is strictly after the bound (window opening). ts null = everything is. */
const afterBound = (e, bound) => bound.ts === null || e.ts_utc > bound.ts;

/**
 * Window bounds (t1, t2]. A null t1 means "the beginning" (nothing excluded);
 * a null t2 means "now" (the ledger tip). stateAt keeps its own null = now.
 */
function windowBounds(ledger, t1, t2) {
  const start = t1 === null || t1 === undefined ? { ts: null, seq: -1 } : resolveBound(ledger, t1);
  const end = resolveBound(ledger, t2);
  return { start, end };
}

// ---------------------------------------------------------------------------
// stateAt — the sheet as it existed at time t (replay entries <= t)
// ---------------------------------------------------------------------------
export function stateAt(ledger, t = null) {
  const bound = resolveBound(ledger, t);
  const cells = {};
  let writes = 0;
  let reads = 0;
  let corrections = 0;
  for (const e of ledger.entries) {
    if (!atOrBefore(e, bound)) break; // entries are ts-ordered by law
    if (e.op === 'read') { reads += 1; continue; }
    writes += 1;
    if (e.cause === 'correction') corrections += 1;
    cells[e.cell] = e.value; // last write wins; corrections naturally override
  }
  return { asOf: bound, cells, writes, reads, corrections };
}

// ---------------------------------------------------------------------------
// diff — per-cell change list between two times
// ---------------------------------------------------------------------------
export function diff(ledger, t1, t2) {
  const a = t1 === null || t1 === undefined
    ? { asOf: { ts: null, seq: -1 }, cells: {}, writes: 0, reads: 0, corrections: 0 }
    : stateAt(ledger, t1);
  const b = stateAt(ledger, t2);
  const ids = new Set([...Object.keys(a.cells), ...Object.keys(b.cells)]);
  const counts = {};
  for (const e of ledger.entries) {
    if (!afterBound(e, a.asOf) || !atOrBefore(e, b.asOf) || e.op !== 'write') continue;
    counts[e.cell] = (counts[e.cell] ?? 0) + 1;
  }
  const changes = [];
  let unchanged = 0;
  for (const id of [...ids].sort()) {
    const from = a.cells[id] === undefined ? null : a.cells[id];
    const to = b.cells[id] === undefined ? null : b.cells[id];
    const changed = JSON.stringify(from) !== JSON.stringify(to);
    if (changed) changes.push({ cell: id, from, to, writes: counts[id] ?? 0 });
    else unchanged += 1;
  }
  return { t1: a.asOf, t2: b.asOf, changes, unchanged, cells: ids.size };
}

// ---------------------------------------------------------------------------
// flowMap — edges {from, to, count, volume} between cells over (t1, t2]
//
// count  = number of flow receipts observed on that edge (an evaluate flow
//          with n deps contributes to each dep's edge — the causal fan-out)
// volume = sum of |numeric written values| on that edge (non-numeric adds 0)
// throttled = number of tide-held attempts journaled on that edge
// ---------------------------------------------------------------------------
export function flowMap(ledger, t1, t2) {
  const { start, end } = windowBounds(ledger, t1, t2);
  const edges = new Map();
  let flows = 0, reads = 0, writes = 0, throttled = 0;
  const bump = (from, to, volume) => {
    const key = `${from}->${to}`;
    let e = edges.get(key);
    if (!e) { e = { from, to, count: 0, volume: 0, throttled: 0 }; edges.set(key, e); }
    e.count += 1;
    e.volume += Math.abs(typeof volume === 'number' && Number.isFinite(volume) ? volume : 0);
  };
  for (const e of ledger.entries) {
    if (!afterBound(e, start) || !atOrBefore(e, end)) continue;
    if (e.cause === 'push-throttled') { throttled += 1; const [f, to] = splitEdge(e.edge); if (f) { const k = `${f}->${to}`; const ed = edges.get(k) ?? { from: f, to, count: 0, volume: 0, throttled: 0 }; ed.throttled += 1; edges.set(k, ed); } continue; }
    if (e.op === 'read') { reads += 1; continue; }
    writes += 1;
    if (e.flow_id == null) continue; // direct set/init: no edge, honest
    const f = ledger.flowIndex().get(e.flow_id);
    if (!f || f.reads.length === 0) continue; // unbalanced flow would be a ledger bug; balanced() catches it
    flows += 1;
    for (const r of f.reads) bump(r.cell, e.cell, e.value);
  }
  return {
    t1: start, t2: end, reads, writes, flows, throttled,
    edges: [...edges.values()].sort((x, y) => y.count - x.count || x.from.localeCompare(y.from)),
  };
}

function splitEdge(edge) {
  if (typeof edge !== 'string') return [null, null];
  const i = edge.indexOf('->');
  if (i === -1) return [null, null];
  return [edge.slice(0, i), edge.slice(i + 2)];
}

// ---------------------------------------------------------------------------
// renderSVG — the quilt with a playhead: cells as lanes on a time axis,
// writes as marks, reads as ticks, pushes as arcs from source to sink lane.
// Self-contained, zero dependencies, all dynamic text escaped.
// ---------------------------------------------------------------------------
const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const hueOf = (id) => {
  const h = crypto.createHash('sha256').update(String(id)).digest();
  return h[0] % 360;
};

export function renderSVG(ledger, t1, t2, opts = {}) {
  const { start, end } = windowBounds(ledger, t1, t2);
  const {
    width = 980, rowH = 34, padL = 168, padR = 28, padT = 78, padB = 46,
    title = 'quilt-chrono — flow projection', maxArcs = 600,
    overlay = null,          // { cell, mode: 'rate'|'accum', window, deadband, unit, scale }
    renderedAt = null,       // pin for byte-deterministic double runs (tests, receipts)
  } = opts;
  const at = renderedAt ?? new Date().toISOString();

  // window entries (t1, t2]
  const win = ledger.entries.filter((e) => afterBound(e, start) && atOrBefore(e, end));
  // lanes: cells ordered by first activity in the window, then any others
  const laneOrder = [];
  const laneSeen = new Set();
  for (const e of win) {
    if (!laneSeen.has(e.cell)) { laneSeen.add(e.cell); laneOrder.push(e.cell); }
  }
  for (const e of ledger.entries) {
    if (!laneSeen.has(e.cell)) { laneSeen.add(e.cell); laneOrder.push(e.cell); }
  }
  const laneY = new Map(laneOrder.map((id, i) => [id, padT + i * rowH + rowH / 2]));

  const t1ms = start.ts ? Date.parse(start.ts) : 0;
  const t2ms = end.ts ? Date.parse(end.ts) : 1;
  const innerW = width - padL - padR;
  const span = Math.max(1, t2ms - t1ms);
  const x = (ts) => padL + ((Date.parse(ts) - t1ms) / span) * innerW;

  const height = padT + laneOrder.length * rowH + padB;

  // arcs from actual push/evaluate flows: pair reads -> writes by flow_id
  const arcs = [];
  const throttleMarks = [];
  const writeMarks = [];
  const readTicks = [];
  const seenFlowWrite = new Set();
  for (const e of win) {
    if (e.cause === 'push-throttled') { throttleMarks.push(e); continue; }
    if (e.op === 'read') { readTicks.push(e); continue; }
    writeMarks.push(e);
    if (e.flow_id == null || seenFlowWrite.has(e.flow_id)) continue;
    seenFlowWrite.add(e.flow_id);
    const f = ledger.flowIndex().get(e.flow_id);
    if (!f) continue;
    for (const r of f.reads) {
      if (laneY.has(r.cell) && laneY.has(e.cell) && r.cell !== e.cell) {
        arcs.push({ from: r.cell, to: e.cell, x: x(e.ts_utc), hue: hueOf(r.cell) });
      }
    }
  }
  const arcNote = arcs.length > maxArcs ? ` (showing first ${maxArcs} of ${arcs.length})` : '';

  // calculus overlay (lane 72-c): the derived series drawn ON the source
  // cell's lane — the derivative/integral as a projection, visually. The
  // derived values are computed by src/calculus.js over the same window,
  // normalized into the lane band; nonzero rate readings carry flag diamonds.
  const overlayParts = [];
  let overlayNote = '';
  if (overlay) {
    const { cell, mode = 'rate', window: ovWindow = 2, deadband = DEADBAND_EPSILON, unit = 'seq', scale = 1 } = overlay;
    if (mode !== 'rate' && mode !== 'accum') {
      throw ledgerError('CALCULUS_BAD_OP', `renderSVG overlay: mode ${JSON.stringify(mode)} not registered (rate | accum)`);
    }
    const stream = flowStream(ledger, cell, { unit, scale }); // CALCULUS_NO_SUCH_FLOW on a typo'd cell
    const inWin = stream.filter((s) => afterBound({ ts_utc: s.ts }, start) && atOrBefore({ ts_utc: s.ts }, end));
    if (inWin.length === 0) {
      throw ledgerError('CALCULUS_NO_FLOW_DATA', `renderSVG overlay: cell ${JSON.stringify(cell)} carries no numeric flow in the window`);
    }
    const derived = mode === 'rate'
      ? rateOf(inWin, { window: ovWindow, deadband })
      : accumSeries(inWin, { mode: overlay.accMode ?? 'level' });
    const pts = derived.filter((r) => r.value !== null && Number.isFinite(r.value)).map((r) => ({ x: x(r.ts), v: r.value }));
    if (pts.length === 0) {
      throw ledgerError('CALCULUS_NO_FLOW_DATA', `renderSVG overlay: ${mode}(${cell}) produced no readings in the window`);
    }
    if (!laneY.has(cell)) {
      throw ledgerError('CALCULUS_NO_FLOW_DATA', `renderSVG overlay: cell ${JSON.stringify(cell)} has no lane in the window`);
    }
    const vals = pts.map((p) => p.v);
    if (mode === 'rate') vals.push(0); // the zero line is meaningful for a derivative
    const vmin = Math.min(...vals), vmax = Math.max(...vals);
    const yTop = laneY.get(cell) - rowH / 2;
    const padPx = rowH * 0.16;
    const yOf = (v) => (vmin === vmax)
      ? yTop + rowH / 2
      : yTop + padPx + (1 - (v - vmin) / (vmax - vmin)) * (rowH - 2 * padPx);
    const color = mode === 'accum' ? '#7ee787' : '#ffa657';
    const poly = pts.map((p) => `${p.x.toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
    overlayParts.push(`<polyline class="overlay" points="${poly}" fill="none" stroke="${color}" stroke-width="1.4" stroke-opacity="0.9"/>`);
    if (mode === 'rate') {
      for (const p of pts) {
        if (p.v === 0) continue; // flags: readings that moved (the ε law's nonzero set)
        const y = yOf(p.v);
        overlayParts.push(`<rect class="flag" x="${(p.x - 2.4).toFixed(1)}" y="${(y - 2.4).toFixed(1)}" width="4.8" height="4.8" fill="${color}" fill-opacity="0.95" transform="rotate(45 ${p.x.toFixed(1)} ${y.toFixed(1)})"/>`);
      }
    }
    const id = mode === 'rate'
      ? derivedCellId(cell, 'rate', { window: ovWindow })
      : derivedCellId(cell, 'accum', { mode: overlay.accMode ?? 'level' });
    overlayNote = ` \u00b7 overlay: ${esc(id)}${mode === 'rate' ? ` &#949;=${deadband}` : ''}`; // entity, like the rest of the legend
  }

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, Menlo, monospace">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#0d1117"/>`);
  // header
  const wCount = writeMarks.length, rCount = readTicks.length, tCount = throttleMarks.length;
  parts.push(`<text x="${padL}" y="30" fill="#e6edf3" font-size="15" font-weight="bold">${esc(title)}</text>`);
  parts.push(`<text x="${padL}" y="50" fill="#8b949e" font-size="11">${esc(start.ts ?? 'begin')} &#8594; ${esc(end.ts ?? 'end')} &#183; lanes: ${laneOrder.length} &#183; writes: ${wCount} &#183; reads: ${rCount} &#183; tide-held: ${tCount} &#183; arcs: ${arcs.length}${esc(arcNote)}</text>`);
  parts.push(`<text x="${padL}" y="66" fill="#6e7681" font-size="10">legend: write = &#9679; &#183; read = tick &#183; tide-held = &#9697; &#183; push/evaluate flow = arc (read lane &#8594; write lane)${overlayNote}</text>`);
  // time gridlines (8 divisions)
  for (let i = 0; i <= 8; i++) {
    const gx = padL + (innerW * i) / 8;
    parts.push(`<line x1="${gx.toFixed(1)}" y1="${padT - 6}" x2="${gx.toFixed(1)}" y2="${height - padB + 8}" stroke="#21262d" stroke-width="1"/>`);
  }
  // lanes
  laneOrder.forEach((id, i) => {
    const y = padT + i * rowH;
    const hue = hueOf(id);
    parts.push(`<rect x="0" y="${y}" width="${width}" height="${rowH}" fill="${i % 2 ? '#161b22' : '#11161d'}"/>`);
    parts.push(`<line x1="${padL}" y1="${(y + rowH).toFixed(1)}" x2="${width - padR}" y2="${(y + rowH).toFixed(1)}" stroke="#21262d" stroke-width="1"/>`);
    parts.push(`<text x="12" y="${(y + rowH / 2 + 4).toFixed(1)}" fill="hsl(${hue},70%,72%)" font-size="11">${esc(id)}</text>`);
  });
  // arcs (below marks so marks stay visible)
  for (const a of arcs.slice(0, maxArcs)) {
    const y1 = laneY.get(a.from), y2 = laneY.get(a.to);
    const cy = Math.min(y1, y2) - 12; // control point above the chord: the arc leaps
    parts.push(`<path class="arc" d="M ${a.x.toFixed(1)} ${y1.toFixed(1)} Q ${a.x.toFixed(1)} ${cy.toFixed(1)} ${a.x.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="hsl(${a.hue},80%,62%)" stroke-opacity="0.34" stroke-width="1.1"><title>${esc(`${a.from} -&gt; ${a.to}`)}</title></path>`);
  }
  // calculus overlay (under the marks: marks are the ground truth, the
  // derivative is the view)
  for (const opart of overlayParts) parts.push(opart);
  // read ticks
  for (const r of readTicks) {
    const y = laneY.get(r.cell);
    parts.push(`<line x1="${x(r.ts_utc).toFixed(1)}" y1="${(y - 4).toFixed(1)}" x2="${x(r.ts_utc).toFixed(1)}" y2="${(y + 4).toFixed(1)}" stroke="#58a6ff" stroke-opacity="0.5" stroke-width="1"/>`);
  }
  // throttle marks (hollow down-triangles on the source lane)
  for (const t of throttleMarks) {
    const y = laneY.get(t.cell);
    const tx = x(t.ts_utc).toFixed(1);
    parts.push(`<path d="M ${tx} ${(y - 3.5).toFixed(1)} L ${(Number(tx) - 3).toFixed(1)} ${(y + 3.5).toFixed(1)} L ${(Number(tx) + 3).toFixed(1)} ${(y + 3.5).toFixed(1)} Z" fill="none" stroke="#d29922" stroke-opacity="0.8" stroke-width="1"/>`);
  }
  // write marks
  for (const w of writeMarks) {
    const y = laneY.get(w.cell);
    const hue = hueOf(w.cell);
    const fill = w.cause === 'correction' ? '#f85149' : `hsl(${hue},75%,62%)`;
    parts.push(`<circle class="wr" cx="${x(w.ts_utc).toFixed(1)}" cy="${y.toFixed(1)}" r="${w.cause === 'correction' ? 4.6 : 3.1}" fill="${fill}" fill-opacity="0.92"><title>${esc(`${w.seq} ${w.cell} = ${JSON.stringify(w.value)} (${w.cause})`)}</title></circle>`);
  }
  parts.push(`<text x="12" y="${height - 14}" fill="#6e7681" font-size="10">${esc(`quilt.chrono.entry/v1 &#183; ledger tip seq ${ledger.entries.length - 1} &#183; rendered from the actual ledger, ${at}`)}</text>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// renderTable — markdown projection of the same window
// ---------------------------------------------------------------------------
export function renderTable(ledger, t1, t2, opts = {}) {
  const { title = 'quilt-chrono projection' } = opts;
  const fm = flowMap(ledger, t1, t2);
  const st2 = stateAt(ledger, t2);
  const firstLast = {};
  for (const e of ledger.entries) {
    if (!afterBound(e, fm.t1) || !atOrBefore(e, fm.t2)) continue;
    firstLast[e.cell] = firstLast[e.cell] ?? { first: e.ts_utc, last: e.ts_utc, w: 0, r: 0 };
    firstLast[e.cell].last = e.ts_utc;
    if (e.op === 'write') firstLast[e.cell].w += 1; else firstLast[e.cell].r += 1;
  }
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`window: \`${fm.t1.ts ?? 'begin'}\` → \`${fm.t2.ts ?? 'end'}\` · flows: ${fm.flows} · writes: ${fm.writes} · reads: ${fm.reads} · tide-held: ${fm.throttled}`);
  lines.push('');
  lines.push('## Cell activity');
  lines.push('');
  lines.push('| cell | writes | reads | first activity | last activity | value at t2 |');
  lines.push('|------|-------:|------:|----------------|---------------|-------------|');
  for (const id of Object.keys(firstLast).sort()) {
    const a = firstLast[id];
    lines.push(`| ${id} | ${a.w} | ${a.r} | ${a.first} | ${a.last} | \`${JSON.stringify(st2.cells[id] ?? null)}\` |`);
  }
  lines.push('');
  lines.push('## Flow edges (pushes and evaluate flows)');
  lines.push('');
  lines.push('| from | to | count | volume (&#124;v&#124;) | tide-held |');
  lines.push('|------|----|------:|-------:|----------:|');
  for (const e of fm.edges) {
    lines.push(`| ${e.from} | ${e.to} | ${e.count} | ${Number(e.volume.toFixed ? e.volume.toFixed(3) : e.volume)} | ${e.throttled} |`);
  }
  lines.push('');
  return lines.join('\n');
}
