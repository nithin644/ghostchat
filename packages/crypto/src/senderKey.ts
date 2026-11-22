import { sodium, ready, b64e, b64d, concat, u32be, readU32be, wipe, randomBytes, utf8 } from './util';
import { kdf, nonceFor, LABELS } from './kdf';
import { secretboxSeal, secretboxOpen } from './secretbox';
import { signDetached, verifyDetached } from './keys';

/**
 * Sender Keys — the group-messaging construction used by Signal.
 *
 * Each member owns one "sender key" (a symmetric chain plus an Ed25519 signing
 * key) and distributes it to the other members over their existing pairwise
 * Double Ratchet sessions. A group message is then encrypted once, with the
 * sender's own chain, instead of N times.
 *
 * Consequences worth stating plainly:
 *   - Group E2EE hides content, not membership. The server must know the member
 *     list to route, and every member can read everything.
 *   - A member who leaves keeps the sender keys they already have; the group
 *     must rotate keys after a removal for forward secrecy against that member.
 *     `GroupService.removeMember` flips a `keyEpoch` counter for exactly this
 *     reason and clients redistribute Sender Keys when it changes.
 *   - Out-of-order delivery is handled by retaining skipped message keys, as
 *     with the pairwise ratchet.
 */

export const MAX_SENDER_KEY_SKIP = 2000;

export interface SenderKeyState {
  /** 8-byte random identifier, unique per (sender, epoch). */
  keyId: string;
  chainKey: Uint8Array;
  iteration: number;
  signingKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
}

export interface ReceiverKeyState {
  keyId: string;
  chainKey: Uint8Array;
  iteration: number;
  signingPublicKey: Uint8Array;
  skipped: Map<number, Uint8Array>;
}

export interface SenderKeyMessage {
  /** keyId(8) || iteration(4) || signingPublicKey(32) */
  header: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}

export async function createSenderKey(): Promise<SenderKeyState> {
  await ready();
  return {
    keyId: b64e(randomBytes(8)),
    chainKey: randomBytes(32),
    iteration: 0,
    signingKeyPair: sodium.crypto_sign_keypair(),
  };
}

/** Payload distributed to other members inside their pairwise session. */
export async function exportSenderKeyDistribution(
  state: SenderKeyState,
): Promise<Uint8Array> {
  const json = JSON.stringify({
    v: 1,
    keyId: state.keyId,
    chainKey: b64e(state.chainKey),
    iteration: state.iteration,
    signingPublicKey: b64e(state.signingKeyPair.publicKey),
  });
  return utf8(json);
}

export async function importSenderKeyDistribution(payload: Uint8Array): Promise<ReceiverKeyState> {
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
    v: number;
    keyId: string;
    chainKey: string;
    iteration: number;
    signingPublicKey: string;
  };
  if (parsed.v !== 1) throw new Error('sender key: unsupported distribution version');
  return {
    keyId: parsed.keyId,
    chainKey: b64d(parsed.chainKey),
    iteration: parsed.iteration,
    signingPublicKey: b64d(parsed.signingPublicKey),
    skipped: new Map(),
  };
}

function encodeSenderKeyHeader(keyId: string, iteration: number, signingPublicKey: Uint8Array): Uint8Array {
  return concat(b64d(keyId), u32be(iteration), signingPublicKey);
}

interface DecodedSenderKeyHeader {
  keyId: string;
  iteration: number;
  signingPublicKey: Uint8Array;
}

function decodeSenderKeyHeader(bytes: Uint8Array): DecodedSenderKeyHeader {
  if (bytes.length !== 8 + 4 + 32) throw new Error('sender key: malformed header');
  return {
    keyId: b64e(bytes.slice(0, 8)),
    iteration: readU32be(bytes, 8),
    signingPublicKey: bytes.slice(12, 44),
  };
}

export async function senderKeyEncrypt(
  state: SenderKeyState,
  plaintext: Uint8Array,
): Promise<SenderKeyMessage> {
  await ready();
  const messageKey = kdf(state.chainKey, LABELS.senderKeyMsg, 32);
  const nextChainKey = kdf(state.chainKey, LABELS.senderKeyChain, 32);
  const header = encodeSenderKeyHeader(state.keyId, state.iteration, state.signingKeyPair.publicKey);

  let ciphertext: Uint8Array;
  try {
    ciphertext = secretboxSeal(messageKey, plaintext, nonceFor(state.iteration)).ciphertext;
  } finally {
    wipe(messageKey);
  }

  // Sign header || ciphertext so a member cannot attribute a forged message to
  // another member, and cannot splice a valid ciphertext onto a different header.
  const signature = signDetached(concat(header, ciphertext), state.signingKeyPair.privateKey);

  wipe(state.chainKey);
  state.chainKey = nextChainKey;
  state.iteration += 1;

  return { header, ciphertext, signature };
}

export async function senderKeyDecrypt(
  state: ReceiverKeyState,
  headerBytes: Uint8Array,
  ciphertext: Uint8Array,
  signature: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  const header = decodeSenderKeyHeader(headerBytes);

  if (header.keyId !== state.keyId) throw new Error('sender key: unknown key id');
  if (!verifyDetached(signature, concat(headerBytes, ciphertext), state.signingPublicKey)) {
    throw new Error('sender key: signature verification failed');
  }

  const draft = cloneReceiverState(state);

  // Late message that we already skipped: use the retained key once.
  const retained = draft.skipped.get(header.iteration);
  if (retained) {
    draft.skipped.delete(header.iteration);
    const plaintext = secretboxOpen(retained, { nonce: nonceFor(header.iteration), ciphertext });
    wipe(retained);
    commitReceiverState(state, draft);
    return plaintext;
  }

  if (header.iteration < draft.iteration) {
    throw new Error('sender key: message key already consumed');
  }
  if (header.iteration - draft.iteration > MAX_SENDER_KEY_SKIP) {
    throw new Error('sender key: too many skipped messages');
  }

  let chain = draft.chainKey;
  for (let i = draft.iteration; i < header.iteration; i++) {
    const mk = kdf(chain, LABELS.senderKeyMsg, 32);
    draft.skipped.set(i, mk);
    const next = kdf(chain, LABELS.senderKeyChain, 32);
    wipe(chain);
    chain = next;
  }

  const messageKey = kdf(chain, LABELS.senderKeyMsg, 32);
  const nextChainKey = kdf(chain, LABELS.senderKeyChain, 32);
  wipe(chain);
  wipe(draft.chainKey);
  draft.chainKey = nextChainKey;
  draft.iteration = header.iteration + 1;

  if (draft.skipped.size > MAX_SENDER_KEY_SKIP) {
    const oldest = draft.skipped.keys().next();
    if (!oldest.done && draft.skipped.has(oldest.value)) {
      wipe(draft.skipped.get(oldest.value)!);
      draft.skipped.delete(oldest.value);
    }
  }

  try {
    const plaintext = secretboxOpen(messageKey, {
      nonce: nonceFor(header.iteration),
      ciphertext,
    });
    commitReceiverState(state, draft);
    return plaintext;
  } finally {
    wipe(messageKey);
  }
}

function cloneReceiverState(state: ReceiverKeyState): ReceiverKeyState {
  return {
    ...state,
    chainKey: state.chainKey.slice(),
    signingPublicKey: state.signingPublicKey.slice(),
    skipped: new Map([...state.skipped].map(([k, v]) => [k, v.slice()])),
  };
}

function commitReceiverState(target: ReceiverKeyState, source: ReceiverKeyState): void {
  Object.assign(target, source);
}

export interface SerializedSenderKeyState {
  keyId: string;
  chainKey: string;
  iteration: number;
  signingPublicKey: string;
  signingPrivateKey: string;
}

export function serializeSenderKey(state: SenderKeyState): SerializedSenderKeyState {
  return {
    keyId: state.keyId,
    chainKey: b64e(state.chainKey),
    iteration: state.iteration,
    signingPublicKey: b64e(state.signingKeyPair.publicKey),
    signingPrivateKey: b64e(state.signingKeyPair.privateKey),
  };
}

export function deserializeSenderKey(input: SerializedSenderKeyState): SenderKeyState {
  return {
    keyId: input.keyId,
    chainKey: b64d(input.chainKey),
    iteration: input.iteration,
    signingKeyPair: {
      publicKey: b64d(input.signingPublicKey),
      privateKey: b64d(input.signingPrivateKey),
    },
  };
}
