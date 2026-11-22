import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { parseBody } from '../common/http';
import { CurrentUser, SessionGuard, type RequestWithUser } from '../common/guards/session.guard';
import { SESSION_COOKIE, SessionService, type AuthedUser } from '../common/session.service';

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(24).regex(/^[a-zA-Z0-9 _.-]+$/).optional(),
  avatar: z.string().max(3_000_000).optional().nullable(),
});

const b64 = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

const contactCodeSchema = z.object({ contactCode: b64 });

const verifySchema = z.object({
  contactCode: b64,
  challengeId: z.string().min(8).max(64),
  signature: b64,
});

const preKeySchema = z.object({
  keyId: z.number().int().min(1).max(2 ** 31 - 1),
  publicKey: b64,
});

const claimSchema = z.object({
  contactCode: b64,
  challengeId: z.string().min(8).max(64),
  displayName: z.string().min(2).max(24),
  avatarHash: b64.optional(),
  avatarObjectKey: z.string().max(200).optional(),
  identitySignPublicKey: b64,
  identityDhPublicKey: b64,
  signedPreKey: preKeySchema.extend({ signature: b64 }),
  oneTimePreKeys: z.array(preKeySchema).max(200),
  bundleSignature: b64,
  verifier: b64,
  proof: b64,
});

const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** Admin direct login */
  @Post('admin-login')
  @HttpCode(200)
  async adminLogin(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(adminLoginSchema, body);
    const { session, token } = await this.auth.adminLogin(input.username, input.password);
    this.sessions.applyCookie(res, token);
    return session;
  }

  /** Step 1: look the key up and hand back a signing challenge. */
  @Post('challenge')
  @HttpCode(200)
  async challenge(@Body() body: unknown) {
    const { contactCode } = parseBody(contactCodeSchema, body);
    return this.auth.challenge(contactCode);
  }

  /** Step 2 (returning user): prove possession of the identity key. */
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(verifySchema, body);
    const { session, token } = await this.auth.verify(input);
    this.sessions.applyCookie(res, token);
    return session;
  }

  /** Step 2 (first run): claim the key and register public pre-keys. */
  @Post('claim')
  @HttpCode(201)
  async claim(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(claimSchema, body);
    const { session, token } = await this.auth.claim(input);
    this.sessions.applyCookie(res, token);
    return session;
  }

  @UseGuards(SessionGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthedUser) {
    return this.auth.me(user.userId);
  }

  @UseGuards(SessionGuard)
  @Patch('profile')
  async updateProfile(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const input = parseBody(updateProfileSchema, body);
    return this.auth.updateProfile(user.userId, input);
  }

  @UseGuards(SessionGuard)
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequestWithUser, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await this.auth.logout(token);
    this.sessions.clearCookie(res);
  }

  @UseGuards(SessionGuard)
  @Get('admin-credentials')
  async getAdminCredentials(@CurrentUser() user: AuthedUser) {
    if (user.role !== 'ADMIN') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin access required' });
    return this.auth.getAdminCredentials();
  }

  @UseGuards(SessionGuard)
  @Patch('admin-credentials')
  async updateAdminCredentials(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    if (user.role !== 'ADMIN') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin access required' });
    const input = parseBody(z.object({
      credentialId: z.number().int().positive(),
      currentPassword: z.string().min(1).max(128),
      username: z.string().trim().min(3).max(64),
      newPassword: z.string().min(8).max(128),
    }), body);
    return this.auth.updateAdminCredentials(input.credentialId, input.currentPassword, input.username, input.newPassword);
  }

  @UseGuards(SessionGuard)
  @Delete('admin-credentials/:credentialId')
  async deleteAdminCredential(@CurrentUser() user: AuthedUser, @Param('credentialId') credentialId: string) {
    if (user.role !== 'ADMIN') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin access required' });
    const id = Number(credentialId);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException({ code: 'VALIDATION', message: 'Invalid credential ID' });
    return this.auth.deleteAdminCredential(id);
  }

  @UseGuards(SessionGuard)
  @Post('admin-credentials')
  async createAdminCredential(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    if (user.role !== 'ADMIN') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Admin access required' });
    const input = parseBody(z.object({
      username: z.string().trim().min(3).max(64),
      password: z.string().min(8).max(128),
    }), body);
    return this.auth.createAdminCredential(input.username, input.password);
  }
}
