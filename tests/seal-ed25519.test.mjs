// seal-ed25519.test.mjs — the v3 sig slot on the chrono seal (wave-69).
//
// seal() gains alg: "Ed25519" — the signer has a NAME (organ v3 law, spec
// §10): the checkpoint carries publicKeyFingerprint and the sig is Ed25519
// over the SAME canonical triple the HMAC covers. The default (no alg) stays
// byte-compat with every pre-v3 seal — proven by the untouched 52-test suite.
//
// KEY HYGIENE: keypairs are generated AT TEST TIME (node:crypto) and never
// written to disk or committed; fingerprints in assertions are computed, never
// hardcoded.
//
// The tamper battery for Ed25519 seals mirrors the HMAC battery: forged sig,
// wrong key, missing key, tampered signed field, unknown alg — every refusal
// keeps its organ-protocol name.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ledger, Clock } from '../src/ledger.js';
import {
  canonicalJson,
  seal,
  verifySeal,
  verifyCustody,
  SEAL_ALG_HMAC,
  SEAL_ALG_ED25519,
  SEAL_ALGS,
} from '../src/seal.js';

const clockAt = (ms, stepMs = 1000) => new Clock({ startMs: ms, stepMs });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-seal-v3-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const KEY = 'seal-test-key-67a'; // the v2 secret (byte-compat witness)
const flipHexChar = (s) => {
  const i = Math.floor(s.length / 2);
  const c = s[i];
  const flipped = c >= '0' && c < '9' ? String.fromCharCode(c.charCodeAt(0) + 1) : '0';
  return s.slice(0, i) + flipped + s.slice(i + 1);
};

// THE FINGERPRINT LAW (organ v3 §10.1 = qmr2 §8.2) — computed, never hardcoded
const fingerprintOf = (pem) =>
  crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' })).digest('hex');

const keygen = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, fingerprint: fingerprintOf(publicKeyPem) };
};

function seededLedger({ name = 'v3-sheet' } = {}) {
  const led = new Ledger({ name, clock: clockAt(1700000000000) });
  led.append({ op: 'write', cell: 'cal', value: 40, by: 'agent:t', cause: 'set', pushed: false, flow_id: null });
  led.append({ op: 'write', cell: 'raw', value: 0, by: 'agent:t', cause: 'set', pushed: false, flow_id: null });
  led.append({ op: 'read', cell: 'cal', value: 40, by: 'agent:t', cause: 'pull', pushed: false, flow_id: null });
  led.append({ op: 'write', cell: 'cal', value: 41, by: 'agent:t', cause: 'set', pushed: false, flow_id: null });
  led.append({ op: 'write', cell: 'raw', value: 5, by: 'agent:t', cause: 'set', pushed: false, flow_id: null });
  return led;
}

test('v3 seal round-trip: Ed25519 checkpoint names its signer; verifySeal accepts it under the public key', () => {
  const { privateKeyPem, publicKeyPem, fingerprint } = keygen();
  const led = seededLedger();
  const { checkpoint: cp } = seal(led, { key: privateKeyPem, alg: SEAL_ALG_ED25519 });

  // organ v3 EXACT shape: the same 9 fields the toolkit's signCheckpointEd25519 emits
  assert.deepEqual(Object.keys(cp).sort(),
    ['alg', 'hash', 'manifest', 'manifestHash', 'publicKeyFingerprint', 'schema', 'schemaVersion', 'seq', 'sig']);
  assert.equal(cp.alg, 'Ed25519');
  assert.equal(cp.publicKeyFingerprint, fingerprint, 'the checkpoint names its signer under THE shared fingerprint law');
  assert.match(cp.sig, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 128 hex');
  // the signature covers the SAME canonical triple the HMAC covers
  const expected = crypto.sign(null, Buffer.from(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8'), privateKeyPem).toString('hex');
  assert.equal(cp.sig, expected);

  const verdict = verifySeal(cp, publicKeyPem); // the verifier needs NO secret
  assert.equal(verdict.ok, true);
  assert.equal(verdict.seq, led.entries.length - 1);
  assert.equal(verdict.chainTip, cp.hash);
  // the private PEM verifies too (it derives the same public half) — a
  // trust-root choice, not a protocol break (organ §10.7)
  assert.equal(verifySeal(cp, privateKeyPem).ok, true);
});

test('v3 byte-compat: a seal minted without alg is byte-identical to the explicit HMAC seal', () => {
  const led = seededLedger();
  const a = seal(led, { key: KEY }).checkpoint;
  const b = seal(led, { key: KEY, alg: SEAL_ALG_HMAC }).checkpoint;
  assert.deepEqual(JSON.parse(canonicalJson(a)), JSON.parse(canonicalJson(b)));
  assert.equal(a.sig, b.sig);
  assert.equal('publicKeyFingerprint' in a, false, 'no v3 field leaks into the default seal');
});

test('v3 full custody: verifyCustody accepts an Ed25519 seal end-to-end (chain + anchor + replay)', () => {
  const dir = tmpdir();
  try {
    const { privateKeyPem, publicKeyPem } = keygen();
    const file = path.join(dir, 'ledger.jsonl');
    const led = seededLedger({ file });
    const sidecar = path.join(dir, 'ledger.chain.jsonl');
    const { checkpoint: cp } = seal(led, { key: privateKeyPem, alg: SEAL_ALG_ED25519, chainFile: sidecar });
    const verdict = verifyCustody(cp, publicKeyPem, { chainFile: sidecar, ledger: led });
    assert.equal(verdict.ok, true);
    // a mid-chain Ed25519 boundary works the same way
    const mid = seal(led, { key: privateKeyPem, alg: SEAL_ALG_ED25519, seq: 3 });
    assert.equal(verifyCustody(mid.checkpoint, publicKeyPem, { links: mid.links, ledger: led }).ok, true);
  } finally { cleanup(dir); }
});

test('v3 tamper battery: forged sig, wrong key, missing key, tampered signed field — all refused BY NAME', () => {
  const signer = keygen();
  const other = keygen();
  const { checkpoint: cp } = seal(seededLedger(), { key: signer.privateKeyPem, alg: SEAL_ALG_ED25519 });

  // forged sig: flip one hex char → CHECKPOINT_SIGNATURE_INVALID
  assert.throws(() => verifySeal({ ...cp, sig: flipHexChar(cp.sig) }, signer.publicKeyPem),
    (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
  // wrong key: a different identity, fingerprint equality first (organ §10.2 law)
  assert.throws(() => verifySeal(cp, other.publicKeyPem),
    (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
  // unusable key material is a broken trust root, not a signature failure
  assert.throws(() => verifySeal(cp, 'not-a-pem'),
    (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
  // missing key: the keyring-missing species → CHECKPOINT_SIGNATURE_REQUIRED
  assert.throws(() => verifySeal(cp, undefined), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
  assert.throws(() => verifySeal(cp, ''), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
  // tampered SIGNED field (hash is inside the triple) → CHECKPOINT_SIGNATURE_INVALID
  assert.throws(() => verifySeal({ ...cp, hash: 'a'.repeat(64) }, signer.publicKeyPem),
    (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
  // stripped signer name → CHECKPOINT_MALFORMED (shape, not trust)
  const { publicKeyFingerprint, ...nameless } = cp;
  void publicKeyFingerprint;
  assert.throws(() => verifySeal(nameless, signer.publicKeyPem), (e) => e.code === 'CHECKPOINT_MALFORMED');
  // an HMAC-length sig under an Ed25519 alg is a shape violation
  assert.throws(() => verifySeal({ ...cp, sig: 'a'.repeat(64) }, signer.publicKeyPem),
    (e) => e.code === 'CHECKPOINT_MALFORMED');
});

test('v3 mint-side refusals: unregistered alg, unusable key material, HMAC-shaped key under Ed25519 — all named', () => {
  const led = seededLedger();
  assert.throws(() => seal(led, { key: 'k', alg: 'RSA-SHA256' }), (e) => e.code === 'SEAL_BAD_ALG');
  assert.throws(() => seal(led, { key: 'not-a-pem', alg: SEAL_ALG_ED25519 }), (e) => e.code === 'SEAL_BAD_KEY');
  assert.throws(() => seal(led, { key: 'an-hmac-secret-not-a-pem', alg: SEAL_ALG_ED25519 }), (e) => e.code === 'SEAL_BAD_KEY');
  assert.throws(() => seal(led, { key: '', alg: SEAL_ALG_ED25519 }), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
  // the alg registry is exactly the two named members
  assert.deepEqual(SEAL_ALGS, ['HMAC-SHA256', 'Ed25519']);
});

test('v3 chain law unchanged: an Ed25519 seal does not weaken the sidecar — link tamper still RECEIPT_HASH_MISMATCH', () => {
  const dir = tmpdir();
  try {
    const { privateKeyPem, publicKeyPem } = keygen();
    const led = seededLedger();
    const sidecar = path.join(dir, 'ledger.chain.jsonl');
    const { checkpoint: cp, links } = seal(led, { key: privateKeyPem, alg: SEAL_ALG_ED25519, chainFile: sidecar });
    const tampered = JSON.parse(JSON.stringify(links));
    tampered[3].op.value = 666;
    assert.throws(() => verifyCustody(cp, publicKeyPem, { links: tampered }),
      (e) => e.code === 'RECEIPT_HASH_MISMATCH');
    // the anchor still pins the ORIGINAL chain: re-hash the tail and the pin breaks by name
    const forged = JSON.parse(JSON.stringify(links));
    forged[3].op.value = 666;
    for (let i = 3; i < forged.length; i++) {
      if (i > 3) forged[i].prev = forged[i - 1].hash;
      forged[i].hash = crypto.createHash('sha256').update(canonicalJson({ seq: forged[i].seq, op: forged[i].op, prev: forged[i].prev })).digest('hex');
    }
    assert.throws(() => verifyCustody(cp, publicKeyPem, { links: forged }),
      (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH');
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// ORGAN INTEROP v3 — the convergence law (seed-dna §0's prediction): the organ
// toolkit's OWN verifier accepts a chrono Ed25519 seal, no chrono code needed
// on its side. Skip-if-absent (the 67-a pattern).
// ---------------------------------------------------------------------------

const organUrl = new URL('../../quilt-jev-toolkit/src/organ/', import.meta.url);
const organReady = fs.existsSync(new URL('boot.mjs', organUrl)) && fs.existsSync(new URL('chronoOps.js', organUrl));
const organ = organReady
  ? { boot: await import(new URL('boot.mjs', organUrl).href), chronoOps: await import(new URL('chronoOps.js', organUrl).href) }
  : null;

test('ORGAN INTEROP v3: the toolkit\'s alg-dispatching verifier + bootChrono accept the chrono Ed25519 seal; forgeries refuse by name', (t) => {
  if (!organ) { t.skip('quilt-jev-toolkit sibling not present — examples/ed25519-cross-repo-proof.mjs carries the committed proof'); return; }
  const { privateKeyPem, publicKeyPem, fingerprint } = keygen();
  const { checkpoint: cp, links } = seal(seededLedger(), { key: privateKeyPem, alg: SEAL_ALG_ED25519 });

  // the toolkit's own verifiers — v2 doorway (alg-dispatching) and the named v3 doorway
  assert.equal(organ.boot.verifySignedCheckpoint(cp, publicKeyPem).ok, true);
  assert.equal(organ.boot.verifyCheckpointEd25519(cp, publicKeyPem).ok, true);
  // fingerprint law: the toolkit derives the SAME name from the same key
  assert.equal(cp.publicKeyFingerprint, fingerprint);

  // forgery refused by the toolkit under the SAME code chrono throws
  const flip = (s) => (s.endsWith('0') ? s.slice(0, -1) + '1' : s.slice(0, -1) + '0');
  assert.equal(organ.boot.verifySignedCheckpoint({ ...cp, sig: flip(cp.sig) }, publicKeyPem).code, 'CHECKPOINT_SIGNATURE_INVALID');
  assert.equal(organ.boot.verifySignedCheckpoint(cp, keygen().publicKeyPem).code, 'CHECKPOINT_SIGNATURE_INVALID');

  // and the full organ boot: the sealed chrono sheet wakes as an organ with
  // Ed25519 provenance riding through
  const organBooted = organ.chronoOps.bootChrono({ links, checkpoint: cp }, { key: publicKeyPem });
  assert.equal(organBooted.custody.kind, 'chrono-seal');
  assert.equal(organBooted.custody.alg, 'Ed25519');
});
