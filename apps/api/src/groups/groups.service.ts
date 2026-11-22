import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  ConversationDetail,
  ConversationMemberDTO,
  GroupInviteDTO,
  CreateGroupRequest,
  GroupRequestDTO,
  CreateGroupWithMembersRequest,
} from '@ghostchat/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';

const MAX_GROUP_MEMBERS = 256;

/**
 * Group lifecycle.
 *
 * Membership is necessarily visible to the server — it has to route messages and
 * enforce the member list. Group *content* stays E2EE via Sender Keys, which the
 * server never sees; `keyEpoch` is bumped on removal so clients know to rotate
 * them (otherwise a removed member keeps reading with keys they already hold).
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  async create(userId: string, input: CreateGroupRequest): Promise<ConversationDetail> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 64) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Group name must be 1-64 characters' });
    }

    const memberIds = new Set<string>([userId]);
    for (const code of input.memberContactCodes.slice(0, MAX_GROUP_MEMBERS - 1)) {
      const keyRow = await this.prisma.accessKey.findUnique({
        where: { contactCode: code },
        select: { user: { select: { id: true, status: true } } },
      });
      const user = keyRow?.user ?? null;
      if (user && user.status === 'ACTIVE') memberIds.add(user.id);
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        type: 'GROUP',
        title: name,
        createdById: userId,
        maxMembers: Math.min(input.maxMembers ?? MAX_GROUP_MEMBERS, MAX_GROUP_MEMBERS),
        members: {
          create: [...memberIds].map((id) => ({
            userId: id,
            role: id === userId ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      select: { id: true },
    });

    await this.prisma.auditEvent.create({
      data: { actorId: userId, action: 'group.created', target: conversation.id },
    });

    return this.chat.detail(userId, conversation.id);
  }

  async createInvite(
    userId: string,
    conversationId: string,
    options: { expiresInHours?: number; maxUses?: number },
  ): Promise<GroupInviteDTO> {
    const member = await this.requireRole(userId, conversationId, ['OWNER', 'ADMIN']);

    const invite = await this.prisma.groupInvite.create({
      data: {
        conversationId,
        createdById: member.userId,
        code: randomBytes(18).toString('base64url'),
        expiresAt: options.expiresInHours
          ? new Date(Date.now() + options.expiresInHours * 3600 * 1000)
          : null,
        maxUses: options.maxUses ?? null,
      },
    });

    return {
      id: invite.id,
      conversationId,
      inviteCode: invite.code,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      maxUses: invite.maxUses,
      uses: invite.uses,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  async join(userId: string, code: string): Promise<ConversationDetail> {
    const invite = await this.prisma.groupInvite.findUnique({
      where: { code },
      include: { conversation: { include: { _count: { select: { members: true } } } } },
    });

    if (!invite || invite.revokedAt) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invite is not valid' });
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Invite has expired' });
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Invite has been used up' });
    }
    if (invite.conversation._count.members >= invite.conversation.maxMembers) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Group is full' });
    }

    try {
      await this.prisma.$transaction([
        this.prisma.conversationMember.create({ data: { conversationId: invite.conversationId, userId } }),
        this.prisma.groupInvite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } }),
      ]);
    } catch {
      // Already a member: joining twice is a no-op, not an error the user must see.
    }

    return this.chat.detail(userId, invite.conversationId);
  }

  async members(conversationId: string): Promise<ConversationMemberDTO[]> {
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      include: { user: true },
    });
    return rows.map((m) => ({
      userId: m.userId,
      pseudoId: m.user.pseudoId,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarObjectKey
        ? m.user.avatarObjectKey.startsWith('data:') || /^https?:\/\//.test(m.user.avatarObjectKey)
          ? m.user.avatarObjectKey
          : `/api/media/${m.user.avatarObjectKey}`
        : null,
      role: m.role,
      isVerified: Boolean(m.user.isVerified),
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  /**
   * Remove a member and rotate the group key epoch.
   *
   * Rotation is mandatory, not cosmetic: the departing member still holds the
   * Sender Keys for the current epoch. Bumping the epoch tells every remaining
   * client to mint a fresh Sender Key and redistribute it, so the removed member
   * cannot read anything sent after this point.
   */
  async removeMember(actorId: string, conversationId: string, targetPseudoId: string) {
    await this.requireRole(actorId, conversationId, ['OWNER', 'ADMIN']);

    const target = await this.prisma.user.findUnique({
      where: { pseudoId: targetPseudoId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found' });

    if (target.id === actorId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Use /leave to remove yourself' });
    }

    await this.prisma.$transaction([
      this.prisma.conversationMember.deleteMany({
        where: { conversationId, userId: target.id },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { keyEpoch: { increment: 1 }, lastActivityAt: new Date() },
      }),
      this.prisma.auditEvent.create({
        data: { actorId, action: 'group.member-removed', target: conversationId },
      }),
    ]);

    return { removed: true, keyEpochBumped: true };
  }

  async leave(userId: string, conversationId: string) {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not a member' });

    await this.prisma.$transaction([
      this.prisma.conversationMember.delete({ where: { id: member.id } }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { keyEpoch: { increment: 1 } },
      }),
    ]);
    return { left: true };
  }

  async createWithMembers(
    userId: string,
    input: CreateGroupWithMembersRequest,
  ): Promise<{ group: ConversationDetail; inviteCode: string }> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 64) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Group name must be 1-64 characters' });
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        type: 'GROUP',
        title: name,
        avatarObjectKey: input.avatarUrl ?? null,
        createdById: userId,
        members: {
          create: [{ userId, role: 'OWNER' }],
        },
      },
      select: { id: true },
    });

    const inviteCode = randomBytes(18).toString('base64url');
    await this.prisma.groupInvite.create({
      data: {
        conversationId: conversation.id,
        createdById: userId,
        code: inviteCode,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        maxUses: 256,
      },
    });

    if (input.memberPseudoIds && input.memberPseudoIds.length > 0) {
      const targetPseudos = [...new Set(input.memberPseudoIds)];
      for (const targetPseudo of targetPseudos) {
        const target = await this.prisma.user.findFirst({
          where: { OR: [{ pseudoId: targetPseudo }, { id: targetPseudo.length === 36 ? targetPseudo : undefined }] },
          select: { id: true },
        });
        if (target && target.id !== userId) {
          await this.prisma.groupRequest.upsert({
            where: { conversationId_userId: { conversationId: conversation.id, userId: target.id } },
            update: { status: 'PENDING', inviteCode },
            create: {
              conversationId: conversation.id,
              invitedById: userId,
              userId: target.id,
              inviteCode,
              status: 'PENDING',
            },
          });
        }
      }
    }

    await this.prisma.auditEvent.create({
      data: { actorId: userId, action: 'group.created', target: conversation.id },
    });

    const group = await this.chat.detail(userId, conversation.id);
    return { group, inviteCode };
  }

  async updateGroup(
    userId: string,
    conversationId: string,
    input: { avatarUrl?: string | null; name?: string },
  ): Promise<ConversationDetail> {
    await this.requireRole(userId, conversationId, ['OWNER', 'ADMIN']);

    const data: { avatarObjectKey?: string | null; title?: string } = {};
    if (input.avatarUrl !== undefined) {
      data.avatarObjectKey = input.avatarUrl;
    }
    if (input.name) {
      data.title = input.name.trim();
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data,
    });

    return this.chat.detail(userId, conversationId);
  }

  async sendGroupRequests(
    adminUserId: string,
    conversationId: string,
    targetPseudoIds: string[],
  ): Promise<{ count: number; inviteCode: string }> {
    await this.requireRole(adminUserId, conversationId, ['OWNER', 'ADMIN']);

    let invite = await this.prisma.groupInvite.findFirst({
      where: { conversationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!invite) {
      const code = randomBytes(18).toString('base64url');
      invite = await this.prisma.groupInvite.create({
        data: {
          conversationId,
          createdById: adminUserId,
          code,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          maxUses: 256,
        },
      });
    }

    const cleanTargets = [...new Set(targetPseudoIds)];
    let count = 0;
    for (const targetPseudo of cleanTargets) {
      const target = await this.prisma.user.findFirst({
        where: { OR: [{ pseudoId: targetPseudo }, { id: targetPseudo.length === 36 ? targetPseudo : undefined }] },
        select: { id: true },
      });
      if (target && target.id !== adminUserId) {
        await this.prisma.groupRequest.upsert({
          where: { conversationId_userId: { conversationId, userId: target.id } },
          update: { status: 'PENDING', inviteCode: invite.code },
          create: {
            conversationId,
            invitedById: adminUserId,
            userId: target.id,
            inviteCode: invite.code,
            status: 'PENDING',
          },
        });
        count++;
      }
    }

    return { count, inviteCode: invite.code };
  }

  async getGroupRequests(userId: string): Promise<GroupRequestDTO[]> {
    const rows = await this.prisma.groupRequest.findMany({
      where: { userId, status: 'PENDING' },
      include: {
        conversation: {
          include: {
            _count: { select: { members: true } },
          },
        },
        invitedBy: {
          select: { pseudoId: true, displayName: true, numericId: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      groupTitle: r.conversation.title ?? 'Group',
      groupAvatarUrl: r.conversation.avatarObjectKey,
      memberCount: r.conversation._count.members,
      invitedBy: {
        pseudoId: r.invitedBy.pseudoId,
        displayName: r.invitedBy.displayName,
        numericId: r.invitedBy.numericId ?? undefined,
      },
      inviteCode: r.inviteCode,
      status: r.status as 'PENDING',
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async acceptGroupRequest(
    userId: string,
    requestId: string,
  ): Promise<{ conversationId: string; inviteCode: string; group: ConversationDetail }> {
    const req = await this.prisma.groupRequest.findFirst({
      where: { id: requestId, userId },
      include: { conversation: { include: { _count: { select: { members: true } } } } },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group request not found' });
    if (req.conversation._count.members >= req.conversation.maxMembers) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Group is full' });
    }

    await this.prisma.$transaction([
      this.prisma.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: req.conversationId, userId } },
        update: {},
        create: { conversationId: req.conversationId, userId, role: 'MEMBER' },
      }),
      this.prisma.groupRequest.update({
        where: { id: req.id },
        data: { status: 'ACCEPTED' },
      }),
    ]);

    const group = await this.chat.detail(userId, req.conversationId);
    return { conversationId: req.conversationId, inviteCode: req.inviteCode, group };
  }

  async declineGroupRequest(userId: string, requestId: string): Promise<{ success: boolean }> {
    const req = await this.prisma.groupRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group request not found' });

    await this.prisma.groupRequest.update({
      where: { id: req.id },
      data: { status: 'DECLINED' },
    });
    return { success: true };
  }

  private async requireRole(
    userId: string,
    conversationId: string,
    roles: Array<'OWNER' | 'ADMIN' | 'MEMBER'>,
  ) {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: { userId: true, role: true },
    });
    if (!member) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Conversation not found' });
    if (!roles.includes(member.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Insufficient group role' });
    }
    return member;
  }
}
