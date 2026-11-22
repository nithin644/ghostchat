import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * Redis holds only ephemeral state: sessions, challenges, rate-limit counters,
 * presence and typing indicators. It is configured with `appendonly no`, so a
 * restart is a clean slate — which is the desired property for an anonymous
 * messenger rather than a defect.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly subscriber: Redis;
  readonly publisher: Redis;

  constructor(@Inject(CONFIG) config: AppConfig) {
    const opts = {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Keys are namespaced so several deployments can share one instance.
      keyPrefix: undefined,
    } as const;

    this.client = new Redis(config.REDIS_URL, opts);
    this.subscriber = new Redis(config.REDIS_URL, opts);
    this.publisher = new Redis(config.REDIS_URL, opts);

    this.client.on('error', (e) => this.logger.error(`redis: ${e.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.subscriber.quit(), this.publisher.quit()]);
  }

  async latencyMs(): Promise<number> {
    const started = process.hrtime.bigint();
    await this.client.ping();
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  /** Namespaced key helper: every key carries a deployment prefix. */
  k(...parts: string[]): string {
    return ['ghostchat', ...parts].join(':');
  }
}
