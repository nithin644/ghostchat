import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ChatService } from './chat.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import type { AuthedUser } from '../common/session.service';

const b64 = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/);

@UseGuards(SessionGuard)
@Controller('conversations')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    return this.chat.list(user.userId);
  }

  @Get('find-user')
  async findUser(@CurrentUser() user: AuthedUser, @Query('q') q?: string) {
    if (!q || q.trim().length === 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'Query cannot be empty' });
    }
    return this.chat.findUser(user.userId, q);
  }

  @Post('direct')
  async openDirect(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const parsed = parseBody(
      z.object({
        contactCode: z.string().min(3).max(512).optional(),
        query: z.string().min(3).max(512).optional(),
        userId: z.string().min(3).max(512).optional(),
      }),
      body,
    );
    const identifier = parsed.userId ?? parsed.query ?? parsed.contactCode;
    if (!identifier) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'User ID or contact code required' });
    }
    const id = await this.chat.openDirect(user.userId, identifier);
    return { id };
  }

  @Get('blocks/list')
  async listBlocks(@CurrentUser() user: AuthedUser) {
    return this.chat.listBlockedUsers(user.userId);
  }

  @Post('block/:target')
  async block(@CurrentUser() user: AuthedUser, @Param('target') target: string) {
    return this.chat.blockUser(user.userId, target);
  }

  @Delete('block/:target')
  async unblock(@CurrentUser() user: AuthedUser, @Param('target') target: string) {
    return this.chat.unblockUser(user.userId, target);
  }

  @Delete(':id')
  async delete(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.chat.deleteConversation(user.userId, id);
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.chat.detail(user.userId, id);
  }

  @Get(':id/messages')
  async messages(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.history(user.userId, id, before, limit ? Number(limit) : 50);
  }
}
