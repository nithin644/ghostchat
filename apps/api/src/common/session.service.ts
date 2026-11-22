import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import type { Response } from 'express';
import { CONFIG, type AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import type { UserRole } from '@ghostchat/shared-types';

export interface SessionRecord {
  userId: string;
  pseudoId: string;
  role: UserRole;
  createdAt: number;
  lastSeen: number;
}

export interface AuthedUser {
  userId: string;
  pseudoId: string;
  role: UserRole;
  sessionId: string;
}

export const SESSION_COOKIE = 'gc_session';

/**
 * Opaque server-side sessions.
 *
 * The cookie carries 256 bits of randomness and nothing else — no user id, no
 * role, no JWT claims to decode. Redis is the only authority, so revocation is
 * immediate and there is no signing key to leak. The stored key is the SHA-256
 * of the token, so a Redis dump (or a MONITOR session) does not yield usable
 * cookies.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  private key(token: string): string {
    return this.redis.k('sess', createHash('sha256').update(token).digest('base64url'));
  }

  async create(user: { id: string; pseudoId: string; role: UserRole }): Promise<{
    token: string;
    expiresAt: Date;
  }> {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const record: SessionRecord = {
      userId: user.id,
      pseudoId: user.pseudoId,
      role: user.role,
      createdAt: now,
      lastSeen: now,
    };
    await this.redis.client.set(
      this.key(token),
      JSON.stringify(record),
      'EX',
      this.config.SESSION_TTL_SECONDS,
    );
    return {
      token,
      expiresAt: new Date(now + this.config.SESSION_TTL_SECONDS * 1000),
    };
  }

  async resolve(token: string): Promise<SessionRecord | null> {
    const raw = await this.redis.client.get(this.key(token));
    if (!raw) return null;

    let record: SessionRecord;
    try {
      record = JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }

    // Idle timeout: an abandoned laptop must not stay authenticated forever.
    if (Date.now() - record.lastSeen > this.config.SESSION_IDLE_SECONDS * 1000) {
      await this.destroy(token);
      return null;
    }

    record.lastSeen = Date.now();
    // Sliding expiry, capped by the absolute TTL refreshed here.
    await this.redis.client.set(
      this.key(token),
      JSON.stringify(record),
      'EX',
      this.config.SESSION_TTL_SECONDS,
    );
    return record;
  }

  async destroy(token: string): Promise<void> {
    await this.redis.client.del(this.key(token));
  }

  /** Kill every session for a user (ban, key revocation, "log out everywhere"). */
  async destroyAllForUser(userId: string): Promise<number> {
    const pattern = this.redis.k('sess', '*');
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const raw = await this.redis.client.get(key);
        if (!raw) continue;
        try {
          if ((JSON.parse(raw) as SessionRecord).userId === userId) {
            await this.redis.client.del(key);
            removed += 1;
          }
        } catch {
          /* malformed record: let it expire */
        }
      }
    } while (cursor !== '0');
    return removed;
  }

  async countActive(): Promise<number> {
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor,
        'MATCH',
        this.redis.k('sess', '*'),
        'COUNT',
        500,
      );
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  /**
   * Cookie flags.
   *
   * `sameSite: 'lax'` (not 'strict') keeps the app usable when a user follows a
   * link into a chat, while still blocking cross-site POSTs. `secure` is driven
   * by configuration: it MUST be true on HTTPS, and must be false when serving
   * over a Tor onion, because onions are plain HTTP at the application layer
   * and a Secure cookie would simply never be sent.
   */
  cookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    domain?: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      ...(this.config.COOKIE_DOMAIN ? { domain: this.config.COOKIE_DOMAIN } : {}),
      maxAge: this.config.SESSION_TTL_SECONDS * 1000,
    };
  }

  applyCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, this.cookieOptions());
  }

  clearCookie(res: Response): void {
    const { maxAge, ...rest } = this.cookieOptions();
    res.clearCookie(SESSION_COOKIE, rest);
  }
}
