import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { CallKind } from '@ghostchat/shared-types';
import { RateLimitService, RULES } from '../common/rate-limit.service';
import { CallService } from './call.service';

interface SocketAuth {
  userId: string;
  pseudoId: string;
  displayName: string;
  sessionId: string;
}

type AuthedSocket = Socket & { auth?: SocketAuth };

/**
 * Call signalling only. SDP and ICE blobs are relayed verbatim: the server is
 * a switchboard, not a media endpoint. Credentials come from the same
 * authenticated socket that ChatGateway validates.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? false, credentials: true },
  transports: ['websocket', 'polling'],
})
export class CallsGateway {
  private readonly logger = new Logger(CallsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly calls: CallService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @SubscribeMessage('call:invite')
  async onInvite(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId: string; kind: CallKind; screenShare?: boolean },
  ): Promise<{ ok: boolean; roomId?: string; peerOnline?: boolean; error?: string }> {
    const auth = socket.auth;
    if (!auth) return { ok: false, error: 'unauthenticated' };

    try {
      await this.rateLimit.enforce(RULES.callInvite, auth.userId);
      const room = await this.calls.createRoom(auth, body.conversationId, body.kind);

      for (const pseudoId of room.invitees) {
        this.server.to(`user:${pseudoId}`).emit('call:incoming', {
          roomId: room.roomId,
          conversationId: body.conversationId,
          kind: body.kind,
          fromDisplayName: auth.displayName,
          fromUserId: auth.pseudoId,
          screenShare: Boolean(body.screenShare),
        });
      }
      return { ok: true, roomId: room.roomId, peerOnline: room.peerOnline };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  @SubscribeMessage('call:ringing')
  async onRinging(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.roomId) return;

    const peers = await this.calls.participants(body.roomId);
    for (const pseudoId of peers) {
      if (pseudoId === auth.pseudoId) continue;
      this.server.to(`user:${pseudoId}`).emit('call:ringing', {
        roomId: body.roomId,
      });
    }
  }

  @SubscribeMessage('call:signal')
  async onSignal(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { roomId: string; type: string; data: unknown },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth) return;
    if (!body?.roomId || typeof body.type !== 'string') return;

    const allowed = await this.calls.assertParticipant(body.roomId, auth.userId);
    if (!allowed) return;

    const peers = await this.calls.participants(body.roomId);
    for (const pseudoId of peers) {
      if (pseudoId === auth.pseudoId) continue;
      this.server.to(`user:${pseudoId}`).emit('call:signal', {
        roomId: body.roomId,
        type: body.type,
        data: body.data,
        fromUserId: auth.pseudoId,
      });
    }
  }

  @SubscribeMessage('call:media-chunk')
  async onMediaChunk(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { roomId: string; chunk: ArrayBuffer },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth || !body?.roomId) return;

    const peers = await this.calls.participants(body.roomId);
    for (const pseudoId of peers) {
      if (pseudoId === auth.pseudoId) continue;
      this.server.to(`user:${pseudoId}`).emit('call:media-chunk', {
        roomId: body.roomId,
        chunk: body.chunk,
      });
    }
  }

  @SubscribeMessage('call:end')
  async onEnd(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    const auth = socket.auth;
    if (!auth) return;
    const peers = await this.calls.endRoom(body.roomId, auth.userId, 'hangup');
    for (const pseudoId of peers) {
      this.server.to(`user:${pseudoId}`).emit('call:ended', {
        roomId: body.roomId,
        reason: 'hangup',
      });
    }
  }
}
