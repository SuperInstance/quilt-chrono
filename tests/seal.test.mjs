// tests/seal.test.mjs — signed time custody (lane 67-a): hash-chain sidecar,
// organ-checkpoint-EXACT seals, fail-closed verification, organ interop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Ledger, Clock, loadLedger } from '../src/ledger.js';
import {
  canonicalJson, buildChain, chainTip, verifyChainLinks,
  chainFileFor, readChainSidecar, writeChainSidecar, cellsAt,
  seal, verifySeal, verifyCustody, linkHash,
} from '../src/seal.js';
import { Chrono } from '../src/flow.js';
import { snapshot, restore } from '../src/rewind.js';
import { stateAt } from '../src/projection.js';

const clockAt = (ms, stepMs = 1000) => new Clock({ startMs: ms, stepMs });
const KEY = 'seal-test-key-67a';
const KEY2 = 'a different minter entirely';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-seal-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A deterministic 12-entry ledger: 2 cells, pushes, a read, a correction. */
function seededLedger({ name = 'demo', file = null } = {}) {
  const led = new Ledger({ name, file, clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'sensor', value: 10, by: 'agent:world', cause: 'init' });
  led.append({ op: 'write', cell: 'gain', value: 2, by: 'agent:op', cause: 'set' });
  led.append({ op: 'read', cell: 'sensor', value: 10, by: 'formula:cal', cause: 'evaluate', flow_id: 'f0' });
  led.append({ op: 'write', cell: 'cal', value: 20, by: 'formula:cal', cause: 'evaluate', flow_id: 'f0' });
  led.append({ op: 'write', cell: 'sensor', value: 11, by: 'agent:world', cause: 'step' });
  led.recordFlow({ from: 'cal', to: 'display', value: 22, by: 'engine' });
  led.append({ op: 'write', cell: 'sensor', value: 12, by: 'agent:world', cause: 'step' });
  led.correct(4, { value: 21, by: 'agent:operator' }); // compensating entry, never a rewrite
  led.append({ op: 'read', cell: 'display', value: 22, by: 'agent:ui', cause: 'pull' });
  led.append({ op: 'write', cell: 'sensor', value: 13, by: 'agent:world', cause: 'step' });
  led.append({ op: 'write', cell: 'sensor', value: 14, by: 'agent:world', cause: 'step' });
  led.append({ op: 'write', cell: 'gain', value: 3, by: 'agent:op', cause: 'set' });
  return led; // 12 entries, seq 0..11
}

// ---------------------------------------------------------------------------
// the chain itself
// ---------------------------------------------------------------------------

test('chain build is deterministic and the link hash follows the organ receipt formula', () => {
  const led = seededLedger();
  const a = buildChain(led);
  const b = buildChain(led.entries);
  assert.equal(canonicalJson(a), canonicalJson(b)); // byte-identical, not just deepEqual

  // golden formula check, computed independently: hash = sha256(canonical({seq, op, prev}))
  const expected0 = crypto.createHash('sha256')
    .update(canonicalJson({ seq: 0, op: JSON.parse(canonicalJson(led.entries[0])), prev: 'GENESIS' }), 'utf8')
    .digest('hex');
  assert.equal(a[0].hash, expected0);
  assert.equal(a[0].prev, 'GENESIS');
  assert.equal(a[1].prev, a[0].hash); // hash-linked
  assert.match(a[0].hash, /^[0-9a-f]{64}$/);
  // the chrono entry rides verbatim inside the link (organ receipt shape: {seq, op, prev, hash})
  assert.deepEqual(a[5].op, led.entries[5]);
});

test('tipHash of the chain is stable across rebuilds and reloads', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const led = seededLedger({ file });
    const tip1 = chainTip(buildChain(led));
    const reloaded = loadLedger(file);
    const tip2 = chainTip(buildChain(reloaded));
    assert.equal(tip1, tip2);
    assert.match(tip1, /^[0-9a-f]{64}$/);
    // the chain tip is the LAST link's hash — append-only growth moves it honestly
    led.append({ op: 'write', cell: 'sensor', value: 15, by: 'agent:world', cause: 'step' });
    assert.notEqual(chainTip(buildChain(led)), tip1);
  } finally { cleanup(dir); }
});

test('sidecar write is append-only: existing prefix bytes never change; divergent/truncating rewrites refuse', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const led = seededLedger({ file });
    const sidecar = chainFileFor(file);
    assert.equal(sidecar, path.join(dir, 'ledger.chain.jsonl'));
    seal(led, { key: KEY }); // default chainFile derives from ledger.file
    const before = fs.readFileSync(sidecar, 'utf8');

    // extend the ledger; the sidecar EXTENDS, never rewrites
    led.append({ op: 'write', cell: 'sensor', value: 99, by: 'agent:world', cause: 'step' });
    const res = seal(led, { key: KEY });
    assert.equal(res.appended, 1);
    const after = fs.readFileSync(sidecar, 'utf8');
    assert.ok(after.startsWith(before), 'append-only: old sidecar bytes are a byte-prefix of the new');

    // a tampered sidecar must not be "extended" — the chain check fires first and
    // names the broken offset (never extend a broken chain, never rewrite history)
    const tampered = before.replace('"value":10', '"value":666');
    fs.writeFileSync(sidecar, tampered, 'utf8');
    assert.throws(() => writeChainSidecar(sidecar, buildChain(led)), (e) => e.code === 'RECEIPT_HASH_MISMATCH');

    // truncation is a rewrite too: a shorter chain than the sidecar refuses
    fs.writeFileSync(sidecar, before, 'utf8');
    const shorter = buildChain(led.entries.slice(0, 5));
    assert.throws(() => writeChainSidecar(sidecar, shorter), (e) => e.code === 'CHAIN_REWRITE_REFUSED');
  } finally { cleanup(dir); }
});

test('TAMPER DETECTION AT ANY OFFSET: flipping bytes in ANY sidecar entry is named, at every seq', () => {
  const dir = tmpdir();
  try {
    const led = seededLedger();
    const N = led.entries.length;
    const sidecar = path.join(dir, 'ledger.chain.jsonl');
    seal(led, { key: KEY, chainFile: sidecar });

    for (let i = 0; i < N; i++) {
      const lines = fs.readFileSync(sidecar, 'utf8').split('\n').filter((l) => l.length > 0);
      const forged = JSON.parse(lines[i]);
      forged.op.value = `__tampered__${i}`; // flip the entry; the stale hash stays
      lines[i] = JSON.stringify(forged);
      fs.writeFileSync(path.join(dir, `t${i}.chain.jsonl`), lines.join('\n') + '\n', 'utf8');
      assert.throws(
        () => readChainSidecar(path.join(dir, `t${i}.chain.jsonl`)),
        (e) => e.code === 'RECEIPT_HASH_MISMATCH' && e.message.includes(`seq ${i}`),
        `tamper at offset ${i} was not detected with the named error`,
      );
    }

    // raw single-byte flip inside a ts_utc: parseable bytes, still named
    const raw = fs.readFileSync(sidecar, 'utf8').replace('"2023-11-14T22:13:20.001Z"', '"2023-11-14T22:13:20.002Z"');
    fs.writeFileSync(path.join(dir, 'flip.chain.jsonl'), raw, 'utf8');
    assert.throws(() => readChainSidecar(path.join(dir, 'flip.chain.jsonl')), (e) => e.code === 'RECEIPT_HASH_MISMATCH');

    // a broken prev-link is a different named species (CHAIN_GAP)
    const links = JSON.parse(fs.readFileSync(sidecar, 'utf8').split('\n').filter((l) => l.length > 0)[3]);
    links.prev = '0'.repeat(64);
    const lines = fs.readFileSync(sidecar, 'utf8').split('\n').filter((l) => l.length > 0);
    lines[3] = JSON.stringify(links);
    fs.writeFileSync(path.join(dir, 'gap.chain.jsonl'), lines.join('\n') + '\n', 'utf8');
    assert.throws(() => readChainSidecar(path.join(dir, 'gap.chain.jsonl')), (e) => e.code === 'CHAIN_GAP');
  } finally { cleanup(dir); }
});

test('cellsAt folds writes <= seq (reads are observations, not transitions)', () => {
  const led = seededLedger();
  const top = led.entries.length - 1;
  const cells = cellsAt(led, top);
  assert.deepEqual(cells, { sensor: { kind: 'value', value: 14 }, gain: { kind: 'value', value: 3 }, cal: { kind: 'value', value: 20 }, display: { kind: 'value', value: 22 } });
  // matches the projection's stateAt for the same bound (two folds, one truth)
  const st = stateAt(led, top);
  for (const [id, c] of Object.entries(cells)) assert.equal(c.value, st.cells[id]);
  assert.throws(() => cellsAt(led, 99), (e) => e.code === 'CHECKPOINT_SEQ_OUT_OF_RANGE');
});

// ---------------------------------------------------------------------------
// seal -> verify round-trips
// ---------------------------------------------------------------------------

test('seal emits an organ-checkpoint-EXACT document; verifySeal round-trips it', () => {
  const led = seededLedger();
  const { checkpoint: cp } = seal(led, { key: KEY });
  // exact shape, exact fields, nothing chrono-specific bolted on
  assert.deepEqual(Object.keys(cp).sort(), ['alg', 'hash', 'manifest', 'manifestHash', 'schema', 'schemaVersion', 'seq', 'sig']);
  assert.equal(cp.schema, 'quilt.organ.checkpoint');
  assert.equal(cp.schemaVersion, 1);
  assert.equal(cp.alg, 'HMAC-SHA256');
  assert.equal(cp.seq, led.entries.length - 1);
  assert.equal(cp.hash, chainTip(buildChain(led)));
  assert.equal(cp.manifest.schema, 'quilt.organ.manifest');
  assert.equal(cp.manifest.receiptRange.count, led.entries.length);
  // sig = HMAC-SHA256(key, canonical({hash, manifestHash, seq})) — recomputed independently
  const expectedSig = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8'))
    .update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
  assert.equal(cp.sig, expectedSig);

  const verdict = verifySeal(cp, KEY);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.seq, led.entries.length - 1);
  assert.equal(verdict.chainTip, cp.hash);
});

test('verifyCustody: the full courtroom — chain, anchor, manifest, replayed state', () => {
  const dir = tmpdir();
  try {
    const led = seededLedger();
    const sidecar = path.join(dir, 'ledger.chain.jsonl');
    const { checkpoint: cp } = seal(led, { key: KEY, chainFile: sidecar });
    const verdict = verifyCustody(cp, KEY, { chainFile: sidecar, ledger: led });
    assert.equal(verdict.ok, true);
    // the anchored replay state IS the sheet's state at the boundary
    assert.deepEqual(verdict.cells, cellsAt(led, led.entries.length - 1));
    // and a sealed boundary at mid-chain works the same way
    const mid = seal(led, { key: KEY, seq: 5 });
    assert.equal(verifyCustody(mid.checkpoint, KEY, { links: mid.links, ledger: led }).ok, true);
  } finally { cleanup(dir); }
});

test('fail-closed: wrong key, missing key, malformed docs, empty ledgers, bad boundaries', () => {
  const led = seededLedger();
  const { checkpoint: cp } = seal(led, { key: KEY });

  assert.throws(() => verifySeal(cp, KEY2), (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
  assert.throws(() => verifySeal(cp, undefined), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
  assert.throws(() => seal(led, { key: '' }), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
  assert.throws(() => verifyCustody(cp, KEY, {}), (e) => e.code === 'SEAL_NO_CHAIN_SOURCE');

  const malformed = { ...cp, alg: 'ED25519' };
  assert.throws(() => verifySeal(malformed, KEY), (e) => e.code === 'CHECKPOINT_MALFORMED');
  const badsig = { ...cp, sig: 'zz' };
  assert.throws(() => verifySeal(badsig, KEY), (e) => e.code === 'CHECKPOINT_MALFORMED');
  const tamperedField = { ...cp, hash: 'a'.repeat(64) }; // signed field flipped
  assert.throws(() => verifySeal(tamperedField, KEY), (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');

  assert.throws(() => seal(new Ledger({ clock: clockAt(1700000000000) }), { key: KEY }), (e) => e.code === 'SEAL_EMPTY_LEDGER');
  assert.throws(() => seal(led, { key: KEY, seq: 99 }), (e) => e.code === 'CHECKPOINT_SEQ_OUT_OF_RANGE');
  assert.throws(() => seal(led, { key: KEY, name: 'Bad Name!' }), (e) => e.code === 'SEAL_BAD_NAME');
});

test('custody forgery fails under the organ anchor law, not just the signature', () => {
  const dir = tmpdir();
  try {
    const led = seededLedger();
    const sidecar = path.join(dir, 'ledger.chain.jsonl');
    const { checkpoint: cp } = seal(led, { key: KEY, chainFile: sidecar });

    // tamper the UNSIGNED-but-anchored manifest → no longer re-hashes to the signed manifestHash
    const forged = JSON.parse(JSON.stringify(cp));
    forged.manifest.state.cellsSha256 = 'f'.repeat(64);
    assert.throws(() => verifyCustody(forged, KEY, { chainFile: sidecar }), (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH');

    // the self-consistent chain forgery: re-hash entries 5.. AND fix every link hash.
    // The chain verifies internally, but the SIGNED boundary no longer matches — spec §8's
    // "honest scope of the anchor": a fully re-hashed history is a fork, and the seal names it.
    const links = readChainSidecar(sidecar).links;
    const forgedOp = JSON.parse(JSON.stringify(links[5].op));
    forgedOp.value = -1;
    let prev = links[5].prev;
    for (let i = 5; i < links.length; i++) {
      links[i].op = i === 5 ? forgedOp : JSON.parse(JSON.stringify(links[i].op));
      links[i].prev = prev;
      links[i].hash = linkHash(links[i]);
      prev = links[i].hash;
    }
    assert.doesNotThrow(() => verifyChainLinks(links)); // internally consistent...
    assert.throws(() => verifyCustody(cp, KEY, { links }), (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH'); // ...but not THE chain

    // a sidecar/ledger divergence is named directly: same seal, a ledger whose
    // history differs from the one the chain carries
    const otherHistory = JSON.parse(canonicalJson(led.entries));
    otherHistory[5].value = -1;
    assert.throws(
      () => verifyCustody(cp, KEY, { chainFile: sidecar, ledger: otherHistory }),
      (e) => e.code === 'CHAIN_ENTRY_MISMATCH' && e.message.includes('seq 5'),
    );
  } finally { cleanup(dir); }
});

test('post-seal appends extend the chain honestly; the old seal still holds at its boundary', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const led = seededLedger({ file });
    const first = seal(led, { key: KEY }); // seals at tip
    const firstSeq = first.checkpoint.seq;
    assert.equal(firstSeq, led.entries.length - 1);

    for (let v = 20; v <= 22; v++) led.append({ op: 'write', cell: 'sensor', value: v, by: 'agent:world', cause: 'step' });
    const second = seal(led, { key: KEY, organId: first.checkpoint.manifest.organId, supersedes: first.checkpoint.manifest.manifestHash });
    assert.equal(second.appended, 3);
    assert.equal(second.checkpoint.seq, firstSeq + 3);
    // identity carried forward (organ law: carried, not re-minted); lineage honest
    assert.equal(second.checkpoint.manifest.organId, first.checkpoint.manifest.organId);
    assert.equal(second.checkpoint.manifest.supersedes, first.checkpoint.manifest.manifestHash);

    // the OLD seal still verifies against the EXTENDED chain at ITS boundary
    const extended = readChainSidecar(first.chainFile);
    assert.equal(verifyCustody(first.checkpoint, KEY, { chainFile: first.chainFile, ledger: led }).ok, true);
    assert.equal(extended.links.length, firstSeq + 4);
    assert.equal(verifyCustody(second.checkpoint, KEY, { links: extended.links }).ok, true);
    assert.equal(second.checkpoint.hash, extended.tipHash);
  } finally { cleanup(dir); }
});

test('seal works on a file-loaded ledger; verify-before-boot gates restore()', () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const engine = new Chrono({ name: 'custody-demo', ledger: new Ledger({ name: 'custody-demo', file, clock: clockAt(1700000000000) }) });
    engine.value('raw', null);
    engine.value('disp', null);
    engine.formula('cal', ['raw'], (r) => r * 2);
    engine.push('cal', 'disp', { by: 'w' });
    for (let i = 1; i <= 4; i++) {
      engine.tick();
      engine.write('raw', i * 5, { by: 'agent:t' });
      engine.pull('cal', { by: 'agent:t' });
    }

    const loaded = loadLedger(file); // boot from the FILE, not the live object
    const { checkpoint: cp } = seal(loaded, { key: KEY });
    const snap = snapshot(engine, null);

    // verify-before-boot: custody runs BEFORE anything materializes
    const booted = restore(snap, { custody: { checkpoint: cp, key: KEY, chainFile: chainFileFor(file), ledger: loaded } });
    assert.equal(booted.pull('cal', { by: 'agent:t' }), 40);
    // and a forged custody claim refuses the boot outright
    const forged = JSON.parse(JSON.stringify(cp));
    forged.manifest.cells[0].stateHash = 'e'.repeat(64);
    assert.throws(
      () => restore(snap, { custody: { checkpoint: forged, key: KEY, chainFile: chainFileFor(file) } }),
      (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH',
    );
    assert.throws(
      () => restore(snap, { custody: { checkpoint: cp, key: KEY2, chainFile: chainFileFor(file) } }),
      (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID',
    );
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// ORGAN INTEROP — the point of the lane: the organ toolkit's OWN code accepts
// a chrono seal. Skips honestly when the sibling repo is not checked out.
// ---------------------------------------------------------------------------

const organUrl = new URL('../../quilt-jev-toolkit/src/organ/', import.meta.url);
const organReady = fs.existsSync(new URL('boot.mjs', organUrl)) && fs.existsSync(new URL('manifest.mjs', organUrl));
const organ = organReady
  ? { boot: await import(new URL('boot.mjs', organUrl).href), manifest: await import(new URL('manifest.mjs', organUrl).href) }
  : null;

test('ORGAN INTEROP: canonical bytes are byte-identical to the organ implementation', (t) => {
  if (!organ) { t.skip('quilt-jev-toolkit sibling not present — the interop proof needs it locally'); return; }
  const nasty = { z: 1, a: { d: [2, 1, { b: null, a: 'x' }], c: true }, m: 0.5, s: 'quote"and\\slash', arr: [1, [2, [3]]] };
  assert.equal(canonicalJson(nasty), organ.manifest.canonicalJson(nasty));
  assert.throws(() => canonicalJson({ bad: undefined }), TypeError);
  assert.throws(() => canonicalJson({ bad: 123n }), TypeError);
});

test('ORGAN INTEROP: organ verifySignedCheckpoint accepts the chrono seal (and rejects forgeries)', (t) => {
  if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
  const led = seededLedger();
  const { checkpoint: cp } = seal(led, { key: KEY });
  assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY).ok, true);
  assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY2).ok, false);
  assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY2).code, 'CHECKPOINT_SIGNATURE_INVALID');
});

test('ORGAN INTEROP: organ verifyChain verifies the chrono sidecar; tip == sealed chainTip', (t) => {
  if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
  const led = seededLedger();
  const { checkpoint: cp, links } = seal(led, { key: KEY });
  const verdict = organ.manifest.verifyChain(links, { expectedStart: 0, expectedPrev: 'GENESIS' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tipHash, cp.hash);
  // the sidecar links re-hash under the ORGAN's own receiptHash, one by one
  for (const l of links) assert.equal(organ.manifest.receiptHash(l), l.hash);
  // and the organ's own tamper naming fires on the chrono sidecar
  const broken = JSON.parse(JSON.stringify(links));
  broken[7].op.value = 'forged-by-hand';
  assert.equal(organ.manifest.verifyChain(broken).code, 'RECEIPT_HASH_MISMATCH');
});

test('ORGAN INTEROP: organ validateManifest accepts the seal manifest; manifestHash matches computeManifestHash', (t) => {
  if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
  const led = seededLedger();
  const { checkpoint: cp } = seal(led, { key: KEY, seq: 5 });
  const validation = organ.manifest.validateManifest(cp.manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors ?? []));
  assert.equal(organ.manifest.computeManifestHash(cp.manifest), cp.manifestHash);
  // the manifest's state hash is the organ state law: sha256Json of the cells map
  assert.equal(cp.manifest.state.cellsSha256, organ.manifest.sha256Json(cellsAt(led, 5)));
});
