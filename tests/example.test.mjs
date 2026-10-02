// tests/example.test.mjs — the tide demo as an integration test: 40 steps,
// 9 cells, the correction story, outputs regenerated into a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTide } from '../examples/tide/run.mjs';
import { loadLedger } from '../src/ledger.js';

test('the tide demo: 40 steps, 9 cells, balanced double-entry, a correction, a tide', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-tide-'));
  const { engine, ledger, receipt, state20, flowMap: fm } = await runTide({ outDir, live: false });

  // the sheet has the required >= 5 cells and ran the required ~40 steps
  assert.ok(engine.cells.size >= 5, `expected >= 5 cells, got ${engine.cells.size}`);
  assert.equal(receipt.steps, 40);
  assert.equal(engine.cells.size, 9);

  // every write has its cause-read: the double-entry law holds over a real run
  const balance = ledger.balanced();
  assert.equal(balance.ok, true);
  assert.equal(receipt.balanced, true);

  // the tide actually flowed: bounded-rate edge held values between crests
  assert.ok(fm.throttled > 20, `expected many tide-held attempts, got ${fm.throttled}`);
  const alertEdge = fm.edges.find((e) => e.from === 'sensor.calibrated' && e.to === 'sink.alert');
  assert.ok(alertEdge && alertEdge.count >= 5 && alertEdge.count < 15,
    `expected a throttled alert edge, got ${JSON.stringify(alertEdge)}`);
  const displayEdge = fm.edges.find((e) => e.to === 'sink.display');
  assert.ok(displayEdge.count > alertEdge.count, 'unthrottled display should crest far more often than the alert');

  // the correction story: spike write at 18, compensating entry at 20,
  // original entry byte-intact (append-only)
  const correction = ledger.entries[receipt.story.correctionSeq];
  assert.equal(correction.cause, 'correction');
  assert.equal(correction.corrects, receipt.story.spikeWriteSeq);
  const spike = ledger.entries[receipt.story.spikeWriteSeq];
  assert.equal(spike.cell, 'sensor.raw');
  assert.ok(spike.value > 100, 'the step-18 spike should be a hot value');
  assert.ok(correction.value < 100, 'the operator corrected it back into trend');
  // and the corrected value rippled: state at 20 shows the corrected raw
  assert.equal(state20.cells['sensor.raw'], correction.value);

  // the ai cell journaled through the ledger (offline backend, still a flow)
  const voiceFlows = [...ledger.flowIndex().values()].filter((f) => f.writes.some((w) => w.cell === 'voice'));
  assert.equal(voiceFlows.length, 2); // pulled at steps 10 and 25
  assert.ok(voiceFlows.every((f) => f.reads.length === 2 && f.writes.length === 1));

  // outputs exist and the ledger file is a valid append-only jsonl
  for (const f of ['ledger.jsonl', 'state-at-20.json', 'diff-t10-t30.json', 'flowmap.svg', 'flowmap.json', 'table.md', 'run-receipt.json', 'snapshot-at-20.json']) {
    assert.ok(fs.existsSync(path.join(outDir, f)), `missing output ${f}`);
  }
  const reloaded = loadLedger(path.join(outDir, 'ledger.jsonl'));
  assert.equal(reloaded.entries.length, ledger.entries.length);
  assert.equal(reloaded.balanced().ok, true);

  // the SVG renders the actual demo ledger: lanes for the cells, arcs for pushes
  const svg = fs.readFileSync(path.join(outDir, 'flowmap.svg'), 'utf8');
  for (const lane of ['sensor.raw', 'sensor.calibrated', 'sink.display', 'sink.alert', 'health', 'voice']) {
    assert.ok(svg.includes(lane), `svg missing lane ${lane}`);
  }
  const wrMarks = svg.split('class="wr"').length - 1;
  const ledgerWrites = ledger.entries.filter((e) => e.op === 'write').length;
  assert.equal(wrMarks, ledgerWrites, 'svg write marks must equal ledger writes');
  assert.ok(svg.split('class="arc"').length - 1 > 50, 'expected a rich arc field');
});
