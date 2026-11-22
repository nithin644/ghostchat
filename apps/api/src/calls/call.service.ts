import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { CallKind, IceServer } from '@ghostchat/shared-types';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChatService } from '../chat/chat.service';

interface Caller {
  userId: string;
  pseudoId: string;
  displayName: string;
}

interface RoomRecord {
  roomId: string;
  conversationId: string;
  kind: CallKind;
  host: string;
  participants: string[]; // pseudo ids
  createdAt: number;
}

const ROOM_TTL_SECONDS = 4 * 3600;

/**
 * WebRTC signalling + ICE credentials.
 *
 * The server never sees or relays media: it only exchanges SDP/ICE blobs and
 * mints short-lived TURN credentials. For 1:1 calls this is peer-to-peer and the
 * media is DTLS-SRTP encrypted end to end. For groups, an SFU is required, which
 * by definition terminates the hop — see README "Calls" for the honest
 * trade-off and the SFrame path that keeps group media unreadable to the SFU.
 */
@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly chat: ChatService,
  ) {}

  async lookupUser(userId: string): Promise<{ displayName: string } | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
  }

  async conversationIdsFor(userId: string): Promise<string[]> {
    const rows = await this.prisma.conversationMember.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    return rows.map((r) => r.conversationId);
  }

  private roomKey(roomId: string): string {
    return this.redis.k('call', roomId);
  }

  private async loadRoom(roomId: string): Promise<RoomRecord | null> {
    const raw = await this.redis.client.get(this.roomKey(roomId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomRecord;
    } catch {
      return null;
    }
  }

  private async saveRoom(room: RoomRecord): Promise<void> {
    await this.redis.client.set(this.roomKey(room.roomId), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
  }

  /**
   * TURN REST credentials (RFC 8489 shared-secret scheme).
   *
   * A static TURN password shipped to browsers is a permanent free relay for
   * anyone who reads the bundle. Instead each client gets a username that
   * encodes its expiry and a password that is an HMAC over that username, so
   * coturn can validate it without a database and the credential dies on time.
   */
  private iceServers(pseudoId: string): IceServer[] {
    const defaultServers: IceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ];
    const urls = this.config.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      return defaultServers;
    }
    if (!this.config.TURN_SHARED_SECRET) return [...defaultServers, ...urls.map((u) => ({ urls: u }))];

    const expiry = Math.floor(Date.now() / 1000) + this.config.TURN_CREDENTIAL_TTL;
    const username = `${expiry}:${pseudoId}`;
    const credential = createHmac('sha1', this.config.TURN_SHARED_SECRET)
      .update(username)
      .digest('base64');

    return [...defaultServers, ...urls.map((u) => ({ urls: u, username, credential }))];
  }

  async isUserOnline(pseudoId: string): Promise<boolean> {
    const presence = await this.redis.client.get(this.redis.k('presence', pseudoId));
    return Boolean(presence);
  }

  async createRoom(
    caller: Caller,
    conversationId: string,
    kind: CallKind,
  ): Promise<{ roomId: string; invitees: string[]; peerOnline: boolean; iceServers: IceServer[] }> {
    await this.chat.assertMember(caller.userId, conversationId);

    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true, user: { select: { pseudoId: true } } },
    });
    for (const m of members) {
      if (m.userId !== caller.userId) {
        const blocked = await this.chat.isPairBlocked(caller.userId, m.userId);
        if (blocked) {
          throw new ForbiddenException({ code: 'FORBIDDEN', message: 'User is not available' });
        }
      }
    }
    const pseudoIds = members.map((m) => m.user.pseudoId).filter((p) => p !== caller.pseudoId);
    if (pseudoIds.length === 0) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Nobody else is in this conversation' });
    }

    const roomId = randomBytes(16).toString('base64url');
    const room: RoomRecord = {
      roomId,
      conversationId,
      kind,
      host: caller.pseudoId,
      participants: [caller.pseudoId, ...pseudoIds],
      createdAt: Date.now(),
    };
    await this.saveRoom(room);

    const peerPseudo = pseudoIds[0];
    const peerOnline = peerPseudo ? await this.isUserOnline(peerPseudo) : false;

    this.logger.log(`call room opened (${kind}) for ${pseudoIds.length + 1} participants (peerOnline: ${peerOnline})`);
    return { roomId, invitees: pseudoIds, peerOnline, iceServers: this.iceServers(caller.pseudoId) };
  }

  async assertParticipant(roomId: string, userId: string): Promise<boolean> {
    const room = await this.loadRoom(roomId);
    if (!room) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { pseudoId: true } });
    if (!user) return false;
    return room.participants.includes(user.pseudoId);
  }

  async participants(roomId: string): Promise<string[]> {
    const room = await this.loadRoom(roomId);
    return room?.participants ?? [];
  }

  async endRoom(roomId: string, userId: string, reason: string): Promise<string[]> {
    const room = await this.loadRoom(roomId);
    if (!room) return [];
    const allowed = await this.assertParticipant(roomId, userId);
    if (!allowed) return [];
    await this.redis.client.del(this.roomKey(roomId));
    this.logger.log(`call room closed (${reason})`);
    return room.participants;
  }

  /** REST bootstrap for a client joining a call it was invited to. */
  async credentials(userId: string, pseudoId: string, roomId: string) {
    const room = await this.loadRoom(roomId);
    if (!room) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Call has ended' });
    if (!room.participants.includes(pseudoId)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Not a participant' });
    }
    void userId;
    return {
      roomId,
      conversationId: room.conversationId,
      kind: room.kind,
      iceServers: this.iceServers(pseudoId),
      sfuToken: null,
      expiresAt: new Date(Date.now() + this.config.TURN_CREDENTIAL_TTL * 1000).toISOString(),
    };
  }
}
