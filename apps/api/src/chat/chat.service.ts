import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ConversationDetail,
  ConversationSummary,
  MessageDTO,
  PublicUser,
  ReceiptDTO,
  SendMessageRequest,
} from '@ghostchat/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TTL_SECONDS = 90 * 24 * 3600;

function formatAvatar(key?: string | null): string | null {
  if (!key) return null;
  if (key.startsWith('data:') || key.startsWith('http://') || key.startsWith('https://')) return key;
  return `/api/media/${key}`;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Membership                                                             */
  /* ---------------------------------------------------------------------- */

  async assertMember(userId: string, conversationId: string): Promise<void> {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { id: true },
    });
    // Same error for "does not exist" and "not a member": a non-member must not
    // be able to probe which conversation ids exist.
    if (!member) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Conversation not found' });
  }

  async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async memberPseudoIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      select: { user: { select: { pseudoId: true } } },
    });
    return rows.map((r) => r.user.pseudoId);
  }

  /* ---------------------------------------------------------------------- */
  /* Conversations                                                          */
  /* ---------------------------------------------------------------------- */

  async list(userId: string): Promise<ConversationSummary[]> {
    const blockedSet = await this.getBlockedUserIds(userId);

    const memberships = await this.prisma.conversationMember.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            members: { include: { user: { include: { accessKey: true } } } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
      orderBy: { conversation: { lastActivityAt: 'desc' } },
      take: 100,
    });

    const summaries: ConversationSummary[] = [];

    for (const m of memberships) {
      const convo = m.conversation;
      const last = convo.messages[0];
      const peerMember =
        convo.type === 'DIRECT' ? convo.members.find((x) => x.userId !== userId) : undefined;
      const isPeerBlocked = peerMember ? blockedSet.has(peerMember.userId) : false;

      const unreadCount = last
        ? await this.prisma.message.count({
            where: {
              conversationId: convo.id,
              createdAt: { gt: m.lastReadAt ?? new Date(0) },
              // Sealed messages have no sender, so they always count as unread.
              OR: [{ senderPseudoId: null }, { senderPseudoId: { not: userId } }],
            },
          })
        : 0;

      summaries.push({
        id: convo.id,
        type: convo.type,
        title:
          convo.type === 'DIRECT'
            ? (peerMember?.user.displayName ?? 'Unknown')
            : (convo.title ?? 'Group'),
        avatarUrl:
          convo.type === 'DIRECT'
            ? formatAvatar(peerMember?.user.avatarObjectKey)
            : formatAvatar(convo.avatarObjectKey),
        peer: peerMember ? this.publicUser(peerMember.user) : null,
        lastMessage: last
          ? {
              id: last.id,
              kind: last.kind,
              // The server cannot decrypt this; it is the ciphertext preview.
              previewCiphertext: last.ciphertext,
              at: last.createdAt.toISOString(),
              fromSelf: last.senderPseudoId === userId,
              envelope: {
                kind: last.envelopeKind as any,
                sessionTag: last.sessionTag,
                header: last.header,
                ciphertext: last.ciphertext,
                signature: last.signature ?? undefined,
              },
              senderPseudoId: last.senderPseudoId,
            }
          : null,
        unreadCount,
        lastActivityAt: convo.lastActivityAt.toISOString(),
        isBlocked: isPeerBlocked,
        memberCount: convo.members.length,
      });
    }

    return summaries;
  }

  async detail(userId: string, conversationId: string): Promise<ConversationDetail> {
    await this.assertMember(userId, conversationId);

    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { members: { include: { user: { include: { accessKey: true } } } } },
    });
    if (!convo) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Conversation not found' });

    const peer = convo.type === 'DIRECT' ? convo.members.find((m) => m.userId !== userId) : undefined;

    return {
      id: convo.id,
      type: convo.type,
      title: convo.type === 'DIRECT' ? (peer?.user.displayName ?? 'Unknown') : (convo.title ?? 'Group'),
      avatarUrl: formatAvatar(convo.avatarObjectKey),
      members: convo.members.map((m) => ({
        userId: m.userId,
        pseudoId: m.user.pseudoId,
        numericId: m.user.numericId ?? '',
        contactCode: m.user.accessKey?.contactCode ?? '',
        displayName: m.user.displayName,
        avatarUrl: formatAvatar(m.user.avatarObjectKey),
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
        isVerified: m.user.isVerified,
      })),
      createdAt: convo.createdAt.toISOString(),
    };
  }

  /**
   * Find-or-create the 1:1 conversation for two users.
   *
   * The unique constraint on the pair is not expressible directly (members are
   * rows), so this runs inside a transaction and re-checks. A duplicate direct
   * conversation is a correctness bug, not a cosmetic one: each side would
   * ratchet on a different conversation id.
   */
  /**
   * Find-or-create the 1:1 conversation for two users. Target can be 3-digit User ID,
   * contactCode, or pseudoId.
   */
  async openDirect(userId: string, peerIdentifier: string): Promise<string> {
    const trimmed = peerIdentifier.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Target cannot be empty' });
    }

    // 1. Try finding by 3-digit numericId
    let peer = await this.prisma.user.findFirst({
      where: { numericId: trimmed, status: 'ACTIVE' },
      select: { id: true, status: true },
    });

    // 2. If not found, try finding by accessKey.contactCode
    if (!peer) {
      const peerKey = await this.prisma.accessKey.findUnique({
        where: { contactCode: trimmed },
        select: { user: { select: { id: true, status: true } } },
      });
      peer = peerKey?.user ?? null;
    }

    // 3. If not found, try finding by pseudoId
    if (!peer) {
      peer = await this.prisma.user.findFirst({
        where: { pseudoId: trimmed, status: 'ACTIVE' },
        select: { id: true, status: true },
      });
    }

    if (!peer || peer.status !== 'ACTIVE') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipient not found' });
    }
    if (peer.id === userId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Cannot message yourself' });
    }

    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { members: { some: { userId } } },
          { members: { some: { userId: peer.id } } },
        ],
      },
      select: { id: true, _count: { select: { members: true } } },
    });
    if (existing && existing._count.members === 2) return existing.id;

    const created = await this.prisma.conversation.create({
      data: {
        type: 'DIRECT',
        createdById: userId,
        members: { create: [{ userId }, { userId: peer.id }] },
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Look up an active user by 3-digit User ID, contactCode, or pseudoId. */
  async findUser(userId: string, query: string): Promise<PublicUser> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Query cannot be empty' });
    }

    // 1. Search by 3-digit User ID (numericId)
    let user = await this.prisma.user.findFirst({
      where: { numericId: trimmed, status: 'ACTIVE' },
      include: { accessKey: true },
    });

    // 2. Search by contactCode
    if (!user) {
      const accessKey = await this.prisma.accessKey.findUnique({
        where: { contactCode: trimmed },
        include: { user: { include: { accessKey: true } } },
      });
      user = accessKey?.user ?? null;
    }

    // 3. Search by pseudoId
    if (!user) {
      user = await this.prisma.user.findFirst({
        where: { pseudoId: trimmed, status: 'ACTIVE' },
        include: { accessKey: true },
      });
    }

    if (!user || user.status !== 'ACTIVE') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No user found' });
    }

    return this.publicUser(user);
  }

  /**
   * Delete a conversation.
   * If DIRECT: deletes conversation, cascaded messages, and cleans up any friend link.
   * If GROUP: leaves group, or purges conversation if last member.
   */
  async deleteConversation(userId: string, conversationId: string): Promise<{ success: boolean }> {
    await this.assertMember(userId, conversationId);

    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true },
    });
    if (!convo) return { success: true };

    if (convo.type === 'DIRECT') {
      const otherMember = convo.members.find((m) => m.userId !== userId);
      if (otherMember) {
        await this.prisma.friendRequest.deleteMany({
          where: {
            OR: [
              { senderId: userId, receiverId: otherMember.userId },
              { senderId: otherMember.userId, receiverId: userId },
            ],
          },
        }).catch(() => null);
      }
      await this.prisma.conversation.delete({ where: { id: conversationId } });
    } else {
      await this.prisma.conversationMember.deleteMany({
        where: { conversationId, userId },
      });
      const remaining = await this.prisma.conversationMember.count({
        where: { conversationId },
      });
      if (remaining === 0) {
        await this.prisma.conversation.delete({ where: { id: conversationId } }).catch(() => null);
      }
    }

    return { success: true };
  }

  /**
   * Block a user by pseudoId, numericId, contactCode, or userId.
   */
  async blockUser(userId: string, targetIdentifier: string): Promise<{ success: boolean; pseudoId: string }> {
    const trimmed = targetIdentifier.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Target cannot be empty' });
    }

    let target = await this.prisma.user.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [
          { pseudoId: trimmed },
          { numericId: trimmed },
          { id: trimmed },
          { accessKey: { contactCode: trimmed } },
        ],
      },
      select: { id: true, pseudoId: true },
    });

    if (!target) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    }

    if (target.id === userId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Cannot block yourself' });
    }

    // 1. Try DB persistence
    try {
      await (this.prisma as any).blockedUser.upsert({
        where: { userId_blockedUserId: { userId, blockedUserId: target.id } },
        create: { userId, blockedUserId: target.id },
        update: {},
      });
    } catch {
      // non-fatal if table not migrated yet
    }

    // 2. Redis fast cache
    await this.redis.client.sadd(this.redis.k('blocks', userId), target.id);
    await this.redis.client.sadd(this.redis.k('blocks_pseudo', userId), target.pseudoId);

    // 3. Remove friend connection
    await this.prisma.friendRequest.deleteMany({
      where: {
        OR: [
          { senderId: userId, receiverId: target.id },
          { senderId: target.id, receiverId: userId },
        ],
      },
    }).catch(() => null);

    return { success: true, pseudoId: target.pseudoId };
  }

  /**
   * Unblock a user.
   */
  async unblockUser(userId: string, targetIdentifier: string): Promise<{ success: boolean; pseudoId: string }> {
    const trimmed = targetIdentifier.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Target cannot be empty' });
    }

    const target = await this.prisma.user.findFirst({
      where: {
        OR: [
          { pseudoId: trimmed },
          { numericId: trimmed },
          { id: trimmed },
          { accessKey: { contactCode: trimmed } },
        ],
      },
      select: { id: true, pseudoId: true },
    });

    if (!target) {
      await this.redis.client.srem(this.redis.k('blocks', userId), trimmed);
      await this.redis.client.srem(this.redis.k('blocks_pseudo', userId), trimmed);
      return { success: true, pseudoId: trimmed };
    }

    try {
      await (this.prisma as any).blockedUser.deleteMany({
        where: { userId, blockedUserId: target.id },
      });
    } catch {
      // non-fatal
    }

    await this.redis.client.srem(this.redis.k('blocks', userId), target.id);
    await this.redis.client.srem(this.redis.k('blocks_pseudo', userId), target.pseudoId);

    return { success: true, pseudoId: target.pseudoId };
  }

  /**
   * List users blocked by this user.
   */
  async listBlockedUsers(userId: string): Promise<any[]> {
    const blocked: any[] = [];
    try {
      const rows = await (this.prisma as any).blockedUser.findMany({
        where: { userId },
        include: { blockedUser: { include: { accessKey: true } } },
      });
      for (const r of rows) {
        if (r.blockedUser) {
          blocked.push({
            id: r.id,
            pseudoId: r.blockedUser.pseudoId,
            numericId: r.blockedUser.numericId ?? '',
            displayName: r.blockedUser.displayName,
            avatarUrl: formatAvatar(r.blockedUser.avatarObjectKey),
            blockedAt: r.createdAt.toISOString(),
          });
        }
      }
    } catch {
      // fallback to redis below
    }

    const redisPseudo = await this.redis.client.smembers(this.redis.k('blocks_pseudo', userId));
    for (const pseudoId of redisPseudo) {
      if (!blocked.some((b) => b.pseudoId === pseudoId)) {
        const u = await this.prisma.user.findFirst({
          where: { pseudoId },
          include: { accessKey: true },
        });
        if (u) {
          blocked.push({
            id: pseudoId,
            pseudoId: u.pseudoId,
            numericId: u.numericId ?? '',
            displayName: u.displayName,
            avatarUrl: formatAvatar(u.avatarObjectKey),
            blockedAt: new Date().toISOString(),
          });
        }
      }
    }

    return blocked;
  }

  async getBlockedUserIds(userId: string): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const rows = await (this.prisma as any).blockedUser.findMany({
        where: { userId },
        select: { blockedUserId: true },
      });
      for (const r of rows) set.add(r.blockedUserId);
    } catch {
      // fallback to redis
    }

    const redisIds = await this.redis.client.smembers(this.redis.k('blocks', userId));
    for (const id of redisIds) set.add(id);

    return set;
  }

  async isPairBlocked(userIdA: string, userIdB: string): Promise<boolean> {
    const [setA, setB] = await Promise.all([
      this.getBlockedUserIds(userIdA),
      this.getBlockedUserIds(userIdB),
    ]);
    return setA.has(userIdB) || setB.has(userIdA);
  }

  /* ---------------------------------------------------------------------- */
  /* Messages                                                               */
  /* ---------------------------------------------------------------------- */

  async history(
    userId: string,
    conversationId: string,
    before?: string,
    limit = 50,
  ): Promise<MessageDTO[]> {
    await this.assertMember(userId, conversationId);
    const take = Math.min(Math.max(limit, 1), 100);

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        sender: { select: { id: true, pseudoId: true, displayName: true } },
        receipts: { select: { state: true, userId: true } },
        reactions: {
          select: {
            emoji: true,
            userId: true,
            user: { select: { pseudoId: true, displayName: true } },
          },
        },
      },
    });

    return rows.reverse().map((m) => this.toDto(m, userId));
  }

  async send(
    userId: string,
    input: SendMessageRequest,
  ): Promise<{ message: MessageDTO; recipients: string[] }> {
    await this.assertMember(userId, input.conversationId);

    // Verify neither party has blocked the other in direct chat
    const convoMembers = await this.prisma.conversationMember.findMany({
      where: { conversationId: input.conversationId },
      select: { userId: true },
    });
    for (const m of convoMembers) {
      if (m.userId !== userId) {
        const blocked = await this.isPairBlocked(userId, m.userId);
        if (blocked) {
          throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Communication blocked' });
        }
      }
    }

    const ciphertextBytes = Buffer.from(input.envelope.ciphertext, 'base64url').length;
    if (ciphertextBytes === 0 || ciphertextBytes > MAX_MESSAGE_BYTES) {
      throw new BadRequestException({ code: 'PAYLOAD_TOO_LARGE', message: 'Message too large' });
    }

    const ttl = input.ttlSeconds ?? null;
    if (ttl !== null && (ttl < 5 || ttl > MAX_TTL_SECONDS)) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Invalid TTL' });
    }

    // Sealed sender: the transport identity is deliberately NOT persisted.
    const sealed = input.envelope.kind === 'SEALED';

    // Idempotency: the unique (conversationId, clientRef) constraint means a
    // retried send returns the original row instead of duplicating the message.
    const existing = await this.prisma.message.findUnique({
      where: {
        conversationId_clientRef: {
          conversationId: input.conversationId,
          clientRef: input.clientRef,
        },
      },
      include: {
        sender: { select: { id: true, pseudoId: true, displayName: true } },
        reactions: {
          select: {
            emoji: true,
            userId: true,
            user: { select: { pseudoId: true, displayName: true } },
          },
        },
      },
    });
    if (existing) {
      return {
        message: this.toDto(existing, userId),
        recipients: await this.memberPseudoIds(input.conversationId),
      };
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { keyEpoch: true },
    });

    const created = await this.prisma.message.create({
      data: {
        conversationId: input.conversationId,
        senderPseudoId: sealed ? null : userId,
        envelopeKind: input.envelope.kind,
        sessionTag: input.envelope.sessionTag,
        header: input.envelope.header,
        ciphertext: input.envelope.ciphertext,
        signature: input.envelope.signature ?? null,
        keyEpoch: conversation?.keyEpoch ?? 0,
        clientRef: input.clientRef,
        replyTo: input.replyTo ? JSON.stringify(input.replyTo) : null,
        expiresAt: ttl ? new Date(Date.now() + ttl * 1000) : null,
      },
      include: {
        sender: { select: { id: true, pseudoId: true, displayName: true } },
        reactions: {
          select: {
            emoji: true,
            userId: true,
            user: { select: { pseudoId: true, displayName: true } },
          },
        },
      },
    });

    await this.prisma.conversation.update({
      where: { id: input.conversationId },
      data: { lastActivityAt: new Date() },
    });

    return {
      message: this.toDto(created, userId),
      recipients: await this.memberPseudoIds(input.conversationId),
    };
  }

  async markRead(userId: string, conversationId: string, messageIds: string[]): Promise<ReceiptDTO[]> {
    await this.assertMember(userId, conversationId);

    const ids = messageIds.slice(0, 200);
    // CRITICAL: A user should NEVER mark their own sent messages as read!
    const messages = await this.prisma.message.findMany({
      where: {
        id: { in: ids },
        conversationId,
        OR: [
          { senderPseudoId: null },
          { senderPseudoId: { not: userId } },
        ],
      },
      select: { id: true },
    });

    const receipts: ReceiptDTO[] = [];
    for (const message of messages) {
      const receipt = await this.prisma.receipt.upsert({
        where: { messageId_userId_state: { messageId: message.id, userId, state: 'READ' } },
        create: { messageId: message.id, userId, state: 'READ' },
        update: { at: new Date() },
      });
      receipts.push({
        messageId: receipt.messageId,
        conversationId,
        userId,
        state: 'READ',
        at: receipt.at.toISOString(),
      });
    }

    await this.prisma.conversationMember.updateMany({
      where: { conversationId, userId },
      data: { lastReadAt: new Date() },
    });

    return receipts;
  }

  async react(
    userId: string,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ action: 'add' | 'remove'; emoji: string }> {
    await this.assertMember(userId, conversationId);

    const existing = await this.prisma.reaction.findUnique({
      where: { messageId_userId: { messageId, userId } },
    });

    if (existing && existing.emoji === emoji) {
      await this.prisma.reaction.delete({
        where: { id: existing.id },
      });
      return { action: 'remove', emoji };
    }

    if (existing) {
      await this.prisma.reaction.update({
        where: { id: existing.id },
        data: { emoji },
      });
      return { action: 'add', emoji };
    }

    await this.prisma.reaction.create({
      data: { messageId, userId, emoji },
    });
    return { action: 'add', emoji };
  }

  async markDelivered(userId: string, conversationId: string, messageId: string): Promise<ReceiptDTO | null> {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { id: true },
    });
    if (!member) return null;

    const receipt = await this.prisma.receipt.upsert({
      where: { messageId_userId_state: { messageId, userId, state: 'DELIVERED' } },
      create: { messageId, userId, state: 'DELIVERED' },
      update: {},
    });
    return {
      messageId: receipt.messageId,
      conversationId,
      userId,
      state: 'DELIVERED',
      at: receipt.at.toISOString(),
    };
  }

  /** Recipients of a message, for socket fan-out. */
  async recipientsFor(conversationId: string, messageId: string): Promise<string[]> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true },
    });
    if (!message) return [];
    return this.memberPseudoIds(message.conversationId);
  }

  /* ---------------------------------------------------------------------- */
  /* Mapping                                                                */
  /* ---------------------------------------------------------------------- */

  toDto(
    m: {
      id: string;
      conversationId: string;
      senderPseudoId: string | null;
      kind: string;
      envelopeKind: string;
      sessionTag: string;
      header: string;
      ciphertext: string;
      signature: string | null;
      clientRef: string;
      replyTo?: string | null;
      createdAt: Date;
      expiresAt: Date | null;
      sender?: { id?: string; pseudoId: string; displayName: string } | null;
      receipts?: Array<{ state: string; userId: string }>;
      reactions?: Array<{
        emoji: string;
        userId: string;
        user?: { pseudoId: string; displayName: string } | null;
      }>;
    },
    viewerUserId?: string,
  ): MessageDTO {
    let receiptState: MessageDTO['receiptState'] = 'SENT';
    if (m.receipts && m.receipts.length > 0) {
      // Exclude receipts by the author of the message themselves
      const nonAuthorReceipts = m.receipts.filter(
        (r) => r.userId !== m.senderPseudoId && (!m.sender?.id || r.userId !== m.sender.id),
      );
      if (nonAuthorReceipts.some((r) => r.state === 'READ')) {
        receiptState = 'READ';
      } else if (nonAuthorReceipts.some((r) => r.state === 'DELIVERED')) {
        receiptState = 'DELIVERED';
      }
    }

    const senderPseudoId =
      m.sender?.pseudoId ??
      (m.senderPseudoId?.startsWith('u_') || m.senderPseudoId === 'admin' ? m.senderPseudoId : null);

    const fromSelf = viewerUserId
      ? (m.sender?.id === viewerUserId || m.senderPseudoId === viewerUserId)
      : false;

    let replyTo: any = null;
    if (m.replyTo) {
      try {
        replyTo = JSON.parse(m.replyTo);
      } catch {
        replyTo = null;
      }
    }

    const reactionsMap = new Map<string, { count: number; byMe: boolean; users: Array<{ pseudoId: string; displayName: string }> }>();
    if (m.reactions) {
      for (const r of m.reactions) {
        const entry = reactionsMap.get(r.emoji) ?? { count: 0, byMe: false, users: [] };
        entry.count++;
        if (viewerUserId && r.userId === viewerUserId) entry.byMe = true;
        if (r.user) entry.users.push({ pseudoId: r.user.pseudoId, displayName: r.user.displayName });
        reactionsMap.set(r.emoji, entry);
      }
    }
    const reactions = Array.from(reactionsMap.entries()).map(([emoji, data]) => ({
      emoji,
      ...data,
    }));

    return {
      id: m.id,
      conversationId: m.conversationId,
      senderPseudoId,
      senderDisplayName: m.sender?.displayName ?? null,
      kind: m.kind as MessageDTO['kind'],
      envelope: {
        kind: m.envelopeKind as MessageDTO['envelope']['kind'],
        sessionTag: m.sessionTag,
        header: m.header,
        ciphertext: m.ciphertext,
        ...(m.signature ? { signature: m.signature } : {}),
      },
      createdAt: m.createdAt.toISOString(),
      expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
      clientRef: m.clientRef,
      receiptState,
      reactions,
      replyTo,
      fromSelf,
    };
  }

  publicUser(user: {
    pseudoId: string;
    displayName: string;
    numericId?: string | null;
    avatarObjectKey: string | null;
    keyFingerprint: string;
    createdAt: Date;
    role: string;
    accessKey?: { contactCode: string } | null;
    isVerified?: boolean;
  }): PublicUser {
    return {
      pseudoId: user.pseudoId,
      displayName: user.displayName,
      numericId: user.numericId ?? '',
      avatarUrl: formatAvatar(user.avatarObjectKey),
      contactCode: user.accessKey?.contactCode ?? '',
      role: user.role as PublicUser['role'],
      keyFingerprint: user.keyFingerprint,
      createdAt: user.createdAt.toISOString(),
      isVerified: user.isVerified ?? false,
    };
  }
}
