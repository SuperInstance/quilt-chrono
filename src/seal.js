// quilt-chrono — src/seal.js (lane 67-a)
//
// SIGNED TIME CUSTODY — hash-chain the chrono jsonl in a sidecar, and seal the
// chain tip with an organ-protocol checkpoint.
//
// This module is the glue wave-66 queued ("hash-chain the chrono jsonl and hand
// tipHash to quilt-jev-toolkit's checkpoint.mjs"). It deliberately does NOT
// invent a signature format. The sealed document is BYTE-EXACTLY the organ v2
// checkpoint (quilt-jev-toolkit/docs/REVERSE-ACTUALIZED-SPEC.md §8.1,
// src/organ/checkpoint.mjs + boot.mjs):
//
//   { schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256",
//     seq:  <boundary — last ledger entry the seal covers>,
//     hash: <chainTip at the boundary = the sidecar link's receipt hash>,
//     manifestHash: <sha256 of the prefix custody manifest>,
//     sig: <HMAC-SHA256(key, canonical({hash, manifestHash, seq}))>,
//     manifest: <quilt.organ.manifest/v1, content-addressed to manifestHash> }
//
// So the organ toolkit's OWN verifiers accept a chrono seal unmodified:
//   boot.mjs verifySignedCheckpoint(cp, key)  — structure + HMAC
//   manifest.mjs verifyChain(links)           — the sidecar IS an organ
//                                               receipt chain
//   manifest.mjs validateManifest(cp.manifest) — the prefix custody manifest
// tests/seal.test.mjs proves all three against the real organ code when the
// sibling repo is present (skip-if-absent; this repo stays stdlib-only and
// dependency-free — the formats match, no code is imported at runtime).
//
// THE CHAIN SIDECAR (`<ledger>.chain.jsonl`): the original ledger bytes are
// never touched. One link per ledger entry, appended in lockstep:
//
//   { seq, op: <the chrono entry verbatim>, prev: <previous link hash>,
//     hash: sha256(canonicalJson({seq, op, prev})) }
//
// A link is EXACTLY an organ receipt (`makeReceipt` in organ manifest.mjs)
// whose op is the chrono entry — the wave brief's formula
// `h = sha256(prev_h || canonical(entry))` is subsumed by the organ formula
// `sha256(canonical({seq, op, prev}))` (prev AND the entry AND the position
// are all covered). Consequence: organ's verifyChain() and receiptHash()
// verify the chrono chain unmodified, and every sidecar tamper — at ANY
// offset — breaks every link after it.
//
// CUSTODY LAW (mirrors organ spec §8 honestly): the signature vouches for the
// PREFIX — the derived cell state at `seq`, the boundary chain tip, the organ
// identity. Post-checkpoint entries are guarded by the hash chain only (a
// fully re-hashed tail is a different fork, not a detectable forgery — same
// honest scope as the organ protocol; seal again to tighten the window).
//
// All error codes are named. Codes whose failure species exists in the organ
// protocol use the ORGAN's code (CHECKPOINT_*, CHAIN_GAP, RECEIPT_HASH_MISMATCH);
// chrono-side operational failures use SEAL_/CHAIN_-prefixed codes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ledgerError } from './ledger.js';

export const CHAIN_GENESIS = 'GENESIS';
export const CHAIN_SIDECAR_MARKER = '.chain.jsonl';

// --- canonical JSON + sha256 ------------------------------------------------
// Organ-exact canonicalization (law: quilt-jev-toolkit src/organ/manifest.mjs
// canonicalJson). Sorted keys, no whitespace, fail-closed on undefined /
// bigint / function / symbol / non-finite numbers. The checkpoint signature
// covers these exact bytes, so byte-equality with the organ implementation is
// load-bearing — tests/seal.test.mjs cross-verifies it.

/** Deterministic JSON: recursively sorted object keys, no whitespace.
 *  Refuses (throws) values with no stable JSON meaning. */
export function canonicalJson(value, _path = '$') {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${_path} (fail-closed; JSON has no stable meaning for undefined)`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${_path}`);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    throw new TypeError(`canonicalJson: bigint at ${_path} (fail-closed; serialize explicitly as string)`);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalJson: ${typeof value} at ${_path} is not serializable (fail-closed)`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalJson(v, `${_path}[${i}]`)).join(',') + ']';
  }
  if (value instanceof Map) {
    return canonicalJson(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])), `${_path}#map`);
  }
  if (value instanceof Set) {
    return canonicalJson([...value.values()], `${_path}#set`);
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k], `${_path}.${k}`)).join(',') + '}';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// The chain: links are organ receipts whose op is the chrono entry
// ---------------------------------------------------------------------------

/** Build one link (organ `makeReceipt` law: hash covers {seq, op, prev}). */
export function entryLink(seq, entry, prevHash) {
  const op = JSON.parse(canonicalJson(entry)); // frozen-safe verbatim copy
  const core = { seq, op, prev: prevHash };
  return { seq, op, prev: prevHash, hash: sha256Hex(canonicalJson(core)) };
}

/** Recompute a link's content hash from its own fields (organ receiptHash). */
export function linkHash(link) {
  return sha256Hex(canonicalJson({ seq: link.seq, op: link.op, prev: link.prev }));
}

/** Pure chain build over entries (a Ledger or a plain entries array). */
export function buildChain(entries) {
  const list = entries && Array.isArray(entries.entries) ? entries.entries : entries;
  if (!Array.isArray(list)) throw ledgerError('CHAIN_BAD_INPUT', 'buildChain needs a Ledger or an entries array');
  const links = [];
  let prev = CHAIN_GENESIS;
  for (let i = 0; i < list.length; i++) {
    const link = entryLink(i, list[i], prev);
    links.push(link);
    prev = link.hash;
  }
  return links;
}

/** The chain tip: last link's hash (bare sha256 hex — the organ checkpoint's
 *  `hash` field is unprefixed hex64). Empty chain has no tip. */
export function chainTip(links) {
  return links.length ? links[links.length - 1].hash : null;
}

/**
 * Verify a contiguous, hash-linked link chain (organ verifyChain law, same
 * codes: CHAIN_GAP / RECEIPT_HASH_MISMATCH). Throws named errors — fail-closed.
 * Returns { ok: true, tipHash, count }.
 */
export function verifyChainLinks(links, { expectedStart = 0, expectedPrev = CHAIN_GENESIS } = {}) {
  if (!Array.isArray(links)) throw ledgerError('CHAIN_GAP', 'links is not an array');
  let expected = expectedPrev;
  for (let i = 0; i < links.length; i++) {
    const r = links[i];
    if (!r || typeof r !== 'object') throw ledgerError('CHAIN_GAP', `link #${i} is not an object`);
    if (r.seq !== expectedStart + i) {
      throw ledgerError('CHAIN_GAP', `seq discontinuity at index ${i}: expected ${expectedStart + i}, got ${JSON.stringify(r.seq)}`);
    }
    if (r.prev !== expected) {
      throw ledgerError('CHAIN_GAP', `prev-hash break at seq ${r.seq}: expected ${expected}, got ${r.prev}`);
    }
    const recomputed = linkHash(r);
    if (recomputed !== r.hash) {
      throw ledgerError('RECEIPT_HASH_MISMATCH', `hash mismatch at seq ${r.seq}: recomputed ${recomputed}, carried ${r.hash}`);
    }
    expected = r.hash;
  }
  return { ok: true, tipHash: expected, count: links.length };
}

// --- sidecar persistence (APPEND-ONLY, original ledger untouched) -----------

/** Sidecar path for a ledger file: ledger.jsonl -> ledger.chain.jsonl. */
export function chainFileFor(ledgerFile) {
  if (typeof ledgerFile !== 'string' || ledgerFile.length === 0) {
    throw ledgerError('CHAIN_BAD_INPUT', 'chainFileFor needs the ledger file path');
  }
  return ledgerFile.endsWith('.jsonl')
    ? ledgerFile.slice(0, -'.jsonl'.length) + CHAIN_SIDECAR_MARKER
    : ledgerFile + CHAIN_SIDECAR_MARKER;
}

/** Read + fully verify a sidecar file. Throws on any broken link. */
export function readChainSidecar(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw ledgerError('CHAIN_SIDECAR_MISSING', `cannot read chain sidecar ${file}: ${e.message}`);
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const links = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw ledgerError('CHAIN_BAD_LINK', `sidecar line ${i + 1} unparseable: ${err.message}`);
    }
  });
  const verdict = verifyChainLinks(links);
  return { links, tipHash: verdict.tipHash };
}

/**
 * Write the sidecar so it covers `links` — APPEND-ONLY by construction:
 *   - an existing sidecar must be BYTE-IDENTICAL to the corresponding prefix
 *     of what we would write (any divergence → CHAIN_REWRITE_REFUSED; we never
 *     rewrite history, fail-closed),
 *   - an existing sidecar must itself verify as a chain before we extend it,
 *   - only the missing tail is appended. The original ledger file is never
 *     opened for writing by this module.
 * Returns { appended, total }.
 */
export function writeChainSidecar(file, links) {
  const wanted = links.map((l) => canonicalJson(l));
  const wantedText = wanted.length ? wanted.join('\n') + '\n' : '';
  let existing = null;
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');

  if (existing !== null) {
    const existingLinks = existing.split('\n').filter((l) => l.trim().length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw ledgerError('CHAIN_BAD_LINK', `sidecar line ${i + 1} unparseable: ${err.message}`);
        }
      });
    verifyChainLinks(existingLinks); // never extend a broken chain
    if (!wantedText.startsWith(existing)) {
      throw ledgerError('CHAIN_REWRITE_REFUSED',
        `sidecar ${file} diverges from the chain the current ledger entries imply — append-only law: refusing to rewrite existing links`);
    }
    const appended = wanted.length - existingLinks.length;
    if (appended < 0) {
      throw ledgerError('CHAIN_REWRITE_REFUSED', `sidecar ${file} carries ${existingLinks.length} links but the ledger implies ${wanted.length} — refusing to truncate`);
    }
    if (appended > 0) fs.appendFileSync(file, wanted.slice(existingLinks.length).join('\n') + '\n', 'utf8');
    return { appended, total: wanted.length };
  }

  fs.writeFileSync(file, wantedText, { encoding: 'utf8', flag: 'wx' }); // create-only
  return { appended: wanted.length, total: wanted.length };
}

// ---------------------------------------------------------------------------
// The prefix custody state (organ snapshot's cells, derived from the ledger)
// ---------------------------------------------------------------------------

/** Fold writes ≤ seq into {cellId: {kind: 'value', value}} — the replay state
 *  a bare ledger can prove. Reads are observations, not transitions (organ
 *  law: cells change only through writes). Deterministic; sorted at use site. */
export function cellsAt(entries, seq) {
  const list = entries && Array.isArray(entries.entries) ? entries.entries : entries;
  if (!Array.isArray(list)) throw ledgerError('SEAL_BAD_INPUT', 'cellsAt needs a Ledger or an entries array');
  if (!Number.isInteger(seq) || seq < 0 || seq >= list.length) {
    throw ledgerError('CHECKPOINT_SEQ_OUT_OF_RANGE', `boundary seq ${JSON.stringify(seq)} outside the carried range [0, ${list.length - 1}]`);
  }
  const cells = {};
  for (let i = 0; i <= seq; i++) {
    const e = list[i];
    if (e.op === 'write') cells[e.cell] = { kind: 'value', value: e.value === undefined ? null : e.value };
  }
  return cells;
}

function sha256Json(value) {
  return sha256Hex(canonicalJson(value));
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Compact fail-closed-at-mint validation of the seal's own manifest (the
 *  closed shape seal() builds). The organ toolkit's validateManifest is the
 *  reference law; the interop test cross-checks equivalence. */
function validateSealManifest(manifest) {
  const errors = [];
  const bad = (d) => errors.push(d);
  if (manifest.schema !== 'quilt.organ.manifest' || manifest.schemaVersion !== 1) {
    bad(`schema drift: ${manifest.schema}/${manifest.schemaVersion}`);
  }
  if (typeof manifest.organId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}@[0-9a-f]{16}$/.test(manifest.organId)) {
    bad(`organId must match name@16hex, got ${JSON.stringify(manifest.organId)}`);
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) bad('name must be a non-empty string');
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) bad('cells must be a non-empty array');
  else for (const c of manifest.cells) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) bad('cell entry missing id');
    else if (typeof c.stateHash !== 'string' || !HEX64.test(c.stateHash)) bad(`cell ${c.id} stateHash not sha256 hex`);
    else if (c.kind !== 'value') bad(`cell ${c.id}: a bare-ledger seal proves values (kind "value"), got ${JSON.stringify(c.kind)}`);
  }
  if (!Array.isArray(manifest.edges)) bad('edges must be an array');
  const rr = manifest.receiptRange;
  if (!rr || !Number.isInteger(rr.start) || !Number.isInteger(rr.end) || !Number.isInteger(rr.count)
      || rr.start !== 0 || rr.end < rr.start || rr.count !== rr.end + 1) {
    bad(`receiptRange inconsistent: ${JSON.stringify(rr)}`);
  }
  if (!manifest.genesis || manifest.genesis.seq !== 0 || manifest.genesis.prevHash !== CHAIN_GENESIS) {
    bad('genesis must be {seq: 0, prevHash: "GENESIS"} for a full-prefix seal');
  }
  if (!manifest.state || !HEX64.test(manifest.state?.cellsSha256 ?? '')) bad('state.cellsSha256 must be sha256 hex');
  if (manifest.supersedes !== null && (typeof manifest.supersedes !== 'string' || !HEX64.test(manifest.supersedes))) {
    bad('supersedes must be null or a sha256 manifestHash');
  }
  if (errors.length) {
    const err = ledgerError('SEAL_MANIFEST_INVALID', `seal produced an invalid manifest (fail-closed): ${errors.join(' | ')}`);
    err.errors = errors;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// seal — mint an organ-checkpoint-EXACT custody anchor for the chrono chain
// ---------------------------------------------------------------------------

/** Resolve {Ledger | entries[]} -> entries array. */
function entriesOf(subject) {
  const list = subject && Array.isArray(subject.entries) ? subject.entries : subject;
  if (!Array.isArray(list)) throw ledgerError('SEAL_BAD_INPUT', 'seal needs a Ledger or an entries array');
  return list;
}

/**
 * Mint a signed custody seal for a chrono ledger (or entries array).
 *
 * @param subject  a Ledger or a plain entries array
 * @param opts {
 *   key         REQUIRED non-empty string|Buffer — the minter's HMAC key
 *   seq         boundary (default: last entry — a checkpoint at the tip is
 *               legal, organ spec §8.4.6)
 *   chainFile   sidecar path; default: chainFileFor(ledger.file) when the
 *               ledger is file-attached, else no sidecar is written
 *   name        organ name (default ledger.name; must match [a-z0-9][a-z0-9._-]*)
 *   organId     carry identity forward from an earlier seal (organ law:
 *               identity is carried, not re-minted)
 *   supersedes  prior seal's manifestHash — honest lineage
 * }
 * @returns { checkpoint, links, chainFile, appended }
 *   `checkpoint` is byte-shape-EXACTLY the organ v2 signed checkpoint —
 *   no chrono-specific fields added (drift is how parallel standards start).
 */
export function seal(subject, opts = {}) {
  const { key, seq = null, chainFile = null, name = null, organId = null, supersedes = null } = opts;
  if (key === undefined || key === null || key === '' || (typeof key === 'object' && key.length === 0)) {
    throw ledgerError('CHECKPOINT_SIGNATURE_REQUIRED', 'seal: signing needs a non-empty key (string or Buffer)');
  }

  const entries = entriesOf(subject);
  if (entries.length === 0) {
    throw ledgerError('SEAL_EMPTY_LEDGER', 'seal: refusing an empty ledger (no custody = no organ — organ snapshot law)');
  }
  const boundary = seq === null ? entries.length - 1 : seq;
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= entries.length) {
    throw ledgerError('CHECKPOINT_SEQ_OUT_OF_RANGE', `checkpoint boundary seq ${JSON.stringify(seq)} is outside the carried range [0, ${entries.length - 1}]`);
  }

  // 1. the chain (extend the sidecar honestly if one is in play)
  const links = buildChain(entries);
  let sidecarFile = chainFile;
  if (sidecarFile === null && subject && subject.file) sidecarFile = chainFileFor(subject.file);
  let appended = 0;
  if (sidecarFile) appended = writeChainSidecar(sidecarFile, links).appended;

  // 2. the prefix custody manifest — quilt.organ.manifest/v1, built to pass
  //    the organ toolkit's own validateManifest (proven by the interop test).
  const cells = cellsAt(entries, boundary);
  const cellIds = Object.keys(cells).sort();
  if (cellIds.length === 0) {
    throw ledgerError('SEAL_EMPTY_LEDGER', `seal: no writes at or below seq ${boundary} — the sealed prefix proves no state`);
  }
  const cellsSha256 = sha256Json(cells);
  const tipHash = links[boundary].hash;
  const organName = name ?? (subject && subject.name) ?? 'chrono';
  if (typeof organName !== 'string' || !NAME_OK.test(organName)) {
    throw ledgerError('SEAL_BAD_NAME', `organ name must match ${NAME_OK} (lowercase id the manifest law can carry), got ${JSON.stringify(organName)}`);
  }
  const oid = organId ?? `${organName}@${sha256Json({ name: organName, material: { cellsSha256, tipHash, startSeq: 0, genesisPrevHash: CHAIN_GENESIS } }).slice(0, 16)}`;

  const manifest = {
    schema: 'quilt.organ.manifest',
    schemaVersion: 1,
    organId: oid,
    name: organName,
    cells: cellIds.map((id) => ({ id, kind: 'value', stateHash: sha256Json({ kind: 'value', value: cells[id].value }) })),
    edges: [], // a bare-ledger seal proves values; flow edges are a projection concern (DESIGN.md §4b)
    receiptRange: { start: 0, end: boundary, count: boundary + 1 },
    genesis: { seq: 0, prevHash: CHAIN_GENESIS },
    state: { cellsSha256 },
    supersedes: supersedes ?? null,
  };
  validateSealManifest(manifest);
  const manifestHash = sha256Json(manifest);
  manifest.manifestHash = manifestHash;

  // 3. the signed checkpoint — organ v2 EXACT: HMAC-SHA256 over
  //    canonical({hash, manifestHash, seq}) (boot.mjs checkpointSigningPayload).
  const cp = {
    schema: 'quilt.organ.checkpoint',
    schemaVersion: 1,
    alg: 'HMAC-SHA256',
    seq: boundary,
    hash: tipHash,
    manifestHash,
  };
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  cp.sig = crypto.createHmac('sha256', k).update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
  cp.manifest = JSON.parse(canonicalJson(manifest));

  return { checkpoint: cp, links, chainFile: sidecarFile, appended };
}

// ---------------------------------------------------------------------------
// verify — the courtroom, before anything boots
// ---------------------------------------------------------------------------

/**
 * Verify a sealed checkpoint's structure + signature (organ boot.mjs
 * verifySignedCheckpoint law — same codes, same bytes):
 *   CHECKPOINT_SIGNATURE_REQUIRED / CHECKPOINT_MALFORMED /
 *   CHECKPOINT_SIGNATURE_INVALID.
 * Returns { ok: true, seq, chainTip, manifestHash }.
 */
export function verifySeal(cp, key) {
  if (key === undefined || key === null || key === '' || (typeof key === 'object' && key.length === 0)) {
    throw ledgerError('CHECKPOINT_SIGNATURE_REQUIRED', 'no usable checkpoint key was provided — an HMAC signature cannot verify without it');
  }
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
    throw ledgerError('CHECKPOINT_MALFORMED', 'checkpoint is not an object');
  }
  if (cp.schema !== 'quilt.organ.checkpoint' || cp.schemaVersion !== 1) {
    throw ledgerError('CHECKPOINT_MALFORMED', `checkpoint schema ${JSON.stringify(cp.schema)}/${JSON.stringify(cp.schemaVersion)} not implemented (knows only quilt.organ.checkpoint/1)`);
  }
  if (cp.alg !== 'HMAC-SHA256') {
    throw ledgerError('CHECKPOINT_MALFORMED', `checkpoint alg ${JSON.stringify(cp.alg)} not implemented (knows only HMAC-SHA256; Ed25519 is the organ v3 path)`);
  }
  if (!Number.isInteger(cp.seq) || cp.seq < 0) {
    throw ledgerError('CHECKPOINT_MALFORMED', `checkpoint seq must be a non-negative integer, got ${JSON.stringify(cp.seq)}`);
  }
  for (const field of ['hash', 'manifestHash', 'sig']) {
    if (typeof cp[field] !== 'string' || !HEX64.test(cp[field])) {
      throw ledgerError('CHECKPOINT_MALFORMED', `checkpoint ${field} missing or not sha256 hex`);
    }
  }
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  const expected = crypto.createHmac('sha256', k).update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
  if (expected !== cp.sig) {
    throw ledgerError('CHECKPOINT_SIGNATURE_INVALID', 'HMAC does not verify under the provided key — forged signature, tampered signed fields, or wrong key');
  }
  return { ok: true, seq: cp.seq, chainTip: cp.hash, manifestHash: cp.manifestHash };
}

/**
 * Full custody verification — call BEFORE booting from a sealed history:
 *   1. verifySeal (structure + HMAC under the verifier's key)
 *   2. the chain source verifies (every link re-hashes; CHAIN_GAP /
 *      RECEIPT_HASH_MISMATCH at the first broken offset — any tamper, any
 *      offset, named)
 *   3. the chain tip at cp.seq IS cp.hash (CHECKPOINT_ANCHOR_MISMATCH — the
 *      signature pins this exact boundary; a re-hashed forgery chain lands
 *      here, matching organ spec §8's "honest scope of the anchor")
 *   4. the carried prefix manifest re-hashes to the SIGNED manifestHash and
 *      obeys manifest law (CHECKPOINT_ANCHOR_MISMATCH / SEAL_MANIFEST_INVALID)
 *   5. replaying the entries the chain carries, writes only, reproduces the
 *      manifest's cell hashes (CHECKPOINT_SEED_MISMATCH — state tamper)
 *   6. if `entries`/`ledger` given: the sidecar must describe THAT ledger
 *      entry-for-entry (CHAIN_ENTRY_MISMATCH), and the boundary must be
 *      within it (CHECKPOINT_SEQ_BEYOND_RECEIPTS)
 *
 * @param cp     the sealed checkpoint (organ v2 shape)
 * @param key    the verifier's key — same secret the minter used (HMAC)
 * @param src    { links | chainFile, entries | ledger } — at least one chain
 *               source is required; entries are the optional second witness
 * @returns { ok, seq, chainTip, manifestHash, cells } — `cells` is the
 *          signature-anchored replay state (the organ boot seed's content)
 */
export function verifyCustody(cp, key, src = {}) {
  const verdict = verifySeal(cp, key);

  const links = src.links ?? (src.chainFile ? readChainSidecar(src.chainFile).links : null);
  if (!links) {
    throw ledgerError('SEAL_NO_CHAIN_SOURCE', 'verifyCustody needs a chain source (links or chainFile) — a signature alone proves nothing');
  }
  verifyChainLinks(links);

  if (cp.seq >= links.length) {
    throw ledgerError('CHECKPOINT_SEQ_BEYOND_RECEIPTS', `checkpoint anchors seq ${cp.seq}, beyond the carried chain (last link seq ${links.length - 1})`);
  }
  if (links[cp.seq].hash !== cp.hash) {
    throw ledgerError('CHECKPOINT_ANCHOR_MISMATCH', `checkpoint pins chainTip ${cp.hash} at seq ${cp.seq}, but the verified chain carries ${links[cp.seq].hash} — wrong chain, wrong boundary, or a re-hashed forgery`);
  }

  // the anchor manifest: content-addressed to the SIGNED manifestHash
  const anchor = cp.manifest;
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    throw ledgerError('CHECKPOINT_ANCHOR_MISMATCH', 'signed checkpoint carries no prefix manifest — the sealed state cannot be anchored');
  }
  const carried = { ...anchor };
  const carriedHash = carried.manifestHash;
  delete carried.manifestHash;
  if (carriedHash !== cp.manifestHash || sha256Json(carried) !== cp.manifestHash) {
    throw ledgerError('CHECKPOINT_ANCHOR_MISMATCH', `checkpoint prefix manifest does not re-hash to the signed manifestHash ${cp.manifestHash} — swapped or tampered anchor`);
  }
  validateSealManifest(carried);

  // replay the prefix from the chain itself: writes only, up to cp.seq
  const cells = {};
  for (let i = 0; i <= cp.seq; i++) {
    const e = links[i].op;
    if (e && e.op === 'write' && typeof e.cell === 'string') {
      cells[e.cell] = { kind: 'value', value: e.value === undefined ? null : e.value };
    }
  }
  const cellsSha256 = sha256Json(cells);
  if (cellsSha256 !== anchor.state.cellsSha256) {
    throw ledgerError('CHECKPOINT_SEED_MISMATCH', `replay of the chain's writes produces ${cellsSha256}, the signature-anchored prefix state claims ${anchor.state.cellsSha256}`);
  }
  for (const c of anchor.cells) {
    if (!cells[c.id] || sha256Json({ kind: 'value', value: cells[c.id].value }) !== c.stateHash) {
      throw ledgerError('CHECKPOINT_SEED_MISMATCH', `cell ${c.id}: replayed state does not match the anchored stateHash — seed tamper`);
    }
  }

  // second witness: the sidecar must describe the caller's ledger exactly
  const entries = src.entries ?? (src.ledger ? entriesOf(src.ledger) : null);
  if (entries) {
    if (cp.seq >= entries.length) {
      throw ledgerError('CHECKPOINT_SEQ_BEYOND_RECEIPTS', `checkpoint anchors seq ${cp.seq}, beyond the carried ledger (last entry seq ${entries.length - 1})`);
    }
    for (let i = 0; i <= cp.seq; i++) {
      if (canonicalJson(links[i].op) !== canonicalJson(entries[i])) {
        throw ledgerError('CHAIN_ENTRY_MISMATCH', `sidecar link at seq ${i} no longer describes the ledger entry it was built from — the chain and the ledger have diverged`);
      }
    }
  }

  return { ...verdict, cells };
}
