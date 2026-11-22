import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminService } from './admin.service';
import { parseBody } from '../common/http';
import { AdminGuard, CurrentUser, SessionGuard } from '../common/guards/session.guard';
import { RateLimitService, RULES } from '../common/rate-limit.service';
import type { AuthedUser } from '../common/session.service';

const mintSchema = z.object({
  count: z.number().int().min(1).max(25),
  label: z.string().max(48).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Every route here is behind SessionGuard *and* AdminGuard. The guards are
 * declared per-controller rather than globally so a new public route cannot
 * accidentally inherit admin reachability.
 */
@UseGuards(SessionGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get('stats')
  async stats() {
    return this.admin.stats();
  }

  @Get('users')
  async users(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.admin.listUsers(cursor, limit ? Number(limit) : 50);
  }

  @Delete('users/:pseudoId')
  async ban(@CurrentUser() actor: AuthedUser, @Param('pseudoId') pseudoId: string) {
    return this.admin.banUser(actor.userId, pseudoId);
  }

  @Patch('users/:pseudoId/numeric-id')
  async updateNumericId(
    @CurrentUser() actor: AuthedUser,
    @Param('pseudoId') pseudoId: string,
    @Body() body: unknown,
  ) {
    const { numericId } = parseBody(z.object({ numericId: z.string().regex(/^\d{3}$/, 'Must be 3 digits') }), body);
    return this.admin.updateNumericId(actor.userId, pseudoId, numericId);
  }

  @Get('keys')
  async keys(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.admin.listKeys(cursor, limit ? Number(limit) : 50);
  }

  @Post('keys')
  async mint(@CurrentUser() actor: AuthedUser, @Body() body: unknown) {
    const input = parseBody(mintSchema, body);
    await this.rateLimit.enforce(RULES.adminMint, actor.userId);
    return this.admin.mint(actor.userId, input);
  }

  @Delete('keys/:id')
  async revoke(@CurrentUser() actor: AuthedUser, @Param('id') id: string) {
    return this.admin.revokeKey(actor.userId, id);
  }

  @Patch('users/:pseudoId/verified')
  async updateVerified(
    @CurrentUser() actor: AuthedUser,
    @Param('pseudoId') pseudoId: string,
    @Body() body: unknown,
  ) {
    const { isVerified } = parseBody(z.object({ isVerified: z.boolean() }), body);
    return this.admin.updateVerified(actor.userId, pseudoId, isVerified);
  }
}
