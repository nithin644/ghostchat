import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { VaultService } from './vault.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import type { AuthedUser } from '../common/session.service';

const syncSchema = z.object({
  entries: z.record(
    z.string().min(1).max(512),
    z.object({
      nonce: z.string().min(1).max(128),
      ciphertext: z.string().min(1),
    }),
  ),
});

@UseGuards(SessionGuard)
@Controller('vault')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get()
  async getAll(@CurrentUser() user: AuthedUser) {
    return this.vault.getAll(user.userId);
  }

  @Post('sync')
  async sync(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const { entries } = parseBody(syncSchema, body);
    return this.vault.upsertMany(user.userId, entries);
  }

  @Delete(':key')
  async delete(@CurrentUser() user: AuthedUser, @Param('key') key: string) {
    return this.vault.delete(user.userId, decodeURIComponent(key));
  }
}
