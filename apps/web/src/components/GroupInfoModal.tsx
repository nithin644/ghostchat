'use client';

import React, { useRef, useState } from 'react';
import type { ConversationDetail, UserSearchResult } from '@ghostchat/shared-types';
import { Avatar } from './Avatar';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';

interface GroupInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: ConversationDetail;
  currentUserPseudoId?: string;
  allUsers: UserSearchResult[];
  onMemberRemoved: (pseudoId: string) => void;
  onGroupLeft: () => void;
  onGroupUpdated?: () => void;
}

export function GroupInfoModal({
  isOpen,
  onClose,
  conversation,
  currentUserPseudoId,
  allUsers,
  onMemberRemoved,
  onGroupLeft,
  onGroupUpdated,
}: GroupInfoModalProps) {
  const { theme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro' || theme === 'midnight';

  const [isAddingMembers, setIsAddingMembers] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [submittingAdd, setSubmittingAdd] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Group Photo & Crop State
  const [avatarPreview, setAvatarPreview] = useState<string | null>(conversation.avatarUrl ?? null);
  const [cropZoom, setCropZoom] = useState(1);
  const [isEditingPhoto, setIsEditingPhoto] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const members = conversation.members || [];
  const currentMember = members.find((m) => m.pseudoId === currentUserPseudoId);
  const isAdmin = currentMember?.role === 'OWNER' || currentMember?.role === 'ADMIN';

  const existingMemberPseudoIds = new Set(members.map((m) => m.pseudoId));
  const candidateUsers = allUsers.filter(
    (u) => !existingMemberPseudoIds.has(u.pseudoId) && u.pseudoId !== currentUserPseudoId,
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file (PNG, JPG, WebP)');
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      showToast('Image must be smaller than 8MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        cropImageRef.current = img;
        setCropZoom(1);
        setIsEditingPhoto(true);

        const canvas = document.createElement('canvas');
        const maxSize = 256;
        const sourceSize = Math.min(img.width, img.height);
        const zoomedSize = sourceSize;
        const sourceX = Math.round((img.width - zoomedSize) / 2);
        const sourceY = Math.round((img.height - zoomedSize) / 2);

        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, sourceX, sourceY, zoomedSize, zoomedSize, 0, 0, maxSize, maxSize);
        setAvatarPreview(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleCropZoom = (zoom: number) => {
    setCropZoom(zoom);
    const img = cropImageRef.current;
    if (!img) return;

    const canvas = document.createElement('canvas');
    const maxSize = 256;
    const sourceSize = Math.min(img.width, img.height);
    const zoomedSize = sourceSize / zoom;
    const sourceX = Math.round((img.width - zoomedSize) / 2);
    const sourceY = Math.round((img.height - zoomedSize) / 2);

    canvas.width = maxSize;
    canvas.height = maxSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sourceX, sourceY, zoomedSize, zoomedSize, 0, 0, maxSize, maxSize);
    setAvatarPreview(canvas.toDataURL('image/jpeg', 0.85));
  };

  const handleSaveAvatar = async () => {
    setSavingPhoto(true);
    try {
      await api.updateGroup(conversation.id, { avatarUrl: avatarPreview });
      showToast('Group photo updated successfully!');
      setIsEditingPhoto(false);
      onGroupUpdated?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update group photo');
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (!window.confirm('Remove group profile picture?')) return;
    setSavingPhoto(true);
    try {
      await api.updateGroup(conversation.id, { avatarUrl: null });
      setAvatarPreview(null);
      cropImageRef.current = null;
      setIsEditingPhoto(false);
      showToast('Group photo removed');
      onGroupUpdated?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove group photo');
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleCopyInviteLink = async () => {
    try {
      const invite = await api.createInvite(conversation.id, { expiresInHours: 720, maxUses: 100 });
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(invite.inviteCode);
      } else {
        const el = document.createElement('textarea');
        el.value = invite.inviteCode;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      showToast('Invite code copied to clipboard!');
    } catch {
      showToast('Failed to generate invite');
    }
  };

  const handleSendInvites = async () => {
    if (selectedToAdd.length === 0) return;
    setSubmittingAdd(true);
    try {
      await api.sendGroupRequests(conversation.id, selectedToAdd);
      showToast(`Group request sent to ${selectedToAdd.length} user(s)!`);
      setSelectedToAdd([]);
      setIsAddingMembers(false);
      onGroupUpdated?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to send invites');
    } finally {
      setSubmittingAdd(false);
    }
  };

  const handleRemoveMember = async (pseudoId: string, name: string) => {
    if (!window.confirm(`Remove ${name} from this group?`)) return;
    try {
      await api.removeMember(conversation.id, pseudoId);
      onMemberRemoved(pseudoId);
      showToast(`${name} removed from group`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleLeaveGroup = async () => {
    if (!window.confirm('Are you sure you want to leave this group?')) return;
    try {
      await api.leaveGroup(conversation.id);
      onGroupLeft();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to leave group');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className={`w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden border ${
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
              : 'border-[#E9EDEF] bg-[#008069] text-white'
          }`}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-base font-bold leading-tight">Group info</h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10 text-sm font-bold"
          >
            ✕
          </button>
        </div>

        {toast && (
          <div className="bg-emerald-500/20 border-b border-emerald-500/30 px-5 py-2 text-xs text-emerald-400 font-semibold flex items-center gap-2">
            <span>✓</span> {toast}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {/* Group Overview Banner */}
          <div
            className={`flex flex-col items-center justify-center p-6 border-b text-center relative ${
              isHacker ? 'bg-black/30' : isPro ? 'bg-slate-900/50' : 'bg-gray-50'
            }`}
          >
            <div className="relative group">
              <Avatar name={conversation.title} src={avatarPreview ?? conversation.avatarUrl} size={92} />
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-0 right-0 rounded-full p-2 bg-[#008069] text-white shadow-lg hover:scale-110 active:scale-95 transition"
                  title="Upload & crop group profile picture from device"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Interactive Crop & Zoom Controls */}
            {isEditingPhoto && (
              <div
                className={`mt-4 w-full max-w-xs p-3.5 rounded-xl border text-left animate-in fade-in duration-150 ${
                  isHacker ? 'bg-black/70 border-[#00FF66]/40' : isPro ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-200 shadow-md'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-semibold mb-2">
                  <span>Crop & Zoom</span>
                  <span className="opacity-60">{cropZoom.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={cropZoom}
                  onChange={(e) => handleCropZoom(Number(e.target.value))}
                  className="w-full mb-3 accent-[#008069]"
                />
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingPhoto(false);
                      setAvatarPreview(conversation.avatarUrl ?? null);
                    }}
                    className="flex-1 rounded-lg py-1.5 text-xs font-semibold opacity-70 hover:opacity-100 hover:bg-black/10 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={savingPhoto}
                    onClick={handleSaveAvatar}
                    className="flex-1 rounded-lg py-1.5 text-xs font-bold text-white bg-[#008069] hover:bg-[#006A57] transition shadow disabled:opacity-50"
                  >
                    {savingPhoto ? 'Saving…' : 'Save Photo'}
                  </button>
                </div>
              </div>
            )}

            {isAdmin && !isEditingPhoto && (conversation.avatarUrl || avatarPreview) && (
              <button
                type="button"
                onClick={handleRemoveAvatar}
                className="mt-2 text-[11px] text-red-500 hover:underline"
              >
                Remove photo
              </button>
            )}

            <h3 className="mt-3 text-lg font-bold">{conversation.title}</h3>
            <p className="mt-1 text-xs opacity-70">
              Group • {members.length} {members.length === 1 ? 'member' : 'members'}
            </p>
          </div>

          {/* Quick Actions */}
          <div className="p-3 border-b border-black/5 divide-y divide-black/5">
            <button
              onClick={handleCopyInviteLink}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-xs font-semibold transition ${
                isHacker ? 'hover:bg-[#00FF66]/10' : isPro ? 'hover:bg-slate-800' : 'hover:bg-gray-100'
              }`}
            >
              <span className="text-base">🔗</span>
              <div className="min-w-0 flex-1">
                <p>Invite to group via link</p>
                <p className="text-[10px] opacity-60">Copy shareable group invite code</p>
              </div>
            </button>
          </div>

          {/* Members Section */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider opacity-60">
                {members.length} {members.length === 1 ? 'member' : 'members'}
              </span>
              {isAdmin && !isAddingMembers && (
                <button
                  onClick={() => setIsAddingMembers(true)}
                  className={`text-xs font-bold transition flex items-center gap-1 ${
                    isHacker ? 'text-[#00FF66] hover:underline' : isPro ? 'text-blue-400 hover:underline' : 'text-[#008069] hover:underline'
                  }`}
                >
                  <span>+</span> Add Members
                </button>
              )}
            </div>

            {/* Add Members Drawer */}
            {isAddingMembers && (
              <div
                className={`mb-4 p-3 rounded-xl border animate-in fade-in duration-100 ${
                  isHacker ? 'bg-black/50 border-[#00FF66]/30' : isPro ? 'bg-slate-800/80 border-slate-700' : 'bg-[#F0F2F5] border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold">Select users to invite</span>
                  <button
                    onClick={() => {
                      setIsAddingMembers(false);
                      setSelectedToAdd([]);
                    }}
                    className="text-xs opacity-60 hover:opacity-100"
                  >
                    Cancel
                  </button>
                </div>

                {candidateUsers.length === 0 ? (
                  <p className="py-2 text-xs opacity-60 text-center">No other users available to add</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto divide-y divide-black/5 mb-3">
                    {candidateUsers.map((u) => {
                      const isChecked = selectedToAdd.includes(u.pseudoId);
                      return (
                        <button
                          key={u.pseudoId}
                          onClick={() =>
                            setSelectedToAdd((prev) =>
                              isChecked ? prev.filter((id) => id !== u.pseudoId) : [...prev, u.pseudoId],
                            )
                          }
                          className="w-full flex items-center justify-between py-2 text-left text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <Avatar name={u.displayName} src={u.avatarUrl} size={28} />
                            <div>
                              <p className="font-semibold">{u.displayName}</p>
                              {u.numericId && <span className="opacity-60 text-[10px]">ID: {u.numericId}</span>}
                            </div>
                          </div>
                          <span
                            className={`h-4 w-4 rounded border flex items-center justify-center text-[10px] font-bold ${
                              isChecked
                                ? isHacker
                                  ? 'bg-[#00FF66] text-black border-[#00FF66]'
                                  : isPro
                                  ? 'bg-blue-600 text-white border-blue-600'
                                  : 'bg-[#008069] text-white border-[#008069]'
                                : 'border-gray-400'
                            }`}
                          >
                            {isChecked && '✓'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button
                  disabled={selectedToAdd.length === 0 || submittingAdd}
                  onClick={handleSendInvites}
                  className={`w-full rounded-lg py-2 text-xs font-bold text-white transition ${
                    selectedToAdd.length > 0 && !submittingAdd
                      ? isHacker
                        ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                        : isPro
                        ? 'bg-blue-600 hover:bg-blue-500'
                        : 'bg-[#008069] hover:bg-[#006A57]'
                      : 'bg-gray-400 opacity-50 cursor-not-allowed'
                  }`}
                >
                  {submittingAdd ? 'Sending Requests…' : `Send Group Request (${selectedToAdd.length})`}
                </button>
              </div>
            )}

            {/* Member List */}
            <div className="divide-y divide-black/5">
              {members.map((m) => {
                const isMe = m.pseudoId === currentUserPseudoId;
                const isMemberAdmin = m.role === 'OWNER' || m.role === 'ADMIN';
                return (
                  <div key={m.userId} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={m.displayName} src={m.avatarUrl} size={38} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-xs font-semibold">
                            {m.displayName} {isMe && '(You)'}
                          </p>
                          {m.numericId && (
                            <span className="rounded bg-black/10 px-1.5 py-0.2 text-[10px] font-mono">
                              ID: {m.numericId}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] opacity-60">
                          Joined {new Date(m.joinedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isMemberAdmin && (
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                            isHacker
                              ? 'bg-[#00FF66]/20 text-[#00FF66]'
                              : isPro
                              ? 'bg-blue-500/20 text-blue-300'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          Group Admin
                        </span>
                      )}
                      {isAdmin && !isMe && (
                        <button
                          onClick={() => handleRemoveMember(m.pseudoId, m.displayName)}
                          className="rounded p-1 text-xs opacity-60 hover:opacity-100 hover:text-red-500"
                          title="Remove from group"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Leave Group Action */}
          <div className="p-4 border-t border-black/5">
            <button
              onClick={handleLeaveGroup}
              className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-bold text-red-500 hover:bg-red-500/10 transition"
            >
              <span>🚪</span>
              <span>Exit group</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
