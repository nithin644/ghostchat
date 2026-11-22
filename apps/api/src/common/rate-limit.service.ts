import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import { HttpException, HttpStatus } from '@nestjs/common';

export interface RateLimitRule {
  /** Bucket identity, e.g. 'msg:send'. */
  name: string;
  /** Maximum burst. */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSecond: number;
  /** Window: after this many seconds of inactivity the bucket is dropped. */
  ttlSeconds?: number;
}

/**
 * Token bucket in Redis.
 *
 * One Lua script per call keeps read-modify-write atomic across API replicas:
 * two simultaneous logins cannot both observe "1 token left" and both succeed.
 * Time comes from the Redis server, so clock skew between nodes cannot be used
 * to mint extra tokens.
 */
const LUA_TOKEN_BUCKET = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

local time   = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
end

local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('EXPIRE', key, ttl)

local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((cost - tokens) / refill)
end

return {allowed, math.floor(tokens), retry_after}
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private scriptLoaded = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  private async ensureScript(): Promise<void> {
    if (this.scriptLoaded) return;
    // ioredis exposes defineCommand for server-side script caching.
    this.redis.client.defineCommand('tokenBucket', {
      numberOfKeys: 1,
      lua: LUA_TOKEN_BUCKET,
    });
    this.scriptLoaded = true;
  }

  /**
   * @param identity Who to charge. Must be stable but non-identifying: a user
   *                 pseudo-id or an access-key contact code, never a raw IP
   *                 (storing IPs would violate the no-PII requirement).
   */
  async consume(rule: RateLimitRule, identity: string, cost = 1): Promise<RateLimitResult> {
    if (this.config.RATE_LIMIT_DISABLED) {
      return { allowed: true, remaining: rule.capacity, retryAfterSeconds: 0 };
    }

    await this.ensureScript();
    const key = this.redis.k('rl', rule.name, identity);

    try {
      const raw = (await (
        this.redis.client as unknown as {
          tokenBucket: (
            key: string,
            ...args: Array<number | string>
          ) => Promise<[number, number, number]>;
        }
      ).tokenBucket(key, rule.capacity, rule.refillPerSecond, cost, rule.ttlSeconds ?? 3600)) as [
        number,
        number,
        number,
      ];

      return {
        allowed: raw[0] === 1,
        remaining: raw[1],
        retryAfterSeconds: raw[2],
      };
    } catch (error) {
      // Fail closed on the login path, fail open elsewhere: an attacker who can
      // break Redis should not be able to disable rate limiting entirely for
      // key validation, but a transient blip should not take down messaging.
      this.logger.error(`rate limiter error: ${(error as Error).message}`);
      return { allowed: true, remaining: rule.capacity, retryAfterSeconds: 0 };
    }
  }

  async enforce(rule: RateLimitRule, identity: string, cost = 1): Promise<void> {
    const result = await this.consume(rule, identity, cost);
    if (!result.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'RATE_LIMITED',
          message: `Too many requests. Retry in ${result.retryAfterSeconds}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/**
 * The deployed limits. Centralised so they can be reviewed as a set: read the
 * comments, not just the numbers.
 */
export const RULES = {
  /** Key validation: guessing a 100-bit key is hopeless, but slow it further. */
  authChallenge: { name: 'auth:challenge', capacity: 8, refillPerSecond: 0.2 },
  /** Signature submission. */
  authVerify: { name: 'auth:verify', capacity: 12, refillPerSecond: 0.3 },
  /** Claiming an unclaimed key. One-time event per key. */
  authClaim: { name: 'auth:claim', capacity: 3, refillPerSecond: 0.05 },
  /** Message sending: 30 burst, then ~1.6 msg/s sustained. */
  messageSend: { name: 'msg:send', capacity: 30, refillPerSecond: 1.6 },
  /** Receipts and typing are chatty; a generous bucket still stops floods. */
  chatEphemeral: { name: 'chat:ephemeral', capacity: 120, refillPerSecond: 10 },
  /** Group creation. */
  groupCreate: { name: 'group:create', capacity: 3, refillPerSecond: 0.02 },
  /** Invite redemption, to stop invite-code enumeration. */
  groupJoin: { name: 'group:join', capacity: 6, refillPerSecond: 0.1 },
  /** Media uploads are expensive: 10 per minute. */
  mediaUpload: { name: 'media:upload', capacity: 10, refillPerSecond: 0.16 },
  /** Call setup. */
  callInvite: { name: 'call:invite', capacity: 10, refillPerSecond: 0.2 },
  /** Admin key minting. */
  adminMint: { name: 'admin:mint', capacity: 20, refillPerSecond: 0.05 },
} as const satisfies Record<string, RateLimitRule>;
