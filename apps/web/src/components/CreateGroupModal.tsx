'use client';

import React, { useRef, useState } from 'react';
import type { ConversationDetail, UserSearchResult } from '@ghostchat/shared-types';
import { Avatar } from './Avatar';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import { storeGroupSecret } from '../lib/groupKeys';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: UserSearchResult[];
  currentUserId?: string;
  onGroupCreated: (group: ConversationDetail) => void;
}

export function CreateGroupModal({
  isOpen,
  onClose,
  users,
  currentUserId,
  onGroupCreated,
}: CreateGroupModalProps) {
  const { theme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro' || theme === 'midnight';

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedUserPseudos, setSelectedUserPseudos] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupEmoji, setGroupEmoji] = useState('👥');
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group Photo & Crop State
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [isEditingPhoto, setIsEditingPhoto] = useState(false);
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (PNG, JPG, WebP)');
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setError('Image must be smaller than 8MB');
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
        setError(null);
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

  if (!isOpen) return null;

  // Filter out self
  const selectableUsers = users.filter((u) => {
    if (currentUserId && u.pseudoId === currentUserId) return false;
    return true;
  });

  const q = search.trim().toLowerCase();
  const filteredUsers = selectableUsers.filter((u) => {
    if (!q) return true;
    return (
      u.displayName.toLowerCase().includes(q) ||
      (u.numericId && u.numericId.includes(q))
    );
  });

  const selectedUsers = selectableUsers.filter((u) => selectedUserPseudos.includes(u.pseudoId));

  const toggleUser = (pseudoId: string) => {
    setSelectedUserPseudos((prev) =>
      prev.includes(pseudoId) ? prev.filter((p) => p !== pseudoId) : [...prev, pseudoId],
    );
  };

  const handleCreateGroup = async () => {
    const trimmed = groupName.trim();
    if (!trimmed) {
      setError('Please provide a group name');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.createGroupWithMembers({
        name: trimmed,
        avatarUrl: avatarPreview || undefined,
        memberPseudoIds: selectedUserPseudos,
      });

      // Save group key material locally
      await storeGroupSecret(res.group.id, {
        inviteCode: res.inviteCode,
        epoch: 0,
      });

      onGroupCreated(res.group);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setSubmitting(false);
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
        {/* WhatsApp-Style Header */}
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
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10 text-base"
              >
                ←
              </button>
            )}
            <div>
              <h2 className="text-base font-bold leading-tight">
                {step === 1 ? 'Add group members' : 'New group'}
              </h2>
              <p className={`text-[11px] ${step === 2 && !isHacker && !isPro ? 'text-white/80' : 'opacity-70'}`}>
                {step === 1
                  ? selectedUserPseudos.length === 0
                    ? 'Select contacts to invite'
                    : `${selectedUserPseudos.length} of ${selectableUsers.length} selected`
                  : `${selectedUserPseudos.length} members selected`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10 text-sm font-bold"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border-b border-red-500/30 px-5 py-2 text-xs text-red-500 font-medium">
            ⚠️ {error}
          </div>
        )}

        {/* STEP 1: SELECT CONTACTS */}
        {step === 1 && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Selected Contacts Horizontal Pill Bar */}
            {selectedUsers.length > 0 && (
              <div
                className={`p-3 border-b flex items-center gap-2 overflow-x-auto ${
                  isHacker ? 'border-[#00FF66]/20 bg-black/40' : isPro ? 'border-slate-800 bg-[#1E293B]/40' : 'border-gray-100 bg-[#F0F2F5]/50'
                }`}
              >
                {selectedUsers.map((u) => (
                  <div
                    key={u.pseudoId}
                    className={`flex items-center gap-1.5 rounded-full pl-1 pr-2 py-0.5 text-xs font-semibold shrink-0 shadow-sm border ${
                      isHacker
                        ? 'bg-[#00FF66]/20 border-[#00FF66]/40 text-[#00FF66]'
                        : isPro
                        ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                        : 'bg-[#E9EDEF] border-gray-300 text-gray-800'
                    }`}
                  >
                    <Avatar name={u.displayName} src={u.avatarUrl} size={22} />
                    <span className="truncate max-w-[80px]">{u.displayName}</span>
                    <button
                      onClick={() => toggleUser(u.pseudoId)}
                      className="ml-0.5 text-[10px] opacity-60 hover:opacity-100 font-bold"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Search Input */}
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

            {/* Contact List */}
            <div className="flex-1 overflow-y-auto divide-y divide-black/5">
              {filteredUsers.length === 0 ? (
                <div className="py-12 text-center text-xs opacity-60">
                  {selectableUsers.length === 0 ? 'No contacts available to add' : `No contacts match "${search}"`}
                </div>
              ) : (
                filteredUsers.map((u) => {
                  const isChecked = selectedUserPseudos.includes(u.pseudoId);
                  return (
                    <button
                      key={u.pseudoId}
                      onClick={() => toggleUser(u.pseudoId)}
                      className={`w-full flex items-center justify-between px-4 py-3 text-left transition ${
                        isChecked
                          ? isHacker
                            ? 'bg-[#00FF66]/15'
                            : isPro
                            ? 'bg-blue-600/20'
                            : 'bg-emerald-50'
                          : isHacker
                          ? 'hover:bg-[#00FF66]/10'
                          : isPro
                          ? 'hover:bg-slate-800/60'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={u.displayName} src={u.avatarUrl} size={40} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold">{u.displayName}</p>
                            {u.numericId && (
                              <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                                ID: {u.numericId}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] opacity-60">
                            GhostChat contact
                          </p>
                        </div>
                      </div>

                      {/* Checkbox */}
                      <div
                        className={`h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 transition ${
                          isChecked
                            ? isHacker
                              ? 'border-[#00FF66] bg-[#00FF66] text-black font-bold text-xs'
                              : isPro
                              ? 'border-blue-500 bg-blue-500 text-white font-bold text-xs'
                              : 'border-[#008069] bg-[#008069] text-white font-bold text-xs'
                            : 'border-gray-400'
                        }`}
                      >
                        {isChecked && '✓'}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Next Step Floating Action */}
            <div
              className={`p-4 border-t flex items-center justify-between ${
                isHacker ? 'border-[#00FF66]/20 bg-[#050D07]' : isPro ? 'border-slate-800 bg-[#1E293B]' : 'border-[#E9EDEF] bg-[#F0F2F5]'
              }`}
            >
              <div className="text-xs opacity-70">
                {selectedUserPseudos.length === 0 ? 'Select contacts to invite' : `${selectedUserPseudos.length} contact(s) selected`}
              </div>
              <button
                onClick={() => setStep(2)}
                className={`flex items-center gap-2 rounded-full px-5 py-2.5 text-xs font-bold text-white transition shadow-lg ${
                  isHacker
                    ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                    : isPro
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : 'bg-[#008069] hover:bg-[#006A57]'
                }`}
              >
                <span>Next</span>
                <span className="text-base">→</span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: GROUP NAME & CONFIRM */}
        {step === 2 && (
          <div className="flex-1 flex flex-col p-5 overflow-y-auto">
            {/* Group Icon & Subject Input */}
            <div className="flex items-center gap-4 py-4">
              <div className="relative group shrink-0">
                {avatarPreview ? (
                  <div className="relative">
                    <img
                      src={avatarPreview}
                      alt="Group Avatar"
                      className="h-16 w-16 rounded-full object-cover border-2 border-[#008069] shadow-md"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute -bottom-1 -right-1 rounded-full p-1.5 bg-[#008069] text-white shadow hover:scale-110 active:scale-95 transition"
                      title="Change device picture"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        const emojis = ['👥', '🔒', '💼', '🚀', '⚡', '🎮', '💡', '🛡️', '💬', '🏆'];
                        const next = emojis[(emojis.indexOf(groupEmoji) + 1) % emojis.length];
                        setGroupEmoji(next);
                      }}
                      className={`h-16 w-16 rounded-full flex items-center justify-center text-3xl shadow-inner border transition shrink-0 ${
                        isHacker
                          ? 'bg-black/60 border-[#00FF66]/40 hover:border-[#00FF66]'
                          : isPro
                          ? 'bg-[#1E293B] border-slate-700 hover:border-blue-500'
                          : 'bg-[#E9EDEF] border-gray-300 hover:border-[#008069]'
                      }`}
                      title="Click to change emoji"
                    >
                      {groupEmoji}
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute -bottom-1 -right-1 rounded-full p-1.5 bg-[#008069] text-white shadow hover:scale-110 active:scale-95 transition"
                      title="Upload & crop photo from device"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />

              <div className="flex-1">
                <input
                  type="text"
                  autoFocus
                  maxLength={64}
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Type group subject here…"
                  className={`w-full border-b-2 py-2 text-sm font-semibold outline-none transition ${
                    isHacker
                      ? 'border-[#00FF66]/40 bg-transparent text-[#00FF66] focus:border-[#00FF66]'
                      : isPro
                      ? 'border-slate-700 bg-transparent text-white focus:border-blue-500'
                      : 'border-[#008069] bg-transparent text-black focus:border-[#006A57]'
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateGroup();
                  }}
                />
                <div className="flex justify-between items-center mt-1 text-[10px] opacity-60">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-[#008069] hover:underline font-semibold"
                  >
                    {avatarPreview ? 'Change photo' : 'Upload device photo'}
                  </button>
                  <span>{groupName.length}/64</span>
                </div>
              </div>
            </div>

            {/* Interactive Crop & Zoom Slider if device photo is selected */}
            {isEditingPhoto && avatarPreview && (
              <div
                className={`mb-4 p-3 rounded-xl border text-left animate-in fade-in duration-150 ${
                  isHacker ? 'bg-black/70 border-[#00FF66]/40' : isPro ? 'bg-slate-800 border-slate-700' : 'bg-[#F0F2F5] border-gray-200'
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
                  className="w-full mb-2 accent-[#008069]"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setAvatarPreview(null);
                      cropImageRef.current = null;
                      setIsEditingPhoto(false);
                    }}
                    className="text-[11px] text-red-500 hover:underline"
                  >
                    Remove photo (use emoji)
                  </button>
                </div>
              </div>
            )}

            <p className="text-xs opacity-70 mb-4">
              Provide a group subject. Invited members will receive a Group Request to join.
            </p>

            {/* Selected Members Preview */}
            <div className="mt-2">
              <h3 className="text-xs font-bold uppercase tracking-wider opacity-60 mb-2">
                Members ({selectedUsers.length})
              </h3>
              <div className="divide-y divide-black/5 rounded-xl border border-black/5 overflow-hidden">
                {selectedUsers.length === 0 ? (
                  <div className="p-3 text-xs opacity-60 text-center">
                    No members selected. You can invite members later.
                  </div>
                ) : (
                  selectedUsers.map((u) => (
                    <div key={u.pseudoId} className="flex items-center gap-3 p-2.5">
                      <Avatar name={u.displayName} src={u.avatarUrl} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{u.displayName}</p>
                        {u.numericId && (
                          <span className="text-[10px] font-mono opacity-60">ID: {u.numericId}</span>
                        )}
                      </div>
                      <span className="text-[10px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">
                        Invite sent
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Floating Action Button / Submit */}
            <div className="mt-auto pt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-xs font-semibold opacity-70 hover:opacity-100 transition"
              >
                ← Back
              </button>
              <button
                type="button"
                disabled={submitting || !groupName.trim()}
                onClick={handleCreateGroup}
                className={`flex items-center gap-2 rounded-full px-6 py-3 text-xs font-bold text-white transition shadow-lg ${
                  groupName.trim() && !submitting
                    ? isHacker
                      ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                      : isPro
                      ? 'bg-blue-600 hover:bg-blue-500'
                      : 'bg-[#008069] hover:bg-[#006A57]'
                    : 'bg-gray-400 opacity-50 cursor-not-allowed'
                }`}
              >
                {submitting ? (
                  <span>Creating…</span>
                ) : (
                  <>
                    <span className="text-sm">✓</span>
                    <span>Create Group</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
