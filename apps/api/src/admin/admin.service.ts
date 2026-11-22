import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  b64e,
  deriveClaimVerifier,
  deriveContactCode,
  generateAccessKey,
} from '@ghostchat/crypto';
import type {
  AdminKeyRow,
  AdminStats,
  AdminUserRow,
  CreateAccessKeysRequest,
  CreateAccessKeysResponse,
} from '@ghostchat/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SessionService } from '../common/session.service';

/**
 * Administrative surface.
 *
 * Deliberately blind: the dashboard can count users, keys and messages, and can
 * ban an account, but there is no code path that reads a message body, resolves
 * a display name to a person, or looks up an IP. Those capabilities do not
 * exist rather than being merely "restricted".
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Mint access keys.
   *
   * The plaintext key exists only in this response. What is stored is the
   * public contact code, the public Argon2 salt and a one-shot claim verifier.
   *
   * Honest limitation: because the server generates the key, the server knows
   * it at mint time and could derive the identity. This is the trade-off for a
   * closed, invite-only deployment; README "Key custody" describes the
   * client-generated alternative.
   */
  async mint(actorId: string, input: CreateAccessKeysRequest): Promise<CreateAccessKeysResponse> {
    if (input.count < 1 || input.count > 25) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'count must be 1-25' });
    }

    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 3600 * 1000)
      : null;

    const created: Array<{ accessKey: string; contactCode: string; expiresAt: string | null }> = [];

    for (let i = 0; i < input.count; i++) {
      const accessKey = generateAccessKey();
      const contactCode = await deriveContactCode(accessKey);
      const verifier = await deriveClaimVerifier(accessKey);
      const identitySalt = b64e(randomBytes(16));

      await this.prisma.accessKey.create({
        data: {
          contactCode,
          identitySalt,
          verifier,
          label: input.label ?? null,
          expiresAt,
        },
      });

      created.push({
        accessKey,
        contactCode,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      });
    }

    await this.prisma.auditEvent.create({
      data: { actorId, action: 'keys.minted', meta: { count: created.length, label: input.label ?? null } },
    });

    return { keys: created, label: input.label ?? null };
  }

  async listKeys(cursor?: string, limit = 50): Promise<AdminKeyRow[]> {
    const rows = await this.prisma.accessKey.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { user: { select: { pseudoId: true, displayName: true } } },
    });

    return rows.map((k) => ({
      id: k.id,
      contactCode: k.contactCode,
      label: k.label,
      status: k.status,
      createdAt: k.createdAt.toISOString(),
      claimedAt: k.claimedAt ? k.claimedAt.toISOString() : null,
      revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
      claimant: k.user ? { pseudoId: k.user.pseudoId, displayName: k.user.displayName } : null,
    }));
  }

  async revokeKey(actorId: string, keyId: string): Promise<{ revoked: boolean }> {
    const key = await this.prisma.accessKey.findUnique({
      where: { id: keyId },
      include: { user: true },
    });
    if (!key) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Key not found' });

    await this.prisma.$transaction(async (tx) => {
      await tx.accessKey.update({
        where: { id: keyId },
        data: { status: 'REVOKED', revokedAt: new Date(), verifier: null },
      });
      if (key.user) {
        await tx.user.update({ where: { id: key.user.id }, data: { status: 'BANNED', bannedAt: new Date() } });
      }
      await tx.auditEvent.create({ data: { actorId, action: 'key.revoked', target: keyId } });
    });

    if (key.user) await this.sessions.destroyAllForUser(key.user.id);
    return { revoked: true };
  }

  async listUsers(cursor?: string, limit = 50): Promise<AdminUserRow[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { accessKey: true, _count: { select: { memberships: true } } },
    });

    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const out: AdminUserRow[] = [];
    for (const u of rows) {
      // Counts only. No message content is read here, and none exists in
      // plaintext to read even if it were.
      const messages30d = await this.prisma.message.count({
        where: { senderPseudoId: u.id, createdAt: { gte: since } },
      });
      out.push({
        pseudoId: u.pseudoId,
        numericId: u.numericId ?? '',
        displayName: u.displayName,
        avatarUrl: u.avatarObjectKey
          ? u.avatarObjectKey.startsWith('data:') || u.avatarObjectKey.startsWith('http')
            ? u.avatarObjectKey
            : `/api/media/${u.avatarObjectKey}`
          : null,
        lastIp: u.lastIp ?? '127.0.0.1',
        status: u.status === 'ACTIVE' ? 'ACTIVE' : u.status === 'BANNED' ? 'BANNED' : 'REVOKED',
        createdAt: u.createdAt.toISOString(),
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
        conversationCount: u._count.memberships,
        messages30d,
        keyFingerprint: u.keyFingerprint,
        accessKeyCode: u.accessKey?.contactCode ?? '',
        isVerified: u.isVerified,
      });
    }
    return out;
  }

  async banUser(actorId: string, pseudoId: string): Promise<{ banned: boolean; deleted: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { pseudoId } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });

    // Find direct conversations to purge cleanly
    const directMemberships = await this.prisma.conversationMember.findMany({
      where: { userId: user.id, conversation: { type: 'DIRECT' } },
      select: { conversationId: true },
    });
    const directConvoIds = directMemberships.map((m) => m.conversationId);

    // End all active user sessions immediately
    await this.sessions.destroyAllForUser(user.id);

    await this.prisma.$transaction(async (tx) => {
      // 1. Delete direct conversations and their messages
      if (directConvoIds.length > 0) {
        await tx.conversation.deleteMany({ where: { id: { in: directConvoIds } } });
      }

      // 2. Delete the user (cascades to prekeys, memberships, requests, receipts, reactions, etc.)
      await tx.user.delete({ where: { id: user.id } });

      // 3. Delete access key
      if (user.accessKeyId) {
        await tx.accessKey.delete({ where: { id: user.accessKeyId } }).catch(() => undefined);
      }

      await tx.auditEvent.create({ data: { actorId, action: 'user.banned_and_deleted', target: pseudoId } });
    });

    return { banned: true, deleted: true };
  }

  async updateNumericId(actorId: string, pseudoId: string, numericId: string): Promise<{ success: boolean; numericId: string }> {
    const trimmed = numericId.trim();
    if (!/^\d{3}$/.test(trimmed)) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'User ID must be exactly 3 digits (e.g. 100-999)' });
    }

    const user = await this.prisma.user.findUnique({ where: { pseudoId } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });

    // Check if another user already has this numericId
    const existing = await this.prisma.user.findFirst({
      where: { numericId: trimmed, NOT: { id: user.id } },
    });
    if (existing) {
      throw new ConflictException({ code: 'ID_TAKEN', message: `User ID ${trimmed} is already in use by another user` });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { numericId: trimmed },
    });

    await this.prisma.auditEvent.create({
      data: { actorId, action: 'user.numericId_updated', target: user.id, meta: { newId: trimmed } },
    });

    return { success: true, numericId: trimmed };
  }

  async updateVerified(actorId: string, pseudoId: string, isVerified: boolean): Promise<{ success: boolean; isVerified: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { pseudoId } });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isVerified },
    });
    await this.prisma.auditEvent.create({
      data: {
        actorId,
        action: isVerified ? 'user.verified' : 'user.unverified',
        target: user.id,
        meta: { isVerified },
      },
    });

    return { success: true, isVerified };
  }

  async stats(): Promise<AdminStats> {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 3600 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000);

    const [totalUsers, active24h, new7d] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { lastSeenAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    ]);

    const [unclaimed, claimed, revoked] = await Promise.all([
      this.prisma.accessKey.count({ where: { status: 'UNCLAIMED' } }),
      this.prisma.accessKey.count({ where: { status: 'CLAIMED' } }),
      this.prisma.accessKey.count({ where: { status: 'REVOKED' } }),
    ]);

    const [totalMessages, last24h, lastHour, direct, group] = await Promise.all([
      this.prisma.message.count(),
      this.prisma.message.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.message.count({ where: { createdAt: { gte: new Date(now - 3600 * 1000) } } }),
      this.prisma.conversation.count({ where: { type: 'DIRECT' } }),
      this.prisma.conversation.count({ where: { type: 'GROUP' } }),
    ]);

    const perMinute = await this.messagesPerMinute(30);

    const [objects, bytesAgg] = await Promise.all([
      this.prisma.mediaObject.count(),
      this.prisma.mediaObject.aggregate({ _sum: { bytes: true } }),
    ]);

    const dbStarted = process.hrtime.bigint();
    await this.prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Number(process.hrtime.bigint() - dbStarted) / 1e6;

    const redisStarted = process.hrtime.bigint();
    await this.redis.client.ping();
    const redisLatencyMs = Number(process.hrtime.bigint() - redisStarted) / 1e6;

    return {
      users: { total: totalUsers, active24h, new7d },
      keys: { unclaimed, claimed, revoked },
      messages: { total: totalMessages, last24h, lastHour, perMinute },
      conversations: { direct, group },
      sessions: { active: await this.sessions.countActive() },
      storage: { objects, bytes: bytesAgg._sum.bytes ?? 0 },
      server: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryRssBytes: process.memoryUsage().rss,
        dbLatencyMs: Number(dbLatencyMs.toFixed(2)),
        redisLatencyMs: Number(redisLatencyMs.toFixed(2)),
        queueDepth: await this.redis.client.llen(this.redis.k('queue', 'delivery')).catch(() => 0),
        version: process.env.npm_package_version ?? '1.0.0',
      },
    };
  }

  /** Message counts per minute, oldest first. Aggregated in SQL, not in JS. */
  private async messagesPerMinute(minutes: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>`
      SELECT date_trunc('minute', "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM "Message"
       WHERE "createdAt" > NOW() - (${minutes} || ' minutes')::interval
       GROUP BY 1
       ORDER BY 1 ASC
    `;
    const byMinute = new Map<number, number>();
    for (const r of rows) byMinute.set(new Date(r.bucket).getTime(), Number(r.count));

    const out: number[] = [];
    const start = Date.now() - minutes * 60_000;
    for (let i = 0; i < minutes; i++) {
      const t = Math.floor((start + i * 60_000) / 60_000) * 60_000;
      out.push(byMinute.get(t) ?? 0);
    }
    return out;
  }
}
