import type {
  AdminKeyRow,
  AdminStats,
  AdminUserRow,
  BlockedUserDTO,
  ChallengeResponse,
  ConversationDetail,
  ConversationSummary,
  CreateAccessKeysResponse,
  FriendRequestDTO,
  GroupRequestDTO,
  CreateGroupWithMembersRequest,
  MessageDTO,
  PreKeyBundle,
  PublicUser,
  SessionResponse,
  UserSearchResult,
} from '@ghostchat/shared-types';

/**
 * Same-origin by default.
 *
 * This matters more than it looks: when the app is served from a .onion address,
 * a bundle that hardcodes `http://localhost:4000` would make every visitor's
 * browser call *their own* machine. A relative base means the browser resolves
 * the API against whatever origin served the page — clearnet, onion, or a
 * localhost dev proxy — with no rebuild.
 */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' ? '/api' : 'http://127.0.0.1:4000/api');

/**
 * Resolve a possibly origin-relative URL returned by the API.
 *
 * The local media driver hands back paths like `/api/blob/...?sig=...` so the
 * same response works on clearnet, on an onion address and against a dev API on
 * another port. The browser only needs the right origin prepended.
 */
export function resolveApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (API_URL.startsWith('http')) {
    const origin = API_URL.replace(/\/api$/, '');
    return `${origin}${pathOrUrl}`;
  }
  return pathOrUrl; // same-origin deployment: leave it relative
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    // The session cookie is httpOnly and scoped to the API origin; `include`
    // is what makes it travel on cross-origin calls in development.
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const body = data as { code?: string; message?: string } | null;
    throw new ApiError(res.status, body?.code ?? 'INTERNAL', body?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  challenge: (contactCode: string) =>
    request<ChallengeResponse>('/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ contactCode }),
    }),

  verify: (body: { contactCode: string; challengeId: string; signature: string }) =>
    request<SessionResponse>('/auth/verify', { method: 'POST', body: JSON.stringify(body) }),

  claim: (body: unknown) =>
    request<SessionResponse>('/auth/claim', { method: 'POST', body: JSON.stringify(body) }),

  me: () => request<PublicUser>('/auth/me'),
  adminCredentials: () => request<{
    username: string;
    credentials: Array<{ id: number; username: string; createdAt: string }>;
  }>('/auth/admin-credentials'),
  createAdminCredential: (body: { username: string; password: string }) =>
    request<{ id: number; username: string }>('/auth/admin-credentials', { method: 'POST', body: JSON.stringify(body) }),
  updateAdminCredentials: (body: { credentialId: number; currentPassword: string; username: string; newPassword: string }) =>
    request<{ username: string }>('/auth/admin-credentials', { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAdminCredential: (credentialId: number) =>
    request<{ deleted: boolean }>(`/auth/admin-credentials/${credentialId}`, { method: 'DELETE' }),

  updateProfile: (body: { displayName?: string; avatar?: string | null }) =>
    request<PublicUser>('/auth/profile', { method: 'PATCH', body: JSON.stringify(body) }),

  adminLogin: (body: { username: string; password: string }) =>
    request<SessionResponse>('/auth/admin-login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  bundle: (contactCode: string) => request<PreKeyBundle>(`/keys/${contactCode}`),

  replenish: (body: unknown) =>
    request<{ published: number; available: number }>('/keys/replenish', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  conversations: () => request<ConversationSummary[]>('/conversations'),

  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),

  deleteConversation: (id: string) =>
    request<{ success: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),

  blockUser: (target: string) =>
    request<{ success: boolean; pseudoId: string }>(`/conversations/block/${encodeURIComponent(target)}`, {
      method: 'POST',
    }),

  unblockUser: (target: string) =>
    request<{ success: boolean; pseudoId: string }>(`/conversations/block/${encodeURIComponent(target)}`, {
      method: 'DELETE',
    }),

  getBlockedUsers: () => request<BlockedUserDTO[]>('/conversations/blocks/list'),

  openDirect: (identifier: string) =>
    request<{ id: string }>('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ query: identifier, contactCode: identifier }),
    }),

  findUser: (query: string) =>
    request<PublicUser>(`/conversations/find-user?q=${encodeURIComponent(query)}`),

  messages: (id: string, before?: string) =>
    request<MessageDTO[]>(`/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  createGroup: (body: { name: string; memberContactCodes: string[] }) =>
    request<ConversationDetail>('/groups', { method: 'POST', body: JSON.stringify(body) }),

  joinGroup: (inviteCode: string) =>
    request<ConversationDetail>('/groups/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode }),
    }),

  createInvite: (conversationId: string, body: { expiresInHours?: number; maxUses?: number }) =>
    request<{ inviteCode: string }>(`/groups/${conversationId}/invites`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeMember: (conversationId: string, pseudoId: string) =>
    request<{ removed: boolean }>(`/groups/${conversationId}/members/${pseudoId}`, {
      method: 'DELETE',
    }),

  createGroupWithMembers: (body: CreateGroupWithMembersRequest) =>
    request<{ group: ConversationDetail; inviteCode: string }>('/groups/create-with-members', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendGroupRequests: (conversationId: string, pseudoIds: string[]) =>
    request<{ count: number; inviteCode: string }>(`/groups/${conversationId}/invite-users`, {
      method: 'POST',
      body: JSON.stringify({ pseudoIds }),
    }),
  getGroupRequests: () =>
    request<GroupRequestDTO[]>('/groups/requests'),
  acceptGroupRequest: (id: string) =>
    request<{ conversationId: string; inviteCode: string; group: ConversationDetail }>(`/groups/requests/${id}/accept`, {
      method: 'POST',
    }),
  declineGroupRequest: (id: string) =>
    request<{ success: boolean }>(`/groups/requests/${id}`, {
      method: 'DELETE',
    }),
  leaveGroup: (conversationId: string) =>
    request<{ left: boolean }>(`/groups/${conversationId}/leave`, {
      method: 'POST',
    }),

  updateGroup: (conversationId: string, body: { avatarUrl?: string | null; name?: string }) =>
    request<ConversationDetail>(`/groups/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  presignUpload: (bytes: number, sha256: string) =>
    request<{ objectKey: string; uploadUrl: string }>('/media/presign', {
      method: 'POST',
      body: JSON.stringify({ bytes, sha256 }),
    }),

  completeUpload: (objectKey: string) =>
    request<{ verified: boolean }>(`/media/${objectKey}/complete`, { method: 'POST' }),

  downloadUrl: (objectKey: string) =>
    request<{ url: string }>(`/media/${objectKey}`),

  adminStats: () => request<AdminStats>('/admin/stats'),
  adminUsers: () => request<AdminUserRow[]>('/admin/users'),
  adminKeys: () => request<AdminKeyRow[]>('/admin/keys'),
  callCredentials: (roomId: string) =>
    request<{ iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> }>(
      `/calls/${roomId}`,
    ),

  adminMint: (body: { count: number; label?: string; expiresInDays?: number }) =>
    request<CreateAccessKeysResponse>('/admin/keys', { method: 'POST', body: JSON.stringify(body) }),
  adminRevoke: (id: string) => request<{ revoked: boolean }>(`/admin/keys/${id}`, { method: 'DELETE' }),
  adminBan: (pseudoId: string) =>
    request<{ banned: boolean }>(`/admin/users/${pseudoId}`, { method: 'DELETE' }),
  adminUpdateNumericId: (pseudoId: string, numericId: string) =>
    request<{ success: boolean; numericId: string }>(`/admin/users/${pseudoId}/numeric-id`, {
      method: 'PATCH',
      body: JSON.stringify({ numericId }),
    }),
  adminUpdateVerified: (pseudoId: string, isVerified: boolean) =>
    request<{ success: boolean; isVerified: boolean }>(`/admin/users/${pseudoId}/verified`, {
      method: 'PATCH',
      body: JSON.stringify({ isVerified }),
    }),

  // Friends & User Search
  searchFriends: (q: string) => request<UserSearchResult[]>(`/friends/search?q=${encodeURIComponent(q)}`),
  listUsers: () =>
    request<{ users: UserSearchResult[]; stats: { total: number; online: number; offline: number } }>(
      '/friends/users',
    ),
  getFriendRequests: () =>
    request<{ incoming: FriendRequestDTO[]; outgoing: FriendRequestDTO[] }>('/friends/requests'),
  sendFriendRequest: (target: string) =>
    request<{ status: string; conversationId?: string; id?: string; message?: string }>('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  acceptFriendRequest: (id: string) =>
    request<{ conversationId: string }>(`/friends/requests/${id}/accept`, { method: 'POST' }),
  declineFriendRequest: (id: string) =>
    request<{ success: boolean }>(`/friends/requests/${id}`, { method: 'DELETE' }),

  // Encrypted Vault Remote Sync
  vaultGetAll: () =>
    request<{ entries: Record<string, { nonce: string; ciphertext: string }> }>('/vault'),
  vaultSync: (entries: Record<string, { nonce: string; ciphertext: string }>) =>
    request<{ count: number }>('/vault/sync', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    }),
  vaultDeleteRemote: (key: string) =>
    request<{ ok: boolean }>(`/vault/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
};
