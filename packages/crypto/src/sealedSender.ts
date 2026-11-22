import { ready, utf8, fromUtf8 } from './util';
import { sealToPublicKey, openSealedBox } from './secretbox';
import type { IdentityKeyPair } from './keys';

/**
 * Sealed sender.
 *
 * The server routes messages by conversation, so it must learn *who receives*
 * a message. It should not learn who sent it. Two things make that possible:
 *
 *  1. The message is wrapped with `crypto_box_seal` to the recipient's identity
 *     key, so only the recipient can open the envelope. The sender's identity
 *     travels *inside* the encrypted payload.
 *
 *  2. There is no sender field on the outer object. The server stores
 *     `senderPseudoId = NULL`, and its access logs have nothing to join on.
 *
 * Honest limitation: the transport session that submitted the envelope is still
 * observable by the server at the moment of delivery. Removing that last link
 * requires unlinkable rate-limit tokens (a blind-signature / VOPRF token
 * service), which is called out in the README roadmap rather than pretended
 * away here. Sealed sender in this codebase therefore means: the sender identity
 * is absent from message rows, response bodies, push payloads and logs.
 */

export interface SealedSenderInner {
  v: 1;
  /** Who actually wrote the message. */
  senderPseudoId: string;
  senderDisplayName: string;
  senderIdentityDhPublicKey: string;
  senderIdentitySignPublicKey: string;
  sentAt: string;
  /** X3DH ephemeral key, present only on the first message of a session. */
  ephemeralPublicKey?: string;
  signedPreKeyId: number;
  oneTimePreKeyId: number | null;
  /** The ratchet/sender-key ciphertext, already encrypted. */
  envelope: {
    kind: 'PAIRWISE' | 'SENDER_KEY';
    sessionTag: string;
    header: string;
    ciphertext: string;
    signature?: string;
  };
}

export async function sealSender(
  inner: SealedSenderInner,
  recipientIdentityDhPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  const payload = utf8(JSON.stringify(inner));
  return sealToPublicKey(payload, recipientIdentityDhPublicKey);
}

export async function unsealSender(
  sealed: Uint8Array,
  identity: IdentityKeyPair,
): Promise<SealedSenderInner> {
  await ready();
  const payload = openSealedBox(sealed, identity.dh.publicKey, identity.dh.privateKey);
  const parsed = JSON.parse(fromUtf8(payload)) as SealedSenderInner;

  if (parsed.v !== 1) throw new Error('sealed sender: unsupported version');
  if (!parsed.senderPseudoId || !parsed.envelope) {
    throw new Error('sealed sender: malformed inner payload');
  }
  return parsed;
}

/**
 * The outer object the server sees. Deliberately minimal: recipient, an opaque
 * blob, a size and a timestamp. Nothing here identifies the author.
 */
export interface SealedEnvelope {
  recipientPseudoId: string;
  blob: Uint8Array;
  sentAt: string;
}

export function sealedEnvelopeSize(envelope: SealedEnvelope): number {
  return envelope.blob.length;
}
