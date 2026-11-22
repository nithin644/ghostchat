import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { MediaService } from './media.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import { RateLimitService, RULES } from '../common/rate-limit.service';
import type { AuthedUser } from '../common/session.service';

const presignSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[A-Za-z0-9_-]{40,50}$/),
});

/** Session-authenticated media metadata API. */
@UseGuards(SessionGuard)
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('presign')
  async presign(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const input = parseBody(presignSchema, body);
    await this.rateLimit.enforce(RULES.mediaUpload, user.userId);
    return this.media.presignUpload(user.userId, input.bytes, input.sha256);
  }

  @Post(':objectKey/complete')
  async complete(@CurrentUser() user: AuthedUser, @Param('objectKey') objectKey: string) {
    return this.media.complete(user.userId, objectKey);
  }

  @Get(':objectKey')
  async download(@CurrentUser() user: AuthedUser, @Param('objectKey') objectKey: string) {
    return this.media.presignDownload(user.userId, objectKey);
  }
}

/**
 * Blob transport for the local driver.
 *
 * Deliberately outside SessionGuard: the URL itself carries a short-lived HMAC
 * capability, which is what lets a plain `<img>`/`fetch` work without relying on
 * cookie scoping. The token is purpose-bound (up vs down), object-bound and
 * expiring, so it cannot be replayed against another object or direction.
 *
 * Under MEDIA_DRIVER=s3 these routes simply return 404 — the browser talks to
 * the object store directly instead.
 */
@Controller('blob')
export class BlobController {
  constructor(private readonly media: MediaService) {}

  private authorize(purpose: 'up' | 'down', objectKey: string, query: Request['query']): void {
    const exp = Number(query.exp);
    const sig = typeof query.sig === 'string' ? query.sig : '';
    if (!sig || !this.media.verifyToken(purpose, objectKey, exp, sig)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Invalid or expired URL' });
    }
  }

  @Put(':objectKey')
  async upload(
    @Param('objectKey') objectKey: string,
    @Query('p') purpose: string,
    @Req() req: Request,
    @Query() query: Request['query'],
  ): Promise<{ ok: true; bytes: number }> {
    if (purpose !== 'up') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Wrong token purpose' });
    }
    this.authorize('up', objectKey, query);

    // Raw body: the global JSON parser ignores application/octet-stream, so the
    // stream arrives untouched and is piped straight to disk.
    const bytes = await this.media.saveBlob(objectKey, req);
    return { ok: true, bytes };
  }

  @Get(':objectKey')
  async download(
    @Param('objectKey') objectKey: string,
    @Query('p') purpose: string,
    @Res() res: Response,
    @Query() query: Request['query'],
  ): Promise<void> {
    if (purpose !== 'down') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Wrong token purpose' });
    }
    this.authorize('down', objectKey, query);

    const info = await this.media.blobInfo(objectKey);
    if (!info) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Object not found' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(info.size));
    // Ciphertext is immutable once written, and it is not HTML.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    this.media.readBlob(objectKey).on('error', () => res.destroy()).pipe(res);
  }
}
