'use client';

import {
  b64d,
  b64e,
  utf8,
  fromUtf8,
  kdf,
  LABELS,
  concat,
  u32be,
  x3dhInitiate,
  x3dhRespond,
  ratchetInitInitiator,
  ratchetInitResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeState,
  deserializeState,
  createSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  deriveSignedPreKey,
  deriveOneTimePreKey,
  type IdentityKeyPair,
  type PublicPreKeyBundle,
  type RatchetState,
  type SenderKeyState,
  type ReceiverKeyState,
  type SerializedRatchetState,
} from '@ghostchat/crypto';
import type { Envelope } from '@ghostchat/shared-types';
import { api } from './api';
import { vaultGet, vaultPut, vaultDelete } from './vault';

/**
 * Browser-side session manager.
 *
 * 1:1 conversations use X3DH + Double Ratchet, with the initiator's pre-key
 * prelude carried in the *first* message only. A prelude is not a ciphertext: it
 * tells the responder which of its published pre-keys to use so it can derive the
 * same shared secret.
 *
 * Groups use Sender Keys. Distribution is bootstrapped from the group invite
 * secret, which every member already holds — a deliberate simplification over
 * Signal's pairwise distribution fan-out, documented in README "Group E2EE".
 * Consequence: anyone holding the invite code can compute a member's sender key
 * and forge their messages. Rotate the invite (and the group) after a removal.
 */

export interface StoredPreKeys {
  signedPreKey: { keyId: number; publicKey: string; privateKey: string };
  oneTimePreKeys: Array<{ keyId: number; publicKey: string; privateKey: string }>;
}

interface PreKeyPrelude {
  t: 'pk';
  ik: string;
  ek: string;
  spk: number;
  otp: number | null;
  h: string;
}

const sessions = new Map<string, RatchetState>();
const senderKeys = new Map<string, SenderKeyState>();
const receiverKeys = new Map<string, ReceiverKeyState>();

export function resetSessions(): void {
  sessions.clear();
  senderKeys.clear();
  receiverKeys.clear();
}

function sessionKey(peerPseudoId: string): string {
  return `ratchet:${peerPseudoId}`;
}

async function persist(peerPseudoId: string, state: RatchetState): Promise<void> {
  await vaultPut(sessionKey(peerPseudoId), serializeState(state));
}

export async function loadSession(peerPseudoId: string, force = false): Promise<RatchetState | null> {
  if (!force) {
    const cached = sessions.get(peerPseudoId);
    if (cached) return cached;
  }

  const stored = await vaultGet<SerializedRatchetState>(sessionKey(peerPseudoId));
  if (!stored) return sessions.get(peerPseudoId) ?? null;
  const state = deserializeState(stored);
  sessions.set(peerPseudoId, state);
  return state;
}

function toBundle(dto: Awaited<ReturnType<typeof api.bundle>>): PublicPreKeyBundle {
  return {
    identityDhPublicKey: b64d(dto.identityDhPublicKey),
    identitySignPublicKey: b64d(dto.identitySignPublicKey),
    signedPreKey: {
      keyId: dto.signedPreKey.keyId,
      publicKey: b64d(dto.signedPreKey.publicKey),
      signature: b64d(dto.signedPreKey.signature),
    },
    oneTimePreKey: dto.oneTimePreKey
      ? { keyId: dto.oneTimePreKey.keyId, publicKey: b64d(dto.oneTimePreKey.publicKey) }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* 1:1                                                                        */
/* -------------------------------------------------------------------------- */

export async function encryptDirect(
  identity: IdentityKeyPair,
  peer: { pseudoId: string; contactCode: string },
  plaintext: string,
): Promise<Envelope> {
  let state = await loadSession(peer.pseudoId);
  let prelude: PreKeyPrelude | null = null;

  if (!state) {
    // First message: verify the bundle, run X3DH, start as initiator.
    const dto = await api.bundle(peer.contactCode);
    const bundle = toBundle(dto);
    const init = await x3dhInitiate(identity, bundle, b64d(dto.bundleSignature));
    state = ratchetInitInitiator(init.sharedSecret, bundle.signedPreKey.publicKey);
    sessions.set(peer.pseudoId, state);

    prelude = {
      t: 'pk',
      ik: b64e(identity.dh.publicKey),
      ek: b64e(init.ephemeralPublicKey),
      spk: dto.signedPreKey.keyId,
      otp: dto.oneTimePreKey ? dto.oneTimePreKey.keyId : null,
      h: '',
    };
  }

  const message = await ratchetEncrypt(state, utf8(plaintext));
  await persist(peer.pseudoId, state);

  if (prelude) {
    prelude.h = b64e(message.header);
    return {
      kind: 'PAIRWISE',
      sessionTag: b64e(state.sessionTag),
      header: b64e(utf8(JSON.stringify(prelude))),
      ciphertext: b64e(message.ciphertext),
    };
  }

  return {
    kind: 'PAIRWISE',
    sessionTag: b64e(state.sessionTag),
    header: b64e(message.header),
    ciphertext: b64e(message.ciphertext),
  };
}

export async function decryptDirect(
  identity: IdentityKeyPair,
  fromPseudoId: string,
  envelope: Envelope,
  preKeys: StoredPreKeys | null,
): Promise<string> {
  let header = b64d(envelope.header);
  let state = await loadSession(fromPseudoId);

  // Detect the pre-key prelude. It is JSON, a ratchet header never is.
  if (header.length > 0 && header[0] === 0x7b /* '{' */) {
    const prelude = JSON.parse(fromUtf8(header)) as PreKeyPrelude;
    if (prelude.t !== 'pk') throw new Error('unknown pre-key prelude');

    // Retrieve or deterministically derive the signed pre-key
    let spkKey: { publicKey: Uint8Array; privateKey: Uint8Array };
    if (preKeys?.signedPreKey && preKeys.signedPreKey.keyId === prelude.spk) {
      spkKey = {
        publicKey: b64d(preKeys.signedPreKey.publicKey),
        privateKey: b64d(preKeys.signedPreKey.privateKey),
      };
    } else {
      const derivedSpk = deriveSignedPreKey(identity, prelude.spk || 1);
      spkKey = derivedSpk.keyPair;
    }

    // Retrieve or deterministically derive the one-time pre-key if used
    let otpKey: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;
    if (prelude.otp !== null && prelude.otp !== undefined) {
      const found = preKeys?.oneTimePreKeys?.find((k) => k.keyId === prelude.otp);
      if (found) {
        otpKey = { publicKey: b64d(found.publicKey), privateKey: b64d(found.privateKey) };
      } else {
        const derivedOtp = deriveOneTimePreKey(identity.seed, prelude.otp);
        otpKey = derivedOtp.keyPair;
      }
    }

    const responded = await x3dhRespond(
      identity,
      spkKey,
      b64d(prelude.ik),
      b64d(prelude.ek),
      otpKey,
    );

    state = ratchetInitResponder(responded.sharedSecret, spkKey);
    sessions.set(fromPseudoId, state);
    header = b64d(prelude.h);
  }

  if (!state) {
    // A message arrived before we ever initiated: we cannot derive the session
    // from a non-prelude header, so surface a real error rather than garbage.
    throw new Error('no session for sender; ask them to resend');
  }

  try {
    const plaintext = await ratchetDecrypt(state, header, b64d(envelope.ciphertext));
    await persist(fromPseudoId, state);
    return fromUtf8(plaintext);
  } catch (err) {
    // Retry once with freshly reloaded state from vault in case of multi-tab or concurrent write
    try {
      const freshState = await loadSession(fromPseudoId, true);
      if (freshState && freshState !== state) {
        const plaintext = await ratchetDecrypt(freshState, header, b64d(envelope.ciphertext));
        await persist(fromPseudoId, freshState);
        return fromUtf8(plaintext);
      }
    } catch {
      // ignore retry error
    }

    // If we have a pre-key prelude in the original header, the sender started
    // a fresh X3DH session. The local ratchet state is stale (from an older
    // session). Delete the stale session so the NEXT message with a prelude
    // will re-initialize cleanly.
    const rawHeader = b64d(envelope.header);
    if (rawHeader.length > 0 && rawHeader[0] === 0x7b /* '{' */) {
      sessions.delete(fromPseudoId);
      await vaultDelete(sessionKey(fromPseudoId)).catch(() => {});
    }

    console.warn('decryptDirect failed for message:', err);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Groups                                                                     */
/* -------------------------------------------------------------------------- */

function seedForGroup(inviteSecret: string, pseudoId: string): Uint8Array {
  return kdf(utf8(inviteSecret), LABELS.senderKeyChain, 32, utf8(pseudoId));
}

export async function initGroupSenderKey(inviteSecret: string, selfPseudoId: string): Promise<SenderKeyState> {
  const cacheKey = `sk:${inviteSecret.slice(0, 8)}:${selfPseudoId}`;
  const cached = senderKeys.get(cacheKey);
  if (cached) return cached;

  const base = await createSenderKey();
  const seed = seedForGroup(inviteSecret, selfPseudoId);
  const state: SenderKeyState = { ...base, chainKey: seed };
  senderKeys.set(cacheKey, state);
  return state;
}

export async function encryptGroup(
  inviteSecret: string,
  selfPseudoId: string,
  plaintext: string,
): Promise<Envelope> {
  const state = await initGroupSenderKey(inviteSecret, selfPseudoId);
  const message = await senderKeyEncrypt(state, utf8(plaintext));
  return {
    kind: 'SENDER_KEY',
    sessionTag: b64e(kdf(utf8(inviteSecret), LABELS.sessionTag, 16)),
    header: b64e(message.header),
    ciphertext: b64e(message.ciphertext),
    signature: b64e(message.signature),
  };
}

export async function decryptGroup(
  inviteSecret: string,
  fromPseudoId: string,
  envelope: Envelope,
): Promise<string> {
  const cacheKey = `rk:${inviteSecret.slice(0, 8)}:${fromPseudoId}`;
  let receiver = receiverKeys.get(cacheKey);

  if (!receiver) {
    const seed = seedForGroup(inviteSecret, fromPseudoId);
    receiver = {
      keyId: '',
      chainKey: seed,
      iteration: 0,
      signingPublicKey: new Uint8Array(32),
      skipped: new Map(),
    };
    receiverKeys.set(cacheKey, receiver);
  }

  if (!envelope.signature) throw new Error('group message missing signature');
  const header = b64d(envelope.header);

  // The signing key comes from the header on first contact, then is pinned by
  // the receiver state; a later key swap is rejected by the signature check.
  if (receiver.signingPublicKey.every((b) => b === 0)) {
    receiver.signingPublicKey = header.slice(12, 44);
  }
  receiver.keyId = b64e(header.slice(0, 8));

  const plaintext = await senderKeyDecrypt(
    receiver,
    header,
    b64d(envelope.ciphertext),
    b64d(envelope.signature),
  );
  return fromUtf8(plaintext);
}

export function groupInviteSecret(inviteCode: string, conversationId: string): string {
  return `${inviteCode}:${conversationId}`;
}

export { concat };
