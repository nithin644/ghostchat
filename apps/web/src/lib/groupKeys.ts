'use client';

import { vaultDelete, vaultGet, vaultPut } from './vault';

/**
 * Group secret storage.
 *
 * A group's Sender Keys are bootstrapped from a secret that every member must
 * already share. In this build that secret is the group invite code, which is
 * distributed out-of-band (the same way the access key is) and never sent to the
 * server as key material.
 *
 * The honest consequence, stated plainly: whoever holds the invite code can
 * derive any member's sender chain and therefore forge messages attributed to
 * them. Rotate the invite and re-create the group after removing someone. This is
 * a deliberate simplification over Signal's pairwise Sender Key distribution,
 * which requires one encrypted copy per member.
 */
export interface GroupSecret {
  inviteCode: string;
  epoch: number;
}

function key(conversationId: string): string {
  return `group:${conversationId}`;
}

export async function storeGroupSecret(
  conversationId: string,
  secret: GroupSecret,
): Promise<void> {
  await vaultPut(key(conversationId), secret);
}

export async function getGroupSecret(conversationId: string): Promise<GroupSecret | null> {
  return vaultGet<GroupSecret>(key(conversationId));
}

export async function forgetGroupSecret(conversationId: string): Promise<void> {
  await vaultDelete(key(conversationId));
}

/** Invite codes are high-entropy already; no extra KDF is needed. */
export function isValidInviteCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(code);
}
