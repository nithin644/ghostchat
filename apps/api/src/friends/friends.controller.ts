import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { FriendsService } from './friends.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import type { AuthedUser } from '../common/session.service';

const requestSchema = z.object({
  target: z.string().min(1).max(512),
});

@UseGuards(SessionGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get('search')
  async search(@CurrentUser() user: AuthedUser, @Query('q') query?: string) {
    return this.friends.searchUsers(user.userId, query ?? '');
  }

  @Get('users')
  async listUsers(@CurrentUser() user: AuthedUser) {
    return this.friends.listUsers(user.userId);
  }

  @Get('requests')
  async getRequests(@CurrentUser() user: AuthedUser) {
    return this.friends.getRequests(user.userId);
  }

  @Post('request')
  async sendRequest(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const { target } = parseBody(requestSchema, body);
    return this.friends.sendRequest(user.userId, target);
  }

  @Post('requests/:id/accept')
  async acceptRequest(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.friends.acceptRequest(user.userId, id);
  }

  @Delete('requests/:id')
  async declineRequest(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.friends.declineRequest(user.userId, id);
  }
}
