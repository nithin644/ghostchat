import sodiumImport from 'libsodium-wrappers-sumo';

/**
 * libsodium-wrappers-sumo ships as CJS with a default export. Depending on the
 * bundler (tsx, Next.js, Nest) the interop shape differs; normalise it once.
 */
export const sodium: typeof sodiumImport =
  (sodiumImport as unknown as { default?: typeof sodiumImport }).default ?? sodiumImport;

let readyPromise: Promise<void> | null = null;

/** Must be awaited before any primitive is used. Idempotent. */
export function ready(): Promise<void> {
  if (!readyPromise) {
    readyPromise = Promise.resolve(sodium.ready);
  }
  return readyPromise!;
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

export function b64e(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function b64d(text: string): Uint8Array {
  return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function hex(bytes: Uint8Array): string {
  return sodium.to_hex(bytes);
}

export function fromHex(text: string): Uint8Array {
  return sodium.from_hex(text);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/* -------------------------------------------------------------------------- */
/* Byte manipulation                                                           */
/* -------------------------------------------------------------------------- */

export function concat(...parts: Array<Uint8Array | null | undefined>): Uint8Array {
  let total = 0;
  for (const p of parts) if (p) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    if (!p) continue;
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 4-byte big-endian. */
export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

/** 8-byte big-endian. Counters are JS numbers, so 2^53 is the practical ceiling. */
export function u64be(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  const hi = Math.floor(value / 2 ** 32);
  const lo = value >>> 0;
  view.setUint32(0, hi >>> 0, false);
  view.setUint32(4, lo, false);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  return sodium.randombytes_buf(length);
}

export function randomId(bytes = 16): string {
  return b64e(randomBytes(bytes));
}

/** Constant-time comparison. Never use `===` on secrets. */
export function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

/** Best-effort zeroisation. JS strings cannot be wiped, byte arrays can. */
export function wipe(...arrays: Array<Uint8Array | null | undefined>): void {
  for (const a of arrays) if (a) sodium.memzero(a);
}

export function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === 'string') return utf8(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}
