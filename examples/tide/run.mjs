// quilt-chrono — examples/tide/run.mjs (lane 66-b)
//
// THE TIDE DEMO — a small sheet lived through 40 steps of simulated time.
//
// Cells (9 lanes):
//   sensor.raw         value  — written once per step by the "world" agent
//   cal.gain           value  — calibration constant (2.0)
//   cal.offset         value  — calibration constant (1.0)
//   sensor.calibrated  formula(raw, gain, offset)
//   health             formula(calibrated)         -> "HOT" | "nominal"
//   sink.display       value  — PUSH from calibrated (unthrottled: every crest)
//   sink.alert         value  — PUSH from calibrated, minInterval 5000ms
//                               (the tide: held between crests, latest wins)
//   sink.log           value  — PUSH from raw, transform to a log line
//   voice              ai     — journals its readings/writings; local backend
//                               by default, typesafe when CHRONO_LIVE_SMOKE=1
//
// Story beats:
//   step 18 — a sensor spike (fault)
//   step 20 — the operator CORRECTS history with a compensating entry
//             (organ law: never delete; the ledger shows the ripple)
//
// Outputs -> examples/tide/outputs/ (deterministic: fixed clock + seeded noise)
//   ledger.jsonl, state-at-20.json, diff-t10-t30.json, flowmap.svg,
//   flowmap.json, table.md, run-receipt.json
//
// Live micro-smoke (budget: <=2 typesafe calls, self-imposed: exactly the
// voice pulls): CHRONO_LIVE_SMOKE=1 node run.mjs — outputs then go to
// receipts/live-smoke/ and a receipt with token usage is written. If the
// network fails the run writes an honest FAIL receipt and still finishes
// locally (the voice cell falls back to its local backend).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, Clock } from '../../src/ledger.js';
import { Chrono } from '../../src/flow.js';
import { stateAt, diff, flowMap, renderSVG, renderTable } from '../../src/projection.js';
import { snapshot } from '../../src/rewind.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS = 40;
const BASE_MS = 1790000000000; // deterministic epoch; 1000ms per simulated step

// seeded LCG — deterministic noise, no Math.random
function makeNoise(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ---- the voice cell's backends ---------------------------------------------
function localVoice({ values }) {
  const [calibrated, health] = values;
  return `reading ${calibrated} — ${health}; tide flows.`;
}

// typesafe systemone backend (ONLY used when CHRONO_LIVE_SMOKE=1; <=2 calls)
async function typesafeVoice({ values }) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY missing — live smoke fail-closed');
  const [calibrated, health] = values;
  const t0 = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { sheet: 'tide-demo', sensor_calibrated: calibrated, health },
      questions: {
        voice: {
          type: 'string',
          instructions: 'You are the greeter voice of a tide-monitoring sheet. Answer with ONE short sentence (max 12 words) stating the reading and its mood.',
        },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`systemone HTTP ${res.status}`);
    err.http = res.status;
    err.usage = body.usage ?? null;
    throw err;
  }
  typesafeVoice.calls = (typesafeVoice.calls ?? 0) + 1;
  typesafeVoice.usage = body.usage ?? null;
  typesafeVoice.latency_ms = Date.now() - t0;
  const answer = body?.answers?.voice;
  return typeof answer === 'string' ? answer : JSON.stringify(answer);
}

// ---- the sheet ---------------------------------------------------------------
export function buildSheet({ ledger = null, clock = null, live = false } = {}) {
  clock = ledger?.clock ?? clock ?? new Clock({ startMs: BASE_MS, stepMs: 1000 });
  const engine = new Chrono({ name: 'tide-demo', ledger: ledger ?? new Ledger({ name: 'tide-demo', clock }), clock });

  engine.value('sensor.raw', 60);
  engine.value('cal.gain', 2);
  engine.value('cal.offset', 1);
  engine.formula('sensor.calibrated', ['sensor.raw', 'cal.gain', 'cal.offset'],
    (raw, gain, offset) => Math.round((raw * gain + offset) * 10) / 10);
  engine.formula('health', ['sensor.calibrated'],
    (cal) => (cal > 110 ? 'HOT' : 'nominal'));
  engine.value('sink.display', null);
  engine.value('sink.alert', null);
  engine.value('sink.log', null);
  engine.ai('voice', {
    deps: ['sensor.calibrated', 'health'],
    prompt: 'one-sentence greeter voice',
    backend: live ? typesafeVoice : localVoice,
  });

  engine.push('sensor.calibrated', 'sink.display', { by: 'engine:wire' });
  engine.push('sensor.calibrated', 'sink.alert', { by: 'engine:wire', minIntervalMs: 5000 });
  engine.push('sensor.raw', 'sink.log', { by: 'engine:wire', transform: (v) => `raw=${v}` });

  return { engine, clock };
}

// ---- the run -------------------------------------------------------------------
export async function runTide({ outDir = path.join(HERE, 'outputs'), live = false, steps = STEPS } = {}) {
  // Outputs are REGENERABLE demo artifacts: each run rebuilds them from its own
  // ledger. (The Ledger class itself has no truncate/overwrite method — the
  // append-only law is structural. Only this demo-owned directory is replaced;
  // production ledgers live elsewhere and are never rewritten.)
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const ledgerFile = path.join(outDir, 'ledger.jsonl');
  const clock = new Clock({ startMs: BASE_MS, stepMs: 1000 }); // deterministic simulated time
  const ledger = new Ledger({ name: 'tide-demo', file: ledgerFile, clock });
  const { engine } = buildSheet({ ledger, live });
  const noise = makeNoise(42);
  const beat = { spikeWriteSeq: null, correctionSeq: null, voicePulls: 0, liveCalls: 0 };

  for (let step = 1; step <= steps; step++) {
    clock.advance(); // one simulated second per step

    if (step === 20 && beat.spikeWriteSeq !== null) {
      // the operator is holding the sensor: step 18's spike was a fault.
      // Correct history with a compensating entry instead of writing anew.
      const expected = Math.round((60 + 28 * Math.sin(18 / 5.5) + noise() * 4 - 0.55) * 10) / 10;
      const entry = engine.correct(beat.spikeWriteSeq, expected, { by: 'agent:operator' });
      beat.correctionSeq = entry.seq;
    } else {
      const spike = step === 18 ? 55 : 0;
      const raw = Math.round((60 + 28 * Math.sin(step / 5.5) + noise() * 4 + spike) * 100) / 100;
      engine.write('sensor.raw', raw, { by: 'agent:world', cause: 'step' });
      if (step === 18) beat.spikeWriteSeq = ledger.lastWrite('sensor.raw').seq;
    }

    engine.pull('sensor.calibrated', { by: 'agent:watcher', cause: 'pull' });
    engine.pull('health', { by: 'agent:watcher', cause: 'pull' });

    if (step === 10 || step === 25) {
      await engine.pull('voice', { by: 'agent:greeter', cause: 'pull' });
      beat.voicePulls += 1;
    }
  }

  // ---- projections over the actual ledger ------------------------------------
  const t = (step) => new Date(BASE_MS + step * 1000).toISOString();
  const state20 = stateAt(ledger, t(20));
  const d = diff(ledger, t(10), t(30));
  const fm = flowMap(ledger, t(0), null); // open end: everything the run wrote
  const svg = renderSVG(ledger, t(0), null, { title: 'tide-demo — 40 steps of the quilt with a playhead' });
  const table = renderTable(ledger, t(0), null, { title: 'tide-demo — projection table' });

  fs.writeFileSync(path.join(outDir, 'state-at-20.json'), JSON.stringify(state20, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'diff-t10-t30.json'), JSON.stringify(d, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'flowmap.json'), JSON.stringify(fm, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'flowmap.svg'), svg);
  fs.writeFileSync(path.join(outDir, 'table.md'), table);

  const balance = ledger.balanced();
  const receipt = {
    kind: 'tide-demo-run',
    steps,
    live,
    cells: engine.cells.size,
    ledger_entries: ledger.entries.length,
    tip_hash: ledger.tipHash(),
    balanced: balance.ok,
    unbalanced_writes: balance.unbalancedWrites.length,
    orphan_reads: balance.orphanReads.length,
    story: beat,
    voice_value: engine.state().voice,
    live_usage: live ? (typesafeVoice.usage ?? null) : null,
  };
  fs.writeFileSync(path.join(outDir, 'run-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

  // rewind proof-of-life: snapshot at step 20 is hash-pinned and restorable
  const snap = snapshot(engine, t(20), { note: 'stable point: post-correction, pre-crest' });
  fs.writeFileSync(path.join(outDir, 'snapshot-at-20.json'), JSON.stringify(snap, null, 2) + '\n');

  return { engine, ledger, receipt, state20, diff: d, flowMap: fm, snapshot: snap };
}

// ---- main ----------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const live = process.env.CHRONO_LIVE_SMOKE === '1';
  const outDir = live ? path.join(HERE, '../../receipts/live-smoke') : path.join(HERE, 'outputs');
  try {
    const { receipt } = await runTide({ outDir, live });
    console.log(`tide demo: ${receipt.ledger_entries} entries over ${receipt.steps} steps, ${receipt.cells} cells, balanced=${receipt.balanced}`);
    console.log(`outputs -> ${outDir}`);
    if (live) {
      const ok = (typesafeVoice.calls ?? 0) > 0;
      const smoke = {
        kind: 'live-smoke',
        channel: 'typesafe',
        endpoint: 'POST /v1/systemone',
        calls: typesafeVoice.calls ?? 0,
        budget: 2,
        usage: typesafeVoice.usage ?? null,
        latency_ms: typesafeVoice.latency_ms ?? null,
        ok,
        at: new Date().toISOString(),
      };
      fs.mkdirSync(path.join(HERE, '../../receipts'), { recursive: true });
      fs.writeFileSync(path.join(HERE, '../../receipts/live-smoke.json'), JSON.stringify(smoke, null, 2) + '\n');
      console.log(`live smoke: ${ok ? 'PASS' : 'FAIL'} — ${smoke.calls} typesafe call(s), usage=${JSON.stringify(smoke.usage)}`);
    }
  } catch (err) {
    if (live) {
      // honest FAIL receipt — network failures happen; local tests still prove the wave
      fs.mkdirSync(path.join(HERE, '../../receipts'), { recursive: true });
      fs.writeFileSync(path.join(HERE, '../../receipts/live-smoke.json'), JSON.stringify({
        kind: 'live-smoke', channel: 'typesafe', ok: false, error: err.message,
        budget: 2, calls: typesafeVoice.calls ?? 0, at: new Date().toISOString(),
      }, null, 2) + '\n');
      console.error(`live smoke FAIL (receipted): ${err.message}`);
      // the local run may still have produced outputs before the voice call failed;
      // fall through and finish the demo locally so the wave is proven either way
      const { receipt } = await runTide({ outDir: path.join(HERE, 'outputs'), live: false });
      console.log(`local fallback run complete: ${receipt.ledger_entries} entries`);
      process.exitCode = 0;
    } else {
      throw err;
    }
  }
}
