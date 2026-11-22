import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { SendMessageRequest } from '@ghostchat/shared-types';
import { SessionService, SESSION_COOKIE } from '../common/session.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService, RULES } from '../common/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from './chat.service';

interface SocketAuth {
  userId: string;
  pseudoId: string;
  displayName: string;
  sessionId: string;
}

type AuthedSocket = Socket & { auth?: SocketAuth };

/**
 * Realtime messaging transport.
 *
 * Authentication happens on connection against the same httpOnly session
 * cookie the REST API uses — never a token in the query string, where it would
 * leak into proxy logs and browser history.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? false, credentials: true },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly sessions: SessionService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  async handleConnection(socket: AuthedSocket): Promise<void> {
    try {
      const token = parseCookie(socket.handshake.headers.cookie ?? '', SESSION_COOKIE);
      if (!token) return void socket.disconnect(true);

      const record = await this.sessions.resolve(token);
      if (!record) return void socket.disconnect(true);

      const user = await this.prisma.user.findUnique({
        where: { id: record.userId },
        select: { displayName: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE') return void socket.disconnect(true);

      socket.auth = {
        userId: record.userId,
        pseudoId: record.pseudoId,
        displayName: user.displayName,
        sessionId: token.slice(0, 8),
      };

      await socket.join(`user:${record.pseudoId}`);
      const memberships = await this.prisma.conversationMember.findMany({
        where: { userId: record.userId },
        select: { conversationId: true },
      });
      for (const m of memberships) await socket.join(`conv:${m.conversationId}`);

      await this.redis.client.set(
        this.redis.k('presence', record.pseudoId),
        Date.now().toString(),
        'EX',
        120,
      );
      this.server.emit('presence', { userId: record.pseudoId, online: true, lastSeenAt: null });
    } catch (error) {
      this.logger.warn(`socket rejected: ${(error as Error).message}`);
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: AuthedSocket): Promise<void> {
    if (!socket.auth) return;
    await this.redis.client.del(this.redis.k('presence', socket.auth.pseudoId));
    this.server.emit('presence', {
      userId: socket.auth.pseudoId,
      online: false,
      lastSeenAt: new Date().toISOString(),
    });
  }

  @SubscribeMessage('message:send')
  async onSend(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: SendMessageRequest,
  ): Promise<{ ok: boolean; message?: unknown; delivered?: boolean; error?: string }> {
    const auth = socket.auth;
    if (!auth) return { ok: false, error: 'unauthenticated' };

    try {
      await this.rateLimit.enforce(RULES.messageSend, auth.userId);
      const { message, recipients } = await this.chat.send(auth.userId, body);

      let anyRecipientOnline = false;
      for (const pseudoId of recipients) {
        if (pseudoId === auth.pseudoId) continue;
        const presence = await this.redis.client.get(this.redis.k('presence', pseudoId));
        if (presence) {
          anyRecipientOnline = true;
          // Look up user to mark as delivered in DB
          const recipientUser = await this.prisma.user.findUnique({
            where: { pseudoId },
            select: { id: true },
          });
          if (recipientUser) {
            await this.chat.markDelivered(recipientUser.id, message.conversationId, message.id);
          }
        }
        // Deliver message to recipient room with fromSelf: false
        const recipientMessage = { ...message, fromSelf: false };
        this.server.to(`user:${pseudoId}`).emit('message:new', recipientMessage);
      }

      if (anyRecipientOnline) {
        const receipt = {
          messageId: message.id,
          conversationId: message.conversationId,
          userId: auth.userId,
          state: 'DELIVERED' as const,
          at: new Date().toISOString(),
        };
        this.server.to(`user:${auth.pseudoId}`).emit('message:receipt', receipt);
        this.server.to(`conv:${message.conversationId}`).emit('message:receipt', receipt);
      }

      return { ok: true, message, delivered: anyRecipientOnline };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  @SubscribeMessage('message:react')
  async onReact(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; messageId: string; emoji: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId || !body?.messageId || !body?.emoji) return;

    try {
      const res = await this.chat.react(auth.userId, body.conversationId, body.messageId, body.emoji);
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      const payload = {
        conversationId: body.conversationId,
        messageId: body.messageId,
        emoji: res.emoji,
        userPseudoId: auth.pseudoId,
        action: res.action,
      };
      this.server.to(`conv:${body.conversationId}`).emit('message:reaction', payload);
      for (const pseudoId of memberPseudoIds) {
        this.server.to(`user:${pseudoId}`).emit('message:reaction', payload);
      }
    } catch (err) {
      // non-fatal
    }
  }

  @SubscribeMessage('message:delivered')
  async onDelivered(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; messageId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId || !body?.messageId) return;

    const receipt = await this.chat.markDelivered(auth.userId, body.conversationId, body.messageId);
    if (receipt) {
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      this.server.to(`conv:${body.conversationId}`).emit('message:receipt', receipt);
      for (const pseudoId of memberPseudoIds) {
        this.server.to(`user:${pseudoId}`).emit('message:receipt', receipt);
      }
    }
  }

  @SubscribeMessage('conversation:join')
  async onJoinConversation(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    if (!socket.auth || !body?.conversationId) return;
    await socket.join(`conv:${body.conversationId}`);
  }

  @SubscribeMessage('message:read')
  async onRead(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; messageIds: string[] },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId || !Array.isArray(body.messageIds)) return;

    await this.rateLimit.enforce(RULES.chatEphemeral, auth.userId).catch(() => undefined);
    const receipts = await this.chat.markRead(auth.userId, body.conversationId, body.messageIds);
    const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
    for (const receipt of receipts) {
      this.server.to(`conv:${receipt.conversationId}`).emit('message:receipt', receipt);
      this.server.to(`user:${auth.pseudoId}`).emit('message:receipt', receipt);
      for (const pseudoId of memberPseudoIds) {
        this.server.to(`user:${pseudoId}`).emit('message:receipt', receipt);
      }
    }
  }

  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; typing: boolean },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    // Ephemeral by design: a persisted typing event is a behavioural metadata
    // trail, and the feature does not need one.
    socket.to(`conv:${body.conversationId}`).emit('typing', {
      conversationId: body.conversationId,
      userId: auth.pseudoId,
      displayName: auth.displayName,
      typing: Boolean(body.typing),
    });
  }

  @SubscribeMessage('chat:bomb')
  async onBomb(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    try {
      await this.chat.assertMember(auth.userId, body.conversationId);
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      const payload = {
        conversationId: body.conversationId,
        fromUserId: auth.pseudoId,
        fromDisplayName: auth.displayName,
      };
      // Broadcast to all conversation members (opposite user / group)
      socket.to(`conv:${body.conversationId}`).emit('chat:bomb', payload);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('chat:bomb', payload);
      }
    } catch {
      // non-fatal
    }
  }

  @SubscribeMessage('chat:fire')
  async onFire(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    try {
      await this.chat.assertMember(auth.userId, body.conversationId);
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      const payload = {
        conversationId: body.conversationId,
        fromUserId: auth.pseudoId,
        fromDisplayName: auth.displayName,
      };
      socket.to(`conv:${body.conversationId}`).emit('chat:fire', payload);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('chat:fire', payload);
      }
    } catch {
      // non-fatal
    }
  }

  @SubscribeMessage('chat:love')
  async onLove(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    try {
      await this.chat.assertMember(auth.userId, body.conversationId);
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      const payload = {
        conversationId: body.conversationId,
        fromUserId: auth.pseudoId,
        fromDisplayName: auth.displayName,
      };
      socket.to(`conv:${body.conversationId}`).emit('chat:love', payload);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('chat:love', payload);
      }
    } catch {
      // non-fatal
    }
  }

  @SubscribeMessage('walkie:start')
  async onWalkieStart(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    try {
      await this.chat.assertMember(auth.userId, body.conversationId);
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('walkie:incoming', {
          conversationId: body.conversationId,
          fromDisplayName: auth.displayName,
          fromPseudoId: auth.pseudoId,
        });
      }
    } catch {
      // non-fatal
    }
  }

  @SubscribeMessage('walkie:chunk')
  async onWalkieChunk(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; chunk: ArrayBuffer; sampleRate?: number },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId || !body?.chunk) return;

    try {
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('walkie:audio', {
          conversationId: body.conversationId,
          fromDisplayName: auth.displayName,
          fromPseudoId: auth.pseudoId,
          chunk: body.chunk,
          sampleRate: body.sampleRate,
        });
      }
    } catch {
      // non-fatal
    }
  }

  @SubscribeMessage('walkie:end')
  async onWalkieEnd(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.conversationId) return;

    try {
      const memberPseudoIds = await this.chat.memberPseudoIds(body.conversationId);
      for (const pseudoId of memberPseudoIds) {
        if (pseudoId === auth.pseudoId) continue;
        this.server.to(`user:${pseudoId}`).emit('walkie:ended', {
          conversationId: body.conversationId,
          fromPseudoId: auth.pseudoId,
        });
      }
    } catch {
      // non-fatal
    }
  }

  notifyRoom(room: string, event: string, payload: unknown): void {
    this.server.to(room).emit(event, payload);
  }
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=')) || null;
  }
  return null;
}
