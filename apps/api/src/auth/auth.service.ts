import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes, timingSafeEqual, createHash, pbkdf2Sync } from 'node:crypto';
import { b64d, utf8, verifyDetached, keyFingerprint } from '@ghostchat/crypto';
import type {
  ChallengeResponse,
  ClaimRequest,
  PublicUser,
  SessionResponse,
  UserRole,
  VerifyRequest,
} from '@ghostchat/shared-types';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SessionService } from '../common/session.service';
import { RateLimitService, RULES } from '../common/rate-limit.service';

const CHALLENGE_TTL_SECONDS = 300;

interface StoredChallenge {
  contactCode: string;
  challenge: string;
  purpose: 'login' | 'claim';
}

/** Deterministic, delimiter-safe transcripts. Display names cannot contain '|'. */
export function loginTranscript(contactCode: string, challenge: string): Uint8Array {
  return utf8(['ghostchat/login/v1', contactCode, challenge].join('|'));
}

export function claimTranscript(input: {
  contactCode: string;
  challenge: string;
  displayName: string;
  avatarHash: string;
  identitySignPublicKey: string;
  identityDhPublicKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKeys: Array<{ keyId: number; publicKey: string }>;
  bundleSignature: string;
}): Uint8Array {
  const otp = input.oneTimePreKeys
    .slice()
    .sort((a, b) => a.keyId - b.keyId)
    .map((k) => `${k.keyId}:${k.publicKey}`)
    .join(',');

  return utf8(
    [
      'ghostchat/claim/v1',
      input.contactCode,
      input.challenge,
      input.displayName,
      input.avatarHash,
      input.identitySignPublicKey,
      input.identityDhPublicKey,
      String(input.signedPreKey.keyId),
      input.signedPreKey.publicKey,
      input.signedPreKey.signature,
      input.bundleSignature,
      otp,
    ].join('|'),
  );
}

/** Display names are constrained at the boundary: no control chars, no '|'. */
export const DISPLAY_NAME_RE = /^[\p{L}\p{N} ._-]{2,24}$/u;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async generateUniqueNumericId(client: PrismaService | Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const candidate = String(Math.floor(100 + Math.random() * 900));
      const existing = await client.user.findFirst({
        where: { numericId: candidate },
        select: { id: true },
      });
      if (!existing) {
        return candidate;
      }
    }
    return String(Math.floor(100 + Math.random() * 900));
  }

  async onModuleInit(): Promise<void> {
    try {
      const unassigned = await this.prisma.user.findMany({
        where: { numericId: null },
        select: { id: true },
      });
      for (const u of unassigned) {
        const numericId = await this.generateUniqueNumericId(this.prisma);
        await this.prisma.user.update({
          where: { id: u.id },
          data: { numericId },
        });
        this.logger.log(`Assigned 3-digit User ID ${numericId} to user ${u.id}`);
      }
    } catch (err) {
      this.logger.warn(`Could not backfill numeric IDs: ${err instanceof Error ? err.message : err}`);
    }
  }

  private challengeKey(id: string): string {
    return this.redis.k('challenge', id);
  }

  /* ---------------------------------------------------------------------- */
  /* Challenge                                                              */
  /* ---------------------------------------------------------------------- */

  async challenge(contactCode: string): Promise<ChallengeResponse> {
    await this.rateLimit.enforce(RULES.authChallenge, contactCode);

    const key = await this.prisma.accessKey.findUnique({ where: { contactCode } });

    // Uniform response for "unknown key" and "revoked key": the caller learns
    // only that this contact code is not usable. A distinct error for revoked
    // keys would confirm to an attacker that the code was once real.
    if (!key || key.status === 'REVOKED') {
      throw new NotFoundException({ code: 'INVALID_KEY', message: 'Unknown or revoked key' });
    }
    if (key.expiresAt && key.expiresAt.getTime() < Date.now() && key.status === 'UNCLAIMED') {
      throw new ForbiddenException({ code: 'KEY_EXPIRED', message: 'This key has expired' });
    }

    const purpose = key.status === 'UNCLAIMED' ? 'claim' : 'login';
    const challengeId = randomBytes(16).toString('base64url');
    const challenge = randomBytes(32).toString('base64url');

    const stored: StoredChallenge = { contactCode, challenge, purpose };
    await this.redis.client.set(
      this.challengeKey(challengeId),
      JSON.stringify(stored),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );

    return {
      challengeId,
      challenge,
      identitySalt: key.identitySalt,
      claimed: key.status === 'CLAIMED',
      expiresIn: CHALLENGE_TTL_SECONDS,
    };
  }

  private async takeChallenge(
    challengeId: string,
    purpose: 'login' | 'claim',
  ): Promise<StoredChallenge> {
    // GETDEL makes the challenge strictly single-use, which defeats replay of a
    // captured signature even if the attacker also captured the challenge.
    const raw = await this.redis.client.getdel(this.challengeKey(challengeId));
    if (!raw) {
      throw new UnauthorizedException({
        code: 'CHALLENGE_EXPIRED',
        message: 'Challenge expired or already used',
      });
    }
    const stored = JSON.parse(raw) as StoredChallenge;
    if (stored.purpose !== purpose) {
      throw new UnauthorizedException({ code: 'CHALLENGE_EXPIRED', message: 'Wrong challenge' });
    }
    return stored;
  }

  /* ---------------------------------------------------------------------- */
  /* Login                                                                  */
  /* ---------------------------------------------------------------------- */

  async verify(input: VerifyRequest): Promise<{ session: SessionResponse; token: string }> {
    await this.rateLimit.enforce(RULES.authVerify, input.contactCode);
    const stored = await this.takeChallenge(input.challengeId, 'login');
    if (stored.contactCode !== input.contactCode) {
      throw new UnauthorizedException({ code: 'INVALID_KEY', message: 'Challenge mismatch' });
    }

    const key = await this.prisma.accessKey.findUnique({
      where: { contactCode: input.contactCode },
      include: { user: true },
    });
    if (!key || !key.user || key.status !== 'CLAIMED') {
      throw new UnauthorizedException({ code: 'NOT_CLAIMED', message: 'Key is not claimed' });
    }
    if (key.user.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Account is not active' });
    }

    const ok = verifyDetached(
      b64d(input.signature),
      loginTranscript(input.contactCode, stored.challenge),
      b64d(key.user.identitySignPublicKey),
    );
    if (!ok) {
      // Same shape as a bad key: do not tell the caller whether the signature
      // was wrong or the identity key changed.
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE', message: 'Invalid credentials' });
    }

    const token = await this.sessions.create({
      id: key.user.id,
      pseudoId: key.user.pseudoId,
      role: key.user.role as UserRole,
    });
    await this.prisma.user.update({
      where: { id: key.user.id },
      data: { lastSeenAt: new Date() },
    });

    return {
      token: token.token,
      session: {
        user: this.toPublicUser(key.user, input.contactCode),
        expiresAt: token.expiresAt.toISOString(),
        freshClaim: false,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Claim (first run)                                                      */
  /* ---------------------------------------------------------------------- */

  async claim(input: ClaimRequest): Promise<{ session: SessionResponse; token: string }> {
    await this.rateLimit.enforce(RULES.authClaim, input.contactCode);

    if (!DISPLAY_NAME_RE.test(input.displayName)) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'Display name must be 2-24 characters of letters, numbers, spaces, dot, dash or underscore',
      });
    }

    const stored = await this.takeChallenge(input.challengeId, 'claim');
    if (stored.contactCode !== input.contactCode) {
      throw new UnauthorizedException({ code: 'INVALID_KEY', message: 'Challenge mismatch' });
    }

    const key = await this.prisma.accessKey.findUnique({ where: { contactCode: input.contactCode } });
    if (!key) throw new NotFoundException({ code: 'INVALID_KEY', message: 'Unknown key' });
    if (key.status !== 'UNCLAIMED') {
      // Someone else won the race, or the key was revoked between challenge
      // and claim. Both mean: this key is no longer claimable.
      throw new ConflictException({ code: 'ALREADY_CLAIMED', message: 'Key already claimed' });
    }
    if (!key.verifier) {
      throw new ForbiddenException({
        code: 'INVALID_KEY',
        message: 'This key was not minted with a claim verifier',
      });
    }

    // The verifier proves the caller held the access key at claim time. It is
    // a domain-separated hash of the Argon2id seed, so the server still never
    // sees the key, and the stored verifier is destroyed two lines later.
    const supplied = Buffer.from(input.verifier, 'base64url');
    const expected = Buffer.from(key.verifier, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new UnauthorizedException({ code: 'INVALID_KEY', message: 'Invalid claim proof' });
    }

    const proofOk = verifyDetached(
      b64d(input.proof),
      claimTranscript({
        contactCode: input.contactCode,
        challenge: stored.challenge,
        displayName: input.displayName,
        avatarHash: input.avatarHash ?? '',
        identitySignPublicKey: input.identitySignPublicKey,
        identityDhPublicKey: input.identityDhPublicKey,
        signedPreKey: input.signedPreKey,
        oneTimePreKeys: input.oneTimePreKeys,
        bundleSignature: input.bundleSignature,
      }),
      b64d(input.identitySignPublicKey),
    );
    if (!proofOk) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE', message: 'Invalid claim signature' });
    }

    // Opaque, stable, non-sequential identifier. 12 bytes of randomness is
    // plenty, and it is deliberately unrelated to the access key or contact code.
    const pseudoId = `u_${randomBytes(12).toString('base64url')}`;

    const created = await this.prisma.$transaction(async (tx) => {
      // Conditional update: if another request claimed first, count is 0 and
      // the whole transaction aborts. This closes the check-then-act race.
      const claimed = await tx.accessKey.updateMany({
        where: { id: key.id, status: 'UNCLAIMED' },
        data: {
          status: 'CLAIMED',
          claimedAt: new Date(),
          verifier: null, // one-shot credential, gone forever
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: 'ALREADY_CLAIMED', message: 'Key already claimed' });
      }

      const numericId = await this.generateUniqueNumericId(tx);
      const user = await tx.user.create({
        data: {
          pseudoId,
          numericId,
          displayName: input.displayName,
          accessKeyId: key.id,
          identitySignPublicKey: input.identitySignPublicKey,
          identityDhPublicKey: input.identityDhPublicKey,
          keyFingerprint: keyFingerprint(b64d(input.identitySignPublicKey)),
          avatarObjectKey: input.avatarObjectKey ?? null,
          avatarHash: input.avatarHash ?? null,
          bundleSignature: input.bundleSignature,
          lastSeenAt: new Date(),
        },
      });

      await tx.signedPreKey.create({
        data: {
          userId: user.id,
          keyId: input.signedPreKey.keyId,
          publicKey: input.signedPreKey.publicKey,
          signature: input.signedPreKey.signature,
        },
      });

      if (input.oneTimePreKeys.length > 0) {
        await tx.oneTimePreKey.createMany({
          data: input.oneTimePreKeys.map((k) => ({
            userId: user.id,
            keyId: k.keyId,
            publicKey: k.publicKey,
          })),
        });
      }

      await tx.auditEvent.create({
        data: { actorId: user.id, action: 'key.claimed', target: key.id },
      });

      return user;
    });

    const token = await this.sessions.create({
      id: created.id,
      pseudoId: created.pseudoId,
      role: created.role as UserRole,
    });

    this.logger.log(`key claimed: ${pseudoId}`);

    return {
      token: token.token,
      session: {
        user: this.toPublicUser(created, input.contactCode),
        expiresAt: token.expiresAt.toISOString(),
        freshClaim: true,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Session helpers                                                        */
  /* ---------------------------------------------------------------------- */

  async me(userId: string): Promise<PublicUser> {
    let user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { accessKey: true },
    });
    if (!user) throw new UnauthorizedException('session refers to a deleted account');
    if (!user.numericId) {
      const numericId = await this.generateUniqueNumericId(this.prisma);
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { numericId },
        include: { accessKey: true },
      });
    }
    return this.toPublicUser(user, user.accessKey.contactCode);
  }

  async logout(token: string): Promise<void> {
    await this.sessions.destroy(token);
  }

  toPublicUser(
    user: {
      pseudoId: string;
      displayName: string;
      numericId?: string | null;
      avatarObjectKey: string | null;
      isVerified?: boolean;
      role: string;
      keyFingerprint: string;
      createdAt: Date;
    },
    contactCode: string,
  ): PublicUser {
    return {
      pseudoId: user.pseudoId,
      displayName: user.displayName,
      numericId: user.numericId ?? '',
      avatarUrl: user.avatarObjectKey
        ? user.avatarObjectKey.startsWith('data:') || /^https?:\/\//.test(user.avatarObjectKey)
          ? user.avatarObjectKey
          : `/api/media/${user.avatarObjectKey}`
        : null,
      contactCode,
      role: user.role as UserRole,
      keyFingerprint: user.keyFingerprint,
      createdAt: user.createdAt.toISOString(),
      isVerified: 'isVerified' in user ? Boolean(user.isVerified) : false,
    };
  }

  /** Used by the admin bootstrap path to mark an existing user as admin. */
  async promoteToAdmin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
    await this.prisma.auditEvent.create({
      data: { actorId: userId, action: 'admin.promoted', target: userId },
    });
    // Existing sessions carry the old role in Redis; force a fresh login.
    await this.sessions.destroyAllForUser(userId);
  }

  /** Deterministic idempotency helper for the bootstrap script. */
  static fingerprintOf(publicKeyB64: string): string {
    return createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);
  }

  /**
   * Direct admin login with username and password.
   * Auto-provisions or promotes an admin account if none exists.
   */
  async adminLogin(
    username: string,
    password: string,
  ): Promise<{ session: SessionResponse; token: string }> {
    let credential = await this.prisma.adminCredential.findFirst({ where: { username } });
    if (!credential) {
      const credentialCount = await this.prisma.adminCredential.count();
      if (credentialCount === 0 && username === 'admin') {
        const salt = randomBytes(16).toString('base64url');
        const passwordHash = pbkdf2Sync('admin', salt, 120_000, 32, 'sha256').toString('base64url');
        credential = await this.prisma.adminCredential.create({
          data: { username: 'admin', passwordHash: `${salt}$${passwordHash}` },
        });
      } else {
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid admin credentials',
        });
      }
    }

    const [salt, expected] = credential.passwordHash.split('$');
    if (!salt) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid admin credentials' });
    }
    const actual = pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('base64url');
    const validPassword = expected
      ? timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
      : false;
    if (username !== credential.username || !validPassword) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid admin credentials',
      });
    }

    let adminUser = await this.prisma.user.findFirst({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      include: { accessKey: true },
    });

    if (!adminUser) {
      const existingUser = await this.prisma.user.findFirst({
        where: { pseudoId: 'admin' },
        include: { accessKey: true },
      });

      if (existingUser) {
        adminUser = await this.prisma.user.update({
          where: { id: existingUser.id },
          data: { role: 'ADMIN', status: 'ACTIVE' },
          include: { accessKey: true },
        });
      } else {
        const anyUser = await this.prisma.user.findFirst({
          where: { status: 'ACTIVE' },
          include: { accessKey: true },
        });

        if (anyUser) {
          adminUser = await this.prisma.user.update({
            where: { id: anyUser.id },
            data: { role: 'ADMIN' },
            include: { accessKey: true },
          });
        } else {
          const contactCode = 'admin_' + randomBytes(8).toString('base64url');
          const accessKey = await this.prisma.accessKey.create({
            data: {
              contactCode,
              identitySalt: randomBytes(16).toString('base64url'),
              status: 'CLAIMED',
              label: 'bootstrap-admin',
            },
          });

          const dummyKey = randomBytes(32).toString('base64url');
          const numericId = await this.generateUniqueNumericId(this.prisma);
          adminUser = await this.prisma.user.create({
            data: {
              pseudoId: 'admin',
              numericId,
              displayName: 'Admin',
              role: 'ADMIN',
              status: 'ACTIVE',
              accessKeyId: accessKey.id,
              identitySignPublicKey: dummyKey,
              identityDhPublicKey: dummyKey,
              keyFingerprint: 'admin000',
              lastSeenAt: new Date(),
            },
            include: { accessKey: true },
          });
        }
      }
    }

    if (!adminUser.numericId) {
      const numericId = await this.generateUniqueNumericId(this.prisma);
      adminUser = await this.prisma.user.update({
        where: { id: adminUser.id },
        data: { numericId },
        include: { accessKey: true },
      });
    }

    const { token, expiresAt } = await this.sessions.create({
      id: adminUser.id,
      pseudoId: adminUser.pseudoId,
      role: 'ADMIN',
    });

    return {
      session: {
        user: this.toPublicUser(adminUser, adminUser.accessKey?.contactCode ?? 'admin'),
        expiresAt: expiresAt.toISOString(),
        freshClaim: false,
      },
      token,
    };
  }

  async updateProfile(
    userId: string,
    input: { displayName?: string; avatar?: string | null },
  ): Promise<PublicUser> {
    const data: { displayName?: string; avatarObjectKey?: string | null } = {};
    if (input.displayName) {
      data.displayName = input.displayName.trim();
    }
    if (input.avatar !== undefined) {
      data.avatarObjectKey = input.avatar;
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      include: { accessKey: true },
    });

    return this.toPublicUser(updated, updated.accessKey.contactCode);
  }

  async getAdminCredentials(): Promise<{
    username: string;
    credentials: Array<{ id: number; username: string; createdAt: string }>;
  }> {
    const credentials = await this.prisma.adminCredential.findMany({ orderBy: { createdAt: 'asc' } });
    return {
      username: credentials[0]?.username ?? 'admin',
      credentials: credentials.map((c) => ({
        id: c.id,
        username: c.username,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  async updateAdminCredentials(
    credentialId: number,
    currentPassword: string,
    username: string,
    newPassword: string,
  ): Promise<{ username: string }> {
    const credential = await this.prisma.adminCredential.findUnique({ where: { id: credentialId } });
    if (!credential) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Admin credential not found' });

    const [salt, expected] = credential.passwordHash.split('$');
    if (!salt) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
    const actual = pbkdf2Sync(currentPassword, salt, 120_000, 32, 'sha256').toString('base64url');
    if (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' });
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 64) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Username must be 3–64 characters' });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'New password must be 8–128 characters' });
    }

    const existing = await this.prisma.adminCredential.findFirst({
      where: { username: trimmedUsername, NOT: { id: credentialId } },
    });
    if (existing) throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'That admin username is already in use' });

    const newSalt = randomBytes(16).toString('base64url');
    const newHash = pbkdf2Sync(newPassword, newSalt, 120_000, 32, 'sha256').toString('base64url');
    await this.prisma.adminCredential.update({
      where: { id: credentialId },
      data: { username: trimmedUsername, passwordHash: `${newSalt}$${newHash}` },
    });

    return { username: trimmedUsername };
  }

  async createAdminCredential(username: string, password: string): Promise<{ id: number; username: string }> {
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 64) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Username must be 3–64 characters' });
    }
    if (password.length < 8 || password.length > 128) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Password must be 8–128 characters' });
    }

    const existing = await this.prisma.adminCredential.findUnique({ where: { username: trimmedUsername } });
    if (existing) throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'That admin username is already in use' });

    const salt = randomBytes(16).toString('base64url');
    const passwordHash = pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('base64url');
    const credential = await this.prisma.adminCredential.create({
      data: { username: trimmedUsername, passwordHash: `${salt}$${passwordHash}` },
    });
    return { id: credential.id, username: credential.username };
  }

  async deleteAdminCredential(credentialId: number): Promise<{ deleted: boolean }> {
    const count = await this.prisma.adminCredential.count();
    if (count <= 1) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'At least one admin credential must remain' });
    }
    await this.prisma.adminCredential.delete({ where: { id: credentialId } }).catch(() => undefined);
    return { deleted: true };
  }
}

