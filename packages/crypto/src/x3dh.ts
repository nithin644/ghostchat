import { sodium, ready, concat, wipe, equalConstantTime } from './util';
import { kdf, LABELS } from './kdf';
import {
  type IdentityKeyPair,
  type PublicPreKeyBundle,
  type KeyPair,
  verifyBundle,
} from './keys';

/**
 * X3DH (Extended Triple Diffie-Hellman) as specified by Signal.
 *
 * Gives both parties the same 32-byte shared secret with one round trip, while
 * authenticating the initiator's long-term identity and providing forward
 * secrecy for the session setup.
 *
 *   DH1 = DH(IKa, SPKb)   authenticates the initiator to the responder
 *   DH2 = DH(EKa, IKb)    authenticates the responder to the initiator
 *   DH3 = DH(EKa, SPKb)   forward secrecy for the signed pre-key
 *   DH4 = DH(EKa, OPKb)   forward secrecy for the one-time pre-key (optional)
 *
 *   SK = BLAKE2b(F || DH1 || DH2 || DH3 || DH4),  F = 0xFF * 32
 *
 * The 0xFF prefix is the Signal domain-separation constant; it keeps X3DH
 * output disjoint from any raw curve25519 output used elsewhere.
 */

const F = new Uint8Array(32).fill(0xff);

export interface X3DHInitResult {
  sharedSecret: Uint8Array;
  /** Associated data bound into the first ratchet message. */
  associatedData: Uint8Array;
  /** Included in the first message so the responder can reproduce SK. */
  ephemeralPublicKey: Uint8Array;
  usedOneTimePreKeyId: number | null;
  /** Fingerprint of the responder's identity key, for TOFU pinning. */
  responderIdentityDhPublicKey: Uint8Array;
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    // libsodium rejects all-zero outputs, i.e. small-order public keys.
    return sodium.crypto_scalarmult(privateKey, publicKey);
  } catch {
    throw new Error('x3dh: invalid or low-order public key');
  }
}

function deriveSharedSecret(dhOutputs: Uint8Array[]): Uint8Array {
  const material = concat(F, ...dhOutputs);
  // Keyed BLAKE2b needs a key; use a constant, public domain key.
  const key = new Uint8Array(32).fill(0x00);
  const sk = sodium.crypto_generichash(32, material, key);
  wipe(material);
  return sk;
}

/**
 * Initiator side. Verifies the responder's signed pre-key and bundle signature
 * before touching any of the key material: an unverified bundle is an
 * unauthenticated key exchange, which is exactly the attack X3DH must prevent.
 */
export async function x3dhInitiate(
  identity: IdentityKeyPair,
  bundle: PublicPreKeyBundle,
  bundleSignature: Uint8Array,
): Promise<X3DHInitResult> {
  await ready();
  if (!verifyBundle(bundle, bundleSignature)) {
    throw new Error('x3dh: pre-key bundle signature verification failed');
  }

  const ephemeral = sodium.crypto_box_keypair();

  const dh1 = dh(identity.dh.privateKey, bundle.signedPreKey.publicKey);
  const dh2 = dh(ephemeral.privateKey, bundle.identityDhPublicKey);
  const dh3 = dh(ephemeral.privateKey, bundle.signedPreKey.publicKey);
  const dh4 = bundle.oneTimePreKey
    ? dh(ephemeral.privateKey, bundle.oneTimePreKey.publicKey)
    : null;

  const sharedSecret = deriveSharedSecret([dh1, dh2, dh3, ...(dh4 ? [dh4] : [])]);
  wipe(dh1, dh2, dh3, dh4);

  const associatedData = concat(
    new TextEncoder().encode('ghostchat/x3dh-ad/v1'),
    identity.dh.publicKey,
    bundle.identityDhPublicKey,
  );

  return {
    sharedSecret,
    associatedData,
    ephemeralPublicKey: ephemeral.publicKey,
    usedOneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
    responderIdentityDhPublicKey: bundle.identityDhPublicKey,
  };
}

/**
 * Responder side. `oneTimePreKey` must be the private half of the key the
 * initiator used; the server deletes it on hand-out, so a replay of the same
 * bundle cannot happen once it has been consumed.
 */
export async function x3dhRespond(
  identity: IdentityKeyPair,
  signedPreKey: KeyPair,
  initiatorIdentityDhPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  oneTimePreKey?: KeyPair | null,
): Promise<{ sharedSecret: Uint8Array; associatedData: Uint8Array }> {
  await ready();

  const dh1 = dh(signedPreKey.privateKey, initiatorIdentityDhPublicKey);
  const dh2 = dh(identity.dh.privateKey, ephemeralPublicKey);
  const dh3 = dh(signedPreKey.privateKey, ephemeralPublicKey);
  const dh4 = oneTimePreKey ? dh(oneTimePreKey.privateKey, ephemeralPublicKey) : null;

  const sharedSecret = deriveSharedSecret([dh1, dh2, dh3, ...(dh4 ? [dh4] : [])]);
  wipe(dh1, dh2, dh3, dh4);

  const associatedData = concat(
    new TextEncoder().encode('ghostchat/x3dh-ad/v1'),
    initiatorIdentityDhPublicKey,
    identity.dh.publicKey,
  );

  return { sharedSecret, associatedData };
}

/** Constant-time check that a pinned identity key matches what the server served. */
export function identityKeyMatches(pinned: Uint8Array, received: Uint8Array): boolean {
  return equalConstantTime(pinned, received);
}

/** Session tag: a stable, server-uncomputable locator for a pairwise session. */
export function sessionTagFromSecret(sharedSecret: Uint8Array): Uint8Array {
  return kdf(sharedSecret, LABELS.sessionTag, 16);
}
