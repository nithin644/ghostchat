'use client';

import React, { useState } from 'react';
import type { ConversationSummary, UserSearchResult } from '@ghostchat/shared-types';
import { Avatar } from './Avatar';
import { useTheme } from '../lib/theme';

interface ForwardModalProps {
  isOpen: boolean;
  onClose: () => void;
  messageText: string;
  senderName: string;
  conversations: ConversationSummary[];
  users: UserSearchResult[];
  currentUserId?: string;
  onForwardToConversation: (conversationId: string) => void;
  onForwardToUser: (targetUser: UserSearchResult) => void;
}

export function ForwardModal({
  isOpen,
  onClose,
  messageText,
  senderName,
  conversations,
  users,
  currentUserId,
  onForwardToConversation,
  onForwardToUser,
}: ForwardModalProps) {
  const { theme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro' || theme === 'midnight';

  const [search, setSearch] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<{
    type: 'convo' | 'user';
    id: string;
    target?: UserSearchResult;
    name: string;
  } | null>(null);

  if (!isOpen) return null;

  const q = search.trim().toLowerCase();

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(q) ||
    (c.peer?.numericId && c.peer.numericId.includes(q)),
  );

  const existingConvoUserIds = new Set(
    conversations
      .filter((c) => c.type === 'DIRECT' && c.peer?.pseudoId)
      .map((c) => c.peer!.pseudoId),
  );

  const otherUsers = users.filter((u) => {
    if (currentUserId && u.pseudoId === currentUserId) return false;
    if (existingConvoUserIds.has(u.pseudoId)) return false;
    if (!q) return true;
    return (
      u.displayName.toLowerCase().includes(q) ||
      (u.numericId && u.numericId.includes(q))
    );
  });

  const handleConfirmForward = () => {
    if (!selectedTarget) return;
    if (selectedTarget.type === 'convo') {
      onForwardToConversation(selectedTarget.id);
    } else if (selectedTarget.target) {
      onForwardToUser(selectedTarget.target);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden border ${
          isHacker
            ? 'bg-[#07150A] border-[#00FF66]/40 text-[#00FF66]'
            : isPro
            ? 'bg-[#0F172A] border-slate-700 text-slate-100'
            : 'bg-white border-gray-200 text-[#111B21]'
        }`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-5 py-4 border-b ${
            isHacker
              ? 'border-[#00FF66]/20 bg-[#050D07]'
              : isPro
              ? 'border-slate-800 bg-[#1E293B]'
              : 'border-[#E9EDEF] bg-[#F0F2F5]'
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">↪</span>
            <div>
              <h2 className="text-base font-bold leading-tight">Forward message to…</h2>
              <p className="text-[11px] opacity-70">Select a chat or contact</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/10 text-sm font-bold"
          >
            ✕
          </button>
        </div>

        {/* Message Preview snippet */}
        <div
          className={`px-5 py-2.5 border-b text-xs flex items-center gap-2 ${
            isHacker
              ? 'bg-[#00FF66]/5 border-[#00FF66]/20 text-[#00FF66]/80'
              : isPro
              ? 'bg-blue-500/10 border-slate-800 text-blue-300'
              : 'bg-emerald-50 border-[#E9EDEF] text-emerald-800'
          }`}
        >
          <span className="font-semibold shrink-0">Forwarding:</span>
          <span className="truncate italic">
            "{messageText.slice(0, 80)}{messageText.length > 80 ? '…' : ''}"
          </span>
        </div>

        {/* Search Bar */}
        <div className="p-3 border-b border-black/5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or 3-digit User ID..."
            className={`w-full rounded-xl px-3.5 py-2 text-xs outline-none transition ${
              isHacker
                ? 'bg-black/60 border border-[#00FF66]/40 text-[#00FF66] placeholder-[#00FF66]/40'
                : isPro
                ? 'bg-[#1E293B] border border-slate-700 text-white placeholder-slate-400'
                : 'bg-[#F0F2F5] text-black ring-1 ring-black/5'
            }`}
          />
        </div>

        {/* Recipient List */}
        <div className="flex-1 overflow-y-auto divide-y divide-black/5">
          {filteredConversations.length > 0 && (
            <div>
              <div className="px-4 py-1.5 text-[10px] font-bold tracking-wider uppercase opacity-60">
                Recent Chats
              </div>
              {filteredConversations.map((c) => {
                const isSelected = selectedTarget?.type === 'convo' && selectedTarget.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setSelectedTarget({
                        type: 'convo',
                        id: c.id,
                        name: c.title,
                      })
                    }
                    className={`w-full flex items-center justify-between px-4 py-3 text-left transition ${
                      isSelected
                        ? isHacker
                          ? 'bg-[#00FF66]/20'
                          : isPro
                          ? 'bg-blue-600/30'
                          : 'bg-emerald-100/70'
                        : isHacker
                        ? 'hover:bg-[#00FF66]/10'
                        : isPro
                        ? 'hover:bg-slate-800/60'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={c.title} src={c.avatarUrl} size={38} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold">{c.title}</p>
                          {c.type === 'GROUP' && (
                            <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-bold uppercase opacity-70">
                              Group
                            </span>
                          )}
                          {c.peer?.numericId && (
                            <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                              ID: {c.peer.numericId}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] opacity-60 truncate">
                          {c.type === 'GROUP' ? 'Group conversation' : 'Direct chat'}
                        </p>
                      </div>
                    </div>
                    <div
                      className={`h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                        isSelected
                          ? isHacker
                            ? 'border-[#00FF66] bg-[#00FF66] text-black font-bold text-xs'
                            : isPro
                            ? 'border-blue-500 bg-blue-500 text-white font-bold text-xs'
                            : 'border-[#128C7E] bg-[#128C7E] text-white font-bold text-xs'
                          : 'border-gray-400'
                      }`}
                    >
                      {isSelected && '✓'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {otherUsers.length > 0 && (
            <div>
              <div className="px-4 py-1.5 text-[10px] font-bold tracking-wider uppercase opacity-60">
                Other Contacts
              </div>
              {otherUsers.map((u) => {
                const isSelected = selectedTarget?.type === 'user' && selectedTarget.id === u.pseudoId;
                return (
                  <button
                    key={u.pseudoId}
                    onClick={() =>
                      setSelectedTarget({
                        type: 'user',
                        id: u.pseudoId,
                        target: u,
                        name: u.displayName,
                      })
                    }
                    className={`w-full flex items-center justify-between px-4 py-3 text-left transition ${
                      isSelected
                        ? isHacker
                          ? 'bg-[#00FF66]/20'
                          : isPro
                          ? 'bg-blue-600/30'
                          : 'bg-emerald-100/70'
                        : isHacker
                        ? 'hover:bg-[#00FF66]/10'
                        : isPro
                        ? 'hover:bg-slate-800/60'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={u.displayName} src={u.avatarUrl} size={38} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold">{u.displayName}</p>
                          {u.numericId && (
                            <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                              ID: {u.numericId}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] opacity-60">Start new chat</p>
                      </div>
                    </div>
                    <div
                      className={`h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                        isSelected
                          ? isHacker
                            ? 'border-[#00FF66] bg-[#00FF66] text-black font-bold text-xs'
                            : isPro
                            ? 'border-blue-500 bg-blue-500 text-white font-bold text-xs'
                            : 'border-[#128C7E] bg-[#128C7E] text-white font-bold text-xs'
                          : 'border-gray-400'
                      }`}
                    >
                      {isSelected && '✓'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {filteredConversations.length === 0 && otherUsers.length === 0 && (
            <div className="py-12 text-center text-xs opacity-60">
              No contacts or chats match "{search}"
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className={`px-5 py-3 border-t flex items-center justify-between ${
            isHacker
              ? 'border-[#00FF66]/20 bg-[#050D07]'
              : isPro
              ? 'border-slate-800 bg-[#1E293B]'
              : 'border-[#E9EDEF] bg-[#F0F2F5]'
          }`}
        >
          <div className="text-xs truncate">
            {selectedTarget ? (
              <span>
                Forward to: <strong className="font-bold">{selectedTarget.name}</strong>
              </span>
            ) : (
              <span className="opacity-60">Select recipient above</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-black/10 transition"
            >
              Cancel
            </button>
            <button
              disabled={!selectedTarget}
              onClick={handleConfirmForward}
              className={`rounded-lg px-4 py-2 text-xs font-bold text-white transition shadow ${
                selectedTarget
                  ? isHacker
                    ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                    : isPro
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : 'bg-[#128C7E] hover:bg-[#075E54]'
                  : 'bg-gray-400 opacity-50 cursor-not-allowed'
              }`}
            >
              Send ↪
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
