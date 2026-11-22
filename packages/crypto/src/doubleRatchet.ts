import {
  sodium,
  ready,
  b64e,
  b64d,
  concat,
  u32be,
  readU32be,
  wipe,
  equalConstantTime,
} from './util';
import { chainStep, rootStep, nonceFor, kdf, LABELS } from './kdf';
import { aeadSeal, aeadOpen } from './secretbox';
import type { KeyPair } from './keys';
import { sessionTagFromSecret } from './x3dh';

/**
 * Double Ratchet — symmetric (hash) ratchet + DH ratchet, per Signal's spec.
 *
 * Security properties:
 *   - Forward secrecy: deleting chain keys on advance means a compromise of the
 *     current state cannot decrypt earlier messages.
 *   - Post-compromise security / break-in recovery: each DH ratchet step folds
 *     fresh DH entropy into the root key, so an attacker who steals the state
 *     loses the ability to read the conversation once the peer replies.
 *   - Out-of-order delivery: message keys for skipped messages are retained
 *     (bounded) instead of failing the whole conversation.
 *
 * Implementation notes:
 *   - Every message is encrypted under a single-use key with
 *     XChaCha20-Poly1305; the encoded header is the associated data, so a
 *     ciphertext cannot be replayed onto a different header.
 *   - Decryption runs against a clone and commits only on success. A corrupted
 *     or forged packet therefore cannot desynchronise the ratchet (a trivial
 *     DoS otherwise).
 *   - Skipped-key retention is capped; exceeding the cap is a hard error rather
 *     than unbounded memory growth (again, a DoS vector).
 */

export const MAX_SKIP = 512;
export const MAX_SKIP_STORED = 1024;
const HEADER_BYTES = 1 + 32 + 4 + 4;
const HEADER_VERSION = 1;

export interface RatchetHeader {
  /** Sender's current DH ratchet public key. */
  dh: Uint8Array;
  /** Number of messages in the previous sending chain (for skip-ahead). */
  pn: number;
  /** Message number within the current sending chain. */
  n: number;
}

export interface RatchetState {
  version: 1;
  rootKey: Uint8Array;
  dhSelf: KeyPair;
  dhRemote: Uint8Array | null;
  sendChain: Uint8Array | null;
  recvChain: Uint8Array | null;
  nSend: number;
  nRecv: number;
  pn: number;
  /** `${b64(dhRemotePub)}:${n}` -> message key. */
  skipped: Map<string, Uint8Array>;
  /** Opaque 16-byte pairwise session locator; identical for both peers. */
  sessionTag: Uint8Array;
}

export interface RatchetMessage {
  header: Uint8Array;
  ciphertext: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* Header codec                                                                */
/* -------------------------------------------------------------------------- */

export function encodeHeader(header: RatchetHeader): Uint8Array {
  return concat(
    new Uint8Array([HEADER_VERSION]),
    header.dh,
    u32be(header.pn),
    u32be(header.n),
  );
}

export function decodeHeader(bytes: Uint8Array): RatchetHeader {
  if (bytes.length !== HEADER_BYTES) throw new Error('ratchet: malformed header');
  if (bytes[0] !== HEADER_VERSION) throw new Error('ratchet: unsupported header version');
  return {
    dh: bytes.slice(1, 33),
    pn: readU32be(bytes, 33),
    n: readU32be(bytes, 37),
  };
}

/* -------------------------------------------------------------------------- */
/* Initialisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Initiator (Alice). She already knows Bob's signed pre-key from the bundle, so
 * she can derive a sending chain immediately and encrypt her first message
 * without waiting for a round trip.
 */
export function ratchetInitInitiator(
  sharedSecret: Uint8Array,
  responderSignedPreKeyPublic: Uint8Array,
): RatchetState {
  const dhSelf = sodium.crypto_box_keypair();
  const dhOut = sodium.crypto_scalarmult(dhSelf.privateKey, responderSignedPreKeyPublic);
  const step = rootStep(sharedSecret, dhOut);
  wipe(dhOut);

  return {
    version: 1,
    rootKey: step.rootKey,
    dhSelf,
    dhRemote: responderSignedPreKeyPublic.slice(),
    sendChain: step.chainKey,
    recvChain: null,
    nSend: 0,
    nRecv: 0,
    pn: 0,
    skipped: new Map(),
    sessionTag: sessionTagFromSecret(sharedSecret),
  };
}

/**
 * Responder (Bob). He starts with no sending chain: Double Ratchet requires him
 * to receive Alice's first message (which carries her ratchet key) before he can
 * send. Callers should surface this as "establishing session…" in the UI.
 */
export function ratchetInitResponder(
  sharedSecret: Uint8Array,
  signedPreKey: KeyPair,
): RatchetState {
  return {
    version: 1,
    rootKey: sharedSecret.slice(),
    dhSelf: {
      publicKey: signedPreKey.publicKey.slice(),
      privateKey: signedPreKey.privateKey.slice(),
    },
    dhRemote: null,
    sendChain: null,
    recvChain: null,
    nSend: 0,
    nRecv: 0,
    pn: 0,
    skipped: new Map(),
    sessionTag: sessionTagFromSecret(sharedSecret),
  };
}

/* -------------------------------------------------------------------------- */
/* Encryption                                                                  */
/* -------------------------------------------------------------------------- */

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): Promise<RatchetMessage> {
  await ready();
  if (!state.sendChain) {
    throw new Error('ratchet: sending chain not established (await peer message)');
  }

  const { messageKey, nextChainKey } = chainStep(state.sendChain);
  const header = encodeHeader({ dh: state.dhSelf.publicKey, pn: state.pn, n: state.nSend });

  try {
    const ciphertext = aeadSeal(messageKey, plaintext, nonceFor(state.nSend), header);
    // Advancing the chain destroys the key that produced this ciphertext.
    wipe(state.sendChain);
    state.sendChain = nextChainKey;
    state.nSend += 1;
    return { header, ciphertext };
  } finally {
    wipe(messageKey);
  }
}

/* -------------------------------------------------------------------------- */
/* Decryption                                                                  */
/* -------------------------------------------------------------------------- */

export async function ratchetDecrypt(
  state: RatchetState,
  headerBytes: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  const header = decodeHeader(headerBytes);

  // Work on a clone: a forged packet must not be able to advance our ratchet.
  const draft = cloneState(state);
  const plaintext = decryptInto(draft, header, headerBytes, ciphertext);
  commitState(state, draft);
  return plaintext;
}

function decryptInto(
  state: RatchetState,
  header: RatchetHeader,
  headerBytes: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const skipKey = `${b64e(header.dh)}:${header.n}`;
  const retained = state.skipped.get(skipKey);
  if (retained) {
    state.skipped.delete(skipKey);
    const plaintext = aeadOpen(retained, ciphertext, nonceFor(header.n), headerBytes);
    wipe(retained);
    return plaintext;
  }

  const isNewRatchetKey = !state.dhRemote || !equalConstantTime(header.dh, state.dhRemote);
  if (isNewRatchetKey) {
    // Catch up the tail of the previous receiving chain before switching.
    skipMessageKeys(state, header.pn);
    dhRatchet(state, header.dh);
  }

  skipMessageKeys(state, header.n);

  if (!state.recvChain) throw new Error('ratchet: no receiving chain');
  const { messageKey, nextChainKey } = chainStep(state.recvChain);
  wipe(state.recvChain);
  state.recvChain = nextChainKey;
  state.nRecv += 1;

  try {
    return aeadOpen(messageKey, ciphertext, nonceFor(header.n), headerBytes);
  } finally {
    wipe(messageKey);
  }
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (until < state.nRecv) return;
  if (until - state.nRecv > MAX_SKIP) {
    throw new Error(`ratchet: refusing to skip ${until - state.nRecv} messages`);
  }
  if (!state.recvChain) {
    if (until === 0) return;
    throw new Error('ratchet: cannot skip without a receiving chain');
  }
  if (!state.dhRemote) throw new Error('ratchet: cannot skip without a remote key');

  let chain = state.recvChain;
  for (let n = state.nRecv; n < until; n++) {
    const { messageKey, nextChainKey } = chainStep(chain);
    state.skipped.set(`${b64e(state.dhRemote)}:${n}`, messageKey);
    wipe(chain);
    chain = nextChainKey;
  }
  state.recvChain = chain;
  state.nRecv = until;

  // Bound memory: drop the oldest retained keys first (insertion order).
  while (state.skipped.size > MAX_SKIP_STORED) {
    const oldest = state.skipped.keys().next();
    if (oldest.done) break;
    const key = state.skipped.get(oldest.value);
    if (key) wipe(key);
    state.skipped.delete(oldest.value);
  }
}

function dhRatchet(state: RatchetState, remoteDh: Uint8Array): void {
  state.pn = state.nSend;
  state.nSend = 0;
  state.nRecv = 0;

  if (state.recvChain) wipe(state.recvChain);
  if (state.dhRemote) wipe(state.dhRemote);
  state.dhRemote = remoteDh.slice();

  // Receiving chain from our current ratchet key + their new key.
  const dhRecv = sodium.crypto_scalarmult(state.dhSelf.privateKey, remoteDh);
  const recvStep = rootStep(state.rootKey, dhRecv);
  wipe(dhRecv);
  wipe(state.rootKey);
  state.rootKey = recvStep.rootKey;
  state.recvChain = recvStep.chainKey;

  // Fresh ratchet key pair for the next sending chain.
  const fresh = sodium.crypto_box_keypair();
  const dhSend = sodium.crypto_scalarmult(fresh.privateKey, remoteDh);
  const sendStep = rootStep(state.rootKey, dhSend);
  wipe(dhSend);
  wipe(state.rootKey);
  state.rootKey = sendStep.rootKey;
  if (state.sendChain) wipe(state.sendChain);
  state.sendChain = sendStep.chainKey;
  state.dhSelf = fresh;
}

/* -------------------------------------------------------------------------- */
/* State management                                                            */
/* -------------------------------------------------------------------------- */

export function cloneState(state: RatchetState): RatchetState {
  return {
    ...state,
    rootKey: state.rootKey.slice(),
    dhSelf: {
      publicKey: state.dhSelf.publicKey.slice(),
      privateKey: state.dhSelf.privateKey.slice(),
    },
    dhRemote: state.dhRemote ? state.dhRemote.slice() : null,
    sendChain: state.sendChain ? state.sendChain.slice() : null,
    recvChain: state.recvChain ? state.recvChain.slice() : null,
    skipped: new Map([...state.skipped].map(([k, v]) => [k, v.slice()])),
    sessionTag: state.sessionTag.slice(),
  };
}

function commitState(target: RatchetState, source: RatchetState): void {
  Object.assign(target, source);
}

export interface SerializedRatchetState {
  version: 1;
  rootKey: string;
  dhSelf: { publicKey: string; privateKey: string };
  dhRemote: string | null;
  sendChain: string | null;
  recvChain: string | null;
  nSend: number;
  nRecv: number;
  pn: number;
  sessionTag: string;
  skipped: Array<[string, string]>;
}

/** JSON-safe form for the encrypted local vault (never sent to the server). */
export function serializeState(state: RatchetState): SerializedRatchetState {
  return {
    version: 1,
    rootKey: b64e(state.rootKey),
    dhSelf: { publicKey: b64e(state.dhSelf.publicKey), privateKey: b64e(state.dhSelf.privateKey) },
    dhRemote: state.dhRemote ? b64e(state.dhRemote) : null,
    sendChain: state.sendChain ? b64e(state.sendChain) : null,
    recvChain: state.recvChain ? b64e(state.recvChain) : null,
    nSend: state.nSend,
    nRecv: state.nRecv,
    pn: state.pn,
    sessionTag: b64e(state.sessionTag),
    skipped: [...state.skipped].map(([k, v]) => [k, b64e(v)]),
  };
}

export function deserializeState(input: SerializedRatchetState): RatchetState {
  return {
    version: 1,
    rootKey: b64d(input.rootKey),
    dhSelf: { publicKey: b64d(input.dhSelf.publicKey), privateKey: b64d(input.dhSelf.privateKey) },
    dhRemote: input.dhRemote ? b64d(input.dhRemote) : null,
    sendChain: input.sendChain ? b64d(input.sendChain) : null,
    recvChain: input.recvChain ? b64d(input.recvChain) : null,
    nSend: input.nSend,
    nRecv: input.nRecv,
    pn: input.pn,
    sessionTag: b64d(input.sessionTag),
    skipped: new Map(input.skipped.map(([k, v]) => [k, b64d(v)])),
  };
}

export function destroyState(state: RatchetState): void {
  wipe(state.rootKey, state.dhSelf.privateKey, state.dhRemote, state.sendChain, state.recvChain);
  for (const key of state.skipped.values()) wipe(key);
  state.skipped.clear();
}

/** Exposed for the UI: "safety number" style verification for a pairwise chat. */
export function sessionFingerprint(state: RatchetState): string {
  return b64e(kdf(state.rootKey, LABELS.sessionTag, 20)).slice(0, 24).toUpperCase();
}
