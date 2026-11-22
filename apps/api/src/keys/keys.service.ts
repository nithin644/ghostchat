import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { b64d, b64e, bundleTranscript, type PublicPreKeyBundle } from '@ghostchat/crypto';
import type { PreKeyBundle, PublishPreKeysRequest, SignedPreKeyDTO } from '@ghostchat/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Pre-key distribution.
 *
 * The server is a blind middleman: it stores public keys, hands out one
 * one-time pre-key per request, and signs nothing (it has no keys of its own).
 * Verification happens on the client, which is the only party able to bind a
 * bundle to a known identity fingerprint.
 *
 * One-time pre-keys are consumed atomically with `FOR UPDATE SKIP LOCKED`, so two
 * concurrent handshakes can never receive the same key. Reuse would let an
 * observer of a repeated X3DH transcript derive the session key.
 */
@Injectable()
export class KeysService {
  constructor(private readonly prisma: PrismaService) {}

  async getBundle(contactCode: string): Promise<PreKeyBundle> {
    const trimmed = contactCode.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [
          { numericId: trimmed },
          { pseudoId: trimmed },
          { accessKey: { contactCode: trimmed } },
        ],
      },
      include: {
        accessKey: true,
        signedPreKeys: { where: { retiredAt: null }, orderBy: { keyId: 'desc' }, take: 1 },
      },
    });

    if (!user) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such user' });
    }

    const spk = user.signedPreKeys[0];
    if (!spk) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'User has no signed pre-key' });
    }

    // Atomic single-consumer claim of the lowest-numbered available pre-key.
    const consumed = await this.prisma.$queryRaw<Array<{ keyId: number; publicKey: string }>>(
      Prisma.sql`
        UPDATE "OneTimePreKey"
           SET "consumedAt" = NOW()
         WHERE "id" = (
           SELECT "id" FROM "OneTimePreKey"
            WHERE "userId" = ${user.id}::uuid AND "consumedAt" IS NULL
            ORDER BY "keyId" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
        RETURNING "keyId", "publicKey"
      `,
    );

    const otp = consumed[0] ?? null;
    const bundle: PublicPreKeyBundle = {
      identityDhPublicKey: b64d(user.identityDhPublicKey),
      identitySignPublicKey: b64d(user.identitySignPublicKey),
      signedPreKey: {
        keyId: spk.keyId,
        publicKey: b64d(spk.publicKey),
        signature: b64d(spk.signature),
      },
      oneTimePreKey: otp ? { keyId: otp.keyId, publicKey: b64d(otp.publicKey) } : null,
    };

    const bundleSig = user.bundleSignature || spk.signature;
    // Re-hash for diagnostics only; the signature covers these exact bytes.
    void bundleTranscript(bundle);

    return {
      contactCode: user.accessKey.contactCode,
      pseudoId: user.pseudoId,
      numericId: user.numericId ?? '',
      displayName: user.displayName,
      avatarUrl: user.avatarObjectKey
        ? user.avatarObjectKey.startsWith('data:') || user.avatarObjectKey.startsWith('http')
          ? user.avatarObjectKey
          : `/api/media/${user.avatarObjectKey}`
        : null,
      identityDhPublicKey: b64e(bundle.identityDhPublicKey),
      identitySignPublicKey: b64e(bundle.identitySignPublicKey),
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: b64e(bundle.signedPreKey.publicKey),
        signature: b64e(bundle.signedPreKey.signature),
      },
      oneTimePreKey: bundle.oneTimePreKey
        ? { keyId: bundle.oneTimePreKey.keyId, publicKey: b64e(bundle.oneTimePreKey.publicKey) }
        : null,
      bundleSignature: bundleSig,
      isVerified: Boolean(user.isVerified),
    };
  }

  async publish(
    userId: string,
    input: PublishPreKeysRequest,
    bundleSignature?: string,
  ): Promise<{ published: number; available: number }> {
    let published = 0;

    await this.prisma.$transaction(async (tx) => {
      if (input.signedPreKey) {
        const spk: SignedPreKeyDTO = input.signedPreKey;
        await tx.signedPreKey.updateMany({
          where: { userId, retiredAt: null, keyId: { not: spk.keyId } },
          data: { retiredAt: new Date() },
        });
        await tx.signedPreKey.upsert({
          where: { userId_keyId: { userId, keyId: spk.keyId } },
          create: { userId, keyId: spk.keyId, publicKey: spk.publicKey, signature: spk.signature },
          update: { publicKey: spk.publicKey, signature: spk.signature, retiredAt: null },
        });
      }

      for (const key of input.oneTimePreKeys) {
        await tx.oneTimePreKey.upsert({
          where: { userId_keyId: { userId, keyId: key.keyId } },
          create: { userId, keyId: key.keyId, publicKey: key.publicKey },
          update: { publicKey: key.publicKey, consumedAt: null },
        });
        published += 1;
      }

      if (bundleSignature) {
        await tx.user.update({ where: { id: userId }, data: { bundleSignature } });
      }
    });

    const available = await this.countAvailable(userId);
    return { published, available };
  }

  async countAvailable(userId: string): Promise<number> {
    return this.prisma.oneTimePreKey.count({ where: { userId, consumedAt: null } });
  }
}
