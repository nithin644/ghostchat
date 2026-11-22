'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationDetail, ConversationSummary, FriendRequestDTO, GroupRequestDTO, PublicUser, UserSearchResult } from '@ghostchat/shared-types';
import { Avatar } from './Avatar';
import { ProfileModal } from './ProfileModal';
import { CreateGroupModal } from './CreateGroupModal';
import { VerifiedBadge } from './VerifiedBadge';
import { useTheme, type ThemeType } from '../lib/theme';
import { api } from '../lib/api';
import { requestNotificationPermission } from '../lib/sound';
import { storeGroupSecret } from '../lib/groupKeys';

export interface ChatListProps {
  conversations: ConversationSummary[];
  unread: Record<string, number>;
  activeId: string | null;
  selfName: string;
  selfContactCode: string;
  selfNumericId?: string;
  selfAvatarUrl?: string | null;
  user?: PublicUser;
  isAdmin: boolean;
  blockedUsers?: string[];
  onSelect: (id: string) => void;
  onNewChat: (query: string) => void;
  onNewGroup: () => void;
  onJoinGroup: (code: string) => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
  onProfileUpdated?: (user: PublicUser) => void;
  onDeleteChat?: (conversationId: string) => void;
  onBlockUser?: (targetPseudoId: string, displayName?: string) => void;
  onUnblockUser?: (targetPseudoId: string, displayName?: string) => void;
}

type TabType = 'CHAT' | 'USERS' | 'REQUESTS' | 'GROUPS';

export function ChatList({
  conversations,
  unread,
  activeId,
  selfName,
  selfContactCode,
  selfNumericId,
  selfAvatarUrl,
  user,
  isAdmin,
  blockedUsers = [],
  onSelect,
  onNewChat,
  onNewGroup,
  onJoinGroup,
  onOpenAdmin,
  onLogout,
  onProfileUpdated,
  onDeleteChat,
  onBlockUser,
  onUnblockUser,
}: ChatListProps) {
  const { theme, setTheme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro';
  const isMidnight = theme === 'midnight';
  const isNordic = theme === 'nordic';
  const isDark = isHacker || isPro || isMidnight;
  const isDarkPro = isPro || isMidnight;

  const [tab, setTab] = useState<TabType>('CHAT');
  const [copiedId, setCopiedId] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [openMenuConvoId, setOpenMenuConvoId] = useState<string | null>(null);
  const [openMenuUserId, setOpenMenuUserId] = useState<string | null>(null);

  // Close menus on outside click or Escape
  useEffect(() => {
    const handleDown = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        setOpenMenuConvoId(null);
        setOpenMenuUserId(null);
      } else if (e instanceof MouseEvent) {
        // Handled per click if not inside menu
      }
    };
    window.addEventListener('keydown', handleDown);
    return () => window.removeEventListener('keydown', handleDown);
  }, []);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchDropdownRef = useRef<HTMLDivElement | null>(null);

  // Users tab state
  const [allUsers, setAllUsers] = useState<UserSearchResult[]>([]);
  const [userStats, setUserStats] = useState({ total: 0, online: 0, offline: 0 });
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Friend requests state
  const [requests, setRequests] = useState<{ incoming: FriendRequestDTO[]; outgoing: FriendRequestDTO[] }>({
    incoming: [],
    outgoing: [],
  });
  const [groupRequests, setGroupRequests] = useState<GroupRequestDTO[]>([]);
  const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleCopyId = () => {
    if (!selfNumericId) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(selfNumericId);
      setCopiedId(true);
      showToast(`Copied User ID: ${selfNumericId}`);
      setTimeout(() => setCopiedId(false), 2000);
    }
  };

  // Load friend requests & group requests
  const loadRequests = useCallback(async () => {
    try {
      const [friendData, groupData] = await Promise.all([
        api.getFriendRequests(),
        api.getGroupRequests().catch(() => []),
      ]);
      setRequests(friendData);
      setGroupRequests(groupData);
    } catch {
      // ignore in background
    }
  }, []);

  const handleAcceptGroupRequest = async (req: GroupRequestDTO) => {
    setProcessingRequestId(req.id);
    try {
      const res = await api.acceptGroupRequest(req.id);
      await storeGroupSecret(res.conversationId, { inviteCode: res.inviteCode, epoch: 0 });
      showToast(`Joined group: ${req.groupTitle}`);
      onSelect(res.conversationId);
      void loadRequests();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleDeclineGroupRequest = async (requestId: string) => {
    setProcessingRequestId(requestId);
    try {
      await api.declineGroupRequest(requestId);
      showToast('Group request declined');
      setGroupRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to decline request');
    } finally {
      setProcessingRequestId(null);
    }
  };

  // Load all users
  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await api.listUsers();
      setAllUsers(res.users);
      setUserStats(res.stats);
    } catch {
      // ignore
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  // Initial and periodic refresh
  useEffect(() => {
    void loadRequests();
    void loadUsers();
    const interval = setInterval(() => {
      void loadRequests();
    }, 8000);
    return () => clearInterval(interval);
  }, [loadRequests, loadUsers]);

  // Live search debounce
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setIsSearchOpen(false);
      return;
    }

    setSearching(true);
    setIsSearchOpen(true);
    const timeout = setTimeout(async () => {
      try {
        const results = await api.searchFriends(q);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchQuery]);

  // Close search dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchDropdownRef.current && !searchDropdownRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Send friend request
  const handleSendRequest = async (targetUser: UserSearchResult) => {
    try {
      const targetIdentifier = targetUser.numericId || targetUser.pseudoId;
      const res = await api.sendFriendRequest(targetIdentifier);
      showToast(res.message ?? (res.status === 'ACCEPTED' ? 'Connected!' : 'Friend request sent!'));
      void loadRequests();
      void loadUsers();
      if (searchQuery.trim()) {
        const updatedSearch = await api.searchFriends(searchQuery.trim());
        setSearchResults(updatedSearch);
      }
      if (res.status === 'ACCEPTED') {
        onNewChat(targetIdentifier);
        setTab('CHAT');
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Could not send request');
    }
  };

  // Accept friend request
  const handleAcceptRequest = async (requestId: string, friendName: string) => {
    setProcessingRequestId(requestId);
    try {
      const res = await api.acceptFriendRequest(requestId);
      showToast(`You and ${friendName} are now connected!`);
      void loadRequests();
      void loadUsers();
      onSelect(res.conversationId);
      setTab('CHAT');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Could not accept request');
    } finally {
      setProcessingRequestId(null);
    }
  };

  // Decline friend request
  const handleDeclineRequest = async (requestId: string) => {
    setProcessingRequestId(requestId);
    try {
      await api.declineFriendRequest(requestId);
      showToast('Request removed');
      void loadRequests();
      void loadUsers();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Could not decline request');
    } finally {
      setProcessingRequestId(null);
    }
  };

  const incomingCount = requests.incoming.length + groupRequests.length;
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + (n || 0), 0);

  return (
    <aside
      className={`flex h-full w-full flex-col md:w-[420px] shadow-sm select-none transition-colors ${
        isHacker
          ? 'bg-[#030804] border-r border-[#00FF66]/20 font-mono text-[#00FF66]'
          : isPro
          ? 'bg-[#0F172A] border-r border-slate-800 text-slate-100'
          : isMidnight
          ? 'bg-[#0E1118] border-r border-[#202534] text-[#F8FAFC]'
          : isNordic
          ? 'bg-[#FFFFFF] border-r border-[#E2E8F0] text-[#0F172A]'
          : 'bg-[#FFFFFF] border-r border-[#E9EDEF] text-[#111B21]'
      }`}
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-black/85 px-4 py-2 text-xs font-medium text-white shadow-lg transition-all animate-bounce">
          {toastMessage}
        </div>
      )}

      {/* Top Bar (Style matched to Reference: PRIVATE_CHAT logo, Search People, Bell, Profile) */}
      <header
        className={`flex flex-col gap-2 px-3 py-2.5 transition shadow-sm ${
          isHacker
            ? 'bg-[#050E07] border-b border-[#00FF66]/30 text-[#00FF66] font-mono shadow-[0_2px_15px_rgba(0,255,102,0.1)]'
            : isPro
            ? 'bg-[#0F172A] border-b border-blue-500/20 text-white shadow-sm'
            : isMidnight
            ? 'bg-[#131722] border-b border-[#242A3C] text-white shadow-sm'
            : isNordic
            ? 'bg-[#FFFFFF] border-b border-[#E2E8F0] text-[#0F172A] shadow-sm'
            : 'bg-[#F0F2F5] border-b border-[#E9EDEF] text-[#111B21]'
        }`}
      >
        <div className="flex items-center justify-between gap-1.5 w-full">
          {/* Brand Logo */}
          <div className="flex items-center gap-1.5 shrink-0 min-w-0">
            <span className="text-base">{isHacker ? '⚡' : isPro ? '💼' : isMidnight ? '🌌' : isNordic ? '❄️' : '💬'}</span>
            <span
              className={`text-xs font-black tracking-wider truncate ${
                isHacker
                  ? 'text-[#00FF66] drop-shadow-[0_0_8px_rgba(0,255,102,0.5)]'
                  : isPro
                  ? 'bg-gradient-to-r from-blue-400 via-indigo-300 to-cyan-300 bg-clip-text text-transparent'
                  : isMidnight
                  ? 'bg-gradient-to-r from-indigo-400 via-purple-300 to-pink-300 bg-clip-text text-transparent'
                  : isNordic
                  ? 'text-[#0284C7]'
                  : 'text-[#128C7E]'
              }`}
            >
              PRIVATE_CHAT
            </span>
          </div>

          {/* Right Header Actions: Theme, Bell, User Badge, Logout */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Theme Toggle Button */}
            <button
              type="button"
              onClick={() => {
                const cycle: ThemeType[] = ['normal', 'midnight', 'pro', 'nordic', 'hacker'];
                const idx = cycle.indexOf(theme);
                const next = cycle[(idx + 1) % cycle.length];
                setTheme(next);
              }}
              className={`h-8 px-2 rounded-full text-xs font-bold transition flex items-center gap-1 shrink-0 ${
                isHacker
                  ? 'bg-[#00FF66]/20 text-[#00FF66] border border-[#00FF66]/40 shadow-[0_0_8px_rgba(0,255,102,0.3)]'
                  : isPro
                  ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40 shadow-[0_0_8px_rgba(59,130,246,0.3)]'
                  : isMidnight
                  ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 shadow-[0_0_8px_rgba(99,102,241,0.3)]'
                  : isNordic
                  ? 'bg-sky-500/10 text-sky-600 border border-sky-300 hover:bg-sky-100'
                  : 'bg-[#E9EDEF] text-[#54656F] border border-[#D1D7DB] hover:bg-[#D9DEE0]'
              }`}
              title={`Theme: ${theme.toUpperCase()} (Click to switch)`}
            >
              <span className="text-sm">{isHacker ? '⚡' : isPro ? '💼' : isMidnight ? '🌌' : isNordic ? '❄️' : '🌿'}</span>
              <span className="hidden xl:inline text-[10px]">
                {isHacker ? 'Hacker' : isPro ? 'Exec' : isMidnight ? 'Midnight' : isNordic ? 'Nordic' : 'Normal'}
              </span>
            </button>

            {/* Notification Bell with Badge */}
            <button
              onClick={() => {
                void requestNotificationPermission();
                setTab('REQUESTS');
              }}
              className={`relative h-8 w-8 shrink-0 flex items-center justify-center rounded-full transition ${
                tab === 'REQUESTS'
                  ? isHacker
                    ? 'bg-[#00FF66]/20 text-[#00FF66]'
                    : isMidnight
                    ? 'bg-indigo-600/30 text-indigo-300'
                    : isPro
                    ? 'bg-blue-600/30 text-blue-300'
                    : 'bg-[#E9EDEF] text-[#128C7E]'
                  : isHacker
                  ? 'text-[#00FF66]/70 hover:bg-[#00FF66]/10 hover:text-[#00FF66]'
                  : isDarkPro
                  ? 'text-white/70 hover:bg-white/10 hover:text-white'
                  : 'text-[#54656F] hover:bg-[#E9EDEF] hover:text-[#111B21]'
              }`}
              title="Friend Requests & Notifications"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
              {incomingCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white shadow">
                  {incomingCount}
                </span>
              )}
            </button>

            {/* User Profile Pill (Click to edit profile, name & photo) */}
            <button
              type="button"
              onClick={() => setIsProfileOpen(true)}
              className={`flex items-center gap-1.5 rounded-full pl-1 pr-2 py-0.5 transition text-left group border shrink-0 ${
                isHacker
                  ? 'bg-black/40 border-[#00FF66]/30 hover:bg-black/60 text-[#00FF66]'
                  : isMidnight
                  ? 'bg-white/10 border-[#2D354B] hover:bg-white/15 text-white'
                  : isPro
                  ? 'bg-white/10 border-white/10 hover:bg-white/20 text-white'
                  : 'bg-[#E9EDEF] border-[#D1D7DB] hover:bg-[#D9DEE0] text-[#111B21]'
              }`}
              title="Click to edit Name, Photo & Profile"
            >
              <Avatar name={selfName} src={selfAvatarUrl} size={26} />
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1">
                  <span className="truncate max-w-[65px] text-xs font-semibold leading-none">{selfName}</span>
                  {user?.isVerified && <VerifiedBadge size={11} />}
                </div>
                {selfNumericId && (
                  <span
                    className={`font-mono text-[9px] font-bold leading-tight ${
                      isHacker
                        ? 'text-[#00FF66]'
                        : isMidnight
                        ? 'text-indigo-300'
                        : isPro
                        ? 'text-blue-300'
                        : 'text-[#128C7E]'
                    }`}
                  >
                    ID: {selfNumericId}
                  </span>
                )}
              </div>
            </button>

            {/* Quick Log Out Button */}
            {onLogout && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Are you sure you want to log out of GhostChat?')) {
                    onLogout();
                  }
                }}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition shadow-sm border ${
                  isHacker
                    ? 'border-red-500/50 bg-red-500/15 text-red-400 hover:bg-red-500/30 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                    : isDarkPro
                    ? 'border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/25 hover:border-red-400 shadow-sm'
                    : 'border-red-200 bg-red-50 text-red-500 hover:bg-red-100 hover:border-red-300 shadow-sm'
                }`}
                title="Log Out of GhostChat"
                aria-label="Log Out of GhostChat"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.2"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
              </button>
            )}

            {false && isAdmin && (
              <button
                onClick={onOpenAdmin}
                className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
                  isHacker
                    ? 'bg-[#00FF66] text-black font-bold'
                    : isPro
                    ? 'bg-indigo-600/60 text-white hover:bg-indigo-600'
                    : 'bg-[#128C7E] text-white hover:bg-[#075E54]'
                }`}
              >
                Admin
              </button>
            )}
          </div>
        </div>

        {/* Search People Bar (Global) */}
        <div ref={searchDropdownRef} className="relative w-full">
          <div className="relative flex items-center">
            <span
              className={`absolute left-3 text-xs ${
                isHacker ? 'text-[#00FF66]/50' : isDarkPro ? 'text-white/40' : 'text-[#54656F]'
              }`}
            >
              🔍
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => {
                if (searchQuery.trim()) setIsSearchOpen(true);
              }}
              placeholder="Search people by User ID or Name…"
              className={`w-full rounded-lg pl-8 pr-8 py-1.5 text-xs outline-none transition ${
                isHacker
                  ? 'bg-black/60 border border-[#00FF66]/30 text-[#00FF66] placeholder-[#00FF66]/30 focus:border-[#00FF66] focus:ring-1 focus:ring-[#00FF66]'
                  : isMidnight
                  ? 'bg-[#161A26] border border-[#272D40] text-white placeholder-slate-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                  : isPro
                  ? 'bg-[#1E293B] border border-slate-700 text-white placeholder-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                  : 'bg-white border border-[#E9EDEF] text-[#111B21] placeholder-[#667781] focus:ring-1 focus:ring-[#128C7E]'
              }`}
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setIsSearchOpen(false);
                }}
                className={`absolute right-2.5 text-xs ${
                  isHacker ? 'text-[#00FF66]/60' : isDarkPro ? 'text-white/40' : 'text-[#54656F] hover:text-[#111B21]'
                }`}
              >
                ✕
              </button>
            )}
          </div>

          {/* Search Dropdown Results */}
          {isSearchOpen && (
            <div
              className={`absolute top-full left-0 right-0 z-50 mt-1 max-h-72 overflow-y-auto rounded-xl p-2 shadow-2xl transition border ${
                isHacker
                  ? 'bg-[#050D07] border-[#00FF66]/30 text-[#00FF66]'
                  : isMidnight
                  ? 'bg-[#111420] border-[#272D40] text-white shadow-2xl'
                  : isPro
                  ? 'bg-[#0F172A] border-slate-700 text-white'
                  : 'bg-white border-[#E9EDEF] text-[#111B21]'
              }`}
            >
              {searching && (
                <p className={`p-3 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-white/50' : 'text-[#667781]'}`}>
                  Searching users…
                </p>
              )}
              {!searching && searchResults.length === 0 && (
                <p className={`p-3 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-white/50' : 'text-[#667781]'}`}>
                  No users found matching "{searchQuery}"
                </p>
              )}
              {!searching &&
                searchResults.map((u) => (
                  <div
                    key={u.pseudoId}
                    className={`flex items-center justify-between gap-2 rounded-lg p-2 transition ${
                      isHacker
                        ? 'hover:bg-[#00FF66]/10'
                        : isPro
                        ? 'hover:bg-white/5'
                        : 'hover:bg-[#F5F6F6]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={u.displayName} src={u.avatarUrl} size={32} />
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold flex items-center gap-1 ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-white' : 'text-[#111B21]'}`}>
                          <span className="truncate">{u.displayName}</span>
                          {u.isVerified && <VerifiedBadge size={12} />}
                        </p>
                        {u.numericId && (
                          <span
                            className={`inline-block rounded px-1.5 py-0.2 font-mono text-[10px] font-bold ${
                              isHacker
                                ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                                : isPro
                                ? 'bg-blue-500/20 text-blue-300'
                                : 'bg-[#E9EDEF] text-[#54656F]'
                            }`}
                          >
                            ID: {u.numericId}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {u.friendStatus === 'ACCEPTED' ? (
                        <button
                          onClick={() => {
                            onNewChat(u.numericId || u.pseudoId);
                            setIsSearchOpen(false);
                            setSearchQuery('');
                          }}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white transition ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          Chat
                        </button>
                      ) : u.friendStatus === 'PENDING_SENT' ? (
                        <span
                          className={`rounded px-2 py-1 text-[10px] font-medium ${
                            isHacker ? 'bg-white/10 text-white/60' : isPro ? 'bg-white/10 text-white/60' : 'bg-[#E9EDEF] text-[#667781]'
                          }`}
                        >
                          Pending
                        </span>
                      ) : u.friendStatus === 'PENDING_RECEIVED' ? (
                        <button
                          onClick={() => {
                            if (u.requestId) handleAcceptRequest(u.requestId, u.displayName);
                            setIsSearchOpen(false);
                            setSearchQuery('');
                          }}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white transition ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          Accept
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSendRequest(u)}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white transition ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </header>

      {/* Horizontal Navigation Tabs */}
      <nav
        className={`flex items-center px-2 shadow-sm transition border-b ${
          isHacker
            ? 'bg-[#050D07] border-[#00FF66]/30'
            : isPro
            ? 'bg-[#131E36] border-slate-800'
            : isMidnight
            ? 'bg-[#111420] border-[#222738]'
            : isNordic
            ? 'bg-[#FFFFFF] border-[#E2E8F0]'
            : 'bg-white border-[#E9EDEF]'
        }`}
      >
        <button
          onClick={() => setTab('CHAT')}
          className={`flex-1 py-2.5 text-center text-xs font-bold tracking-wider uppercase transition border-b-2 flex items-center justify-center gap-1.5 ${
            tab === 'CHAT'
              ? isHacker
                ? 'border-[#00FF66] text-[#00FF66] bg-[#00FF66]/10'
                : isPro
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : isMidnight
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : isNordic
                ? 'border-sky-600 text-sky-600 bg-sky-50'
                : 'border-[#128C7E] text-[#128C7E] bg-[#F0F2F5]/70'
              : isHacker
              ? 'border-transparent text-[#00FF66]/50 hover:text-[#00FF66]'
              : isDark
              ? 'border-transparent text-slate-400 hover:text-white'
              : isNordic
              ? 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              : 'border-transparent text-[#667781] hover:text-[#111B21] hover:bg-[#F5F6F6]'
          }`}
        >
          <span>Chat</span>
          {totalUnread > 0 && (
            <span
              className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold text-white shadow-sm ${
                isHacker ? 'bg-[#00FF66] text-black font-mono' : isPro ? 'bg-blue-500' : isMidnight ? 'bg-indigo-600' : isNordic ? 'bg-sky-600' : 'bg-[#25D366]'
              }`}
            >
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </button>
        <button
          onClick={() => {
            setTab('USERS');
            void loadUsers();
          }}
          className={`flex-1 py-2.5 text-center text-xs font-bold tracking-wider uppercase transition border-b-2 ${
            tab === 'USERS'
              ? isHacker
                ? 'border-[#00FF66] text-[#00FF66] bg-[#00FF66]/10'
                : isPro
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : isMidnight
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : isNordic
                ? 'border-sky-600 text-sky-600 bg-sky-50'
                : 'border-[#128C7E] text-[#128C7E] bg-[#F0F2F5]/70'
              : isHacker
              ? 'border-transparent text-[#00FF66]/50 hover:text-[#00FF66]'
              : isDark
              ? 'border-transparent text-slate-400 hover:text-white'
              : isNordic
              ? 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              : 'border-transparent text-[#667781] hover:text-[#111B21] hover:bg-[#F5F6F6]'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => {
            setTab('REQUESTS');
            void loadRequests();
          }}
          className={`relative flex-1 py-2.5 text-center text-xs font-bold tracking-wider uppercase transition border-b-2 ${
            tab === 'REQUESTS'
              ? isHacker
                ? 'border-[#00FF66] text-[#00FF66] bg-[#00FF66]/10'
                : isPro
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : isMidnight
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : isNordic
                ? 'border-sky-600 text-sky-600 bg-sky-50'
                : 'border-[#128C7E] text-[#128C7E] bg-[#F0F2F5]/70'
              : isHacker
              ? 'border-transparent text-[#00FF66]/50 hover:text-[#00FF66]'
              : isDark
              ? 'border-transparent text-slate-400 hover:text-white'
              : isNordic
              ? 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              : 'border-transparent text-[#667781] hover:text-[#111B21] hover:bg-[#F5F6F6]'
          }`}
        >
          Requests
          {incomingCount > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
              {incomingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('GROUPS')}
          className={`flex-1 py-2.5 text-center text-xs font-bold tracking-wider uppercase transition border-b-2 ${
            tab === 'GROUPS'
              ? isHacker
                ? 'border-[#00FF66] text-[#00FF66] bg-[#00FF66]/10'
                : isPro
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : isMidnight
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : isNordic
                ? 'border-sky-600 text-sky-600 bg-sky-50'
                : 'border-[#128C7E] text-[#128C7E] bg-[#F0F2F5]/70'
              : isHacker
              ? 'border-transparent text-[#00FF66]/50 hover:text-[#00FF66]'
              : isDark
              ? 'border-transparent text-slate-400 hover:text-white'
              : isNordic
              ? 'border-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-50'
              : 'border-transparent text-[#667781] hover:text-[#111B21] hover:bg-[#F5F6F6]'
          }`}
        >
          Groups
        </button>
      </nav>

      {/* Status Pills */}
      <div
        className={`flex items-center gap-2 px-3.5 py-1.5 text-[11px] font-medium border-b transition ${
          isHacker
            ? 'bg-[#050E07] border-[#00FF66]/20 text-[#00FF66]'
            : isMidnight
            ? 'bg-[#111420] border-[#202535] text-slate-300'
            : isPro
            ? 'bg-[#0B132B] border-slate-800 text-slate-300'
            : 'bg-[#F0F2F5] border-[#E9EDEF] text-[#54656F]'
        }`}
      >
        <span
          className={`rounded-full px-2 py-0.5 border shadow-sm ${
            isHacker
              ? 'bg-black/60 border-[#00FF66]/30 text-[#00FF66]'
              : isMidnight
              ? 'bg-[#1A1F2E] border-[#2D354B] text-slate-200'
              : isPro
              ? 'bg-[#1E293B] border-slate-700 text-slate-200'
              : 'bg-white border-[#E9EDEF] text-[#54656F]'
          }`}
        >
          👤 {userStats.total} users
        </span>
        <span
          className={`rounded-full px-2 py-0.5 border font-semibold shadow-sm ${
            isHacker
              ? 'bg-[#00FF66]/20 border-[#00FF66]/40 text-[#00FF66]'
              : isDarkPro
              ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
              : 'bg-[#DCF8C6] border-[#25D366]/40 text-[#075E54] font-semibold'
          }`}
        >
          ● {userStats.online} online
        </span>
        <span
          className={`rounded-full px-2 py-0.5 border shadow-sm ${
            isHacker
              ? 'bg-black/40 border-[#00FF66]/20 text-[#00FF66]/60'
              : isMidnight
              ? 'bg-[#1A1F2E] border-[#2D354B] text-slate-400'
              : isPro
              ? 'bg-[#1E293B] border-slate-700 text-slate-400'
              : 'bg-white border-[#E9EDEF] text-[#8696A0]'
          }`}
        >
          ○ {userStats.offline} offline
        </span>
      </div>

      {/* Content Area Based on Active Tab */}
      <div className="flex-1 overflow-y-auto">
        {/* TAB 1: CHATS */}
        {tab === 'CHAT' && (
          <div>
            <div
              className={`px-3.5 py-1.5 text-[11px] font-bold tracking-wider uppercase transition shadow-sm ${
                isHacker
                  ? 'bg-[#07150A] text-[#00FF66] border-b border-[#00FF66]/30'
                  : isMidnight
                  ? 'bg-[#131722] text-indigo-300 border-b border-[#222738]'
                  : isPro
                  ? 'bg-[#131E36] text-blue-300 border-b border-slate-800'
                  : 'bg-[#F0F2F5] text-[#54656F] border-b border-[#E9EDEF]'
              }`}
            >
              Your Chats
            </div>
            {conversations.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className={`text-xs leading-relaxed ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-slate-400' : 'text-[#667781]'}`}>
                  no chats yet — find someone in <span className={`font-semibold ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-blue-400' : 'text-[#128C7E]'}`}>"Users"</span> or search above and send a request
                </p>
                <button
                  onClick={() => setTab('USERS')}
                  className={`mt-4 rounded-lg px-4 py-2 text-xs font-semibold text-white transition shadow ${
                    isHacker
                      ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                      : isPro
                      ? 'bg-blue-600 hover:bg-blue-500'
                      : 'bg-[#128C7E] hover:bg-[#075E54]'
                  }`}
                >
                  Browse Users
                </button>
              </div>
            ) : (
              <ul>
                {conversations.map((conversation) => {
                  const count = (unread[conversation.id] ?? conversation.unreadCount) || 0;
                  const peerNumericId = conversation.peer?.numericId;
                  const peerPseudoId = conversation.peer?.pseudoId;
                  const isPeerBlocked = conversation.isBlocked || (peerPseudoId ? blockedUsers.includes(peerPseudoId) : false);
                  const isConvoActive = activeId === conversation.id;
                  const lastMsg = conversation.lastMessage;
                  const snippetText = lastMsg
                    ? lastMsg.snippet
                      ? (lastMsg.fromSelf ? 'You: ' : '') + lastMsg.snippet
                      : 'Encrypted message'
                    : 'No messages yet';

                  return (
                    <li key={conversation.id}>
                      <button
                        onClick={() => onSelect(conversation.id)}
                        className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition border-b ${
                          isConvoActive
                            ? isHacker
                              ? 'bg-[#071C0A] border-l-4 border-l-[#00FF66] text-[#00FF66] border-[#00FF66]/20'
                              : isPro
                              ? 'bg-[#1E293B] border-l-4 border-l-blue-500 text-white border-slate-800'
                              : isMidnight
                              ? 'bg-[#181D2B] border-l-4 border-l-indigo-500 text-white border-[#272E44]'
                              : isNordic
                              ? 'bg-sky-50 border-l-4 border-l-sky-600 text-slate-900 border-slate-200'
                              : 'bg-[#F0F2F5] border-l-4 border-l-[#128C7E] text-[#111B21] border-[#E9EDEF]'
                            : isHacker
                            ? 'hover:bg-[#07150A] text-[#00FF66] border-[#00FF66]/10'
                            : isPro
                            ? 'hover:bg-[#1E293B]/60 text-slate-200 border-slate-800/60'
                            : isMidnight
                            ? 'hover:bg-[#151926]/70 text-slate-200 border-[#202536]'
                            : isNordic
                            ? 'hover:bg-slate-50 text-slate-900 border-slate-100'
                            : 'hover:bg-[#F5F6F6] text-[#111B21] border-[#E9EDEF]'
                        }`}
                      >
                        <Avatar name={conversation.title} src={conversation.avatarUrl} />
                        <div className="min-w-0 flex-1 pb-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className={`truncate text-sm font-semibold ${isHacker ? 'text-[#00FF66]' : isDark ? 'text-white' : 'text-[#111B21]'}`}>
                                {conversation.title}
                              </span>
                              {conversation.peer?.isVerified && <VerifiedBadge size={12} />}
                              {peerNumericId && (
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.2 font-mono text-[10px] font-bold ${
                                    isHacker
                                      ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                                      : isPro
                                      ? 'bg-blue-500/20 border border-blue-400/30 text-blue-300'
                                      : 'bg-[#E9EDEF] text-[#54656F] border border-[#D1D7DB]'
                                  }`}
                                >
                                  ID: {peerNumericId}
                                </span>
                              )}
                              {isPeerBlocked && (
                                <span className="shrink-0 rounded px-1.5 py-0.2 text-[9px] font-bold text-red-500 bg-red-500/10 border border-red-500/30">
                                  Blocked
                                </span>
                              )}
                            </div>
                            <span
                              className={`shrink-0 text-[10px] ${
                                count > 0
                                  ? isHacker
                                    ? 'text-[#00FF66] font-bold'
                                    : isPro
                                    ? 'text-blue-400 font-bold'
                                    : 'text-[#128C7E] font-bold'
                                  : isHacker
                                  ? 'text-[#00FF66]/50'
                                  : isPro
                                  ? 'text-slate-400'
                                  : 'text-[#667781]'
                              }`}
                            >
                              {lastMsg
                                ? new Date(lastMsg.at).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : ''}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-xs ${
                                count > 0
                                  ? isHacker
                                    ? 'font-semibold text-[#00FF66]'
                                    : isPro
                                    ? 'font-semibold text-white'
                                    : 'font-semibold text-[#111B21]'
                                  : isHacker
                                  ? 'text-[#00FF66]/60'
                                  : isPro
                                  ? 'text-slate-400'
                                  : 'text-[#667781]'
                              }`}
                            >
                              {snippetText}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {count > 0 && (
                                <span
                                  className={`flex items-center justify-center min-w-[20px] h-5 rounded-full px-1.5 text-[11px] font-bold text-white shadow-sm transition-all ${
                                    isHacker
                                      ? 'bg-[#00FF66] text-black shadow-[0_0_8px_rgba(0,255,102,0.6)] font-mono'
                                      : isPro
                                      ? 'bg-blue-500 text-white shadow-[0_0_8px_rgba(59,130,246,0.5)]'
                                      : isMidnight
                                      ? 'bg-indigo-600 text-white shadow-[0_0_8px_rgba(99,102,241,0.5)]'
                                      : isNordic
                                      ? 'bg-sky-600 text-white'
                                      : 'bg-[#25D366] text-white'
                                  }`}
                                >
                                  {count > 99 ? '99+' : count}
                                </span>
                              )}
                              <div className="relative">
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenuConvoId(openMenuConvoId === conversation.id ? null : conversation.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation();
                                      setOpenMenuConvoId(openMenuConvoId === conversation.id ? null : conversation.id);
                                    }
                                  }}
                                  className={`h-6 w-6 rounded flex items-center justify-center text-sm font-bold transition hover:bg-black/10 dark:hover:bg-white/10 ${
                                    isHacker ? 'text-[#00FF66]/70 hover:text-[#00FF66]' : isDark ? 'text-slate-400 hover:text-white' : 'text-[#54656F] hover:text-[#111B21]'
                                  }`}
                                  title="Options"
                                  aria-label="Options"
                                >
                                  ⋮
                                </span>
                                {openMenuConvoId === conversation.id && (
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    className={`absolute right-0 top-full mt-1 w-44 rounded-xl p-1.5 shadow-2xl z-50 border transition ${
                                      isHacker
                                        ? 'bg-[#050D07] border-[#00FF66]/40 text-[#00FF66]'
                                        : isPro
                                        ? 'bg-[#0F172A] border-slate-700 text-white'
                                        : isMidnight
                                        ? 'bg-[#111522] border-[#2A3146] text-white'
                                        : isNordic
                                        ? 'bg-white border-slate-200 text-slate-900 shadow-lg'
                                        : 'bg-white border-[#E9EDEF] text-[#111B21]'
                                    }`}
                                  >
                                    {conversation.type === 'DIRECT' && peerPseudoId && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuConvoId(null);
                                          if (isPeerBlocked) {
                                            onUnblockUser?.(peerPseudoId, conversation.title);
                                          } else {
                                            onBlockUser?.(peerPseudoId, conversation.title);
                                          }
                                        }}
                                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                                          isHacker
                                            ? 'hover:bg-[#00FF66]/10'
                                            : isPro
                                            ? 'hover:bg-white/5'
                                            : 'hover:bg-[#F5F6F6]'
                                        } ${isPeerBlocked ? 'text-emerald-500 hover:text-emerald-400' : 'text-red-500 hover:text-red-400'}`}
                                      >
                                        <span>{isPeerBlocked ? '🟢' : '🚫'}</span>
                                        <span>{isPeerBlocked ? 'Unblock Contact' : 'Block Contact'}</span>
                                      </button>
                                    )}
                                    {onDeleteChat && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuConvoId(null);
                                          onDeleteChat(conversation.id);
                                        }}
                                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 transition text-left ${
                                          isHacker
                                            ? 'hover:bg-[#00FF66]/10'
                                            : isPro
                                            ? 'hover:bg-white/5'
                                            : 'hover:bg-[#F5F6F6]'
                                        }`}
                                      >
                                        <span>🗑️</span>
                                        <span>Delete Chat</span>
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* TAB 2: USERS DIRECTORY */}
        {tab === 'USERS' && (
          <div>
            <div
              className={`px-3.5 py-1.5 text-[11px] font-bold tracking-wider uppercase transition shadow-sm flex items-center justify-between ${
                isHacker
                  ? 'bg-[#07150A] text-[#00FF66] border-b border-[#00FF66]/30'
                  : isMidnight
                  ? 'bg-[#131722] text-indigo-300 border-b border-[#222738]'
                  : isPro
                  ? 'bg-[#131E36] text-blue-300 border-b border-slate-800'
                  : 'bg-[#F0F2F5] text-[#54656F] border-b border-[#E9EDEF]'
              }`}
            >
              <span>All Registered Users</span>
              <button
                onClick={() => void loadUsers()}
                className={`text-[10px] lowercase transition ${
                  isHacker ? 'text-[#00FF66]/70 hover:text-[#00FF66]' : isPro ? 'text-slate-400 hover:text-white' : 'text-[#54656F] hover:text-[#111B21]'
                }`}
              >
                refresh
              </button>
            </div>

            {loadingUsers ? (
              <p className={`p-8 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-slate-400' : 'text-[#667781]'}`}>Loading users…</p>
            ) : allUsers.length === 0 ? (
              <p className={`p-8 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-slate-400' : 'text-[#667781]'}`}>No other registered users yet.</p>
            ) : (
              <ul>
                {allUsers.map((u) => {
                  const isUserBlocked = u.isBlocked || u.friendStatus === 'BLOCKED' || blockedUsers.includes(u.pseudoId);
                  const existingConvo = conversations.find((c) => c.peer?.pseudoId === u.pseudoId);

                  return (
                    <li
                      key={u.pseudoId}
                      className={`flex items-center justify-between gap-3 px-3.5 py-3 transition border-b ${
                        isHacker
                          ? 'hover:bg-[#07150A] border-[#00FF66]/10 text-[#00FF66]'
                          : isPro
                          ? 'hover:bg-[#1E293B]/60 border-slate-800/60 text-slate-200'
                          : 'hover:bg-[#F5F6F6] border-[#E9EDEF] text-[#111B21]'
                      }`}
                    >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={u.displayName} src={u.avatarUrl} size={38} />
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold flex items-center gap-1 ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-white' : 'text-[#111B21]'}`}>
                          <span className="truncate">{u.displayName}</span>
                          {u.isVerified && <VerifiedBadge size={12} />}
                        </p>
                        {u.numericId && (
                          <span
                            className={`inline-block mt-0.5 rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                              isHacker
                                ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                                : isPro
                                ? 'bg-blue-500/20 border border-blue-400/30 text-blue-300'
                                : 'bg-[#E9EDEF] text-[#54656F] border border-[#D1D7DB]'
                            }`}
                          >
                            User ID: {u.numericId}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5">
                      {isUserBlocked ? (
                        <div className="flex items-center gap-1.5">
                          <span className="rounded px-2 py-0.5 text-[10px] font-bold text-red-500 bg-red-500/10 border border-red-500/30">
                            Blocked
                          </span>
                          <button
                            type="button"
                            onClick={() => onUnblockUser?.(u.pseudoId, u.displayName)}
                            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition shadow"
                          >
                            Unblock
                          </button>
                        </div>
                      ) : u.friendStatus === 'ACCEPTED' ? (
                        <button
                          onClick={() => {
                            onNewChat(u.numericId || u.pseudoId);
                            setTab('CHAT');
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          Chat
                        </button>
                      ) : u.friendStatus === 'PENDING_SENT' ? (
                        <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                          isHacker ? 'bg-white/10 text-white/60' : isPro ? 'bg-white/10 text-white/60' : 'bg-[#E9EDEF] text-[#667781]'
                        }`}>
                          Request Sent
                        </span>
                      ) : u.friendStatus === 'PENDING_RECEIVED' ? (
                        <button
                          onClick={() => {
                            if (u.requestId) handleAcceptRequest(u.requestId, u.displayName);
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition shadow ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          Accept
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSendRequest(u)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition shadow ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          + Add Friend
                        </button>
                      )}

                      {/* User Item 3-dots Menu */}
                      <div className="relative">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuUserId(openMenuUserId === u.pseudoId ? null : u.pseudoId);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              setOpenMenuUserId(openMenuUserId === u.pseudoId ? null : u.pseudoId);
                            }
                          }}
                          className={`h-6 w-6 rounded flex items-center justify-center text-sm font-bold transition hover:bg-black/10 dark:hover:bg-white/10 ${
                            isHacker ? 'text-[#00FF66]/70 hover:text-[#00FF66]' : isPro ? 'text-slate-400 hover:text-white' : 'text-[#54656F] hover:text-[#111B21]'
                          }`}
                          title="Options"
                          aria-label="Options"
                        >
                          ⋮
                        </span>
                        {openMenuUserId === u.pseudoId && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className={`absolute right-0 top-full mt-1 w-44 rounded-xl p-1.5 shadow-2xl z-50 border transition ${
                              isHacker
                                ? 'bg-[#050D07] border-[#00FF66]/40 text-[#00FF66]'
                                : isPro
                                ? 'bg-[#0F172A] border-slate-700 text-white'
                                : 'bg-white border-[#E9EDEF] text-[#111B21]'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuUserId(null);
                                if (isUserBlocked) {
                                  onUnblockUser?.(u.pseudoId, u.displayName);
                                } else {
                                  onBlockUser?.(u.pseudoId, u.displayName);
                                }
                              }}
                              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                                isHacker
                                  ? 'hover:bg-[#00FF66]/10'
                                  : isPro
                                  ? 'hover:bg-white/5'
                                  : 'hover:bg-[#F5F6F6]'
                              } ${isUserBlocked ? 'text-emerald-500 hover:text-emerald-400' : 'text-red-500 hover:text-red-400'}`}
                            >
                              <span>{isUserBlocked ? '🟢' : '🚫'}</span>
                              <span>{isUserBlocked ? 'Unblock User' : 'Block User'}</span>
                            </button>
                            {existingConvo && onDeleteChat && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuUserId(null);
                                  onDeleteChat(existingConvo.id);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 transition text-left ${
                                  isHacker
                                    ? 'hover:bg-[#00FF66]/10'
                                    : isPro
                                    ? 'hover:bg-white/5'
                                    : 'hover:bg-[#F5F6F6]'
                                }`}
                              >
                                <span>🗑️</span>
                                <span>Delete Chat</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
              </ul>
            )}
          </div>
        )}

        {/* TAB 3: FRIEND REQUESTS */}
        {tab === 'REQUESTS' && (
          <div>
            {/* Group Invites Section */}
            {groupRequests.length > 0 && (
              <div className="mb-4">
                <div
                  className={`flex items-center gap-2 px-3.5 py-1.5 text-[11px] font-bold tracking-wider uppercase transition border-b ${
                    isHacker
                      ? 'bg-[#00FF66]/10 text-[#00FF66] border-[#00FF66]/30'
                      : isMidnight
                      ? 'bg-indigo-600/10 text-indigo-300 border-[#222738]'
                      : isPro
                      ? 'bg-blue-600/10 text-blue-300 border-slate-800'
                      : 'bg-emerald-50 text-[#008069] border-[#E9EDEF]'
                  }`}
                >
                  <span>👥 Group Invites ({groupRequests.length})</span>
                </div>
                <ul>
                  {groupRequests.map((gReq) => (
                    <li
                      key={gReq.id}
                      className={`p-3.5 transition border-b flex items-center justify-between gap-3 ${
                        isHacker
                          ? 'hover:bg-[#07150A] border-[#00FF66]/10 text-[#00FF66]'
                          : isPro
                          ? 'hover:bg-[#1E293B]/60 border-slate-800/60 text-slate-200'
                          : 'hover:bg-[#F5F6F6] border-[#E9EDEF] text-[#111B21]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={gReq.groupTitle} src={gReq.groupAvatarUrl} size={40} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold">{gReq.groupTitle}</p>
                          <p className="text-[11px] opacity-70">
                            Invited by <strong className="font-semibold">{gReq.invitedBy.displayName}</strong> • {gReq.memberCount} members
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          disabled={processingRequestId === gReq.id}
                          onClick={() => handleAcceptGroupRequest(gReq)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition shadow disabled:opacity-50 ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#008069] hover:bg-[#006A57]'
                          }`}
                        >
                          Accept
                        </button>
                        <button
                          disabled={processingRequestId === gReq.id}
                          onClick={() => handleDeclineGroupRequest(gReq.id)}
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                            isHacker
                              ? 'border border-[#00FF66]/30 text-[#00FF66]/70 hover:bg-[#00FF66]/10'
                              : isPro
                              ? 'border border-white/10 text-white/60 hover:bg-white/10'
                              : 'border border-[#D1D7DB] text-[#54656F] hover:bg-[#E9EDEF]'
                          }`}
                        >
                          Decline
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div
              className={`px-3.5 py-1.5 text-[11px] font-bold tracking-wider uppercase transition shadow-sm ${
                isHacker
                  ? 'bg-[#07150A] text-[#00FF66] border-b border-[#00FF66]/30'
                  : isMidnight
                  ? 'bg-[#131722] text-indigo-300 border-b border-[#222738]'
                  : isPro
                  ? 'bg-[#131E36] text-blue-300 border-b border-slate-800'
                  : 'bg-[#F0F2F5] text-[#54656F] border-b border-[#E9EDEF]'
              }`}
            >
              Incoming Friend Requests ({requests.incoming.length})
            </div>

            {requests.incoming.length === 0 ? (
              <p className={`p-6 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-slate-400' : 'text-[#667781]'}`}>
                No pending incoming requests.
              </p>
            ) : (
              <ul>
                {requests.incoming.map((req) => (
                  <li
                    key={req.id}
                    className={`p-3.5 transition border-b ${
                      isHacker
                        ? 'hover:bg-[#07150A] border-[#00FF66]/10 text-[#00FF66]'
                        : isPro
                        ? 'hover:bg-[#1E293B]/60 border-slate-800/60 text-slate-200'
                        : 'hover:bg-[#F5F6F6] border-[#E9EDEF] text-[#111B21]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={req.user.displayName} src={req.user.avatarUrl} size={38} />
                        <div className="min-w-0">
                          <p className={`truncate text-sm font-semibold ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-white' : 'text-[#111B21]'}`}>
                            {req.user.displayName}
                          </p>
                          {req.user.numericId && (
                            <span
                              className={`inline-block mt-0.5 rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                                isHacker
                                  ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                                  : isPro
                                  ? 'bg-blue-500/20 border border-blue-400/30 text-blue-300'
                                  : 'bg-[#E9EDEF] text-[#54656F] border border-[#D1D7DB]'
                              }`}
                            >
                              User ID: {req.user.numericId}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          disabled={processingRequestId === req.id}
                          onClick={() => handleAcceptRequest(req.id, req.user.displayName)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition shadow disabled:opacity-50 ${
                            isHacker
                              ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                              : isPro
                              ? 'bg-blue-600 hover:bg-blue-500'
                              : 'bg-[#128C7E] hover:bg-[#075E54]'
                          }`}
                        >
                          Accept
                        </button>
                        <button
                          disabled={processingRequestId === req.id}
                          onClick={() => handleDeclineRequest(req.id)}
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                            isHacker
                              ? 'border border-[#00FF66]/30 text-[#00FF66]/70 hover:bg-[#00FF66]/10'
                              : isPro
                              ? 'border border-white/10 text-white/60 hover:bg-white/10'
                              : 'border border-[#D1D7DB] text-[#54656F] hover:bg-[#E9EDEF]'
                          }`}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Outgoing Requests */}
            <div
              className={`mt-4 px-3.5 py-1.5 text-[11px] font-bold tracking-wider uppercase transition shadow-sm ${
                isHacker
                  ? 'bg-[#07150A] text-[#00FF66] border-b border-[#00FF66]/30'
                  : isMidnight
                  ? 'bg-[#131722] text-indigo-300 border-b border-[#222738]'
                  : isPro
                  ? 'bg-[#131E36] text-blue-300 border-b border-slate-800'
                  : 'bg-[#F0F2F5] text-[#54656F] border-b border-[#E9EDEF]'
              }`}
            >
              Sent Requests ({requests.outgoing.length})
            </div>

            {requests.outgoing.length === 0 ? (
              <p className={`p-6 text-center text-xs ${isHacker ? 'text-[#00FF66]/50' : isPro ? 'text-slate-400' : 'text-[#667781]'}`}>
                No pending sent requests.
              </p>
            ) : (
              <ul>
                {requests.outgoing.map((req) => (
                  <li
                    key={req.id}
                    className={`flex items-center justify-between gap-3 p-3.5 transition border-b ${
                      isHacker
                        ? 'hover:bg-[#07150A] border-[#00FF66]/10 text-[#00FF66]'
                        : isPro
                        ? 'hover:bg-[#1E293B]/60 border-slate-800/60 text-slate-200'
                        : 'hover:bg-[#F5F6F6] border-[#E9EDEF] text-[#111B21]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={req.user.displayName} src={req.user.avatarUrl} size={38} />
                      <div className="min-w-0">
                        <p className={`truncate text-sm font-semibold ${isHacker ? 'text-[#00FF66]' : isPro ? 'text-white' : 'text-[#111B21]'}`}>
                          {req.user.displayName}
                        </p>
                        {req.user.numericId && (
                          <span
                            className={`inline-block mt-0.5 rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                              isHacker
                                ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                                : isPro
                                ? 'bg-blue-500/20 border border-blue-400/30 text-blue-300'
                                : 'bg-[#E9EDEF] text-[#54656F] border border-[#D1D7DB]'
                            }`}
                          >
                            User ID: {req.user.numericId}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[11px] font-medium ${isHacker ? 'text-amber-400' : isPro ? 'text-amber-400' : 'text-amber-600'}`}>
                        Pending acceptance…
                      </span>
                      <button
                        onClick={() => handleDeclineRequest(req.id)}
                        className={`rounded border px-2 py-1 text-[10px] transition ${
                          isHacker
                            ? 'border border-[#00FF66]/30 text-[#00FF66]/70 hover:bg-[#00FF66]/10'
                            : isPro
                            ? 'border border-white/10 text-white/60 hover:bg-white/10'
                            : 'border border-[#D1D7DB] text-[#54656F] hover:bg-[#E9EDEF]'
                        }`}
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* TAB 4: GROUPS */}
        {tab === 'GROUPS' && (
          <div>
            <div
              className={`flex items-center justify-between px-3.5 py-2 text-[11px] font-bold tracking-wider uppercase transition shadow-sm ${
                isHacker
                  ? 'bg-[#07150A] text-[#00FF66] border-b border-[#00FF66]/30'
                  : isMidnight
                  ? 'bg-[#131722] text-indigo-300 border-b border-[#222738]'
                  : isPro
                  ? 'bg-[#131E36] text-blue-300 border-b border-slate-800'
                  : 'bg-[#F0F2F5] text-[#54656F] border-b border-[#E9EDEF]'
              }`}
            >
              <span>Groups ({conversations.filter((c) => c.type === 'GROUP').length})</span>
              <button
                onClick={() => setIsCreateGroupOpen(true)}
                className={`rounded px-2.5 py-1 text-xs font-semibold text-white transition ${
                  isHacker
                    ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                    : isPro
                    ? 'bg-blue-600 hover:bg-blue-500'
                    : 'bg-[#008069] hover:bg-[#006A57]'
                }`}
              >
                + Create Group
              </button>
            </div>

            {/* List of groups */}
            {conversations.filter((c) => c.type === 'GROUP').length === 0 ? (
              <div className="p-8 text-center text-xs opacity-60">
                <span className="text-3xl block mb-2">👥</span>
                <p className="font-semibold">No groups yet</p>
                <p className="mt-1 opacity-75">Create a group to chat with multiple people at once</p>
              </div>
            ) : (
              <ul className="divide-y divide-black/5">
                {conversations
                  .filter((c) => c.type === 'GROUP')
                  .map((convo) => {
                    const isActive = convo.id === activeId;
                    const unreadCount = unread[convo.id] || convo.unreadCount || 0;
                    return (
                      <li
                        key={convo.id}
                        onClick={() => onSelect(convo.id)}
                        className={`flex items-center gap-3 p-3.5 cursor-pointer transition select-none ${
                          isActive
                            ? isHacker
                              ? 'bg-[#00FF66]/20 border-l-4 border-[#00FF66]'
                              : isPro
                              ? 'bg-[#1E293B] border-l-4 border-blue-500'
                              : 'bg-[#F0F2F5] border-l-4 border-[#008069]'
                            : isHacker
                            ? 'hover:bg-[#07150A]'
                            : isPro
                            ? 'hover:bg-[#1E293B]/60'
                            : 'hover:bg-[#F5F6F6]'
                        }`}
                      >
                        <Avatar name={convo.title} src={convo.avatarUrl} size={48} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <p className="truncate text-sm font-semibold">{convo.title}</p>
                            {convo.lastMessage && (
                              <span className="text-[10px] opacity-60 shrink-0">
                                {new Date(convo.lastMessage.at).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between mt-1">
                            <p className="truncate text-xs opacity-70">
                              {convo.lastMessage?.snippet || 'Encrypted group chat'}
                            </p>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium opacity-70">
                                {convo.memberCount ? `${convo.memberCount} members` : 'Group'}
                              </span>
                              {unreadCount > 0 && (
                                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#25D366] px-1 text-[10px] font-bold text-white">
                                  {unreadCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}

            <div className="p-3.5 border-t border-black/5">
              <button
                onClick={() => {
                  const code = window.prompt('Group invite code');
                  if (code) onJoinGroup(code.trim());
                }}
                className={`w-full rounded-lg border border-dashed py-2.5 text-xs font-medium transition ${
                  isHacker
                    ? 'border-[#00FF66]/40 bg-[#00FF66]/5 text-[#00FF66] hover:bg-[#00FF66]/10'
                    : isPro
                    ? 'border-blue-500/40 bg-blue-500/5 text-blue-300 hover:bg-blue-500/10'
                    : 'border-[#D1D7DB] bg-[#F0F2F5] text-[#54656F] hover:bg-[#E9EDEF]'
                }`}
              >
                Join a group with an invite code
              </button>
            </div>
          </div>
        )}
      </div>

      {isProfileOpen && (
        <ProfileModal
          user={
            user ?? {
              pseudoId: '',
              displayName: selfName,
              avatarUrl: selfAvatarUrl ?? null,
              contactCode: selfContactCode,
              numericId: selfNumericId,
              role: isAdmin ? 'ADMIN' : 'USER',
              keyFingerprint: '',
              createdAt: new Date().toISOString(),
            }
          }
          isOpen={isProfileOpen}
          onClose={() => setIsProfileOpen(false)}
          onLogout={onLogout}
          onUpdated={(updated) => {
            onProfileUpdated?.(updated);
            showToast('Profile updated successfully!');
          }}
        />
      )}

      {isCreateGroupOpen && (
        <CreateGroupModal
          isOpen={isCreateGroupOpen}
          onClose={() => setIsCreateGroupOpen(false)}
          users={allUsers}
          currentUserId={user?.pseudoId}
          onGroupCreated={(newGroup) => {
            showToast(`Group "${newGroup.title}" created!`);
            onSelect(newGroup.id);
            void api.conversations().then((list) => {
              // Trigger parent conversation reload
            });
          }}
        />
      )}
    </aside>
  );
}
