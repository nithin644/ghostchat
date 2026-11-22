import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_COOKIE, SessionService, type AuthedUser } from '../session.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { UserRole } from '@ghostchat/shared-types';

export interface RequestWithUser extends Request {
  user?: AuthedUser;
}

/** Requires a valid session cookie. Attaches `req.user` on success. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException('not authenticated');

    const record = await this.sessions.resolve(token);
    if (!record) throw new UnauthorizedException('session expired');

    req.user = {
      userId: record.userId,
      pseudoId: record.pseudoId,
      role: record.role,
      // Never expose the token itself; the prefix is enough for log correlation.
      sessionId: token.slice(0, 8),
    };

    const rawIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      (req as any).ip ||
      '127.0.0.1';
    const clientIp = rawIp.replace(/^::ffff:/, '');

    void this.prisma.user
      .update({
        where: { id: record.userId },
        data: { lastIp: clientIp, lastSeenAt: new Date() },
      })
      .catch(() => null);

    return true;
  }
}

/** Requires an authenticated admin. Apply after SessionGuard. */
@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) throw new UnauthorizedException('not authenticated');
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('admin role required');
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) throw new UnauthorizedException('not authenticated');
    return req.user;
  },
);
