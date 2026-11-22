import { sodium, utf8, concat, u64be, wipe } from './util';

/**
 * Key derivation.
 *
 * GhostChat uses keyed BLAKE2b as a PRF rather than HKDF-SHA256. BLAKE2b is
 * native to libsodium (so we do not need a second hash implementation in the
 * browser) and keyed BLAKE2b is a standard PRF construction. Every derivation
 * is domain-separated by a distinct ASCII label; mixing labels would break the
 * security proof, so they are centralised here and never inlined at call sites.
 */

export const LABELS = {
  identityDh: 'ghostchat/id-dh/v1',
  sessionTag: 'ghostchat/sess-tag/v1',
  rootChain: 'ghostchat/root/v1',
  messageKey: 'ghostchat/msg-key/v1',
  chainAdvance: 'ghostchat/chain/v1',
  x3dh: 'ghostchat/x3dh/v1',
  senderKeyMsg: 'ghostchat/sk-msg/v1',
  senderKeyChain: 'ghostchat/sk-chain/v1',
  mediaKey: 'ghostchat/media-key/v1',
  vaultKey: 'ghostchat/vault/v1',
  adminToken: 'ghostchat/admin-token/v1',
} as const;

/** Keyed BLAKE2b with mandatory domain separation. */
export function kdf(
  key: Uint8Array,
  label: string,
  length = 32,
  context?: Uint8Array,
): Uint8Array {
  if (key.length < 16) throw new Error('kdf: key material too short');
  if (length < 16 || length > 64) throw new Error('kdf: invalid output length');
  return sodium.crypto_generichash(length, concat(utf8(label), context ?? null), key);
}

/**
 * Symmetric ratchet step.
 *
 *   messageKey_i   = PRF(chainKey_i, "msg-key")
 *   chainKey_{i+1} = PRF(chainKey_i, "chain")
 *
 * The chain key is destroyed by the caller once advanced: possession of
 * chainKey_{i+1} must never allow recovery of messageKey_i.
 */
export function chainStep(chainKey: Uint8Array): {
  messageKey: Uint8Array;
  nextChainKey: Uint8Array;
} {
  const messageKey = kdf(chainKey, LABELS.messageKey, 32);
  const nextChainKey = kdf(chainKey, LABELS.chainAdvance, 32);
  return { messageKey, nextChainKey };
}

/**
 * DH ratchet step: fold a fresh DH output into the root key.
 * Returns 64 bytes split into a new root key and a new chain key, which is the
 * standard `KDF_RK` from the Double Ratchet specification.
 */
export function rootStep(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const out = kdf(rootKey, LABELS.rootChain, 64, dhOutput);
  const nextRoot = out.slice(0, 32);
  const chainKey = out.slice(32, 64);
  wipe(out);
  return { rootKey: nextRoot, chainKey };
}

/**
 * Deterministic 24-byte nonce for a message counter.
 *
 * Safe precisely because every message key is single-use: nonce reuse would
 * require key reuse, and the ratchet forbids that. Using a counter (instead of
 * random bytes) removes any dependence on the quality of the RNG at send time.
 */
export function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce.set(u64be(counter), 16);
  return nonce;
}

/** libsodium's BLAKE2b-based KDF, used where a fixed 8-byte context is required. */
export function subkey(key: Uint8Array, id: number, context: string, length = 32): Uint8Array {
  if (context.length !== 8) throw new Error('subkey: context must be exactly 8 chars');
  return sodium.crypto_kdf_derive_from_key(length, id, context, key);
}
