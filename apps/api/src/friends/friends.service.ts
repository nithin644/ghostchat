import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FriendRequestDTO, PublicUser, UserSearchResult } from '@ghostchat/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  /** Search users by 3-digit User ID or Display Name */
  async searchUsers(currentUserId: string, rawQuery: string): Promise<UserSearchResult[]> {
    const q = rawQuery.trim();
    if (!q) return [];

    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: { not: currentUserId },
        OR: [
          { numericId: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
          { pseudoId: { contains: q, mode: 'insensitive' } },
          { accessKey: { contactCode: { contains: q, mode: 'insensitive' } } },
        ],
      },
      include: { accessKey: true },
      take: 20,
    });

    return this.attachFriendshipStatus(currentUserId, users);
  }

  /** Browse all registered users with friend status and stats */
  async listUsers(currentUserId: string) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: { not: currentUserId },
      },
      include: { accessKey: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const results = await this.attachFriendshipStatus(currentUserId, users);
    const totalUsers = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const onlineCount = await this.prisma.user.count({
      where: { status: 'ACTIVE', lastSeenAt: { gte: fifteenMinutesAgo } },
    });
    const offlineCount = Math.max(0, totalUsers - onlineCount);

    return {
      users: results,
      stats: {
        total: totalUsers,
        online: onlineCount,
        offline: offlineCount,
      },
    };
  }

  /** Send or auto-accept a friend request */
  async sendRequest(
    currentUserId: string,
    targetIdentifier: string,
  ): Promise<{ status: string; conversationId?: string; id?: string }> {
    const trimmed = targetIdentifier.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Target cannot be empty' });
    }

    // Resolve target
    let target = await this.prisma.user.findFirst({
      where: { numericId: trimmed, status: 'ACTIVE' },
      select: { id: true, pseudoId: true },
    });

    if (!target) {
      target = await this.prisma.user.findFirst({
        where: { pseudoId: trimmed, status: 'ACTIVE' },
        select: { id: true, pseudoId: true },
      });
    }

    if (!target) {
      const key = await this.prisma.accessKey.findUnique({
        where: { contactCode: trimmed },
        select: { user: { select: { id: true, pseudoId: true, status: true } } },
      });
      if (key?.user && key.user.status === 'ACTIVE') {
        target = key.user;
      }
    }

    if (!target) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });
    }

    if (target.id === currentUserId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Cannot add yourself' });
    }

    // Check existing request in either direction
    const existing = await this.prisma.friendRequest.findFirst({
      where: {
        OR: [
          { senderId: currentUserId, receiverId: target.id },
          { senderId: target.id, receiverId: currentUserId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        const conversationId = await this.chat.openDirect(currentUserId, target.pseudoId);
        return { status: 'ACCEPTED', conversationId };
      }

      if (existing.senderId === target.id && existing.status === 'PENDING') {
        // Auto-accept reciprocal request
        await this.prisma.friendRequest.update({
          where: { id: existing.id },
          data: { status: 'ACCEPTED' },
        });
        const conversationId = await this.chat.openDirect(currentUserId, target.pseudoId);
        return { status: 'ACCEPTED', conversationId };
      }

      if (existing.senderId === currentUserId && existing.status === 'PENDING') {
        return { status: 'PENDING', id: existing.id };
      }

      // If previously declined, re-open as PENDING
      const updated = await this.prisma.friendRequest.update({
        where: { id: existing.id },
        data: { senderId: currentUserId, receiverId: target.id, status: 'PENDING' },
      });
      return { status: 'PENDING', id: updated.id };
    }

    const created = await this.prisma.friendRequest.create({
      data: {
        senderId: currentUserId,
        receiverId: target.id,
        status: 'PENDING',
      },
    });

    return { status: 'PENDING', id: created.id };
  }

  /** List pending incoming & outgoing friend requests */
  async getRequests(currentUserId: string): Promise<{
    incoming: FriendRequestDTO[];
    outgoing: FriendRequestDTO[];
  }> {
    const requests = await this.prisma.friendRequest.findMany({
      where: {
        OR: [
          { receiverId: currentUserId, status: 'PENDING' },
          { senderId: currentUserId, status: 'PENDING' },
        ],
      },
      include: {
        sender: { include: { accessKey: true } },
        receiver: { include: { accessKey: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const incoming: FriendRequestDTO[] = [];
    const outgoing: FriendRequestDTO[] = [];

    for (const r of requests) {
      if (r.receiverId === currentUserId) {
        incoming.push({
          id: r.id,
          senderId: r.senderId,
          receiverId: r.receiverId,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          user: this.toPublicUser(r.sender),
        });
      } else {
        outgoing.push({
          id: r.id,
          senderId: r.senderId,
          receiverId: r.receiverId,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          user: this.toPublicUser(r.receiver),
        });
      }
    }

    return { incoming, outgoing };
  }

  /** Accept friend request and open direct conversation */
  async acceptRequest(currentUserId: string, requestId: string): Promise<{ conversationId: string }> {
    const request = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
      include: { sender: true },
    });

    if (!request || request.receiverId !== currentUserId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Friend request not found' });
    }

    await this.prisma.friendRequest.update({
      where: { id: requestId },
      data: { status: 'ACCEPTED' },
    });

    // Create direct conversation
    const conversationId = await this.chat.openDirect(currentUserId, request.sender.pseudoId);
    return { conversationId };
  }

  /** Decline or cancel friend request */
  async declineRequest(currentUserId: string, requestId: string): Promise<{ success: boolean }> {
    const request = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });

    if (!request || (request.receiverId !== currentUserId && request.senderId !== currentUserId)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Friend request not found' });
    }

    await this.prisma.friendRequest.delete({
      where: { id: requestId },
    });

    return { success: true };
  }

  private async attachFriendshipStatus(
    currentUserId: string,
    users: Array<any>,
  ): Promise<UserSearchResult[]> {
    if (users.length === 0) return [];
    const targetIds = users.map((u) => u.id);
    const blockedSet = await this.chat.getBlockedUserIds(currentUserId);

    const requests = await this.prisma.friendRequest.findMany({
      where: {
        OR: [
          { senderId: currentUserId, receiverId: { in: targetIds } },
          { receiverId: currentUserId, senderId: { in: targetIds } },
        ],
      },
    });

    const statusMap = new Map<string, { status: string; id: string }>();
    for (const r of requests) {
      const otherId = r.senderId === currentUserId ? r.receiverId : r.senderId;
      if (r.status === 'ACCEPTED') {
        statusMap.set(otherId, { status: 'ACCEPTED', id: r.id });
      } else if (r.status === 'PENDING') {
        if (r.senderId === currentUserId) {
          statusMap.set(otherId, { status: 'PENDING_SENT', id: r.id });
        } else {
          statusMap.set(otherId, { status: 'PENDING_RECEIVED', id: r.id });
        }
      }
    }

    return users.map((u) => {
      const isBlocked = blockedSet.has(u.id);
      const req = statusMap.get(u.id);
      return {
        ...this.toPublicUser(u),
        friendStatus: isBlocked ? 'BLOCKED' : ((req?.status as UserSearchResult['friendStatus']) ?? 'NONE'),
        requestId: req?.id,
        isBlocked,
      };
    });
  }

  private toPublicUser(user: any): PublicUser {
    return {
      pseudoId: user.pseudoId,
      displayName: user.displayName,
      numericId: user.numericId ?? '',
      avatarUrl: user.avatarObjectKey
        ? user.avatarObjectKey.startsWith('data:') || user.avatarObjectKey.startsWith('http')
          ? user.avatarObjectKey
          : `/api/media/${user.avatarObjectKey}`
        : null,
      contactCode: user.accessKey?.contactCode ?? '',
      role: user.role,
      keyFingerprint: user.keyFingerprint,
      createdAt: user.createdAt.toISOString(),
      isVerified: Boolean(user.isVerified),
    };
  }
}
