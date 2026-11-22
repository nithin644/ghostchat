import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { createAdapter } from '@socket.io/redis-adapter';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/http';
import { RedisService } from './redis/redis.service';
import { ChatGateway } from './chat/chat.gateway';
import { CallsGateway } from './calls/calls.gateway';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Structured-ish logging without request bodies: bodies are ciphertext, but
    // logging them would still build a traffic archive for no operational gain.
    logger: config.NODE_ENV === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
  });

  // Behind a TLS terminator or Tor, we do NOT trust X-Forwarded-For: the app
  // never reads client IPs, so parsing them would only create a temptation to
  // log them later.
  app.set('trust proxy', false);

  app.use(
    helmet({
      contentSecurityPolicy: false, // set at the reverse proxy, where the app's own assets are known
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ limit: '25mb', extended: true }));

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  // Everything lives under /api so that a single-origin reverse proxy (and
  // therefore a Tor hidden service) can route by prefix alone.
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.PORT, '0.0.0.0');

  // Fan out socket events across API replicas. Without this, two users on
  // different nodes cannot see each other's messages in real time.
  const redis = app.get(RedisService);
  const chatGateway = app.get(ChatGateway);
  const callsGateway = app.get(CallsGateway);
  const adapter = createAdapter(redis.publisher, redis.subscriber);
  chatGateway.server.adapter(adapter);
  callsGateway.server.adapter(adapter);

  const logger = new Logger('bootstrap');
  logger.log(`GhostChat API listening on :${config.PORT} (${config.NODE_ENV})`);
  if (!config.TURN_URLS) {
    logger.warn('TURN_URLS is empty: calls will only work on permissive NATs');
  }
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('fatal boot error:', error);
  process.exit(1);
});
