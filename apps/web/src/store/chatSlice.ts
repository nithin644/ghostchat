import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ConversationSummary, MessageDTO } from '@ghostchat/shared-types';

/** A message plus its locally-decrypted text. Ciphertext never leaves this shape. */
export interface UiMessage extends MessageDTO {
  text: string | null;
  mine: boolean;
  failed?: boolean;
  pending?: boolean;
  status?: 'pending' | 'sent' | 'delivered' | 'read';
}

export interface ChatState {
  conversations: ConversationSummary[];
  messages: Record<string, UiMessage[]>;
  activeId: string | null;
  typing: Record<string, { userId: string; displayName: string; at: number } | null>;
  unread: Record<string, number>;
  loading: boolean;
  blockedUsers: string[];
}

const initialState: ChatState = {
  conversations: [],
  messages: {},
  activeId: null,
  typing: {},
  unread: {},
  loading: false,
  blockedUsers: [],
};

const slice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setConversations(state, action: PayloadAction<ConversationSummary[]>) {
      state.conversations = action.payload;
      for (const c of action.payload) {
        if (state.activeId !== c.id) {
          state.unread[c.id] = c.unreadCount ?? state.unread[c.id] ?? 0;
        } else {
          state.unread[c.id] = 0;
        }
      }
      state.loading = false;
    },
    upsertConversation(state, action: PayloadAction<ConversationSummary>) {
      const index = state.conversations.findIndex((c) => c.id === action.payload.id);
      if (index >= 0) state.conversations[index] = action.payload;
      else state.conversations.unshift(action.payload);
    },
    setActive(state, action: PayloadAction<string | null>) {
      state.activeId = action.payload;
      if (action.payload) {
        state.unread[action.payload] = 0;
        const convo = state.conversations.find((c) => c.id === action.payload);
        if (convo) convo.unreadCount = 0;
      }
    },
    setMessages(state, action: PayloadAction<{ conversationId: string; messages: UiMessage[] }>) {
      state.messages[action.payload.conversationId] = action.payload.messages;
    },
    appendMessage(state, action: PayloadAction<UiMessage>) {
      const msg = action.payload;
      const list = state.messages[msg.conversationId] ?? [];
      const existingIdx = list.findIndex(
        (m) => m.id === msg.id || (m.clientRef && m.clientRef === msg.clientRef),
      );
      if (existingIdx >= 0) {
        list[existingIdx] = { ...list[existingIdx], ...msg };
      } else {
        list.push(msg);
      }
      state.messages[msg.conversationId] = list;

      // Update snippet and lastActivityAt in conversation list
      const convoIndex = state.conversations.findIndex((c) => c.id === msg.conversationId);
      if (convoIndex >= 0) {
        const convo = state.conversations[convoIndex];
        const snippet = msg.text
          ? msg.text.startsWith('{"__ghost_media":') || msg.text.startsWith('[file] ')
            ? '📷 Attachment'
            : msg.text
          : msg.failed
          ? '⚠️ Decryption failed'
          : 'Encrypted message';

        convo.lastMessage = {
          id: msg.id,
          kind: msg.kind,
          previewCiphertext: null,
          at: msg.createdAt,
          fromSelf: msg.mine,
          snippet,
        };
        convo.lastActivityAt = msg.createdAt;

        // Move the active conversation to the top
        if (convoIndex > 0) {
          state.conversations.splice(convoIndex, 1);
          state.conversations.unshift(convo);
        }
      }
    },
    updateConversationSnippet(
      state,
      action: PayloadAction<{ conversationId: string; snippet: string; at?: string; fromSelf?: boolean }>,
    ) {
      const convo = state.conversations.find((c) => c.id === action.payload.conversationId);
      if (convo) {
        if (!convo.lastMessage) {
          convo.lastMessage = {
            id: '',
            kind: 'TEXT',
            previewCiphertext: null,
            at: action.payload.at || new Date().toISOString(),
            fromSelf: action.payload.fromSelf ?? null,
            snippet: action.payload.snippet,
          };
        } else {
          convo.lastMessage.snippet = action.payload.snippet;
          if (action.payload.at) convo.lastMessage.at = action.payload.at;
          if (action.payload.fromSelf !== undefined) convo.lastMessage.fromSelf = action.payload.fromSelf;
        }
      }
    },
    patchMessage(
      state,
      action: PayloadAction<{ conversationId: string; clientRef: string; patch: Partial<UiMessage> }>,
    ) {
      const list = state.messages[action.payload.conversationId];
      if (!list) return;
      const target = list.find((m) => m.clientRef === action.payload.clientRef);
      if (target) Object.assign(target, action.payload.patch);
    },
    markRead(state, action: PayloadAction<{ conversationId: string; messageIds: string[] }>) {
      const list = state.messages[action.payload.conversationId];
      if (!list) return;
      for (const m of list) {
        if (action.payload.messageIds.includes(m.id)) {
          m.pending = false;
          if (m.mine) m.status = 'read';
        }
      }
    },
    updateReceipt(
      state,
      action: PayloadAction<{ conversationId: string; messageId: string; state: 'DELIVERED' | 'READ' }>,
    ) {
      const list = state.messages[action.payload.conversationId];
      if (!list) return;
      const target = list.find(
        (m) => m.id === action.payload.messageId || m.clientRef === action.payload.messageId,
      );
      if (target && target.mine) {
        if (action.payload.state === 'READ') {
          target.status = 'read';
          target.pending = false;
        } else if (action.payload.state === 'DELIVERED' && target.status !== 'read') {
          target.status = 'delivered';
          target.pending = false;
        }
      }
    },
    setTyping(
      state,
      action: PayloadAction<{ conversationId: string; typing: ChatState['typing'][string] }>,
    ) {
      state.typing[action.payload.conversationId] = action.payload.typing;
    },
    bumpUnread(state, action: PayloadAction<string>) {
      if (state.activeId === action.payload) return;
      state.unread[action.payload] = (state.unread[action.payload] ?? 0) + 1;
      const convo = state.conversations.find((c) => c.id === action.payload);
      if (convo) {
        convo.unreadCount = state.unread[action.payload];
      }
    },
    updateReaction(
      state,
      action: PayloadAction<{
        conversationId: string;
        messageId: string;
        emoji: string;
        userPseudoId: string;
        action: 'add' | 'remove';
        currentPseudoId?: string;
      }>,
    ) {
      const list = state.messages[action.payload.conversationId];
      if (!list) return;
      const target = list.find((m) => m.id === action.payload.messageId || m.clientRef === action.payload.messageId);
      if (!target) return;
      if (!target.reactions) target.reactions = [];

      const { emoji, userPseudoId, action: act, currentPseudoId } = action.payload;
      const isMe = currentPseudoId ? userPseudoId === currentPseudoId : false;

      const existingIndex = target.reactions.findIndex((r) => r.emoji === emoji);
      if (act === 'add') {
        if (existingIndex >= 0) {
          const r = target.reactions[existingIndex];
          if (!r.users.some((u) => u.pseudoId === userPseudoId)) {
            r.users.push({ pseudoId: userPseudoId, displayName: userPseudoId });
            r.count = r.users.length;
          }
          if (isMe) r.byMe = true;
        } else {
          target.reactions.push({
            emoji,
            count: 1,
            byMe: isMe,
            users: [{ pseudoId: userPseudoId, displayName: userPseudoId }],
          });
        }
      } else {
        if (existingIndex >= 0) {
          const r = target.reactions[existingIndex];
          r.users = r.users.filter((u) => u.pseudoId !== userPseudoId);
          r.count = r.users.length;
          if (isMe) r.byMe = false;
          if (r.count <= 0) {
            target.reactions.splice(existingIndex, 1);
          }
        }
      }
    },
    removeConversation(state, action: PayloadAction<string>) {
      const convoId = action.payload;
      state.conversations = state.conversations.filter((c) => c.id !== convoId);
      if (state.activeId === convoId) {
        state.activeId = null;
      }
      delete state.messages[convoId];
      delete state.unread[convoId];
      delete state.typing[convoId];
    },
    setBlockedUsers(state, action: PayloadAction<string[]>) {
      state.blockedUsers = action.payload;
    },
    addBlockedUser(state, action: PayloadAction<string>) {
      if (!state.blockedUsers.includes(action.payload)) {
        state.blockedUsers.push(action.payload);
      }
    },
    removeBlockedUser(state, action: PayloadAction<string>) {
      state.blockedUsers = state.blockedUsers.filter((p) => p !== action.payload);
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    resetChat() {
      return initialState;
    },
  },
});

export const {
  setConversations,
  upsertConversation,
  setActive,
  setMessages,
  appendMessage,
  patchMessage,
  markRead,
  updateReceipt,
  setTyping,
  bumpUnread,
  updateConversationSnippet,
  updateReaction,
  removeConversation,
  setBlockedUsers,
  addBlockedUser,
  removeBlockedUser,
  setLoading,
  resetChat,
} = slice.actions;
export default slice.reducer;
