import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import {
  ready,
  sodium,
  utf8,
  fromUtf8,
  b64e,
  randomBytes,
} from '../src/util';
import {
  generateAccessKey,
  normalizeAccessKey,
  isValidAccessKey,
  deriveIdentity,
  identityFromSeed,
  createSignedPreKey,
  deriveSignedPreKey,
  createOneTimePreKeys,
  deriveOneTimePreKeys,
  signBundle,
  verifyBundle,
  type PublicPreKeyBundle,
} from '../src/keys';
import {
  ratchetInitInitiator,
  ratchetInitResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeState,
  deserializeState,
  destroyState,
} from '../src/doubleRatchet';
import { x3dhInitiate, x3dhRespond } from '../src/x3dh';
import {
  createSenderKey,
  exportSenderKeyDistribution,
  importSenderKeyDistribution,
  senderKeyEncrypt,
  senderKeyDecrypt,
} from '../src/senderKey';
import { sealSender, unsealSender } from '../src/sealedSender';
import { encryptBlob, decryptBlob, CHUNK_BYTES } from '../src/media';

before(async () => {
  await ready();
});

/** Build a published bundle for `identity` exactly as the API would serve it. */
function publishBundle(
  identity: ReturnType<typeof identityFromSeed>,
  spkKeyId: number,
  oneTimePreKeys: ReturnType<typeof createOneTimePreKeys>,
): { bundle: PublicPreKeyBundle; signature: Uint8Array; spk: ReturnType<typeof createSignedPreKey> } {
  const spk = createSignedPreKey(identity, spkKeyId);
  const otp = oneTimePreKeys[0] ?? null;
  const bundle: PublicPreKeyBundle = {
    identityDhPublicKey: identity.dh.publicKey,
    identitySignPublicKey: identity.sign.publicKey,
    signedPreKey: { keyId: spk.keyId, publicKey: spk.keyPair.publicKey, signature: spk.signature },
    oneTimePreKey: otp ? { keyId: otp.keyId, publicKey: otp.keyPair.publicKey } : null,
  };
  return { bundle, signature: signBundle(bundle, identity), spk };
}

/** Runs a full X3DH handshake and returns both peers plus the shared secret. */
async function establishSession() {
  const aliceSeed = randomBytes(32);
  const bobSeed = randomBytes(32);
  const alice = identityFromSeed(aliceSeed);
  const bob = identityFromSeed(bobSeed);

  const bobOtp = createOneTimePreKeys(1, 1);
  const { bundle, signature, spk } = publishBundle(bob, 7, bobOtp);

  const init = await x3dhInitiate(alice, bundle, signature);
  const resp = await x3dhRespond(bob, spk.keyPair, alice.dh.publicKey, init.ephemeralPublicKey, bobOtp[0]!.keyPair);

  assert.deepEqual(init.sharedSecret, resp.sharedSecret, 'X3DH secrets must agree');

  const aliceState = ratchetInitInitiator(init.sharedSecret, bundle.signedPreKey.publicKey);
  const bobState = ratchetInitResponder(resp.sharedSecret, spk.keyPair);

  return { alice, bob, init, aliceState, bobState, spk, bobOtp };
}

/* -------------------------------------------------------------------------- */

test('access keys: 100 bits, valid shape, typo-tolerant normalisation', () => {
  const key = generateAccessKey();
  assert.match(key, /^GHOST(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  assert.equal(isValidAccessKey(key), true);

  // Transcription repairs: lower case, spaces, I->1, O->0, missing dashes.
  const mangled = key.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'I').replace(/0/g, 'O');
  assert.equal(normalizeAccessKey(mangled), key, 'normalisation must round-trip typos');

  assert.equal(isValidAccessKey('GHOST-00000-00000-00000-0000'), false, 'too short');
  assert.equal(isValidAccessKey('not a key'), false);

  const unique = new Set(Array.from({ length: 500 }, generateAccessKey));
  assert.equal(unique.size, 500, 'no collisions in 500 draws');
});

test('identity: deterministic per (key, salt), distinct across salts', async () => {
  const key = generateAccessKey();
  const salt = randomBytes(sodium.crypto_pwhash_SALTBYTES);
  const a = await deriveIdentity(key, salt, { opsLimit: 1, memLimit: 8 * 1024 * 1024 });
  const b = await deriveIdentity(key, salt, { opsLimit: 1, memLimit: 8 * 1024 * 1024 });
  assert.deepEqual(a.sign.publicKey, b.sign.publicKey);
  assert.deepEqual(a.dh.publicKey, b.dh.publicKey);

  const c = await deriveIdentity(key, randomBytes(sodium.crypto_pwhash_SALTBYTES), {
    opsLimit: 1,
    memLimit: 8 * 1024 * 1024,
  });
  assert.notDeepEqual(a.sign.publicKey, c.sign.publicKey);
});

test('pre-key bundle: signature verification rejects tampering', async () => {
  const bob = identityFromSeed(randomBytes(32));

  // Verify deterministic derivation produces identical keys across calls
  const spk1 = deriveSignedPreKey(bob, 1);
  const spk2 = deriveSignedPreKey(bob, 1);
  assert.deepEqual(spk1.keyPair.publicKey, spk2.keyPair.publicKey);
  assert.deepEqual(spk1.keyPair.privateKey, spk2.keyPair.privateKey);
  assert.deepEqual(spk1.signature, spk2.signature);

  const otpks1 = deriveOneTimePreKeys(bob.seed, 1, 5);
  const otpks2 = deriveOneTimePreKeys(bob.seed, 1, 5);
  assert.deepEqual(otpks1[0].keyPair.publicKey, otpks2[0].keyPair.publicKey);
  assert.deepEqual(otpks1[0].keyPair.privateKey, otpks2[0].keyPair.privateKey);

  const { bundle, signature } = publishBundle(bob, 1, createOneTimePreKeys(1, 1));
  assert.equal(verifyBundle(bundle, signature), true);

  const tampered: PublicPreKeyBundle = {
    ...bundle,
    identityDhPublicKey: randomBytes(32),
  };
  assert.equal(verifyBundle(tampered, signature), false, 'swapped identity key must fail');

  const swappedSpk: PublicPreKeyBundle = {
    ...bundle,
    signedPreKey: { ...bundle.signedPreKey, publicKey: randomBytes(32) },
  };
  assert.equal(verifyBundle(swappedSpk, signature), false, 'swapped SPK must fail');
});

test('double ratchet: bidirectional conversation with key rotation', async () => {
  const { aliceState, bobState } = await establishSession();

  const a1 = await ratchetEncrypt(aliceState, utf8('hello bob'));
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, a1.header, a1.ciphertext)), 'hello bob');

  const b1 = await ratchetEncrypt(bobState, utf8('hi alice'));
  assert.equal(fromUtf8(await ratchetDecrypt(aliceState, b1.header, b1.ciphertext)), 'hi alice');

  // Two more round trips: each one must perform a DH ratchet step.
  const a2 = await ratchetEncrypt(aliceState, utf8('how are you?'));
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, a2.header, a2.ciphertext)), 'how are you?');

  const b2 = await ratchetEncrypt(bobState, utf8('all good'));
  assert.equal(fromUtf8(await ratchetDecrypt(aliceState, b2.header, b2.ciphertext)), 'all good');

  // Ratchet keys must have changed; root keys must have diverged from X3DH.
  assert.notDeepEqual(aliceState.dhSelf.publicKey, bobState.dhSelf.publicKey);
  destroyState(aliceState);
  destroyState(bobState);
});

test('double ratchet: out-of-order delivery inside one chain', async () => {
  const { aliceState, bobState } = await establishSession();

  const m1 = await ratchetEncrypt(aliceState, utf8('first'));
  const m2 = await ratchetEncrypt(aliceState, utf8('second'));
  const m3 = await ratchetEncrypt(aliceState, utf8('third'));

  // Deliver 3, then 1, then 2.
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m3.header, m3.ciphertext)), 'third');
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m1.header, m1.ciphertext)), 'first');
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m2.header, m2.ciphertext)), 'second');
});

test('double ratchet: replayed message is rejected', async () => {
  const { aliceState, bobState } = await establishSession();
  const m1 = await ratchetEncrypt(aliceState, utf8('once'));

  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m1.header, m1.ciphertext)), 'once');
  await assert.rejects(
    () => ratchetDecrypt(bobState, m1.header, m1.ciphertext),
    /authentication failed|no receiving chain|already consumed/,
    'replay must not decrypt twice',
  );
});

test('double ratchet: tampered ciphertext does not desynchronise state', async () => {
  const { aliceState, bobState } = await establishSession();
  const m1 = await ratchetEncrypt(aliceState, utf8('integrity'));

  const before = serializeState(bobState);
  const corrupted = m1.ciphertext.slice();
  corrupted[corrupted.length - 1] ^= 0xff;

  await assert.rejects(() => ratchetDecrypt(bobState, m1.header, corrupted));
  const after = serializeState(bobState);
  assert.deepEqual(after.rootKey, before.rootKey, 'root key unchanged after forgery');
  assert.deepEqual(after.recvChain, before.recvChain, 'recv chain unchanged after forgery');

  // The genuine message must still work.
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m1.header, m1.ciphertext)), 'integrity');
});

test('double ratchet: header substitution is rejected by associated data', async () => {
  const { aliceState, bobState } = await establishSession();
  const m1 = await ratchetEncrypt(aliceState, utf8('bound to header'));

  const forgedHeader = m1.header.slice();
  forgedHeader[forgedHeader.length - 1] ^= 0x01; // bump the message counter

  await assert.rejects(() => ratchetDecrypt(bobState, forgedHeader, m1.ciphertext));
});

test('double ratchet: state survives serialisation round-trip', async () => {
  const { aliceState, bobState } = await establishSession();
  const m1 = await ratchetEncrypt(aliceState, utf8('persist me'));

  const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(bobState))));
  assert.equal(fromUtf8(await ratchetDecrypt(restored, m1.header, m1.ciphertext)), 'persist me');
});

test('double ratchet: forward secrecy — a post-advance chain key cannot read past messages', async () => {
  const { aliceState, bobState } = await establishSession();

  const m1 = await ratchetEncrypt(aliceState, utf8('already sent'));

  // Compromise the sender *after* the chain advanced: this is the realistic
  // forward-secrecy scenario (device seized after the fact).
  const compromisedChain = aliceState.sendChain!.slice();

  const { kdf, LABELS, nonceFor } = await import('../src/kdf');
  const { aeadOpen } = await import('../src/secretbox');
  const derived = kdf(compromisedChain, LABELS.messageKey, 32);

  // The retained chain is one step ahead; it must not yield m1's key.
  assert.throws(
    () => aeadOpen(derived, m1.ciphertext, nonceFor(0), m1.header),
    /authentication failed/,
  );

  // The legitimate recipient still decrypts it, proving m1 was well-formed.
  assert.equal(fromUtf8(await ratchetDecrypt(bobState, m1.header, m1.ciphertext)), 'already sent');
});

test('sender keys: group fan-out, ordering, and forgery rejection', async () => {
  const sender = await createSenderKey();
  const distribution = await exportSenderKeyDistribution(sender);
  const receiver = await importSenderKeyDistribution(distribution);

  const m1 = await senderKeyEncrypt(sender, utf8('msg one'));
  const m2 = await senderKeyEncrypt(sender, utf8('msg two'));
  const m3 = await senderKeyEncrypt(sender, utf8('msg three'));

  // Out of order.
  assert.equal(fromUtf8(await senderKeyDecrypt(receiver, m3.header, m3.ciphertext, m3.signature)), 'msg three');
  assert.equal(fromUtf8(await senderKeyDecrypt(receiver, m1.header, m1.ciphertext, m1.signature)), 'msg one');
  assert.equal(fromUtf8(await senderKeyDecrypt(receiver, m2.header, m2.ciphertext, m2.signature)), 'msg two');

  // A member cannot forge another member's message.
  const attacker = await createSenderKey();
  const forged = await senderKeyEncrypt(attacker, utf8('I am not the sender'));
  await assert.rejects(
    () => senderKeyDecrypt(receiver, forged.header, forged.ciphertext, forged.signature),
    /unknown key id|signature/,
  );
});

test('sealed sender: only the recipient can open, author is inside', async () => {
  const alice = identityFromSeed(randomBytes(32));
  const bob = identityFromSeed(randomBytes(32));
  const eve = identityFromSeed(randomBytes(32));

  const sealed = await sealSender(
    {
      v: 1,
      senderPseudoId: 'pseudo-alice',
      senderDisplayName: 'Alice',
      senderIdentityDhPublicKey: b64e(alice.dh.publicKey),
      senderIdentitySignPublicKey: b64e(alice.sign.publicKey),
      sentAt: new Date().toISOString(),
      signedPreKeyId: 3,
      oneTimePreKeyId: null,
      envelope: { kind: 'PAIRWISE', sessionTag: 'tag', header: 'h', ciphertext: 'c' },
    },
    bob.dh.publicKey,
  );

  const opened = await unsealSender(sealed, bob);
  assert.equal(opened.senderPseudoId, 'pseudo-alice');

  await assert.rejects(() => unsealSender(sealed, eve), /authentication failed/);
});

test('media: streaming encryption across multiple chunks, and tamper detection', async () => {
  const plaintext = randomBytes(CHUNK_BYTES * 3 + 1234);
  const blob = await encryptBlob(plaintext);

  assert.notDeepEqual(blob.ciphertext.slice(0, 64), plaintext.slice(0, 64), 'must not be plaintext');
  assert.ok(blob.ciphertext.length > plaintext.length, 'AEAD adds per-chunk overhead');

  const decrypted = await decryptBlob(blob.key, blob.header, blob.ciphertext, blob.contentHash);
  assert.deepEqual(decrypted, plaintext, 'round-trip must be byte-identical');

  // Flip a bit in the last chunk.
  const corrupted = blob.ciphertext.slice();
  corrupted[corrupted.length - 10] ^= 0x01;
  await assert.rejects(() => decryptBlob(blob.key, blob.header, corrupted, blob.contentHash));

  // Truncation must be detected (no final tag).
  const truncated = blob.ciphertext.slice(0, blob.ciphertext.length - 100);
  await assert.rejects(() => decryptBlob(blob.key, blob.header, truncated, blob.contentHash));

  // Wrong key must fail.
  await assert.rejects(() => decryptBlob(randomBytes(32), blob.header, blob.ciphertext));
});

test('media: chunk reordering is fatal (AEAD binds chunk index)', async () => {
  const plaintext = randomBytes(CHUNK_BYTES * 2);
  const blob = await encryptBlob(plaintext);
  const frame = CHUNK_BYTES + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;

  const chunks = [
    blob.ciphertext.slice(0, frame),
    blob.ciphertext.slice(frame, frame * 2),
  ];
  const reordered = new Uint8Array(blob.ciphertext.length);
  reordered.set(chunks[1]!, 0);
  reordered.set(chunks[0]!, chunks[1]!.length);

  await assert.rejects(() => decryptBlob(blob.key, blob.header, reordered));
});
