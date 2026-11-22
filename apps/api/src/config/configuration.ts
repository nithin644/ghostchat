import { z } from 'zod';

/**
 * Fail-fast configuration.
 *
 * Every secret is validated at boot: a process that starts with a missing
 * SESSION_SECRET is a process that silently issues forgeable cookies, which is
 * far worse than a container that refuses to start.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be >= 32 chars'),
  SEALED_SENDER_PEPPER: z.string().min(32).optional(),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(1800),
  RATE_LIMIT_DISABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  S3_ENDPOINT: z.string().default('http://127.0.0.1:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('ghostchat-media'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** 'local' = API disk (no external service); 's3' = any S3-compatible store. */
  MEDIA_DRIVER: z.enum(['local', 's3']).default('local'),
  MEDIA_DIR: z.string().default('./.ghostchat-state/media'),

  TURN_URLS: z.string().default(''),
  TURN_SHARED_SECRET: z.string().default(''),
  TURN_CREDENTIAL_TTL: z.coerce.number().int().positive().default(3600),

  MEDIASOUP_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  MEDIASOUP_ANNOUNCED_IP: z.string().default('127.0.0.1'),

  ADMIN_BOOTSTRAP_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (parsed.data.NODE_ENV === 'production') {
    // Note: COOKIE_SECURE is false when running as a Tor hidden service (.onion uses HTTP at application layer).
    if (parsed.data.CORS_ORIGIN === '*') {
      throw new Error('CORS_ORIGIN must be an explicit origin in production');
    }
  }

  cached = parsed.data;
  return cached;
}

export const CONFIG = 'GHOSTCHAT_CONFIG';
