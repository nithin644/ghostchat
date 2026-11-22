import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { KeysService } from './keys.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import type { AuthedUser } from '../common/session.service';

const b64 = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/);

const publishSchema = z.object({
  signedPreKey: z
    .object({ keyId: z.number().int().min(1), publicKey: b64, signature: b64 })
    .optional(),
  oneTimePreKeys: z
    .array(z.object({ keyId: z.number().int().min(1), publicKey: b64 }))
    .max(200),
  bundleSignature: b64.optional(),
});

@Controller('keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  /**
   * Fetch a bundle. Deliberately unauthenticated: a client must be able to
   * build a session before it has any relationship with the server, and the
   * bundle contains public keys only. Rate limited at the gateway.
   */
  @Get(':contactCode')
  async bundle(@Param('contactCode') contactCode: string) {
    return this.keys.getBundle(contactCode);
  }

  @UseGuards(SessionGuard)
  @Post('replenish')
  async replenish(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const input = parseBody(publishSchema, body);
    return this.keys.publish(user.userId, input, input.bundleSignature);
  }

  @UseGuards(SessionGuard)
  @Get('status/count')
  async status(@CurrentUser() user: AuthedUser) {
    const available = await this.keys.countAvailable(user.userId);
    return { available, low: available < 10 };
  }
}
