#!/usr/bin/env node
// ed25519-cross-repo-proof.mjs — THE CROSS-REPO SEAL PROOF (wave-69, lane 69-b).
//
// ONE run-time Ed25519 identity (minted by the TOOLKIT's keyring-minting
// helper — quilt-chrono adopts Ed25519 without re-deriving a line of crypto),
// TWO repos, each verifying the other's artifact under its own law:
//
//   quilt-chrono  seal(alg:"Ed25519")  →  verifySeal / verifyCustody  (chrono law)
//   quilt-jev-toolkit  verifySignedCheckpoint / verifyCheckpointEd25519 /
//                      bootChrono                                    (organ law)
//
// Both accept the SAME document because the checkpoint is byte-shape-exact
// organ v3 and the fingerprint law is shared (sha256 of the SPKI PEM). This is
// organs-and-chrono converging on ONE identity law — the seed-dna §0
// prediction, now receipted in examples/receipts/.
//
// Fail-closed probes included: forged sig, wrong key, tampered link — each
// refused BY NAME under both laws.
//
// KEY HYGIENE: the identity is RUN-TIME-ONLY. The private PEM never leaves
// this process; the receipt records fingerprints, public material, and
// verdicts — never key material. Re-runs mint a fresh identity (the verdicts
// are structural; the fingerprint of record changes honestly per run).
//
// Run: node examples/ed25519-cross-repo-proof.mjs   (needs the sibling repo
// quilt-jev-toolkit checked out beside this one)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const TOOLKIT = path.resolve(REPO, '..', 'quilt-jev-toolkit');

const need = (cond, code, msg) => {
  if (!cond) {
    console.error(`[${code}] ${msg}`);
    process.exit(1);
  }
};

const toolkitOrgan = path.join(TOOLKIT, 'src', 'organ');
need(fs.existsSync(path.join(toolkitOrgan, 'boot.mjs')), 'SIBLING_MISSING',
  'quilt-jev-toolkit sibling not found beside this repo — check out both repos side by side');

// --- imports: chrono's own seal law + the toolkit's organ law + its helper ----
const { Ledger, Clock } = await import(path.join(REPO, 'src', 'ledger.js'));
const sealMod = await import(path.join(REPO, 'src', 'seal.js'));
const { seal, verifySeal, verifyCustody, SEAL_ALG_ED25519, canonicalJson } = sealMod;
const organ = await import(path.join(toolkitOrgan, 'boot.mjs'));
const chronoOps = await import(path.join(toolkitOrgan, 'chronoOps.js'));
const mint = await import(path.join(TOOLKIT, 'examples', 'keyring-mint.mjs'));

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${step} — ${detail}`);
  return ok;
};

// --- 1. the identity: minted by the TOOLKIT's helper (zero crypto re-derived) --
const id = mint.mintKeyring('chrono-ed25519-minter');
const ring = mint.keyringOf([id]);
record('identity.mint', /^[0-9a-f]{64}$/.test(id.fingerprint) && ring[id.fingerprint] === id.publicKeyPem,
  `mintKeyring() identity fingerprint ${id.fingerprint.slice(0, 16)}… (private key stays runtime-only)`);

// --- 2. the sheet: a real chrono ledger, fixed clock (deterministic content) ---
const clock = new Clock({ startMs: Date.parse('2026-01-01T00:00:00.000Z'), stepMs: 1000 });
const ledger = new Ledger({ name: 'cross-repo-sheet', clock });
ledger.append({ op: 'write', cell: 'sensor.tide', value: 2.4, by: 'engine:init', cause: 'init', pushed: false, flow_id: null });
ledger.append({ op: 'read', cell: 'sensor.tide', value: 2.4, by: 'agent:operator', cause: 'pull', pushed: false, flow_id: null });
ledger.append({ op: 'write', cell: 'sensor.tide', value: 3.1, by: 'agent:operator', cause: 'set', pushed: false, flow_id: null });
ledger.append({ op: 'write', cell: 'sink.almanac', value: 3.1, by: 'agent:operator', cause: 'set', pushed: false, flow_id: null });

// --- 3. the seal: chrono mints organ-v3-exact, signed by the named identity ----
const { checkpoint: cp, links } = seal(ledger, { key: id.privateKeyPem, alg: SEAL_ALG_ED25519, name: 'cross-repo-sheet' });
const shapeOk = cp.alg === 'Ed25519'
  && cp.publicKeyFingerprint === id.fingerprint
  && /^[0-9a-f]{128}$/.test(cp.sig)
  && cp.schema === 'quilt.organ.checkpoint';
record('chrono.seal', shapeOk,
  `seal(alg:"Ed25519") minted checkpoint at seq ${cp.seq}; signer named ${cp.publicKeyFingerprint.slice(0, 16)}…`);

// --- 4. chrono's own law accepts it (signature + full custody) -----------------
const v1 = verifySeal(cp, id.publicKeyPem);
const custody = verifyCustody(cp, id.publicKeyPem, { links, ledger });
record('chrono.verify', v1.ok === true && custody.ok === true,
  `verifySeal ok (seq ${v1.seq}); verifyCustody ok over the full chain (replay state ${Object.keys(custody.cells).length} cells)`);

// --- 5. THE ORGAN LAW accepts the chrono seal, unmodified ----------------------
const organSig = organ.verifySignedCheckpoint(cp, id.publicKeyPem);
const organV3 = organ.verifyCheckpointEd25519(cp, id.publicKeyPem);
record('toolkit.verify', organSig.ok === true && organV3.ok === true,
  `verifySignedCheckpoint ok:true + verifyCheckpointEd25519 ok:true (the organ doorway, zero chrono code)`);

// --- 6. the organ boots from the chrono sheet; Ed25519 provenance rides through -
const booted = chronoOps.bootChrono({ links, checkpoint: cp }, { key: id.publicKeyPem });
const bootOk = booted.custody.kind === 'chrono-seal' && booted.custody.alg === 'Ed25519';
record('toolkit.bootChrono', bootOk,
  `bootChrono custody {kind:"chrono-seal", alg:"Ed25519"}; organ state ${JSON.stringify(booted.cells)}`);

// --- 7. fail-closed probes: forgeries refuse BY NAME under BOTH laws -----------
const flip = (s) => (s.endsWith('0') ? s.slice(0, -1) + '1' : s.slice(0, -1) + '0');
const forgedSig = { ...cp, sig: flip(cp.sig) };
const stranger = mint.mintKeyring('stranger');
let chronoForged = null;
try { verifySeal(forgedSig, id.publicKeyPem); } catch (e) { chronoForged = e.code; }
const toolkitForged = organ.verifySignedCheckpoint(forgedSig, id.publicKeyPem).code;
const wrongKey = organ.verifySignedCheckpoint(cp, stranger.publicKeyPem).code;
const tamperedLinks = JSON.parse(JSON.stringify(links));
tamperedLinks[2].op.value = 999;
let chainRefusal = null;
try { verifyCustody(cp, id.publicKeyPem, { links: tamperedLinks }); } catch (e) { chainRefusal = e.code; }
record('fail-closed.probes',
  chronoForged === 'CHECKPOINT_SIGNATURE_INVALID' && toolkitForged === 'CHECKPOINT_SIGNATURE_INVALID'
    && wrongKey === 'CHECKPOINT_SIGNATURE_INVALID' && chainRefusal === 'RECEIPT_HASH_MISMATCH',
  `forged sig → ${chronoForged}/${toolkitForged}; wrong key → ${wrongKey}; tampered link → ${chainRefusal}`);

const ok = steps.every((s) => s.ok);

// --- 8. the receipt (public material only; identity is run-time-only) ----------
const receipt = {
  proof: 'quilt-chrono Ed25519 seal verified by quilt-jev-toolkit organ law (one identity, two repos)',
  identity: {
    note: 'RUN-TIME-ONLY identity minted by quilt-jev-toolkit examples/keyring-mint.mjs; the private key never left this process and is NOT in this receipt. Re-runs mint a fresh identity — verdicts are structural.',
    fingerprint: id.fingerprint,
    publicKeyPem: id.publicKeyPem,
    helper: 'quilt-jev-toolkit/examples/keyring-mint.mjs mintKeyring()',
  },
  seal: {
    alg: cp.alg,
    seq: cp.seq,
    hash: cp.hash,
    manifestHash: cp.manifestHash,
    publicKeyFingerprint: cp.publicKeyFingerprint,
    sig: cp.sig,
  },
  organLaw: {
    verifier: 'quilt-jev-toolkit src/organ/boot.mjs verifySignedCheckpoint + verifyCheckpointEd25519',
    boot: 'src/organ/chronoOps.js bootChrono → custody {kind:"chrono-seal", alg:"Ed25519"}',
    results: { verifySignedCheckpoint: organSig, verifyCheckpointEd25519: organV3 },
  },
  chronoLaw: { verifier: 'quilt-chrono src/seal.js verifySeal + verifyCustody', results: { verifySeal: v1 } },
  steps,
  ok,
};
fs.mkdirSync(path.join(REPO, 'examples', 'receipts'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'examples', 'receipts', 'ed25519-cross-repo-proof.json'),
  JSON.stringify(receipt, null, 2) + '\n');

console.log(`\nVERDICT: ${ok ? 'ok:true — one Ed25519 identity, two repos, each verifying the other under its own law' : 'FAILED'}`);
console.log('receipt: examples/receipts/ed25519-cross-repo-proof.json');
process.exit(ok ? 0 : 1);
