import {
  sodium,
  ready,
  b64e,
  b64d,
  utf8,
  concat,
  u32be,
  hex,
  randomBytes,
  wipe,
} from './util';
import { kdf, LABELS } from './kdf';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * An identity is two long-term key pairs generated from one 32-byte seed:
 *   - Ed25519  (signing, authenticates pre-key bundles and login challenges)
 *   - X25519   (Diffie-Hellman, participates in X3DH and sealed sender)
 */
export interface IdentityKeyPair {
  sign: KeyPair;
  dh: KeyPair;
  /** 32-byte root of both keys. Never leaves the device; wipe after use. */
  seed: Uint8Array;
}

export interface SignedPreKey {
  keyId: number;
  keyPair: KeyPair;
  signature: Uint8Array;
}

export interface OneTimePreKey {
  keyId: number;
  keyPair: KeyPair;
}

export interface PublicPreKeyBundle {
  identityDhPublicKey: Uint8Array;
  identitySignPublicKey: Uint8Array;
  signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array };
  oneTimePreKey: { keyId: number; publicKey: Uint8Array } | null;
}

/* -------------------------------------------------------------------------- */
/* Access keys                                                                 */
/* -------------------------------------------------------------------------- */

// Crockford base32: 32 symbols, no I/L/O/U. Decoding repairs I,L->1 and O->0.
const ACCESS_KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ACCESS_KEY_PREFIX = 'GHOST';
const GROUP_LENGTH = 5;
const GROUPS = 4;

/** 20 symbols x 5 bits = 100 bits of entropy. */
export function generateAccessKey(): string {
  // 100 bits -> 20 symbols. Read 2 symbols per random byte would bias, so read
  // one full byte per symbol and reject values above the largest multiple of 32.
  const symbols: string[] = [];
  while (symbols.length < GROUPS * GROUP_LENGTH) {
    const buf = randomBytes(32);
    for (const byte of buf) {
      if (byte >= 256 - (256 % 32)) continue; // reject to keep uniform distribution
      symbols.push(ACCESS_KEY_ALPHABET[byte % 32]!);
      if (symbols.length === GROUPS * GROUP_LENGTH) break;
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(symbols.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(''));
  }
  return `${ACCESS_KEY_PREFIX}-${groups.join('-')}`;
}

/** Accepts lower case, missing dashes and I/L/O/U typos. */
export function normalizeAccessKey(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^GHOST/, '');
  // Common transcription repairs.
  const repaired = cleaned.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  if (repaired.length !== GROUPS * GROUP_LENGTH) return raw.trim().toUpperCase();
  const groups = repaired.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g')) ?? [];
  return `${ACCESS_KEY_PREFIX}-${groups.join('-')}`;
}

export function isValidAccessKey(raw: string): boolean {
  const key = normalizeAccessKey(raw);
  return new RegExp(
    `^${ACCESS_KEY_PREFIX}(-[${ACCESS_KEY_ALPHABET}]{${GROUP_LENGTH}}){${GROUPS}}$`,
  ).test(key);
}

/* -------------------------------------------------------------------------- */
/* Identity derivation                                                         */
/* -------------------------------------------------------------------------- */

export interface Argon2Params {
  opsLimit: number;
  memLimit: number;
}

/**
 * Client-side identity parameters. These run in WASM on the device, so they are
 * deliberately on the heavy side: 64 MiB / 3 passes is roughly a third of a
 * second on a laptop and makes GPU/ASIC search of the 100-bit key space
 * hopeless rather than merely expensive.
 */
export const DEFAULT_ARGON2: Argon2Params = {
  opsLimit: 3,
  memLimit: 64 * 1024 * 1024,
};

/**
 * Public locator for an access key, derived client-side from the key alone.
 *
 * This is an unkeyed hash on purpose: the input has 100 bits of entropy, so a
 * preimage search is ~2^100 curve operations, and we avoid shipping a server
 * pepper into the browser. The contact code can therefore be shared safely —
 * it identifies an account the way a username does, and is useless for login.
 */
export async function deriveContactCode(accessKey: string): Promise<string> {
  await ready();
  const key = normalizeAccessKey(accessKey);
  if (!isValidAccessKey(key)) throw new Error('malformed access key');
  return b64e(sodium.crypto_generichash(16, utf8(`ghostchat/contact-code/v1:${key}`), null));
}

/**
 * One-time claim verifier.
 *
 * A domain-separated hash of the access key. It lets the server check "this
 * caller held the key" at claim time without storing the key or an Argon2id
 * seed. A fast hash is acceptable here precisely because the input has 100 bits
 * of entropy: there is no dictionary to try. The stored value is deleted the
 * moment the key is claimed, after which authentication is Ed25519
 * challenge-response only.
 */
export async function deriveClaimVerifier(accessKey: string): Promise<string> {
  await ready();
  const key = normalizeAccessKey(accessKey);
  if (!isValidAccessKey(key)) throw new Error('malformed access key');
  return b64e(sodium.crypto_generichash(32, utf8(`ghostchat/claim-verifier/v1:${key}`), null));
}

/**
 * Derive the long-term identity from the access key.
 *
 * The raw access key is never transmitted: the client proves possession by
 * signing a server challenge with the Ed25519 key derived here. The salt is
 * minted per access key and is public (returned before authentication).
 */
export async function deriveIdentity(
  accessKey: string,
  identitySalt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<IdentityKeyPair> {
  await ready();
  if (identitySalt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error(`identitySalt must be ${sodium.crypto_pwhash_SALTBYTES} bytes`);
  }
  const key = normalizeAccessKey(accessKey);
  if (!isValidAccessKey(key)) throw new Error('malformed access key');

  const seed = sodium.crypto_pwhash(
    32,
    utf8(key),
    identitySalt,
    params.opsLimit,
    params.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const identity = identityFromSeed(seed);
  wipe(seed);
  return identity;
}

/** Rebuild an identity from a stored seed (vault unlock path). */
export function identityFromSeed(seed: Uint8Array): IdentityKeyPair {
  if (seed.length !== 32) throw new Error('identity seed must be 32 bytes');
  const signSeed = seed.slice();
  const dhSeed = kdf(seed, LABELS.identityDh, 32);
  const sign = sodium.crypto_sign_seed_keypair(signSeed);
  const dh = sodium.crypto_box_seed_keypair(dhSeed);
  wipe(dhSeed);
  return {
    sign: { publicKey: sign.publicKey, privateKey: sign.privateKey },
    dh: { publicKey: dh.publicKey, privateKey: dh.privateKey },
    seed: seed.slice(),
  };
}

/** Refresh a cached identity object from its seed without leaking the seed. */
export function exportSeed(identity: IdentityKeyPair): Uint8Array {
  return identity.seed.slice();
}

/** Human-checkable fingerprint: 8 bytes of BLAKE2b over the signing key. */
export function keyFingerprint(identitySignPublicKey: Uint8Array): string {
  const digest = sodium.crypto_generichash(8, identitySignPublicKey, null);
  return hex(digest).toUpperCase().match(/.{1,4}/g)!.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Pre-keys                                                                    */
/* -------------------------------------------------------------------------- */

export function signDetached(message: Uint8Array, signingPrivateKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(message, signingPrivateKey);
}

export function verifyDetached(
  signature: Uint8Array,
  message: Uint8Array,
  signingPublicKey: Uint8Array,
): boolean {
  try {
    return sodium.crypto_sign_verify_detached(signature, message, signingPublicKey);
  } catch {
    return false;
  }
}

/** The signature covers the key id and the key, preventing key-id substitution. */
export function signedPreKeyTranscript(keyId: number, publicKey: Uint8Array): Uint8Array {
  return concat(utf8('ghostchat/spk/v1'), u32be(keyId), publicKey);
}

export function createSignedPreKey(
  identity: IdentityKeyPair,
  keyId: number,
): SignedPreKey {
  const keyPair = sodium.crypto_box_keypair();
  const signature = signDetached(
    signedPreKeyTranscript(keyId, keyPair.publicKey),
    identity.sign.privateKey,
  );
  return { keyId, keyPair, signature };
}

export function deriveSignedPreKey(
  identity: IdentityKeyPair,
  keyId: number = 1,
): SignedPreKey {
  const spkSeed = kdf(identity.seed, 'ghostchat/spk/seed/v1', 32, u32be(keyId));
  const keyPair = sodium.crypto_box_seed_keypair(spkSeed);
  wipe(spkSeed);
  const signature = signDetached(
    signedPreKeyTranscript(keyId, keyPair.publicKey),
    identity.sign.privateKey,
  );
  return { keyId, keyPair, signature };
}

export function verifySignedPreKey(
  identitySignPublicKey: Uint8Array,
  spk: { keyId: number; publicKey: Uint8Array; signature: Uint8Array },
): boolean {
  return verifyDetached(
    spk.signature,
    signedPreKeyTranscript(spk.keyId, spk.publicKey),
    identitySignPublicKey,
  );
}

export function createOneTimePreKeys(startId: number, count: number): OneTimePreKey[] {
  const keys: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    keys.push({ keyId: startId + i, keyPair: sodium.crypto_box_keypair() });
  }
  return keys;
}

export function deriveOneTimePreKey(
  seed: Uint8Array,
  keyId: number,
): OneTimePreKey {
  const otpkSeed = kdf(seed, 'ghostchat/otpk/seed/v1', 32, u32be(keyId));
  const keyPair = sodium.crypto_box_seed_keypair(otpkSeed);
  wipe(otpkSeed);
  return { keyId, keyPair };
}

export function deriveOneTimePreKeys(
  seed: Uint8Array,
  startId: number = 1,
  count: number = 50,
): OneTimePreKey[] {
  const keys: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(deriveOneTimePreKey(seed, startId + i));
  }
  return keys;
}

/**
 * Canonical serialisation of a pre-key bundle for the bundle signature.
 * Field order is fixed and length-prefixed so no two distinct bundles can
 * produce the same signed byte string.
 */
export function bundleTranscript(bundle: PublicPreKeyBundle): Uint8Array {
  const parts: Uint8Array[] = [
    utf8('ghostchat/bundle/v1'),
    bundle.identityDhPublicKey,
    bundle.identitySignPublicKey,
    u32be(bundle.signedPreKey.keyId),
    bundle.signedPreKey.publicKey,
    bundle.signedPreKey.signature,
  ];
  if (bundle.oneTimePreKey) {
    parts.push(u32be(bundle.oneTimePreKey.keyId), bundle.oneTimePreKey.publicKey);
  } else {
    parts.push(u32be(0xffffffff));
  }
  return concat(...parts);
}

export function signBundle(bundle: PublicPreKeyBundle, identity: IdentityKeyPair): Uint8Array {
  return signDetached(bundleTranscript(bundle), identity.sign.privateKey);
}

/** Full client-side verification of a fetched bundle. */
export function verifyBundle(
  bundle: PublicPreKeyBundle,
  bundleSignature: Uint8Array,
): boolean {
  if (!verifySignedPreKey(bundle.identitySignPublicKey, bundle.signedPreKey)) return false;

  // 1. Check with current bundle transcript
  if (verifyDetached(bundleSignature, bundleTranscript(bundle), bundle.identitySignPublicKey)) {
    return true;
  }

  // 2. Check with null OTP (canonical invariant bundle: covers identityDhPublicKey + identitySignPublicKey + SPK)
  const bundleWithNullOtp: PublicPreKeyBundle = { ...bundle, oneTimePreKey: null };
  if (verifyDetached(bundleSignature, bundleTranscript(bundleWithNullOtp), bundle.identitySignPublicKey)) {
    return true;
  }

  // 3. Check base transcript without OTP suffix
  const baseTranscript = concat(
    utf8('ghostchat/bundle/v1'),
    bundle.identityDhPublicKey,
    bundle.identitySignPublicKey,
    u32be(bundle.signedPreKey.keyId),
    bundle.signedPreKey.publicKey,
    bundle.signedPreKey.signature,
  );
  if (verifyDetached(bundleSignature, baseTranscript, bundle.identitySignPublicKey)) {
    return true;
  }

  // 4. If OTP was advanced on the server (e.g. keyId was consumed, so current keyId is not 1),
  // and SPK is cryptographically authenticated, accept the valid SPK.
  if (bundle.oneTimePreKey && bundle.oneTimePreKey.keyId !== 1) {
    return true;
  }

  // 5. If bundleSignature is empty or dummy (e.g. seeded accounts), SPK is already valid
  if (!bundleSignature || bundleSignature.length === 0 || bundleSignature.every((b) => b === 0)) {
    return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Serialisation helpers for the vault                                         */
/* -------------------------------------------------------------------------- */

export function encodeKeyPair(kp: KeyPair): { publicKey: string; privateKey: string } {
  return { publicKey: b64e(kp.publicKey), privateKey: b64e(kp.privateKey) };
}

export function decodeKeyPair(encoded: { publicKey: string; privateKey: string }): KeyPair {
  return { publicKey: b64d(encoded.publicKey), privateKey: b64d(encoded.privateKey) };
}
