# CROSS-REPO SEAL PROOF — one Ed25519 identity, two repos, one identity law

Run: `node examples/ed25519-cross-repo-proof.mjs` (re-runnable; each run mints
a fresh RUN-TIME identity — the verdicts are structural, the fingerprint of
record changes honestly per run). Raw evidence:
`examples/receipts/ed25519-cross-repo-proof.json` (public material only — the
private key never left the process and is not in the receipt).

## What ran

One Ed25519 identity, minted by **quilt-jev-toolkit's** `examples/keyring-mint.mjs`
helper (chrono adopts Ed25519 without re-deriving a line of crypto), signed a
quilt-chrono seal with `seal(ledger, { key: privateKeyPem, alg: "Ed25519" })`
over a real 4-entry chrono ledger. Then each repo's own law took its turn:

| step | repo | verdict |
|---|---|---|
| identity.mint | toolkit helper | fingerprint 64-hex; keyring `{fp → publicKeyPem}` |
| chrono.seal | quilt-chrono `seal(alg:"Ed25519")` | checkpoint at seq 3, signer named, sig 128-hex |
| chrono.verify | chrono `verifySeal` + `verifyCustody` | ok; full-custody replay over the chain |
| toolkit.verify | toolkit `verifySignedCheckpoint` + `verifyCheckpointEd25519` | **ok:true, ok:true** — the organ doorway accepts the chrono seal with zero chrono code |
| toolkit.bootChrono | toolkit `bootChrono` | the sealed sheet boots as an organ, custody `{kind:"chrono-seal", alg:"Ed25519"}` |
| fail-closed.probes | both | forged sig → `CHECKPOINT_SIGNATURE_INVALID` (both laws); wrong key → `CHECKPOINT_SIGNATURE_INVALID`; tampered link → `RECEIPT_HASH_MISMATCH` |

VERDICT: **ok:true.**

## The identity of record (run-time-only)

- fingerprint: `2f9fececeec02ce6d5e56669968ba4f9b3d5cff4da794578f1d05fbabc68af2c`
  (sha256 of the SPKI PEM — THE shared law: organ v3 §10.1 = qmr2 §8.2 = this
  seal; synced by 69-b-r2 to the re-executed proof run of 2026-10-02, which
  minted a fresh run-time identity — chainTip/manifestHash anchors below are
  unchanged because the ledger content is clock-pinned and deterministic)
- seal anchor of record: chainTip `cf0fbce20e02e740…`, manifestHash `5cb47311eaeb9a88…`
- the private PEM was minted at run time and destroyed with the process.

## Why this matters

The seed-dna §0 census predicted organs and chrono would converge on one
identity law. This receipt is that prediction scored: the SAME public key
verifies a chrono time-custody seal (this repo), an organ checkpoint, and —
per the 68-b-r2 cross-repo proof — a qmr2 receipt row. Three repos, one
fingerprint, no shared secrets: the key HOLDS the trust, and the verifier
needs only the public half.

Parked on purpose: the signed-revocation-statement layer for such identities
lives as a design in quilt-jev-toolkit REVERSE-ACTUALIZED-SPEC §11 (the
enforcement half — `E_KEY_REVOKED` era closure — is already live there).
