import { sodium, ready, randomBytes, wipe, b64e, b64d, u32be } from './util';
import { sha256 } from './secretbox';

/**
 * Client-side file encryption.
 *
 * Files are encrypted with `crypto_secretstream_xchacha20poly1305`, a streaming
 * AEAD designed exactly for this: it is chunked, so a 200 MB video never has to
 * be resident in memory, and it authenticates ordering, so chunks cannot be
 * dropped, duplicated or reordered.
 *
 * The 32-byte file key and the stream header travel inside the E2EE message
 * envelope, never to the object store. MinIO only ever sees ciphertext, and the
 * server never has the key material to decrypt it.
 */

export const CHUNK_BYTES = 64 * 1024;
/** Poly1305 tag + 1-byte tag header = 17 bytes per chunk. Asserted at runtime. */
const ABYTES = 17;

export interface EncryptedBlob {
  /** 32-byte single-use file key. Goes in the message, not to the storage server. */
  key: Uint8Array;
  /** Stream header; public, and required to decrypt. */
  header: Uint8Array;
  ciphertext: Uint8Array;
  /** BLAKE2b-256 of the plaintext, so recipients can detect a corrupted upload. */
  contentHash: Uint8Array;
  plaintextBytes: number;
}

export async function encryptBlob(plaintext: Uint8Array): Promise<EncryptedBlob> {
  await ready();
  if (sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== ABYTES) {
    throw new Error('media: unexpected secretstream overhead');
  }
  const key = randomBytes(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES);
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);

  const chunks: Uint8Array[] = [];
  const total = Math.max(1, Math.ceil(plaintext.length / CHUNK_BYTES));

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, plaintext.length);
    const chunk = plaintext.subarray(start, end);
    const isFinal = i === total - 1;
    const tag = isFinal
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    // The chunk index is authenticated as associated data, so a reorder is fatal.
    chunks.push(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        u32be(i),
        tag,
      ),
    );
  }

  const ciphertext = concatChunks(chunks);
  return {
    key,
    header,
    ciphertext,
    contentHash: sha256(plaintext),
    plaintextBytes: plaintext.length,
  };
}

export async function decryptBlob(
  key: Uint8Array,
  header: Uint8Array,
  ciphertext: Uint8Array,
  expectedHash?: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  const out: Uint8Array[] = [];
  const frame = CHUNK_BYTES + ABYTES;
  let offset = 0;
  let index = 0;
  let finished = false;

  while (offset < ciphertext.length) {
    const end = Math.min(offset + frame, ciphertext.length);
    const chunk = ciphertext.subarray(offset, end);
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      state,
      chunk,
      u32be(index),
    );
    if (!result) throw new Error('media: chunk authentication failed');
    out.push(result.message);
    finished = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    offset = end;
    index += 1;
  }

  if (!finished) throw new Error('media: missing final chunk (truncated upload)');

  const plaintext = concatChunks(out);
  if (expectedHash) {
    const actual = sha256(plaintext);
    if (!timingSafeBytesEqual(actual, expectedHash)) {
      throw new Error('media: content hash mismatch');
    }
  }
  return plaintext;
}

/** Envelope payload describing an encrypted attachment. */
export interface MediaDescriptor {
  v: 1;
  objectKey: string;
  mime: string;
  fileName: string;
  bytes: number;
  key: string;
  header: string;
  contentHash: string;
  /** Optional preview (thumbnail) encrypted with the same key. */
  thumbnailObjectKey?: string;
}

export function encodeMediaDescriptor(descriptor: MediaDescriptor): string {
  return JSON.stringify(descriptor);
}

export function decodeMediaDescriptor(json: string): MediaDescriptor {
  const parsed = JSON.parse(json) as MediaDescriptor;
  if (parsed.v !== 1) throw new Error('media: unsupported descriptor version');
  return parsed;
}

export function descriptorToKeyMaterial(descriptor: MediaDescriptor): {
  key: Uint8Array;
  header: Uint8Array;
  contentHash: Uint8Array;
} {
  return {
    key: b64d(descriptor.key),
    header: b64d(descriptor.header),
    contentHash: b64d(descriptor.contentHash),
  };
}

export function keyMaterialToDescriptorFields(material: {
  key: Uint8Array;
  header: Uint8Array;
  contentHash: Uint8Array;
}): { key: string; header: string; contentHash: string } {
  return {
    key: b64e(material.key),
    header: b64e(material.header),
    contentHash: b64e(material.contentHash),
  };
}

export function destroyBlobKey(blob: EncryptedBlob): void {
  wipe(blob.key);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function timingSafeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
