'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { PublicUser } from '@ghostchat/shared-types';
import { Avatar } from './Avatar';
import { api } from '../lib/api';
import { useTheme, type ThemeType, ALL_THEMES } from '../lib/theme';

interface ProfileModalProps {
  user: PublicUser;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: (updatedUser: PublicUser) => void;
  onLogout?: () => void;
}

export function ProfileModal({ user, isOpen, onClose, onUpdated, onLogout }: ProfileModalProps) {
  const { theme, setTheme } = useTheme();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user.avatarUrl ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cropImageRef = useRef<HTMLImageElement | null>(null);
  const [cropZoom, setCropZoom] = useState(1);

  useEffect(() => {
    if (!isOpen) return;
    setDisplayName(user.displayName);
    setAvatarPreview(user.avatarUrl ?? null);
    setError(null);
  }, [isOpen, user]);

  if (!isOpen) return null;

  // Handle image upload with canvas resizing to keep it crisp & compact
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
        const canvas = document.createElement('canvas');
        const maxSize = 256;
        const sourceSize = Math.min(img.width, img.height);
        const zoomedSize = sourceSize / cropZoom;
        const sourceX = Math.round((img.width - zoomedSize) / 2);
        const sourceY = Math.round((img.height - zoomedSize) / 2);

        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, sourceX, sourceY, zoomedSize, zoomedSize, 0, 0, maxSize, maxSize);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setAvatarPreview(dataUrl);
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError('Display name must be between 2 and 24 characters');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const updated = await api.updateProfile({
        displayName: trimmed,
        avatar: avatarPreview,
      });
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro';
  const isMidnight = theme === 'midnight';
  const isNordic = theme === 'nordic';
  const isDark = isHacker || isPro || isMidnight;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        className={`w-full max-w-lg rounded-2xl p-6 shadow-2xl transition-all ${
          isHacker
            ? 'bg-[#050D07] border border-[#00FF66]/30 text-[#00FF66] font-mono shadow-[0_0_30px_rgba(0,255,102,0.15)]'
            : isPro
            ? 'bg-[#0F172A] border border-[#3B82F6]/30 text-white shadow-[0_0_30px_rgba(59,130,246,0.15)]'
            : isMidnight
            ? 'bg-[#0E1118] border border-[#6366F1]/30 text-[#F8FAFC] shadow-[0_0_30px_rgba(99,102,241,0.15)]'
            : isNordic
            ? 'bg-white border border-[#E2E8F0] text-[#0F172A] shadow-xl'
            : 'bg-white border border-[#E9EDEF] text-[#111B21]'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between pb-4 border-b ${
          isHacker ? 'border-[#00FF66]/20' : isPro ? 'border-white/10' : isMidnight ? 'border-indigo-500/20' : isNordic ? 'border-slate-200' : 'border-[#E9EDEF]'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-lg">⚙️</span>
            <h2 className="text-base font-bold tracking-wide">
              {isHacker ? 'root@ghostchat:~# edit-profile' : 'Profile & Settings'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`rounded-lg p-1.5 transition ${
              isHacker ? 'text-[#00FF66]/50 hover:bg-[#00FF66]/10 hover:text-[#00FF66]' : isPro || isMidnight ? 'text-white/50 hover:bg-white/10 hover:text-white' : isNordic ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-800' : 'text-[#54656F] hover:bg-[#F0F2F5] hover:text-[#111B21]'
            }`}
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSave} className="mt-5 space-y-5">
          {/* Avatar / Photo Section */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider opacity-70 mb-2">
              Profile Photo
            </label>
            <div className="flex items-center gap-4">
              <div className="relative group">
                <Avatar name={displayName || 'User'} src={avatarPreview} size={64} />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition text-xs font-medium text-white"
                  title="Change photo"
                >
                  📷
                </button>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      isHacker
                        ? 'bg-[#00FF66]/10 text-[#00FF66] border border-[#00FF66]/40 hover:bg-[#00FF66]/20'
                        : isPro
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30'
                        : 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30'
                    }`}
                  >
                    Upload Photo
                  </button>
                  {avatarPreview && (
                    <button
                      type="button"
                      onClick={() => {
                        setAvatarPreview(null);
                        cropImageRef.current = null;
                        setCropZoom(1);
                      }}
                      className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 transition"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-[11px] opacity-50">Recommended: Square JPG, PNG, or WebP (max 8MB)</p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          </div>

          {/* Crop Zoom Control */}
          {cropImageRef.current && (
            <div className="mt-3 flex items-center gap-3">
              <label className="text-[11px] opacity-70">Crop zoom</label>
              <input
                type="range"
                min="1"
                max="3"
                step="0.05"
                value={cropZoom}
                onChange={(event) => handleCropZoom(Number(event.target.value))}
                className="w-40"
              />
            </div>
          )}

          {/* Display Name Section */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs font-semibold uppercase tracking-wider opacity-70">
                Display Name
              </label>
              <span className="text-[10px] opacity-50">{displayName.length}/24</span>
            </div>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={24}
              required
              placeholder="e.g. Neo, Phantom"
              className={`w-full rounded-xl px-3.5 py-2.5 text-sm outline-none transition ${
                isHacker
                  ? 'bg-black/60 border border-[#00FF66]/30 text-[#00FF66] placeholder-[#00FF66]/30 focus:border-[#00FF66] focus:ring-1 focus:ring-[#00FF66]'
                  : isPro
                  ? 'bg-black/40 border border-blue-500/30 text-white placeholder-white/30 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                  : 'bg-[#F0F2F5] border border-[#E9EDEF] text-[#111B21] placeholder-[#667781] focus:border-[#128C7E] focus:ring-1 focus:ring-[#128C7E]'
              }`}
            />
          </div>

          {/* User ID and Contact Info */}
          <div className={`rounded-xl p-3 text-xs space-y-1.5 border ${
            isHacker ? 'bg-black/40 border-[#00FF66]/20' : isPro ? 'bg-black/20 border-white/5' : 'bg-[#F0F2F5] border-[#E9EDEF]'
          }`}>
            <div className="flex items-center justify-between">
              <span className={isHacker ? 'text-[#00FF66]/60' : isPro ? 'text-white/60' : 'text-[#54656F]'}>Numeric User ID:</span>
              <span className={`font-mono font-bold ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-blue-400' : 'text-[#128C7E]'}`}>
                {user.numericId || 'Assigned'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className={isHacker ? 'text-[#00FF66]/60' : isPro ? 'text-white/60' : 'text-[#54656F]'}>Contact Code:</span>
              <span className={`font-mono text-[11px] truncate max-w-[200px] ${isHacker ? 'text-[#00FF66]/80' : isPro ? 'text-white/80' : 'text-[#54656F]'}`}>
                {user.contactCode}
              </span>
            </div>
          </div>

          {/* Themes Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold uppercase tracking-wider opacity-70">
                Appearance & Themes
              </label>
              <span className="text-[11px] opacity-60">5 curated styles</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ALL_THEMES.map((item) => {
                const isSelected = theme === item.id;
                let activeBorder = 'border-[#128C7E] bg-[#128C7E]/10 text-[#128C7E] shadow-[0_0_12px_rgba(18,140,126,0.25)]';
                let iconBg = 'bg-[#128C7E] text-white';

                if (item.id === 'pro') {
                  activeBorder = 'border-blue-500 bg-blue-500/15 text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.3)]';
                  iconBg = 'bg-blue-600 text-white';
                } else if (item.id === 'midnight') {
                  activeBorder = 'border-indigo-500 bg-indigo-500/15 text-indigo-300 shadow-[0_0_12px_rgba(99,102,241,0.35)]';
                  iconBg = 'bg-indigo-600 text-white';
                } else if (item.id === 'nordic') {
                  activeBorder = 'border-sky-500 bg-sky-50 text-sky-700 shadow-[0_0_12px_rgba(2,132,199,0.2)]';
                  iconBg = 'bg-sky-600 text-white';
                } else if (item.id === 'hacker') {
                  activeBorder = 'border-[#00FF66] bg-[#00FF66]/15 text-[#00FF66] shadow-[0_0_12px_rgba(0,255,102,0.3)] font-mono';
                  iconBg = 'bg-[#00FF66] text-black font-black';
                }

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTheme(item.id)}
                    className={`flex flex-col items-center gap-1 rounded-xl p-2.5 text-xs font-semibold border transition text-center ${
                      isSelected
                        ? activeBorder
                        : isDark
                        ? 'border-white/10 bg-white/5 opacity-60 hover:opacity-100 hover:bg-white/10'
                        : isNordic
                        ? 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                        : 'border-[#E9EDEF] bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF]'
                    }`}
                  >
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${iconBg}`}>
                      {item.icon}
                    </div>
                    <span className="font-bold leading-tight">{item.label}</span>
                    <span className="text-[10px] opacity-60 leading-tight">{item.subtitle}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action Buttons */}
          <div className={`flex justify-end gap-3 pt-3 border-t ${
            isHacker ? 'border-[#00FF66]/20' : isPro ? 'border-white/10' : isMidnight ? 'border-indigo-500/20' : isNordic ? 'border-slate-200' : 'border-[#E9EDEF]'
          }`}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className={`rounded-xl px-4 py-2 text-xs font-semibold transition ${
                isHacker
                  ? 'text-[#00FF66]/70 hover:bg-[#00FF66]/10'
                  : isPro || isMidnight
                  ? 'text-white/70 hover:bg-white/10'
                  : isNordic
                  ? 'text-slate-600 hover:bg-slate-100'
                  : 'text-[#54656F] hover:bg-[#F0F2F5]'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`rounded-xl px-5 py-2 text-xs font-bold text-white transition shadow-lg disabled:opacity-50 ${
                isHacker
                  ? 'bg-[#00FF66] text-black hover:bg-[#00DD55] shadow-[#00FF66]/20'
                  : isPro
                  ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/20'
                  : isMidnight
                  ? 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/25'
                  : isNordic
                  ? 'bg-sky-600 hover:bg-sky-500 shadow-sky-600/20'
                  : 'bg-[#128C7E] hover:bg-[#075E54] shadow-md'
              }`}
            >
              {loading ? 'Saving...' : 'Save Profile'}
            </button>
          </div>

          {/* Log Out Option */}
          {onLogout && (
            <div className={`pt-3 border-t ${
              isHacker ? 'border-[#00FF66]/20' : isPro ? 'border-white/10' : isMidnight ? 'border-indigo-500/20' : isNordic ? 'border-slate-200' : 'border-[#E9EDEF]'
            }`}>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Are you sure you want to log out of GhostChat?')) {
                    onClose();
                    onLogout();
                  }
                }}
                className={`w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold transition border ${
                  isHacker
                    ? 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : isPro || isMidnight
                    ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
                }`}
              >
                <span className="text-sm">🚪</span>
                <span>Log Out of GhostChat</span>
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
