import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { GroupsService } from './groups.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import { RateLimitService, RULES } from '../common/rate-limit.service';
import type { AuthedUser } from '../common/session.service';

const b64 = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/);

const createSchema = z.object({
  name: z.string().min(1).max(64),
  memberContactCodes: z.array(b64).max(255),
  maxMembers: z.number().int().min(2).max(256).optional(),
});

const createWithMembersSchema = z.object({
  name: z.string().min(1).max(64),
  avatarUrl: z.string().max(2_000_000).nullable().optional(),
  memberPseudoIds: z.array(z.string().min(1)).max(255).optional(),
});

const inviteUsersSchema = z.object({
  pseudoIds: z.array(z.string().min(1)).min(1).max(255),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  avatarUrl: z.string().max(2_000_000).nullable().optional(),
});

@UseGuards(SessionGuard)
@Controller('groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('create-with-members')
  async createWithMembers(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const input = parseBody(createWithMembersSchema, body);
    await this.rateLimit.enforce(RULES.groupCreate, user.userId);
    return this.groups.createWithMembers(user.userId, input);
  }

  @Get('requests')
  async getRequests(@CurrentUser() user: AuthedUser) {
    return this.groups.getGroupRequests(user.userId);
  }

  @Post('requests/:id/accept')
  async acceptRequest(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.groups.acceptGroupRequest(user.userId, id);
  }

  @Delete('requests/:id')
  async declineRequest(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.groups.declineGroupRequest(user.userId, id);
  }

  @Post(':id/invite-users')
  async inviteUsers(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { pseudoIds } = parseBody(inviteUsersSchema, body);
    return this.groups.sendGroupRequests(user.userId, id, pseudoIds);
  }

  @Post()
  async create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const input = parseBody(createSchema, body);
    await this.rateLimit.enforce(RULES.groupCreate, user.userId);
    return this.groups.create(user.userId, input);
  }

  @Post('join')
  async join(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const { inviteCode } = parseBody(z.object({ inviteCode: z.string().min(16).max(64) }), body);
    await this.rateLimit.enforce(RULES.groupJoin, user.userId);
    return this.groups.join(user.userId, inviteCode);
  }

  @Patch(':id')
  async updateGroup(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(updateGroupSchema, body);
    return this.groups.updateGroup(user.userId, id, input);
  }

  @Post(':id/invites')
  async invite(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(
      z.object({ expiresInHours: z.number().int().min(1).max(720).optional(), maxUses: z.number().int().min(1).max(1000).optional() }),
      body,
    );
    return this.groups.createInvite(user.userId, id, input);
  }

  @Get(':id/members')
  async members(@Param('id') id: string) {
    return this.groups.members(id);
  }

  @Delete(':id/members/:pseudoId')
  async remove(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('pseudoId') pseudoId: string,
  ) {
    return this.groups.removeMember(user.userId, id, pseudoId);
  }

  @Post(':id/leave')
  async leave(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.groups.leave(user.userId, id);
  }
}
