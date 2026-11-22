'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  b64d,
  b64e,
  identityFromSeed,
  encryptBlob,
  keyMaterialToDescriptorFields,
  encodeMediaDescriptor,
  deriveSignedPreKey,
  deriveOneTimePreKeys,
  signBundle,
  type IdentityKeyPair,
  type PublicPreKeyBundle,
} from '@ghostchat/crypto';
import type { ConversationDetail, MessageDTO, PublicUser, QuotedMessageDTO, UserSearchResult } from '@ghostchat/shared-types';
import { api, resolveApiUrl } from '../../lib/api';
import { vaultGet, unlockVault, getActiveIdentitySeed, vaultPut, lockVault, syncVaultWithServer } from '../../lib/vault';
import {
  decryptDirect,
  decryptGroup,
  encryptDirect,
  encryptGroup,
  groupInviteSecret,
  resetSessions,
  type StoredPreKeys,
} from '../../lib/e2ee';
import { getGroupSecret, storeGroupSecret } from '../../lib/groupKeys';
import { getSocket, closeSocket } from '../../lib/socket';
import { useCall } from '../../lib/useCall';
import { registerWalkieReceiver } from '../../lib/walkie';
import { ChatList } from '../../components/ChatList';
import { ChatWindow } from '../../components/ChatWindow';
import { CallOverlay } from '../../components/CallOverlay';
import { AdminDashboard } from '../../components/AdminDashboard';
import ChatEffects, { ChatEffectType } from '../../components/ChatEffects';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  appendMessage,
  bumpUnread,
  patchMessage,
  resetChat,
  setActive,
  setConversations,
  setMessages,
  setTyping,
  updateReceipt,
  updateReaction,
  updateConversationSnippet,
  upsertConversation,
  removeConversation,
  setBlockedUsers,
  addBlockedUser,
  removeBlockedUser,
  type UiMessage,
} from '../../store/chatSlice';
import { clearUser, setUser } from '../../store/sessionSlice';
import { useTheme } from '../../lib/theme';
import {
  initAudioOnUserGesture,
  playMessageNotificationSound,
  requestNotificationPermission,
  showBrowserNotification,
} from '../../lib/sound';

interface IdentityRecord {
  seed: string;
  contactCode: string;
}

/**
 * Global set of message IDs that have already been decrypted in this page session.
 * This is THE critical guard: the Double Ratchet is stateful — each call to
 * ratchetDecrypt() permanently advances the chain. Decrypting the same ciphertext
 * twice corrupts the ratchet and makes ALL future messages from that peer
 * undecryptable. This set ensures every message is decrypted exactly once.
 */
const decryptedMessageIds = new Set<string>();

/**
 * Decrypt one message, whatever the conversation type.
 *
 * Returns null instead of throwing for any failure: an undecryptable message must
 * render as "unable to decrypt" rather than breaking the whole history load. That
 * distinction matters — one bad packet should never hide an entire conversation.
 */
async function decryptMessage(
  identity: IdentityKeyPair,
  message: MessageDTO,
  conversationType: 'DIRECT' | 'GROUP',
  fallbackPeerPseudoId: string,
  preKeys: StoredPreKeys | null,
): Promise<string | null> {
  try {
    // GUARD 1: If we already decrypted this message in this session, do NOT
    // touch the ratchet again. Return cached plaintext.
    const msgKey = message.id || message.clientRef;
    if (msgKey && decryptedMessageIds.has(msgKey)) {
      // Already processed — return from cache only
      const cached =
        (await vaultGet<string>(`msg:${message.id}`).catch(() => null)) ||
        (message.clientRef ? await vaultGet<string>(`msg:${message.clientRef}`).catch(() => null) : null) ||
        (typeof window !== 'undefined' && message.id ? localStorage.getItem(`gc_in_${message.id}`) : null) ||
        (typeof window !== 'undefined' && message.clientRef ? localStorage.getItem(`gc_in_${message.clientRef}`) : null);
      return cached || null;
    }

    // GUARD 2: Check vault/localStorage before touching the ratchet
    if (message.id) {
      const cached =
        (await vaultGet<string>(`msg:${message.id}`).catch(() => null)) ||
        (typeof window !== 'undefined' ? localStorage.getItem(`gc_in_${message.id}`) : null);
      if (cached) {
        if (msgKey) decryptedMessageIds.add(msgKey);
        return cached;
      }
    }
    if (message.clientRef) {
      const cached =
        (await vaultGet<string>(`msg:${message.clientRef}`).catch(() => null)) ||
        (typeof window !== 'undefined' ? localStorage.getItem(`gc_in_${message.clientRef}`) : null);
      if (cached) {
        if (msgKey) decryptedMessageIds.add(msgKey);
        return cached;
      }
    }

    // No cache hit — this is the ONLY path that touches the ratchet
    let text: string | null = null;

    if (message.envelope.kind === 'PAIRWISE' || conversationType === 'DIRECT') {
      const peerId =
        message.senderPseudoId && (message.senderPseudoId.startsWith('u_') || message.senderPseudoId === 'admin')
          ? message.senderPseudoId
          : (fallbackPeerPseudoId || message.senderPseudoId || '');
      text = await decryptDirect(
        identity,
        peerId,
        message.envelope,
        preKeys,
      );
    } else if (message.envelope.kind === 'SENDER_KEY') {
      const sender = message.senderPseudoId;
      if (!sender) return null;
      const secret = await getGroupSecret(message.conversationId);
      if (!secret) return null;
      text = await decryptGroup(
        groupInviteSecret(secret.inviteCode, message.conversationId),
        sender,
        message.envelope,
      );
    }

    // Mark as processed BEFORE persisting, so concurrent calls don't re-enter
    if (msgKey) decryptedMessageIds.add(msgKey);

    if (text) {
      // Persist under BOTH id and clientRef so future lookups always hit
      if (message.id) {
        await vaultPut(`msg:${message.id}`, text).catch(() => null);
        if (typeof window !== 'undefined') {
          try { localStorage.setItem(`gc_in_${message.id}`, text); } catch {}
        }
      }
      if (message.clientRef) {
        await vaultPut(`msg:${message.clientRef}`, text).catch(() => null);
        if (typeof window !== 'undefined') {
          try { localStorage.setItem(`gc_in_${message.clientRef}`, text); } catch {}
        }
      }
    }

    return text;
  } catch (err) {
    // ⚠️  Do NOT add to decryptedMessageIds on failure.
    // If the ratchet state hasn't loaded yet (e.g. vault not ready on mobile page
    // load), we must allow a retry on the next poll cycle. Adding to the set here
    // would permanently block retries and leave messages as "Decryption failed"
    // forever.  The ratchet is only advanced inside decryptDirect/decryptGroup, so
    // a failed call does NOT corrupt the chain — it is safe to retry.
    console.warn(`decryptMessage failed for ${message.id}:`, err);
    return null;
  }
}

export default function ChatPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { user } = useAppSelector((s) => s.session);
  const { conversations, messages, activeId, typing, unread, blockedUsers } = useAppSelector((s) => s.chat);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const blockedUsersRef = useRef(blockedUsers);
  blockedUsersRef.current = blockedUsers;

  const identityRef = useRef<IdentityKeyPair | null>(null);
  const preKeysRef = useRef<StoredPreKeys | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  const [allUsers, setAllUsers] = useState<UserSearchResult[]>([]);
  const [activeEffect, setActiveEffect] = useState<ChatEffectType>(null);
  const handleEffectComplete = useCallback(() => {
    setActiveEffect(null);
  }, []);
  const { theme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro';
  const isMidnight = theme === 'midnight';
  const isNordic = theme === 'nordic';

  useEffect(() => {
    void api.listUsers().then((res) => setAllUsers(res.users)).catch(() => null);
  }, []);

  // Calling is delegated to a hook so the peer connection lifecycle is not
  // tangled with message state.
  const {
    call,
    localStream,
    remoteStream,
    muted,
    isCameraOff,
    isScreenSharing,
    start: startCall,
    accept: acceptCall,
    hangup: hangupCall,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
  } = useCall();

  // Initialize Web Audio and browser notification permissions on first interaction
  useEffect(() => {
    initAudioOnUserGesture();
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      const handleFirstGesture = () => {
        void requestNotificationPermission();
        window.removeEventListener('pointerdown', handleFirstGesture);
        window.removeEventListener('keydown', handleFirstGesture);
      };
      window.addEventListener('pointerdown', handleFirstGesture, { once: true });
      window.addEventListener('keydown', handleFirstGesture, { once: true });
      return () => {
        window.removeEventListener('pointerdown', handleFirstGesture);
        window.removeEventListener('keydown', handleFirstGesture);
      };
    }
  }, []);

  // Sync browser window title with unread message badge (e.g. "(1) PRIVATE_CHAT")
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const totalUnread = Object.values(unread).reduce((sum, n) => sum + (n || 0), 0);
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) PRIVATE_CHAT`;
    } else {
      document.title = 'PRIVATE_CHAT';
    }
  }, [unread]);

  /* ---------------------------------------------------------------------- */
  /* Boot: restore identity from the vault                                   */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const me = await api.me();
        dispatch(setUser(me));

        // The vault is sealed with a key derived from the identity seed, so it
        // can only be opened after the user re-enters their access key. That is
        // the cost of never persisting the seed; see README "Vault".
        let seed = getActiveIdentitySeed();
        if (!seed) {
          const stored = await vaultGet<IdentityRecord>('identity').catch(() => null);
          if (stored) {
            seed = b64d(stored.seed);
            unlockVault(seed);
          }
        }

        if (!seed) {
          router.replace('/onboarding');
          return;
        }

        identityRef.current = identityFromSeed(seed);
        // Sync encrypted vault entries across devices (e.g. laptop <-> mobile)
        await syncVaultWithServer().catch(() => null);

        let storedPreKeys = await vaultGet<StoredPreKeys>('prekeys').catch(() => null);

        if (!storedPreKeys || (storedPreKeys.signedPreKey && storedPreKeys.signedPreKey.keyId > 10000)) {
          try {
            const spk = deriveSignedPreKey(identityRef.current, 1);
            const otpks = deriveOneTimePreKeys(identityRef.current.seed, 1, 50);
            const bundle: PublicPreKeyBundle = {
              identityDhPublicKey: identityRef.current.dh.publicKey,
              identitySignPublicKey: identityRef.current.sign.publicKey,
              signedPreKey: { keyId: spk.keyId, publicKey: spk.keyPair.publicKey, signature: spk.signature },
              oneTimePreKey: null,
            };
            const bundleSignature = signBundle(bundle, identityRef.current);
            await api.replenish({
              signedPreKey: {
                keyId: spk.keyId,
                publicKey: b64e(spk.keyPair.publicKey),
                signature: b64e(spk.signature),
              },
              oneTimePreKeys: otpks.map((k) => ({ keyId: k.keyId, publicKey: b64e(k.keyPair.publicKey) })),
              bundleSignature: b64e(bundleSignature),
            }).catch(() => null);

            storedPreKeys = {
              signedPreKey: {
                keyId: spk.keyId,
                publicKey: b64e(spk.keyPair.publicKey),
                privateKey: b64e(spk.keyPair.privateKey),
              },
              oneTimePreKeys: otpks.map((k) => ({
                keyId: k.keyId,
                publicKey: b64e(k.keyPair.publicKey),
                privateKey: b64e(k.keyPair.privateKey),
              })),
            };
            await vaultPut('prekeys', storedPreKeys).catch(() => null);
          } catch {
            // non-fatal
          }
        }
        preKeysRef.current = storedPreKeys;

        const list = await api.conversations();
        if (cancelled) return;

        // Load cached last message snippets for sidebar
        for (const c of list) {
          if (c.lastMessage) {
            const cached = (await vaultGet<string>(`msg:${c.lastMessage.id}`).catch(() => null)) ||
              (await vaultGet<string>(`msg:${c.lastMessage.at}`).catch(() => null));
            if (cached) {
              c.lastMessage.snippet =
                cached.startsWith('{"__ghost_media":') || cached.startsWith('[file] ')
                  ? '📷 Attachment'
                  : cached;
            }
          }
        }

        dispatch(setConversations(list));

        // Load blocked users from API and merge with persistent localStorage
        try {
          const blockedList = await api.getBlockedUsers();
          const pIds = blockedList.map((b) => b.pseudoId);
          if (typeof window !== 'undefined') {
            const local = localStorage.getItem('gc_blocked_users');
            if (local) {
              try {
                const parsed = JSON.parse(local);
                for (const p of parsed) {
                  if (!pIds.includes(p)) pIds.push(p);
                }
              } catch {}
            }
            localStorage.setItem('gc_blocked_users', JSON.stringify(pIds));
          }
          dispatch(setBlockedUsers(pIds));
        } catch {
          if (typeof window !== 'undefined') {
            const local = localStorage.getItem('gc_blocked_users');
            if (local) {
              try { dispatch(setBlockedUsers(JSON.parse(local))); } catch {}
            }
          }
        }

        setReady(true);
      } catch {
        if (!cancelled) {
          setBootError('Session expired. Enter your access key again.');
          router.replace('/onboarding');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dispatch, router]);

  /* ---------------------------------------------------------------------- */
  /* Socket wiring                                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!ready || !user) return;
    const socket = getSocket();

    const onMessage = async (message: MessageDTO) => {
      const identity = identityRef.current;
      if (!identity) return;

      // DEDUP: If we already have this message in the store, skip entirely.
      // This prevents the ratchet from being advanced twice when the polling
      // loop and WebSocket both deliver the same message.
      const existing = messagesRef.current[message.conversationId] || [];
      if (existing.some((m) => m.id === message.id || (message.clientRef && m.clientRef === message.clientRef))) {
        return;
      }

      const isSenderMe =
        Boolean(message.senderPseudoId) &&
        (message.senderPseudoId === user.pseudoId ||
         message.senderPseudoId === (user as unknown as { userId?: string }).userId);
      const mine = message.fromSelf === true ? (message.senderPseudoId ? isSenderMe : false) : isSenderMe;

      const type = conversationsRef.current.find((c) => c.id === message.conversationId)?.type ?? 'DIRECT';
      let text: string | null = null;

      if (mine) {
        // For own messages: check vault under BOTH id and clientRef
        text =
          (await vaultGet<string>(`msg:${message.id}`).catch(() => null)) ||
          (message.clientRef ? await vaultGet<string>(`msg:${message.clientRef}`).catch(() => null) : null) ||
          (typeof window !== 'undefined'
            ? localStorage.getItem(`gc_out_${message.id}`) ||
              (message.clientRef ? localStorage.getItem(`gc_out_${message.clientRef}`) : null)
            : null);
      } else {
        text = await decryptMessage(identity, message, type, conversationPeer(message.conversationId), preKeysRef.current);
      }

      if (text) {
        void vaultPut(`msg:${message.id}`, text).catch(() => null);
      }

      const ui: UiMessage = {
        ...message,
        text,
        mine,
        failed: !mine && text === null,
      };

      dispatch(appendMessage(ui));
      if (!mine) {
        dispatch(bumpUnread(message.conversationId));
        playMessageNotificationSound();

        const convo = conversationsRef.current.find((c) => c.id === message.conversationId);
        const senderTitle = convo?.title || convo?.peer?.displayName || 'GhostChat';
        const notifBody = text
          ? (text.startsWith('{"__ghost_media":') || text.startsWith('[file] ') ? '📷 Sent a file' : text)
          : 'New message';

        if (typeof document !== 'undefined' && (document.hidden || activeIdRef.current !== message.conversationId)) {
          showBrowserNotification(senderTitle, {
            body: notifBody,
            tag: message.conversationId,
            onClick: () => {
              void openConversation(message.conversationId);
            },
          });
        }
      }

      // WhatsApp delivery / read receipts: read if looking at this conversation, delivered otherwise
      if (!mine) {
        if (activeIdRef.current === message.conversationId) {
          socket.emit('message:read', {
            conversationId: message.conversationId,
            messageIds: [message.id],
          });
        } else {
          socket.emit('message:delivered', {
            conversationId: message.conversationId,
            messageId: message.id,
          });
        }
      }
    };

    const onTyping = (payload: { conversationId: string; displayName: string; typing: boolean }) => {
      dispatch(
        setTyping({
          conversationId: payload.conversationId,
          typing: payload.typing
            ? { userId: payload.conversationId, displayName: payload.displayName, at: Date.now() }
            : null,
        }),
      );
    };

    const onReceipt = (receipt: { conversationId: string; messageId: string; state: 'DELIVERED' | 'READ' }) => {
      dispatch(updateReceipt(receipt));
    };

    const onReaction = (payload: {
      conversationId: string;
      messageId: string;
      emoji: string;
      userPseudoId: string;
      action: 'add' | 'remove';
    }) => {
      dispatch(updateReaction({ ...payload, currentPseudoId: user.pseudoId }));
    };

    const onBomb = () => setActiveEffect('bomb');
    const onFire = () => setActiveEffect('fire');
    const onLove = () => setActiveEffect('love');

    socket.on('message:new', (m) => void onMessage(m));
    socket.on('typing', onTyping);
    socket.on('message:receipt', onReceipt);
    socket.on('message:reaction', onReaction);
    socket.on('chat:bomb', onBomb);
    socket.on('chat:fire', onFire);
    socket.on('chat:love', onLove);

    return () => {
      socket.off('message:new');
      socket.off('typing');
      socket.off('message:receipt');
      socket.off('message:reaction');
      socket.off('chat:bomb');
      socket.off('chat:fire');
      socket.off('chat:love');
    };
    // conversationPeer is stable enough for this closure's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user, dispatch]);

  // Global Walkie-Talkie intercom receiver
  useEffect(() => {
    if (!ready || !user) return;
    const cleanupWalkie = registerWalkieReceiver();
    return () => {
      cleanupWalkie();
    };
  }, [ready, user]);

  /* ---------------------------------------------------------------------- */
  /* Conversations                                                          */
  /* ---------------------------------------------------------------------- */

  const conversationPeer = (conversationId: string): string => {
    const convo = conversationsRef.current.find((c) => c.id === conversationId);
    return convo?.peer?.pseudoId ?? '';
  };

  const openConversation = useCallback(
    async (id: string) => {
      dispatch(setActive(id));
      try {
        const [convo, history] = await Promise.all([api.conversation(id), api.messages(id)]);
        setDetail(convo);
        getSocket().emit('conversation:join', { conversationId: id });

        const identity = identityRef.current;
        const ui: UiMessage[] = [];

        // Sort chronologically ascending so ratchet state advances forward in strict sequence
        const sortedHistory = [...history].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

        for (const message of sortedHistory) {
          const isSenderMe =
            Boolean(message.senderPseudoId) &&
            (message.senderPseudoId === user?.pseudoId ||
             message.senderPseudoId === (user as unknown as { userId?: string })?.userId);
          const mine = message.fromSelf === true ? (message.senderPseudoId ? isSenderMe : false) : isSenderMe;
          const fallbackPeer =
            convo.members.find((m) => m.pseudoId !== user?.pseudoId)?.pseudoId ?? '';

          let text: string | null = null;
          if (mine) {
            text =
              (await vaultGet<string>(`msg:${message.id}`).catch(() => null)) ||
              (message.clientRef ? await vaultGet<string>(`msg:${message.clientRef}`).catch(() => null) : null) ||
              (typeof window !== 'undefined'
                ? localStorage.getItem(`gc_out_${message.id}`) ||
                  (message.clientRef ? localStorage.getItem(`gc_out_${message.clientRef}`) : null) ||
                  localStorage.getItem(`gc_in_${message.id}`) ||
                  (message.clientRef ? localStorage.getItem(`gc_in_${message.clientRef}`) : null)
                : null);
          } else if (identity) {
            text = await decryptMessage(identity, message, convo.type, fallbackPeer, preKeysRef.current);
          }

          // If we decrypted/retrieved it, also persist under the server ID so future
          // lookups from the polling loop always find it without touching the ratchet
          if (text && message.id) {
            void vaultPut(`msg:${message.id}`, text).catch(() => null);
            if (typeof window !== 'undefined') {
              try { localStorage.setItem(`gc_in_${message.id}`, text); } catch {}
            }
          }

          const status = !mine
            ? undefined
            : message.receiptState === 'READ'
            ? 'read'
            : message.receiptState === 'DELIVERED'
            ? 'delivered'
            : 'sent';
          ui.push({
            ...message,
            text,
            mine,
            failed: !mine && text === null,
            status,
          });
        }

        dispatch(setMessages({ conversationId: id, messages: ui }));

        const lastMsg = ui[ui.length - 1];
        if (lastMsg) {
          const snippet = lastMsg.text
            ? lastMsg.text.startsWith('{"__ghost_media":') || lastMsg.text.startsWith('[file] ')
              ? '📷 Attachment'
              : lastMsg.text
            : lastMsg.failed
            ? '⚠️ Decryption failed'
            : 'Encrypted message';
          dispatch(
            updateConversationSnippet({
              conversationId: id,
              snippet,
              at: lastMsg.createdAt,
              fromSelf: lastMsg.mine,
            }),
          );
        }

        // Emit read receipt for all unread incoming messages when opening conversation
        const unreadIds = history
          .filter((m) => !m.fromSelf && m.senderPseudoId !== user?.pseudoId)
          .map((m) => m.id);
        if (unreadIds.length > 0) {
          getSocket().emit('message:read', {
            conversationId: id,
            messageIds: unreadIds,
          });
        }
      } catch {
        setBootError('Could not open that conversation.');
      }
    },
    [dispatch, user?.pseudoId],
  );

  /* ---------------------------------------------------------------------- */
  /* Automatic 2-3s Refresh & Notification Polling (WhatsApp Reliability)   */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!ready || !user) return;

    let isPolling = false;

    const autoRefresh = async () => {
      if (isPolling) return;
      // Guard: don't poll until vault/identity is fully loaded. On mobile,
      // the vault may not be ready on the first few ticks after page load.
      if (!identityRef.current) return;
      isPolling = true;

      try {
        const identity = identityRef.current;
        const activeId = activeIdRef.current;

        // 1. Poll conversations & unread badges
        const list = await api.conversations().catch(() => null);
        if (list && list.length > 0) {
          for (const c of list) {
            const prevCount = unreadRef.current[c.id] || 0;
            const newCount = c.unreadCount || 0;

            // Trigger notification if an inactive conversation got new messages
            if (c.id !== activeId && newCount > prevCount) {
              playMessageNotificationSound();

              const senderTitle = c.title || c.peer?.displayName || 'GhostChat';
              const notifSnippet = c.lastMessage?.snippet || 'New encrypted message';
              showBrowserNotification(senderTitle, {
                body: notifSnippet,
                tag: `convo-${c.id}`,
                onClick: () => {
                  void openConversation(c.id);
                },
              });
            }

            // Restore snippet from vault if cached
            if (c.lastMessage && !c.lastMessage.snippet) {
              const cached = (await vaultGet<string>(`msg:${c.lastMessage.id}`).catch(() => null)) ||
                (await vaultGet<string>(`msg:${c.lastMessage.at}`).catch(() => null));
              if (cached) {
                c.lastMessage.snippet =
                  cached.startsWith('{"__ghost_media":') || cached.startsWith('[file] ')
                    ? '📷 Attachment'
                    : cached;
              }
            }
          }

          dispatch(setConversations(list));
        }

        // 2. If actively viewing a conversation, poll for new messages in real-time
        if (activeId && identity) {
          const freshHistory = await api.messages(activeId).catch(() => null);
          if (freshHistory && freshHistory.length > 0) {
            const currentList = messagesRef.current[activeId] || [];
            const currentIds = new Set(currentList.map((m) => m.id));
            const currentRefs = new Set(currentList.map((m) => m.clientRef).filter(Boolean));

            const missing = freshHistory.filter(
              (m) => !currentIds.has(m.id) && !currentRefs.has(m.clientRef),
            );

            if (missing.length > 0) {
              missing.sort(
                (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
              );

              const currentConvo = conversationsRef.current.find((c) => c.id === activeId);
              const convoType = currentConvo?.type ?? 'DIRECT';
              const fallbackPeer = conversationPeer(activeId);

              for (const m of missing) {
                // Double-check the message wasn't added while we were iterating
                const latestList = messagesRef.current[activeId] || [];
                if (latestList.some((existing) => existing.id === m.id)) continue;

                const isSenderMe =
                  Boolean(m.senderPseudoId) &&
                  (m.senderPseudoId === user.pseudoId ||
                   m.senderPseudoId === (user as unknown as { userId?: string }).userId);
                const mine = m.fromSelf === true ? (m.senderPseudoId ? isSenderMe : false) : isSenderMe;

                let text: string | null = null;
                if (mine) {
                  text =
                    (await vaultGet<string>(`msg:${m.id}`).catch(() => null)) ||
                    (m.clientRef ? await vaultGet<string>(`msg:${m.clientRef}`).catch(() => null) : null) ||
                    (typeof window !== 'undefined'
                      ? localStorage.getItem(`gc_out_${m.id}`) ||
                        (m.clientRef ? localStorage.getItem(`gc_out_${m.clientRef}`) : null) ||
                        localStorage.getItem(`gc_in_${m.id}`) ||
                        (m.clientRef ? localStorage.getItem(`gc_in_${m.clientRef}`) : null)
                      : null);
                } else {
                  text = await decryptMessage(identity, m, convoType, fallbackPeer, preKeysRef.current);
                }

                const ui: UiMessage = {
                  ...m,
                  text,
                  mine,
                  failed: !mine && text === null,
                  status: mine
                    ? m.receiptState === 'READ'
                      ? 'read'
                      : m.receiptState === 'DELIVERED'
                      ? 'delivered'
                      : 'sent'
                    : undefined,
                };

                dispatch(appendMessage(ui));

                if (!mine) {
                  playMessageNotificationSound();
                  if (typeof document !== 'undefined' && document.hidden) {
                    const senderTitle = currentConvo?.title || currentConvo?.peer?.displayName || 'GhostChat';
                    showBrowserNotification(senderTitle, {
                      body: text ? (text.startsWith('{"__ghost_media":') || text.startsWith('[file] ') ? '📷 Sent a file' : text) : 'New message',
                      tag: `msg-${m.id}`,
                      onClick: () => {
                        window.focus();
                      },
                    });
                  }
                  // Mark as read immediately since user is on this conversation
                  getSocket().emit('message:read', {
                    conversationId: activeId,
                    messageIds: [m.id],
                  });
                }
              }
            }
          }
        }

        // 3. Keep WebSocket connected
        const socket = getSocket();
        if (socket && !socket.connected) {
          socket.connect();
        }
      } catch {
        // Non-fatal
      } finally {
        isPolling = false;
      }
    };

    const timer = setInterval(autoRefresh, 2500);

    // When the mobile browser tab becomes visible again after background
    // suspension, trigger an immediate refresh so messages appear instantly.
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void autoRefresh();
        void retryFailed();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // -----------------------------------------------------------------------
    // Retry loop for failed messages (runs every 7 seconds).
    // On mobile the vault / ratchet state might not be ready when the first
    // poll fires. Messages marked failed:true are retried here so they show
    // up as soon as the vault is loaded (usually within one or two retries).
    // -----------------------------------------------------------------------
    let isRetrying = false;
    const retryFailed = async () => {
      if (isRetrying || !identityRef.current) return;
      isRetrying = true;
      try {
        const identity = identityRef.current;
        const allMessages = messagesRef.current;
        for (const [convId, msgList] of Object.entries(allMessages)) {
          const unresolvedMsgs = msgList.filter((m) => !m.text || m.failed);
          if (unresolvedMsgs.length === 0) continue;
          const convo = conversationsRef.current.find((c) => c.id === convId);
          const convoType = convo?.type ?? 'DIRECT';
          const fallbackPeer = conversationPeer(convId);
          for (const m of unresolvedMsgs) {
            try {
              if (m.mine) {
                // Outgoing messages: resolve from vault or localStorage cache
                const text =
                  (await vaultGet<string>(`msg:${m.id}`).catch(() => null)) ||
                  (m.clientRef ? await vaultGet<string>(`msg:${m.clientRef}`).catch(() => null) : null) ||
                  (typeof window !== 'undefined'
                    ? localStorage.getItem(`gc_out_${m.id}`) ||
                      (m.clientRef ? localStorage.getItem(`gc_out_${m.clientRef}`) : null) ||
                      localStorage.getItem(`gc_in_${m.id}`) ||
                      (m.clientRef ? localStorage.getItem(`gc_in_${m.clientRef}`) : null)
                    : null);
                if (text) {
                  dispatch(patchMessage({
                    conversationId: convId,
                    clientRef: m.clientRef || m.id,
                    patch: { text, failed: false },
                  }));
                }
              } else {
                // Incoming messages: check vault first, then ratchet
                const cached =
                  (await vaultGet<string>(`msg:${m.id}`).catch(() => null)) ||
                  (m.clientRef ? await vaultGet<string>(`msg:${m.clientRef}`).catch(() => null) : null) ||
                  (typeof window !== 'undefined'
                    ? localStorage.getItem(`gc_in_${m.id}`) ||
                      (m.clientRef ? localStorage.getItem(`gc_in_${m.clientRef}`) : null)
                    : null);
                const text =
                  cached ||
                  (await decryptMessage(
                    identity,
                    m as Parameters<typeof decryptMessage>[1],
                    convoType,
                    fallbackPeer,
                    preKeysRef.current,
                  ));
                if (text) {
                  dispatch(patchMessage({
                    conversationId: convId,
                    clientRef: m.clientRef || m.id,
                    patch: { text, failed: false },
                  }));
                  if (m.id) {
                    void vaultPut(`msg:${m.id}`, text).catch(() => null);
                    if (typeof window !== 'undefined') {
                      try { localStorage.setItem(`gc_in_${m.id}`, text); } catch {}
                    }
                  }
                }
              }
            } catch {
              // Still not decryptable — leave as failed, retry on next cycle
            }
          }
        }
      } finally {
        isRetrying = false;
      }
    };
    const retryTimer = setInterval(retryFailed, 7000);

    return () => {
      clearInterval(timer);
      clearInterval(retryTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [ready, user, dispatch, openConversation]);

  const send = async (
    text: string,
    replyTo?: QuotedMessageDTO | null,
    explicitConvo?: ConversationDetail,
  ) => {
    const identity = identityRef.current;
    const conversation = explicitConvo || detail;
    if (!identity || !conversation || !user) return;

    const lower = text.trim().toLowerCase();

    // Special commands: /bomb, /fire, /love
    // Trigger animations with sound & reaction on both devices without sending the message
    if (lower === '/bomb') {
      setActiveEffect('bomb');
      if (conversation?.id) {
        getSocket().emit('chat:bomb', { conversationId: conversation.id });
      }
      return;
    }

    if (lower === '/fire') {
      setActiveEffect('fire');
      if (conversation?.id) {
        getSocket().emit('chat:fire', { conversationId: conversation.id });
      }
      return;
    }

    if (lower === '/love') {
      setActiveEffect('love');
      if (conversation?.id) {
        getSocket().emit('chat:love', { conversationId: conversation.id });
      }
      return;
    }

    const peer = conversation.members.find((m) => m.pseudoId !== user.pseudoId);
    const clientRef = crypto.randomUUID();

    const local: UiMessage = {
      id: clientRef,
      conversationId: conversation.id,
      senderPseudoId: user.pseudoId,
      senderDisplayName: user.displayName,
      kind: 'TEXT',
      envelope: { kind: 'PAIRWISE', sessionTag: '', header: '', ciphertext: '' },
      createdAt: new Date().toISOString(),
      expiresAt: null,
      clientRef,
      text,
      mine: true,
      pending: true,
      status: 'pending',
      replyTo: replyTo ?? null,
    };
    dispatch(appendMessage(local));
    void vaultPut(`msg:${clientRef}`, text).catch(() => null);
    if (typeof window !== 'undefined') {
      try { localStorage.setItem(`gc_out_${clientRef}`, text); } catch {}
      try { localStorage.setItem(`gc_in_${clientRef}`, text); } catch {}
    }

    try {
      if (conversation.type === 'GROUP') {
        // Group key bootstrap: every member derives their sender chain from the
        // shared invite secret. Refuse to send without it rather than silently
        // downgrading — a plaintext group would be worse than a failed send.
        const secret = await getGroupSecret(conversation.id);
        if (!secret) {
          throw new Error(
            'No group key on this device. Ask a member for the invite code and re-join the group.',
          );
        }
        const envelope = await encryptGroup(
          groupInviteSecret(secret.inviteCode, conversation.id),
          user.pseudoId,
          text,
        );
        getSocket().emit(
          'message:send',
          { conversationId: conversation.id, envelope, clientRef, replyTo: replyTo ?? undefined },
          (ack: { ok: boolean; message?: MessageDTO; delivered?: boolean; error?: string }) => {
            if (!ack.ok) {
              alert(`Send failed: ${ack.error}`);
              dispatch(
                patchMessage({
                  conversationId: conversation.id,
                  clientRef,
                  patch: { failed: true, pending: false },
                }),
              );
              return;
            }
            if (ack.message?.id) {
              void vaultPut(`msg:${ack.message.id}`, text).catch(() => null);
              if (typeof window !== 'undefined') {
                try { localStorage.setItem(`gc_out_${ack.message.id}`, text); } catch {}
                try { localStorage.setItem(`gc_in_${ack.message.id}`, text); } catch {}
              }
            }
            dispatch(
              patchMessage({
                conversationId: conversation.id,
                clientRef,
                patch: {
                  id: ack.message?.id ?? clientRef,
                  pending: false,
                  status: ack.delivered ? 'delivered' : 'sent',
                },
              }),
            );
          },
        );
        return;
      }

      if (!peer) throw new Error('no peer in this conversation');
      const contactCode = await contactCodeFor(peer.pseudoId);
      const envelope = await encryptDirect(
        identity,
        { pseudoId: peer.pseudoId, contactCode },
        text,
      );

      getSocket().emit(
        'message:send',
        { conversationId: conversation.id, envelope, clientRef, replyTo: replyTo ?? undefined },
        (ack: { ok: boolean; message?: MessageDTO; delivered?: boolean; error?: string }) => {
          if (!ack.ok) {
            alert(`Send failed: ${ack.error}`);
            dispatch(
              patchMessage({
                conversationId: conversation.id,
                clientRef,
                patch: { failed: true, pending: false },
              }),
            );
            return;
          }
          if (ack.message?.id) {
            void vaultPut(`msg:${ack.message.id}`, text).catch(() => null);
            if (typeof window !== 'undefined') {
              try { localStorage.setItem(`gc_out_${ack.message.id}`, text); } catch {}
              try { localStorage.setItem(`gc_in_${ack.message.id}`, text); } catch {}
            }
          }
          dispatch(
            patchMessage({
              conversationId: conversation.id,
              clientRef,
              patch: {
                id: ack.message?.id ?? clientRef,
                pending: false,
                status: ack.delivered ? 'delivered' : 'sent',
              },
            }),
          );
        },
      );
    } catch (error) {
      console.error('Send error:', error);
      alert(error instanceof Error ? error.message : 'send failed');
    }
  };

  const handleReact = (messageId: string, emoji: string) => {
    if (!activeId) return;
    getSocket().emit('message:react', {
      conversationId: activeId,
      messageId,
      emoji,
    });
  };

  const contactCodeFor = async (pseudoId: string): Promise<string> => {
    const known = conversations.find((c) => c.peer?.pseudoId === pseudoId)?.peer?.contactCode;
    if (known) return known;
    const convo = detail;
    const member = convo?.members.find((m) => m.pseudoId === pseudoId);
    if (member?.contactCode) return member.contactCode;
    // The API exposes contact codes only for peers we already share a chat with.
    const key = await api.bundle(member?.pseudoId || pseudoId).catch(() => null);
    if (key?.contactCode) return key.contactCode;
    return member?.numericId || pseudoId;
  };

  const attach = async (file: File) => {
    const identity = identityRef.current;
    if (!identity || !detail || !user) return;

    if (file.size > 25 * 1024 * 1024) {
      alert('File exceeds the 25 MB limit.');
      return;
    }

    setUploadingFile(file.name);
    try {
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const blob = await encryptBlob(plaintext);
      const fields = keyMaterialToDescriptorFields(blob);

      const presign = await api.presignUpload(blob.ciphertext.length, fields.contentHash);
      const put = await fetch(resolveApiUrl(presign.uploadUrl), {
        method: 'PUT',
        body: new Blob([blob.ciphertext as unknown as BlobPart], {
          type: 'application/octet-stream',
        }),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!put.ok) throw new Error('File upload was rejected by the server');

      const descriptor = encodeMediaDescriptor({
        v: 1,
        objectKey: presign.objectKey,
        mime: file.type || 'application/octet-stream',
        fileName: file.name,
        bytes: file.size,
        key: fields.key,
        header: fields.header,
        contentHash: fields.contentHash,
      });

      // The descriptor (including the single-use key) is what gets E2EE-encrypted.
      // Storage only sees ciphertext and cannot inspect or decrypt the file.
      await send(`[file] ${descriptor}`);
    } catch (error) {
      console.error('Attachment error:', error);
      alert(error instanceof Error ? error.message : 'File upload failed');
    } finally {
      setUploadingFile(null);
    }
  };

  const logout = async () => {
    await api.logout().catch(() => undefined);
    closeSocket();
    resetSessions();
    lockVault();
    dispatch(clearUser());
    dispatch(resetChat());
    router.replace('/onboarding');
  };

  const handleDeleteChat = useCallback(async (conversationId: string) => {
    if (!window.confirm('Delete this chat? All messages in this conversation will be permanently removed.')) {
      return;
    }
    try {
      await api.deleteConversation(conversationId);
      dispatch(removeConversation(conversationId));
      if (activeIdRef.current === conversationId) {
        dispatch(setActive(null));
        setDetail(null);
      }
      if (typeof window !== 'undefined') {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith(`gc_out_${conversationId}`) || k.startsWith(`gc_in_${conversationId}`))) {
            toRemove.push(k);
          }
        }
        toRemove.forEach((k) => localStorage.removeItem(k));
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete chat');
    }
  }, [dispatch]);

  const handleBlockUser = useCallback(async (targetPseudoId: string, displayName?: string) => {
    const name = displayName || targetPseudoId;
    if (!window.confirm(`Block ${name}? You will no longer receive messages or calls from them.`)) {
      return;
    }
    try {
      await api.blockUser(targetPseudoId);
      dispatch(addBlockedUser(targetPseudoId));
      if (typeof window !== 'undefined') {
        const current: string[] = JSON.parse(localStorage.getItem('gc_blocked_users') || '[]');
        if (!current.includes(targetPseudoId)) {
          current.push(targetPseudoId);
          localStorage.setItem('gc_blocked_users', JSON.stringify(current));
        }
      }
      const list = await api.conversations().catch(() => null);
      if (list) dispatch(setConversations(list));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to block user');
    }
  }, [dispatch]);

  const handleUnblockUser = useCallback(async (targetPseudoId: string, displayName?: string) => {
    try {
      await api.unblockUser(targetPseudoId);
      dispatch(removeBlockedUser(targetPseudoId));
      if (typeof window !== 'undefined') {
        const current: string[] = JSON.parse(localStorage.getItem('gc_blocked_users') || '[]')
          .filter((p: string) => p !== targetPseudoId);
        localStorage.setItem('gc_blocked_users', JSON.stringify(current));
      }
      const list = await api.conversations().catch(() => null);
      if (list) dispatch(setConversations(list));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unblock user');
    }
  }, [dispatch]);

  if (bootError) {
    return (
      <main className="flex h-screen items-center justify-center px-4">
        <div className="max-w-sm rounded-lg bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-red-700">{bootError}</p>
          <button
            onClick={() => router.replace('/onboarding')}
            className="mt-4 rounded bg-wa-green px-4 py-2 text-sm font-medium text-white"
          >
            Re-enter access key
          </button>
        </div>
      </main>
    );
  }

  if (!ready || !user) {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-wa-green border-t-transparent" />
      </main>
    );
  }

  if (showAdmin) {
    return <AdminDashboard onBack={() => setShowAdmin(false)} />;
  }

  const active = activeId ? detail : null;
  const activePeer =
    detail?.type === 'DIRECT'
      ? detail.members?.find((m) => m.pseudoId !== user?.pseudoId) ?? detail.members?.[0]
      : null;
  const isPeerBlocked = activePeer ? blockedUsers.includes(activePeer.pseudoId) : false;

  const handleForwardToConversation = async (targetConvoId: string, text: string) => {
    try {
      const convo = await api.conversation(targetConvoId);
      await openConversation(targetConvoId);
      await send(text, null, convo);
    } catch (err) {
      console.error('Failed to forward to conversation', err);
    }
  };

  const handleForwardToUser = async (targetUser: UserSearchResult, text: string) => {
    try {
      const { id } = await api.openDirect(targetUser.pseudoId);
      const list = await api.conversations();
      dispatch(setConversations(list));
      const convo = await api.conversation(id);
      await openConversation(id);
      await send(text, null, convo);
    } catch (err) {
      console.error('Failed to forward to user', err);
    }
  };

  const handleMemberRemoved = async () => {
    if (!activeId) return;
    const updated = await api.conversation(activeId);
    setDetail(updated);
  };

  const handleGroupLeft = async () => {
    dispatch(setActive(null));
    setDetail(null);
    const list = await api.conversations();
    dispatch(setConversations(list));
  };

  const handleGroupUpdated = async () => {
    if (!activeId) return;
    const [updated, list] = await Promise.all([
      api.conversation(activeId),
      api.conversations().catch(() => null),
    ]);
    setDetail(updated);
    if (list) dispatch(setConversations(list));
  };

  return (
    <main
      className={`flex h-[100dvh] max-h-[100dvh] overflow-hidden ${
        isHacker
          ? 'bg-[#020503] font-mono text-[#00FF66]'
          : isPro
          ? 'bg-[#080D1A] text-slate-100'
          : isMidnight
          ? 'bg-[#090A0F] text-[#F8FAFC]'
          : isNordic
          ? 'bg-[#F8FAFC] text-[#0F172A]'
          : 'bg-[#F0F2F5] text-[#111B21]'
      }`}
    >
      <div className={`${activeId ? 'hidden md:flex' : 'flex'} h-full max-h-[100dvh] w-full md:w-auto`}>
        <ChatList
          conversations={conversations}
          unread={unread}
          activeId={activeId}
          selfName={user.displayName}
          selfContactCode={user.contactCode}
          selfNumericId={user.numericId}
          selfAvatarUrl={user.avatarUrl}
          user={user}
          isAdmin={user.role === 'ADMIN'}
          blockedUsers={blockedUsers}
          onDeleteChat={handleDeleteChat}
          onBlockUser={handleBlockUser}
          onUnblockUser={handleUnblockUser}
          onProfileUpdated={(updated) => {
            dispatch(setUser(updated));
          }}
          onSelect={(id) => void openConversation(id)}
          onNewChat={(query) => {
            void (async () => {
              try {
                const { id } = await api.openDirect(query);
                const list = await api.conversations();
                dispatch(setConversations(list));
                await openConversation(id);
              } catch (err) {
                alert(err instanceof Error ? err.message : 'User not found');
              }
            })();
          }}
          onNewGroup={() => {
            const name = window.prompt('Group name');
            if (!name) return;
            void (async () => {
              try {
                const group = await api.createGroup({ name, memberContactCodes: [] });
                // The invite code IS the group key material in this build, so it
                // is generated once, stored locally, and shown for out-of-band
                // sharing. It is never sent to the server as a key.
                const invite = await api.createInvite(group.id, { expiresInHours: 24 * 7, maxUses: 32 });
                await storeGroupSecret(group.id, { inviteCode: invite.inviteCode, epoch: 0 });

                window.alert(
                  `Group created.\n\nShare this invite code out-of-band:\n\n${invite.inviteCode}\n\n` +
                    'Anyone with this code can read and write to the group. Do not post it publicly.',
                );

                void api.conversations().then((list) => dispatch(setConversations(list)));
                void openConversation(group.id);
              } catch (error) {
                alert(error instanceof Error ? error.message : 'could not create group');
              }
            })();
          }}
          onJoinGroup={(code) => {
            void (async () => {
              try {
                const group = await api.joinGroup(code.trim());
                await storeGroupSecret(group.id, { inviteCode: code.trim(), epoch: 0 });
                void api.conversations().then((list) => dispatch(setConversations(list)));
                void openConversation(group.id);
              } catch (error) {
                alert(error instanceof Error ? error.message : 'could not join group');
              }
            })();
          }}
          onOpenAdmin={() => setShowAdmin(true)}
          onLogout={() => void logout()}
        />
      </div>

      <div className={`${activeId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 h-full max-h-[100dvh] overflow-hidden ${activeEffect === 'bomb' ? 'animate-bomb-shake' : ''}`}>
        <ChatWindow
          conversation={active}
          messages={activeId ? (messages[activeId] ?? []) : []}
          typingLabel={
            activeId && typing[activeId] ? `${typing[activeId]!.displayName} is typing…` : null
          }
          sessionReady={Boolean(identityRef.current)}
          currentUserPseudoId={user.pseudoId}
          uploadingFile={uploadingFile}
          isPeerBlocked={isPeerBlocked}
          onSend={(text, replyTo) => void send(text, replyTo)}
          onAttach={(file) => void attach(file)}
          onReact={handleReact}
          onTyping={(typingNow) => {
            if (!activeId) return;
            getSocket().emit('typing', { conversationId: activeId, typing: typingNow });
          }}
          onStartCall={(kind, screenShare) => {
            if (!detail) return;
            void startCall(detail.id, kind, detail.title, screenShare);
          }}
          onBack={() => {
            dispatch(setActive(null));
            setDetail(null);
          }}
          onLogout={() => void logout()}
          onDeleteChat={() => detail && void handleDeleteChat(detail.id)}
          onBlockUser={() => activePeer && void handleBlockUser(activePeer.pseudoId, activePeer.displayName)}
          onUnblockUser={() => activePeer && void handleUnblockUser(activePeer.pseudoId, activePeer.displayName)}
          allUsers={allUsers}
          conversations={conversations}
          onForwardToConversation={(targetId, text) => void handleForwardToConversation(targetId, text)}
          onForwardToUser={(targetUser, text) => void handleForwardToUser(targetUser, text)}
          onMemberRemoved={() => void handleMemberRemoved()}
          onGroupLeft={() => void handleGroupLeft()}
          onGroupUpdated={() => void handleGroupUpdated()}
        />
      </div>

      {call && (
        <CallOverlay
          kind={call.kind}
          peerName={call.peerName}
          state={call.phase}
          localStream={localStream}
          remoteStream={remoteStream}
          muted={muted}
          isCameraOff={isCameraOff}
          isScreenSharing={isScreenSharing}
          error={call.error}
          onToggleMute={toggleMute}
          onToggleCamera={() => void toggleCamera()}
          onToggleScreenShare={() => void toggleScreenShare()}
          onHangup={hangupCall}
          onAccept={() => void acceptCall()}
        />
      )}

      {/* Interactive Chat Special Effects (/bomb, /fire, /love) */}
      <ChatEffects effect={activeEffect} onComplete={handleEffectComplete} />
    </main>
  );
}
