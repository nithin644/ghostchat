import { sodium, ready, randomBytes, utf8, concat, b64e, b64d, wipe } from './util';
import { DEFAULT_ARGON2, type Argon2Params } from './keys';

/**
 * Two AEADs are used, deliberately:
 *
 *  - `secretbox` (XSalsa20-Poly1305, 24-byte nonce, no AD) for opaque blobs
 *    where the nonce is carried out-of-band: vault records, wrapped keys,
 *    sender-key payloads.
 *
 *  - XChaCha20-Poly1305-IETF with associated data for ratchet messages. Binding
 *    the ratchet header (DH pubkey + counters) as AD is what stops an attacker
 *    from splicing a valid ciphertext onto a different header; the plain
 *    secretbox API cannot do that.
 *
 * Both are misuse-resistant families, and both take 24-byte nonces, so callers
 * can share nonce-handling code.
 */

// Fixed by the algorithms themselves. Declared as literals because libsodium's
// constants are only populated after `await ready()`, and these are used in
// argument validation that runs before that.
export const NONCE_BYTES = 24; // XSalsa20-Poly1305 & XChaCha20-Poly1305-IETF
export const KEY_BYTES = 32;

export interface SealedBox {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* crypto_secretbox (no associated data)                                       */
/* -------------------------------------------------------------------------- */

export function secretboxSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): SealedBox {
  if (key.length !== KEY_BYTES) throw new Error('secretbox: key must be 32 bytes');
  if (nonce.length !== NONCE_BYTES) throw new Error('secretbox: nonce must be 24 bytes');
  return { nonce: nonce.slice(), ciphertext: sodium.crypto_secretbox_easy(plaintext, nonce, key) };
}

export function secretboxOpen(key: Uint8Array, box: SealedBox): Uint8Array {
  // libsodium-wrappers either returns false or throws depending on the build;
  // normalise both into one non-oracular error so callers can rely on it.
  try {
    const opened = sodium.crypto_secretbox_open_easy(box.ciphertext, box.nonce, key);
    if (!opened) throw new Error('secretbox: authentication failed');
    return opened;
  } catch {
    throw new Error('secretbox: authentication failed');
  }
}

/* -------------------------------------------------------------------------- */
/* XChaCha20-Poly1305-IETF (with associated data)                              */
/* -------------------------------------------------------------------------- */

export function aeadSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  associatedData?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error('aead: key must be 32 bytes');
  if (nonce.length !== 24) throw new Error('aead: nonce must be 24 bytes');
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData ?? null,
    null,
    nonce,
    key,
  );
}

export function aeadOpen(
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  associatedData?: Uint8Array,
): Uint8Array {
  try {
    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData ?? null,
      nonce,
      key,
    );
    if (!opened) throw new Error('aead: authentication failed');
    return opened;
  } catch {
    throw new Error('aead: authentication failed');
  }
}

/* -------------------------------------------------------------------------- */
/* Sealed boxes (anonymous public-key encryption)                              */
/* -------------------------------------------------------------------------- */

/**
 * `crypto_box_seal` — an ephemeral X25519 key is generated per message and the
 * recipient can decrypt without learning who wrote it. This is the primitive
 * behind sealed sender.
 */
export function sealToPublicKey(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  return sodium.crypto_box_seal(plaintext, recipientPublicKey);
}

export function openSealedBox(
  ciphertext: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  try {
    const opened = sodium.crypto_box_seal_open(ciphertext, recipientPublicKey, recipientPrivateKey);
    if (!opened) throw new Error('sealed box: authentication failed');
    return opened;
  } catch {
    throw new Error('sealed box: authentication failed');
  }
}

/* -------------------------------------------------------------------------- */
/* Password / vault wrapping                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a secret with a passphrase or access key.
 *
 * Used for the local vault: the identity seed is sealed under a key derived
 * from the access key so a stolen IndexedDB dump is useless without it. The
 * KDF parameters are stored alongside the ciphertext so they can be raised
 * later without breaking existing vaults.
 */
export interface WrappedSecret {
  version: 1;
  opsLimit: number;
  memLimit: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export async function wrapWithSecret(
  secret: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<WrappedSecret> {
  await ready();
  const salt = randomBytes(sodium.crypto_pwhash_SALTBYTES);
  const key = sodium.crypto_pwhash(
    32,
    utf8(password),
    salt,
    params.opsLimit,
    params.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const nonce = randomBytes(NONCE_BYTES);
  const box = secretboxSeal(key, secret, nonce);
  wipe(key);
  return {
    version: 1,
    opsLimit: params.opsLimit,
    memLimit: params.memLimit,
    salt: b64e(salt),
    nonce: b64e(box.nonce),
    ciphertext: b64e(box.ciphertext),
  };
}

export async function unwrapWithSecret(
  wrapped: WrappedSecret,
  password: string,
): Promise<Uint8Array> {
  await ready();
  const salt = b64d(wrapped.salt);
  const key = sodium.crypto_pwhash(
    32,
    utf8(password),
    salt,
    wrapped.opsLimit,
    wrapped.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return secretboxOpen(key, { nonce: b64d(wrapped.nonce), ciphertext: b64d(wrapped.ciphertext) });
  } finally {
    wipe(key);
  }
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

export function sha256(data: Uint8Array): Uint8Array {
  return sodium.crypto_hash_sha256(data);
}

/** Content hash used for avatar dedupe and media integrity checks. */
export function blake2b(content: Uint8Array, length = 32): Uint8Array {
  return sodium.crypto_generichash(length, content, null);
}

/** Domain-separated transcript hash, e.g. for signing structured payloads. */
export function transcript(label: string, ...parts: Uint8Array[]): Uint8Array {
  return sodium.crypto_generichash(32, concat(utf8(label), ...parts), null);
}
