/**
 * GhostChat wire protocol.
 *
 * Everything here is deliberately "ciphertext-shaped": the server is a dumb
 * relay for `Envelope` objects it cannot open. Client-side code is the only
 * place that ever holds a plaintext body.
 */

export const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Access keys                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Access-key format: `GHOST-XXXXX-XXXXX-XXXXX-XXXXX`
 *
 * 20 symbols from a 32-symbol Crockford-style alphabet => 100 bits of entropy.
 * That is far beyond brute force, and short enough to read off a screen.
 */
export const ACCESS_KEY = {
  prefix: 'GHOST',
  alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ', // Crockford base32: no I, L, O, U
  groups: 4,
  groupLength: 5,
} as const;

export const ACCESS_KEY_REGEX =
  /^GHOST(?:-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}){4}$/;

/**
 * A handle is BLAKE2b(accessKey, ACCESS_KEY_PEPPER) truncated to 16 bytes,
 * base64url encoded. It is a *public* locator: safe to share as a contact
 * code, useless for authentication (the server stores it, it is not a secret).
 */
export type Base64Url = string;
export type ContactCode = Base64Url;

export type KeyStatus = 'UNCLAIMED' | 'CLAIMED' | 'REVOKED';

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

export interface ChallengeRequest {
  contactCode: ContactCode;
}

/** Step 1 of login: the server proves it knows which key you mean. */
export interface ChallengeResponse {
  challengeId: string;
  /** 32 random bytes, base64. Signed by the client's Ed25519 identity key. */
  challenge: Base64Url;
  /** Argon2id salt used to derive the identity seed from the access key. */
  identitySalt: Base64Url;
  /** False => the key exists but has never been onboarded. */
  claimed: boolean;
  /** Seconds until the challenge expires. */
  expiresIn: number;
}

export interface SignedPreKeyDTO {
  keyId: number;
  /** X25519 public key, base64. */
  publicKey: Base64Url;
  /** Ed25519 signature over (keyId || publicKey) by the identity key. */
  signature: Base64Url;
}

export interface OneTimePreKeyDTO {
  keyId: number;
  publicKey: Base64Url;
}

/**
 * First-run onboarding. The client sends public keys only; the private half
 * never leaves the device. `proof` is an Ed25519 signature over
 * `claimTranscript(...)` which binds the display name to the identity key.
 */
export interface ClaimRequest {
  contactCode: ContactCode;
  challengeId: string;
  displayName: string;
  /** SHA-256 of the normalised avatar bytes, base64. Not the image itself. */
  avatarHash?: Base64Url;
  /** Which avatar object key the client uploaded (already encrypted). */
  avatarObjectKey?: string;
  identitySignPublicKey: Base64Url;
  identityDhPublicKey: Base64Url;
  signedPreKey: SignedPreKeyDTO;
  oneTimePreKeys: OneTimePreKeyDTO[];
  /** Ed25519 signature over the published pre-key bundle, by the identity key. */
  bundleSignature: Base64Url;
  /** BLAKE2b of the Argon2id identity seed. One-shot; the server deletes it on success. */
  verifier: Base64Url;
  proof: Base64Url;
}

/** Step 2 of login. */
export interface VerifyRequest {
  contactCode: ContactCode;
  challengeId: string;
  signature: Base64Url;
}

export type UserRole = 'USER' | 'ADMIN';

export interface PublicUser {
  pseudoId: string;
  displayName: string;
  avatarUrl: string | null;
  contactCode: ContactCode;
  numericId?: string;
  role: UserRole;
  /** First 8 bytes of the identity signing key, hex — a human-checkable fingerprint. */
  keyFingerprint: string;
  createdAt: string;
  isVerified?: boolean;
}

export interface SessionResponse {
  user: PublicUser;
  /** Absolute expiry, ISO. The token itself lives in an httpOnly cookie. */
  expiresAt: string;
  /** True when this session was created by onboarding rather than login. */
  freshClaim: boolean;
}

/* -------------------------------------------------------------------------- */
/* Pre-key distribution                                                        */
/* -------------------------------------------------------------------------- */

export interface PreKeyBundle {
  contactCode: ContactCode;
  pseudoId: string;
  numericId?: string;
  displayName: string;
  avatarUrl: string | null;
  identityDhPublicKey: Base64Url;
  identitySignPublicKey: Base64Url;
  signedPreKey: SignedPreKeyDTO;
  /** Null when the server has exhausted the supply: client must fall back to SPK-only X3DH. */
  oneTimePreKey: OneTimePreKeyDTO | null;
  /** Ed25519 signature covering the whole bundle, verified client-side. */
  bundleSignature: Base64Url;
  isVerified?: boolean;
}

export interface PublishPreKeysRequest {
  signedPreKey?: SignedPreKeyDTO;
  oneTimePreKeys: OneTimePreKeyDTO[];
}

/* -------------------------------------------------------------------------- */
/* Conversations & messages                                                    */
/* -------------------------------------------------------------------------- */

export type ConversationType = 'DIRECT' | 'GROUP';
export type MessageKind = 'TEXT' | 'MEDIA' | 'SYSTEM' | 'CALL_EVENT';
export type EnvelopeKind = 'PAIRWISE' | 'SENDER_KEY' | 'SEALED';

/**
 * The only message shape the server understands. `header` carries ratchet
 * metadata that is itself AEAD-protected where it matters; `ciphertext` is a
 * secretbox/sender-key payload.
 */
export interface Envelope {
  kind: EnvelopeKind;
  /**
   * Server-blind session locator. Derived from the pairwise root key, so the
   * server cannot recompute it and cannot build a social graph from it.
   */
  sessionTag: Base64Url;
  /** Ratchet header (DH pubkey, counters) or sender-key header. Base64. */
  header: Base64Url;
  /** Base64 secretbox ciphertext. */
  ciphertext: Base64Url;
  /** Optional sender signature (sender-key messages). Base64. */
  signature?: Base64Url;
}

export interface QuotedMessageDTO {
  id: string;
  senderName: string;
  textSnippet: string;
}

export interface MessageReactionDTO {
  emoji: string;
  count: number;
  byMe: boolean;
  users: Array<{ pseudoId: string; displayName: string }>;
}

export interface SendMessageRequest {
  conversationId: string;
  envelope: Envelope;
  /** Client clock. Server clamps to its own clock to stop timestamp games. */
  sentAt?: string;
  /** Client-generated v4 UUID, used for idempotent retries. */
  clientRef: string;
  /** Disappearing messages: seconds after which server + clients drop it. */
  ttlSeconds?: number | null;
  /** Quoted message reply context (like WhatsApp). */
  replyTo?: QuotedMessageDTO | null;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  /**
   * Null for sealed-sender messages: the server genuinely does not know who
   * sent it. The recipient learns the sender only after decrypting.
   */
  senderPseudoId: string | null;
  senderDisplayName: string | null;
  kind: MessageKind;
  envelope: Envelope;
  createdAt: string;
  expiresAt: string | null;
  clientRef: string;
  receiptState?: ReceiptState | 'SENT';
  reactions?: MessageReactionDTO[];
  replyTo?: QuotedMessageDTO | null;
  fromSelf?: boolean;
}

export type ReceiptState = 'DELIVERED' | 'READ';

export interface ReceiptDTO {
  messageId: string;
  conversationId: string;
  userId: string;
  state: ReceiptState;
  at: string;
}

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  title: string;
  avatarUrl: string | null;
  /** Set for DIRECT conversations. */
  peer: PublicUser | null;
  lastMessage: {
    id: string;
    kind: MessageKind;
    /** Base64 preview the server cannot read — clients decrypt lazily. */
    previewCiphertext: Base64Url | null;
    at: string;
    fromSelf: boolean | null;
    snippet?: string | null;
    envelope?: Envelope;
    senderPseudoId?: string | null;
  } | null;
  unreadCount: number;
  lastActivityAt: string;
  isBlocked?: boolean;
  memberCount?: number;
}

export interface ConversationMemberDTO {
  userId: string;
  pseudoId: string;
  displayName: string;
  numericId?: string;
  contactCode?: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  isVerified?: boolean;
}

export interface ConversationDetail {
  id: string;
  type: ConversationType;
  title: string;
  avatarUrl: string | null;
  members: ConversationMemberDTO[];
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Groups                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateGroupRequest {
  name: string;
  memberContactCodes: ContactCode[];
  /** Optional: enforce a maximum member count server-side. */
  maxMembers?: number;
}

export interface GroupInviteDTO {
  id: string;
  conversationId: string;
  /** Shareable, revocable, and NOT an access key. */
  inviteCode: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdAt: string;
}

export interface JoinGroupRequest {
  inviteCode: string;
}

export interface GroupRequestDTO {
  id: string;
  conversationId: string;
  groupTitle: string;
  groupAvatarUrl: string | null;
  memberCount: number;
  invitedBy: {
    pseudoId: string;
    displayName: string;
    numericId?: string;
  };
  inviteCode: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  createdAt: string;
}

export interface CreateGroupWithMembersRequest {
  name: string;
  avatarUrl?: string | null;
  memberPseudoIds?: string[];
}

/* -------------------------------------------------------------------------- */
/* Calls                                                                       */
/* -------------------------------------------------------------------------- */

export type CallKind = 'AUDIO' | 'VIDEO';
export type CallState = 'RINGING' | 'ACTIVE' | 'ENDED' | 'MISSED' | 'DECLINED';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CallCredentials {
  /** Server-side room id; also the mediasoup router handle key. */
  roomId: string;
  conversationId: string;
  kind: CallKind;
  iceServers: IceServer[];
  /** SFrame epoch key, base64. Wrapped per-participant by the caller's ratchet. */
  sfuToken: string | null;
  expiresAt: string;
}

export interface CallSignalPayload {
  roomId: string;
  /** 'offer' | 'answer' | 'ice' | 'sfu-rtp-capabilities' | 'sfu-produce' | ... */
  type: string;
  data: unknown;
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateAccessKeysRequest {
  count: number;
  label?: string;
  /** Days until the *unclaimed* key expires. */
  expiresInDays?: number;
}

/** The plaintext key is returned exactly once, at mint time. It is never stored. */
export interface CreateAccessKeysResponse {
  keys: Array<{ accessKey: string; contactCode: ContactCode; expiresAt: string | null }>;
  label: string | null;
}

export interface AdminUserRow {
  pseudoId: string;
  numericId?: string;
  displayName: string;
  avatarUrl: string | null;
  lastIp: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'BANNED';
  createdAt: string;
  lastSeenAt: string | null;
  conversationCount: number;
  messages30d: number;
  keyFingerprint: string;
  isVerified?: boolean;
  accessKeyCode?: string;
}

export type FriendRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED';

export interface FriendRequestDTO {
  id: string;
  senderId: string;
  receiverId: string;
  status: FriendRequestStatus;
  createdAt: string;
  user: PublicUser;
}

export interface BlockedUserDTO {
  id: string;
  pseudoId: string;
  numericId?: string;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: string;
}

export interface UserSearchResult extends PublicUser {
  friendStatus: 'NONE' | 'PENDING_SENT' | 'PENDING_RECEIVED' | 'ACCEPTED' | 'SELF' | 'BLOCKED';
  requestId?: string;
  isBlocked?: boolean;
}

export interface AdminKeyRow {
  id: string;
  contactCode: ContactCode;
  label: string | null;
  status: KeyStatus;
  createdAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
  claimant: { pseudoId: string; displayName: string } | null;
}

export interface AdminStats {
  users: { total: number; active24h: number; new7d: number };
  keys: { unclaimed: number; claimed: number; revoked: number };
  messages: { total: number; last24h: number; lastHour: number; perMinute: number[] };
  conversations: { direct: number; group: number };
  sessions: { active: number };
  storage: { objects: number; bytes: number };
  server: {
    uptimeSeconds: number;
    memoryRssBytes: number;
    dbLatencyMs: number;
    redisLatencyMs: number;
    queueDepth: number;
    version: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Socket.IO contract                                                          */
/* -------------------------------------------------------------------------- */

export interface ServerToClientEvents {
  'message:new': (m: MessageDTO) => void;
  'message:receipt': (r: ReceiptDTO) => void;
  'message:reaction': (p: { conversationId: string; messageId: string; emoji: string; userPseudoId: string; action: 'add' | 'remove' }) => void;
  'typing': (t: { conversationId: string; userId: string; displayName: string; typing: boolean }) => void;
  'presence': (p: { userId: string; online: boolean; lastSeenAt: string | null }) => void;
  'conversation:new': (c: ConversationSummary) => void;
  'conversation:updated': (c: ConversationSummary) => void;
  'group:members-changed': (p: { conversationId: string; members: ConversationMemberDTO[] }) => void;
  'call:incoming': (p: { roomId: string; conversationId: string; kind: CallKind; fromDisplayName: string; fromUserId: string; screenShare?: boolean }) => void;
  'call:ringing': (p: { roomId: string }) => void;
  'call:signal': (p: CallSignalPayload & { fromUserId: string }) => void;
  'call:media-chunk': (p: { roomId: string; chunk: ArrayBuffer }) => void;
  'call:ended': (p: { roomId: string; reason: string }) => void;
  'walkie:incoming': (p: { conversationId: string; fromDisplayName: string; fromPseudoId: string }) => void;
  'walkie:audio': (p: { conversationId: string; fromDisplayName: string; fromPseudoId: string; chunk: ArrayBuffer; sampleRate?: number }) => void;
  'walkie:ended': (p: { conversationId: string; fromPseudoId: string }) => void;
  'chat:bomb': (p: { conversationId: string; fromUserId?: string; fromDisplayName?: string }) => void;
  'chat:fire': (p: { conversationId: string; fromUserId?: string; fromDisplayName?: string }) => void;
  'chat:love': (p: { conversationId: string; fromUserId?: string; fromDisplayName?: string }) => void;
  'error': (e: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  'conversation:join': (body: { conversationId: string }) => void;
  'message:send': (
    body: SendMessageRequest,
    ack: (res: { ok: true; message: MessageDTO } | { ok: false; error: string }) => void,
  ) => void;
  'message:read': (body: { conversationId: string; messageIds: string[] }) => void;
  'message:delivered': (body: { conversationId: string; messageId: string }) => void;
  'message:react': (body: { conversationId: string; messageId: string; emoji: string }) => void;
  'typing': (body: { conversationId: string; typing: boolean }) => void;
  'call:invite': (
    body: { conversationId: string; kind: CallKind; screenShare?: boolean },
    ack: (res: { ok: true; roomId: string; peerOnline?: boolean } | { ok: false; error: string }) => void,
  ) => void;
  'call:ringing': (body: { roomId: string }) => void;
  'call:signal': (body: CallSignalPayload) => void;
  'call:media-chunk': (body: { roomId: string; chunk: ArrayBuffer }) => void;
  'call:end': (body: { roomId: string }) => void;
  'walkie:start': (body: { conversationId: string }) => void;
  'walkie:chunk': (body: { conversationId: string; chunk: ArrayBuffer; sampleRate?: number }) => void;
  'walkie:end': (body: { conversationId: string }) => void;
  'chat:bomb': (body: { conversationId: string }) => void;
  'chat:fire': (body: { conversationId: string }) => void;
  'chat:love': (body: { conversationId: string }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  pseudoId: string;
  displayName: string;
  role: UserRole;
  sessionId: string;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ApiErrorCode =
  | 'INVALID_KEY'
  | 'KEY_REVOKED'
  | 'KEY_EXPIRED'
  | 'ALREADY_CLAIMED'
  | 'NOT_CLAIMED'
  | 'CHALLENGE_EXPIRED'
  | 'BAD_SIGNATURE'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export interface ApiErrorBody {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
  requestId?: string;
}
