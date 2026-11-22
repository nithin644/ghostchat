'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConversationDetail, ConversationSummary, QuotedMessageDTO, UserSearchResult } from '@ghostchat/shared-types';
import type { UiMessage } from '../store/chatSlice';
import { Avatar } from './Avatar';
import { StatusTicks } from './StatusTicks';
import { FileAttachment } from './FileAttachment';
import { VerifiedBadge } from './VerifiedBadge';
import { ForwardModal } from './ForwardModal';
import { GroupInfoModal } from './GroupInfoModal';
import { useTheme } from '../lib/theme';
import {
  startWalkieTransmission,
  stopWalkieTransmission,
  isWalkieTransmitting,
  subscribeWalkieSpeaker,
} from '../lib/walkie';

export interface ChatWindowProps {
  conversation: ConversationDetail | null;
  messages: UiMessage[];
  typingLabel: string | null;
  sessionReady: boolean;
  currentUserPseudoId?: string;
  uploadingFile?: string | null;
  isPeerBlocked?: boolean;
  allUsers?: UserSearchResult[];
  conversations?: ConversationSummary[];
  onSend: (text: string, replyTo?: QuotedMessageDTO | null) => void;
  onAttach: (file: File) => void;
  onTyping: (typing: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
  onStartCall: (kind: 'AUDIO' | 'VIDEO', screenShare?: boolean) => void;
  onBack: () => void;
  onLogout?: () => void;
  onDeleteChat?: () => void;
  onBlockUser?: () => void;
  onUnblockUser?: () => void;
  onForwardMessage?: (text: string, originalSender: string) => void;
  onForwardToConversation?: (conversationId: string, text: string) => void;
  onForwardToUser?: (targetUser: UserSearchResult, text: string) => void;
  onMemberRemoved?: (pseudoId: string) => void;
  onGroupLeft?: () => void;
  onGroupUpdated?: () => void;
}

const QUICK_REACTIONS = [
  '👍', '❤️', '😂', '🔥', '😮', '😢', '🙏', '🎉', '👏', '💯', '💀', '👀', '😍', '🤝',
];

const EMOJI_CATEGORIES = [
  {
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌',
      '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😔', '😪',
      '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠',
      '🥳', '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺',
      '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫',
      '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👻', '👽', '🤖',
    ],
  },
  {
    name: 'Gestures',
    icon: '👍',
    emojis: [
      '👍', '👎', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾',
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙',
      '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '✊', '👊', '🤛', '🤜', '🫡', '🦶', '🦵',
    ],
  },
  {
    name: 'Hearts & Vibes',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓',
      '💗', '💖', '💘', '💝', '💟', '🔥', '💥', '✨', '🌟', '💫', '💯', '💢', '💤', '⚡',
      '🌈', '☀️', '⭐', '🌙', '☁️', '🌹', '🌸', '💐', '🌺', '🍀', '🍁',
    ],
  },
  {
    name: 'Fun & Objects',
    icon: '🎉',
    emojis: [
      '🎉', '🎊', '🎈', '🎂', '🎁', '🏆', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🎾',
      '🎮', '🎯', '🎲', '🎰', '🎵', '🎶', '🎸', '🎹', '📱', '💻', '🖥️', '📷', '📸', '🔒',
      '🔓', '🔑', '🗝️', '💣', '🧨', '🔫', '🍺', '🍻', '🥂', '🍷', '☕', '🍕', '🍔', '🍟',
      '🌮', '🍿', '🍩', '🍪', '👑', '💎', '🚀', '👀', '👁️', '💬', '📢', '💰', '💸',
    ],
  },
];

export function ChatWindow({
  conversation,
  messages,
  typingLabel,
  sessionReady,
  currentUserPseudoId,
  uploadingFile,
  isPeerBlocked = false,
  allUsers = [],
  conversations = [],
  onSend,
  onAttach,
  onTyping,
  onReact,
  onStartCall,
  onBack,
  onLogout,
  onDeleteChat,
  onBlockUser,
  onUnblockUser,
  onForwardMessage,
  onForwardToConversation,
  onForwardToUser,
  onMemberRemoved,
  onGroupLeft,
  onGroupUpdated,
}: ChatWindowProps) {
  const { theme } = useTheme();
  const isHacker = theme === 'hacker';
  const isPro = theme === 'pro';
  const isMidnight = theme === 'midnight';
  const isNordic = theme === 'nordic';
  const isDark = isHacker || isPro || isMidnight;
  const isDarkPro = isPro || isMidnight;

  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<QuotedMessageDTO | null>(null);
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [activeBubbleMenuId, setActiveBubbleMenuId] = useState<string | null>(null);
  const bubbleMenuRef = useRef<HTMLDivElement | null>(null);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState(0);
  const [forwardModalData, setForwardModalData] = useState<{ text: string; senderName: string } | null>(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const fallbackCopy = (text: string) => {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    } catch {}
  };

  const handleCopyMessage = (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    } catch {
      fallbackCopy(text);
    }
    showToast('Message copied to clipboard');
  };

  // Close options menu when clicking outside
  useEffect(() => {
    if (!optionsOpen) return;

    const handlePointerOutside = (event: PointerEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(event.target as Node)) {
        setOptionsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOptionsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [optionsOpen]);

  // Close bubble 3-dot menu when clicking outside
  useEffect(() => {
    if (!activeBubbleMenuId) return;
    const handleBubblePointerOutside = (event: PointerEvent) => {
      if (bubbleMenuRef.current && bubbleMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setActiveBubbleMenuId(null);
    };
    document.addEventListener('pointerdown', handleBubblePointerOutside);
    return () => document.removeEventListener('pointerdown', handleBubblePointerOutside);
  }, [activeBubbleMenuId]);

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll messages container to bottom without scrolling window/viewport on mobile
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages.length, conversation?.id]);

  // Walkie-Talkie Push-to-Talk State
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [incomingWalkieSpeaker, setIncomingWalkieSpeaker] = useState<{ displayName: string; conversationId: string } | null>(null);
  const isHoldModeRef = useRef(false);

  useEffect(() => {
    const unsub = subscribeWalkieSpeaker((speaker) => {
      setIncomingWalkieSpeaker(speaker);
    });
    return unsub;
  }, []);

  useEffect(() => {
    return () => {
      if (isWalkieTransmitting()) {
        stopWalkieTransmission();
      }
    };
  }, [conversation?.id]);

  // Voice Note Recording State
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceDuration, setVoiceDuration] = useState(0);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
      if (voiceStreamRef.current) {
        voiceStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const formatVoiceDuration = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const startVoiceNote = async () => {
    if (isPeerBlocked) {
      alert('You have blocked this contact. Unblock to send voice notes.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];

      const mime =
        typeof window !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          voiceChunksRef.current.push(e.data);
        }
      };

      recorder.start(100);
      voiceRecorderRef.current = recorder;
      setIsRecordingVoice(true);
      setVoiceDuration(0);

      if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = setInterval(() => {
        setVoiceDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      console.error('Microphone error:', err);
      alert('Could not access microphone to record voice note. Please allow microphone permissions.');
    }
  };

  const cancelVoiceNote = () => {
    if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
    voiceTimerRef.current = null;

    if (voiceRecorderRef.current) {
      try {
        voiceRecorderRef.current.ondataavailable = null;
        voiceRecorderRef.current.stop();
      } catch {}
      voiceRecorderRef.current = null;
    }

    if (voiceStreamRef.current) {
      voiceStreamRef.current.getTracks().forEach((t) => t.stop());
      voiceStreamRef.current = null;
    }

    voiceChunksRef.current = [];
    setIsRecordingVoice(false);
    setVoiceDuration(0);
  };

  const sendVoiceNote = () => {
    if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
    voiceTimerRef.current = null;

    const recorder = voiceRecorderRef.current;
    const stream = voiceStreamRef.current;

    if (!recorder || recorder.state === 'inactive') {
      cancelVoiceNote();
      return;
    }

    recorder.onstop = () => {
      try {
        const mime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: mime });
        if (blob.size > 0) {
          const file = new File([blob], `voice-note-${Date.now()}.webm`, { type: mime });
          onAttach(file);
        }
      } catch (err) {
        console.error('Voice note attachment error:', err);
      } finally {
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
        }
        voiceStreamRef.current = null;
        voiceRecorderRef.current = null;
        voiceChunksRef.current = [];
        setIsRecordingVoice(false);
        setVoiceDuration(0);
      }
    };

    try {
      recorder.stop();
    } catch {
      cancelVoiceNote();
    }
  };

  const handleStartWalkie = async () => {
    if (!conversation) return;
    if (isPeerBlocked) {
      alert('You have blocked this contact. Unblock to use walkie-talkie.');
      return;
    }
    const ok = await startWalkieTransmission(conversation.id);
    if (ok && isHoldModeRef.current) {
      setIsTransmitting(true);
    } else if (ok) {
      stopWalkieTransmission();
      setIsTransmitting(false);
    }
  };

  const handleStopWalkie = () => {
    stopWalkieTransmission();
    setIsTransmitting(false);
  };

  const startWalkieHold = (event?: React.PointerEvent<HTMLButtonElement>) => {
    event?.preventDefault();
    event?.currentTarget.setPointerCapture?.(event.pointerId);
    if (isHoldModeRef.current) return;
    isHoldModeRef.current = true;
    void handleStartWalkie();
  };

  const stopWalkieHold = () => {
    if (isHoldModeRef.current) {
      isHoldModeRef.current = false;
      handleStopWalkie();
    }
  };

  useEffect(() => {
    const stopOnRelease = () => {
      if (isHoldModeRef.current) {
        isHoldModeRef.current = false;
        stopWalkieTransmission();
        setIsTransmitting(false);
      }
    };
    const stopWhenHidden = () => {
      if (document.visibilityState !== 'visible') stopOnRelease();
    };

    window.addEventListener('pointerup', stopOnRelease);
    window.addEventListener('pointercancel', stopOnRelease);
    window.addEventListener('blur', stopOnRelease);
    document.addEventListener('visibilitychange', stopWhenHidden);

    return () => {
      window.removeEventListener('pointerup', stopOnRelease);
      window.removeEventListener('pointercancel', stopOnRelease);
      window.removeEventListener('blur', stopOnRelease);
      document.removeEventListener('visibilitychange', stopWhenHidden);
      if (isHoldModeRef.current) isHoldModeRef.current = false;
      if (isWalkieTransmitting()) stopWalkieTransmission();
    };
  }, [conversation?.id]);

  if (!conversation) {
    return (
      <section
        className={`hidden flex-1 flex-col items-center justify-center md:flex ${
          isHacker
            ? 'bg-[#020503] font-mono text-[#00FF66]'
            : isPro
            ? 'bg-[#0A0F1D] text-slate-300'
            : isMidnight
            ? 'bg-[#090A0F] text-slate-300'
            : isNordic
            ? 'bg-[#F8FAFC] text-slate-600'
            : 'bg-wa-panel text-black/60'
        }`}
      >
        <div className="max-w-sm text-center">
          <h2 className="text-xl font-bold tracking-wider">
            {isHacker
              ? '⚡ GHOST_CHAT // TERMINAL'
              : isPro
              ? '💼 PrivateChat Enterprise'
              : isMidnight
              ? '🌌 PrivateChat Midnight'
              : isNordic
              ? '❄️ PrivateChat Nordic'
              : 'GhostChat'}
          </h2>
          <p className="mt-2 text-sm opacity-60">
            Messages are end-to-end encrypted. The server relays ciphertext and cannot read them.
          </p>
        </div>
      </section>
    );
  }

  // Find peer details for 1:1 direct conversations
  const peer =
    conversation.type === 'DIRECT'
      ? conversation.members?.find((m) => m.pseudoId !== currentUserPseudoId) ??
        conversation.members?.[0]
      : null;
  const peerTitle =
    conversation.type === 'DIRECT' ? (peer?.displayName ?? conversation.title) : conversation.title;
  const peerNumericId = peer?.numericId;
  const peerAvatarUrl =
    conversation.type === 'DIRECT' ? (peer?.avatarUrl ?? conversation.avatarUrl) : conversation.avatarUrl;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text, replyingTo);
    setDraft('');
    setReplyingTo(null);
    setEmojiOpen(false);
    setActiveReactionPickerMessageId(null);
    onTyping(false);
  };

  const handleStartReply = (msg: UiMessage) => {
    const senderName = msg.mine
      ? 'You'
      : msg.senderDisplayName || (conversation.type === 'DIRECT' ? peerTitle : 'Member');
    const textSnippet = (msg.text || (msg.failed ? '⚠️ Decryption failed' : '🔒 Encrypted message')).slice(0, 100);
    setReplyingTo({
      id: msg.id || msg.clientRef,
      senderName,
      textSnippet,
    });
    setActiveReactionPickerMessageId(null);
    setActiveBubbleMenuId(null);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  };

  const handleStartForward = (msg: UiMessage) => {
    const senderName = msg.mine
      ? 'You'
      : msg.senderDisplayName || (conversation.type === 'DIRECT' ? peerTitle : 'Member');
    const text = msg.text || '';
    if (!text) return;
    setForwardModalData({ text, senderName });
    setActiveBubbleMenuId(null);
  };

  const scrollToMessage = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-wa-green');
      setTimeout(() => el.classList.remove('ring-2', 'ring-wa-green'), 1200);
    }
  };

  return (
    <section
      className={`flex h-full max-h-full min-w-0 flex-1 flex-col overflow-hidden ${
        isHacker
          ? 'bg-[#030804] font-mono text-[#00FF66]'
          : isPro
          ? 'bg-[#0A0F1D] text-slate-100'
          : isMidnight
          ? 'bg-[#0A0D14] text-[#F8FAFC]'
          : isNordic
          ? 'bg-[#F8FAFC] text-slate-900'
          : 'bg-[#EFEAE2]'
      }`}
    >
      {/* Sticky Mobile Header */}
      <header
        className={`sticky top-0 z-30 shrink-0 flex items-center gap-3 px-3 py-2.5 transition shadow-sm ${
          isHacker
            ? 'bg-[#07150A] border-b border-[#00FF66]/30 text-[#00FF66] shadow-[0_2px_10px_rgba(0,255,102,0.1)]'
            : isPro
            ? 'bg-[#0F172A] border-b border-blue-500/20 text-white shadow-sm'
            : isMidnight
            ? 'bg-[#121522] border-b border-indigo-500/20 text-white shadow-sm'
            : isNordic
            ? 'bg-[#FFFFFF] border-b border-slate-200 text-slate-900 shadow-sm'
            : 'bg-wa-header text-white'
        }`}
      >
        <button
          onClick={onBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-white/10"
          aria-label="Back to chat list"
        >
          <span className="text-xl leading-none">←</span>
        </button>
        <div
          onClick={() => {
            if (conversation.type === 'GROUP') setGroupInfoOpen(true);
          }}
          className={`flex items-center gap-3 min-w-0 flex-1 ${
            conversation.type === 'GROUP' ? 'cursor-pointer hover:opacity-90 transition' : ''
          }`}
          title={conversation.type === 'GROUP' ? 'Click to view group info & members' : undefined}
        >
          <Avatar name={peerTitle} src={peerAvatarUrl} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-[15px] font-bold leading-tight">{peerTitle}</p>
              {conversation.type === 'GROUP' && (
                <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0">
                  Group
                </span>
              )}
              {peer?.isVerified && <VerifiedBadge size={13} />}
              {peerNumericId && (
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold shrink-0 ${
                    isHacker
                      ? 'bg-[#00FF66]/20 border border-[#00FF66]/40 text-[#00FF66]'
                      : isPro
                      ? 'bg-blue-500/20 border border-blue-400/30 text-blue-300'
                      : 'bg-white/20 text-emerald-100'
                  }`}
                >
                  ID: {peerNumericId}
                </span>
              )}
            </div>
            <p className="truncate text-[11px] opacity-80 leading-tight">
              {conversation.type === 'GROUP' ? (
                <span className="font-medium">
                  {conversation.members?.length || 0} members: {conversation.members?.map((m) => m.displayName).slice(0, 3).join(', ')}{(conversation.members?.length || 0) > 3 ? '…' : ''}
                </span>
              ) : isPeerBlocked ? (
                <span className="font-bold text-red-400">🚫 Blocked Contact</span>
              ) : (
                typingLabel ?? (sessionReady ? '🔒 end-to-end encrypted' : 'establishing encrypted session…')
              )}
            </p>
          </div>
        </div>

        {/* Encrypted Status Pill (Reference UI) */}
        <div
          className={`hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold shadow-sm select-none border transition ${
            isHacker
              ? 'bg-[#00FF66]/10 border-[#00FF66]/30 text-[#00FF66]'
              : isPro
              ? 'bg-[#182338] border-emerald-500/30 text-emerald-400'
              : 'bg-white/90 border-emerald-500/30 text-emerald-800'
          }`}
          title="End-to-End Encrypted via Double Ratchet & DTLS-SRTP"
        >
          <span className="text-xs">🔒</span>
          <span>Encrypted</span>
        </div>

        {/* Action Buttons Group (Matching Reference Image) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Audio Call Button */}
          <button
            onClick={() => {
              if (isPeerBlocked) {
                alert('You have blocked this contact. Unblock to make calls.');
                return;
              }
              onStartCall('AUDIO');
            }}
            className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition border ${
              isPeerBlocked
                ? 'opacity-40 cursor-not-allowed border-slate-700 bg-slate-800/40 text-slate-500'
                : isHacker
                ? 'border-[#00FF66]/40 bg-[#00FF66]/10 text-[#00FF66] hover:bg-[#00FF66]/20'
                : 'bg-[#182232] hover:bg-[#233146] text-slate-300 hover:text-white border-slate-700/60 shadow-sm hover:scale-105 active:scale-95'
            }`}
            aria-label="Voice call"
            title={isPeerBlocked ? 'Blocked' : 'Voice call'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </button>

          {/* Video Call Button */}
          <button
            onClick={() => {
              if (isPeerBlocked) {
                alert('You have blocked this contact. Unblock to make calls.');
                return;
              }
              onStartCall('VIDEO');
            }}
            className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition border ${
              isPeerBlocked
                ? 'opacity-40 cursor-not-allowed border-slate-700 bg-slate-800/40 text-slate-500'
                : isHacker
                ? 'border-[#00FF66]/40 bg-[#00FF66]/10 text-[#00FF66] hover:bg-[#00FF66]/20'
                : 'bg-[#182232] hover:bg-[#233146] text-slate-300 hover:text-white border-slate-700/60 shadow-sm hover:scale-105 active:scale-95'
            }`}
            aria-label="Video call"
            title={isPeerBlocked ? 'Blocked' : 'Video call'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </button>

          {/* Screen Share Button (Pink / Magenta Reference Style) */}
          <button
            onClick={() => {
              if (isPeerBlocked) {
                alert('You have blocked this contact.');
                return;
              }
              onStartCall('VIDEO', true);
            }}
            className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition shadow-md ${
              isPeerBlocked
                ? 'opacity-40 cursor-not-allowed bg-pink-900/40 text-pink-300/40'
                : 'bg-[#E1436E] hover:bg-[#D0355F] text-white shadow-pink-500/25 hover:scale-105 active:scale-95'
            }`}
            aria-label="Share screen"
            title={isPeerBlocked ? 'Blocked' : 'Share Screen'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <path d="M12 13V7" />
              <path d="M9 10l3-3 3 3" />
            </svg>
          </button>

          {/* Walkie-Talkie Push-to-Talk Button */}
          <button
            onPointerDown={(event) => !isPeerBlocked && startWalkieHold(event)}
            onPointerUp={() => !isPeerBlocked && stopWalkieHold()}
            onPointerCancel={() => stopWalkieHold()}
            onPointerLeave={(event) => event.buttons === 0 && stopWalkieHold()}
            onLostPointerCapture={() => stopWalkieHold()}
            onContextMenu={(event) => event.preventDefault()}
            className={`touch-none select-none h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition border ${
              isTransmitting
                ? 'bg-red-500 text-white animate-pulse shadow-lg scale-105 ring-2 ring-red-400 border-red-400'
                : isPeerBlocked
                ? 'opacity-40 cursor-not-allowed border-slate-700 bg-slate-800/40 text-slate-500'
                : isHacker
                ? 'border-[#00FF66]/40 bg-[#00FF66]/10 text-[#00FF66] hover:bg-[#00FF66]/20'
                : 'bg-[#182232] hover:bg-[#233146] text-amber-400 border-slate-700/60 shadow-sm hover:scale-105 active:scale-95'
            }`}
            aria-label="Walkie-Talkie Push-to-Talk"
            title={isTransmitting ? 'Transmitting... Release to stop' : '📻 Walkie-Talkie (Hold to talk)'}
          >
            <span className="text-base leading-none">📻</span>
          </button>

          {/* Options Dropdown Menu for Delete Chat / Block Contact */}
          <div ref={optionsMenuRef} className="relative">
            <button
              type="button"
              aria-expanded={optionsOpen}
              onClick={(event) => {
                event.stopPropagation();
                setOptionsOpen((prev) => !prev);
              }}
              className={`h-9 w-9 shrink-0 flex items-center justify-center rounded-full text-sm font-bold transition border ${
                isHacker
                  ? 'border-[#00FF66]/40 bg-[#00FF66]/10 text-[#00FF66] hover:bg-[#00FF66]/20'
                  : 'bg-[#182232] hover:bg-[#233146] text-slate-300 hover:text-white border-slate-700/60 shadow-sm hover:scale-105 active:scale-95'
              }`}
              title="Chat options"
              aria-label="Chat options"
            >
              ⋮
            </button>
          {optionsOpen && (
            <div
              className={`absolute right-0 top-full mt-2 w-48 rounded-xl p-1.5 shadow-2xl z-50 border transition ${
                isHacker
                  ? 'bg-[#050D07] border-[#00FF66]/40 text-[#00FF66]'
                  : isPro
                  ? 'bg-[#0F172A] border-slate-700 text-white'
                  : isMidnight
                  ? 'bg-[#111522] border-[#2A3146] text-white'
                  : isNordic
                  ? 'bg-white border-slate-200 text-slate-900 shadow-xl'
                  : 'bg-white border-[#E9EDEF] text-[#111B21]'
              }`}
            >
              {conversation.type === 'DIRECT' && (
                <button
                  onClick={() => {
                    setOptionsOpen(false);
                    if (isPeerBlocked) {
                      onUnblockUser?.();
                    } else {
                      onBlockUser?.();
                    }
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                    isHacker
                      ? 'hover:bg-[#00FF66]/10'
                      : isPro
                      ? 'hover:bg-white/5'
                      : 'hover:bg-[#F5F6F6]'
                  } ${isPeerBlocked ? 'text-emerald-500 hover:text-emerald-400' : 'text-red-500 hover:text-red-400'}`}
                >
                  <span className="text-sm">{isPeerBlocked ? '🟢' : '🚫'}</span>
                  <span>{isPeerBlocked ? 'Unblock Contact' : 'Block Contact'}</span>
                </button>
              )}
              {onDeleteChat && (
                <button
                  onClick={() => {
                    setOptionsOpen(false);
                    onDeleteChat();
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 transition text-left ${
                    isHacker
                      ? 'hover:bg-[#00FF66]/10'
                      : isPro
                      ? 'hover:bg-white/5'
                      : 'hover:bg-[#F5F6F6]'
                  }`}
                >
                  <span className="text-sm">🗑️</span>
                  <span>Delete Chat</span>
                </button>
              )}
              {onLogout && (
                <>
                  <div className={`my-1 border-t ${
                    isHacker ? 'border-[#00FF66]/20' : isPro ? 'border-slate-800' : 'border-[#E9EDEF]'
                  }`} />
                  <button
                    onClick={() => {
                      setOptionsOpen(false);
                      if (window.confirm('Are you sure you want to log out of GhostChat?')) {
                        onLogout();
                      }
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 transition text-left ${
                      isHacker
                        ? 'hover:bg-[#00FF66]/10'
                        : isPro
                        ? 'hover:bg-white/5'
                        : 'hover:bg-[#F5F6F6]'
                    }`}
                  >
                    <span className="text-sm">🚪</span>
                    <span>Log Out</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      </header>

      {/* Active Walkie-Talkie Transmitting Banner */}
      {isTransmitting && (
        <div className="bg-red-600 text-white px-4 py-2 flex items-center justify-between text-xs font-bold shadow-md z-30 animate-pulse">
          <div className="flex items-center gap-2">
            <span className="text-base animate-bounce">📻</span>
            <span>WALKIE-TALKIE LIVE: Transmitting to {peerTitle} • Release to stop</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/30 px-2 py-0.5 rounded text-[11px] font-mono">
            <span className="h-2 w-2 rounded-full bg-white animate-ping" />
            <span>ON AIR</span>
          </div>
        </div>
      )}

      {/* Incoming Walkie-Talkie Speaker Banner */}
      {incomingWalkieSpeaker && incomingWalkieSpeaker.conversationId === conversation.id && !isTransmitting && (
        <div className="bg-emerald-600 text-white px-4 py-2 flex items-center justify-between text-xs font-bold shadow-md z-30 animate-pulse">
          <div className="flex items-center gap-2">
            <span className="text-base animate-bounce">📻</span>
            <span>WALKIE-TALKIE LIVE: {incomingWalkieSpeaker.displayName} is speaking live...</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/30 px-2 py-0.5 rounded text-[11px] font-mono">
            <span className="h-2 w-2 rounded-full bg-white animate-ping" />
            <span>LIVE</span>
          </div>
        </div>
      )}

      {/* Messages Stream Container */}
      <div
        ref={messagesContainerRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 min-h-0"
        style={{
          backgroundImage: isHacker
            ? 'radial-gradient(circle at 25% 25%, rgba(0,255,102,0.05) 1px, transparent 1px)'
            : isPro
            ? 'radial-gradient(circle at 25% 25%, rgba(59,130,246,0.05) 1px, transparent 1px)'
            : isMidnight
            ? 'radial-gradient(circle at 25% 25%, rgba(99,102,241,0.06) 1px, transparent 1px)'
            : isNordic
            ? 'radial-gradient(circle at 25% 25%, rgba(2,132,199,0.04) 1px, transparent 1px)'
            : 'radial-gradient(circle at 25% 25%, rgba(0,0,0,0.025) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        {messages.map((message) => {
          const isMine = message.mine;
          const msgId = message.id || message.clientRef;
          const isPickerOpen = activeReactionPickerMessageId === msgId;

          return (
            <div
              key={msgId}
              id={`msg-${msgId}`}
              className={`group relative flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
            >
              {/* Message Bubble + Action Buttons Container */}
              <div
                className={`relative flex items-end gap-1.5 max-w-[85%] sm:max-w-[75%] ${
                  isMine ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                {/* Bubble Body */}
                <div
                  className={`rounded-2xl px-3.5 py-2 text-[14px] leading-snug shadow-sm transition ${
                    isMine
                      ? isHacker
                        ? 'bg-[#003B15] text-[#00FF66] border border-[#00FF66]/40 shadow-[0_0_12px_rgba(0,255,102,0.15)] rounded-tr-sm'
                        : isPro
                        ? 'bg-blue-600 text-white shadow-blue-600/20 rounded-tr-sm'
                        : isMidnight
                        ? 'bg-indigo-600 text-white shadow-indigo-600/25 rounded-tr-sm'
                        : isNordic
                        ? 'bg-sky-600 text-white shadow-sky-600/20 rounded-tr-sm'
                        : 'bg-wa-bubbleOut text-black rounded-tr-sm'
                      : isHacker
                      ? 'bg-[#0A1C0E] text-[#00FF66] border border-[#00FF66]/20 rounded-tl-sm'
                      : isPro
                      ? 'bg-[#1E293B] text-slate-100 border border-slate-700/60 rounded-tl-sm'
                      : isMidnight
                      ? 'bg-[#151926] text-slate-100 border border-[#272D40] rounded-tl-sm shadow-sm'
                      : isNordic
                      ? 'bg-white text-slate-900 border border-slate-200/80 rounded-tl-sm shadow-sm'
                      : 'bg-wa-bubbleIn text-black rounded-tl-sm'
                  }`}
                >
                  {/* Sender Name — shown above every message bubble */}
                  {!isMine && (
                    <p
                      className={`mb-0.5 text-[11px] font-bold leading-tight ${
                        isHacker
                          ? 'text-[#00FF66]/80'
                          : isPro
                          ? 'text-blue-400'
                          : isMidnight
                          ? 'text-indigo-400'
                          : isNordic
                          ? 'text-sky-600'
                          : 'text-wa-greenDark'
                      }`}
                    >
                      {message.senderDisplayName ?? (conversation.type === 'GROUP' ? 'Member' : peerTitle)}
                    </p>
                  )}
                  {isMine && (
                    <p
                      className={`mb-0.5 text-[11px] font-bold leading-tight text-right ${
                        isHacker
                          ? 'text-[#00FF66]/60'
                          : isPro
                          ? 'text-blue-300/70'
                          : isMidnight
                          ? 'text-indigo-200/80'
                          : isNordic
                          ? 'text-sky-100'
                          : 'text-wa-greenDark/70'
                      }`}
                    >
                      You
                    </p>
                  )}

                  {/* Quoted Message Card */}
                  {message.replyTo && (
                    <div
                      onClick={() => scrollToMessage(message.replyTo!.id)}
                      className={`mb-2 rounded-lg border-l-4 px-2.5 py-1 text-xs cursor-pointer select-none transition ${
                        isHacker
                          ? 'border-[#00FF66] bg-black/50 text-[#00FF66]/90 hover:bg-black/70'
                          : isPro
                          ? 'border-blue-400 bg-slate-800/80 text-slate-200 hover:bg-slate-800'
                          : isMine
                          ? 'border-wa-greenDark bg-black/5 text-gray-800 hover:bg-black/10'
                          : 'border-wa-green bg-black/5 text-gray-800 hover:bg-black/10'
                      }`}
                      title="Click to view original message"
                    >
                      <p className="font-bold text-[11px] opacity-90 truncate">{message.replyTo.senderName}</p>
                      <p className="text-[11px] opacity-75 line-clamp-2">{message.replyTo.textSnippet}</p>
                    </div>
                  )}

                  {/* Message Content */}
                  {message.text?.startsWith('[file] ') ? (
                    <FileAttachment text={message.text} isMine={isMine} theme={theme} />
                  ) : (
                    <p className="break-words whitespace-pre-wrap">
                      {message.text ??
                        (message.failed
                          ? '⚠️ Decryption failed'
                          : isMine
                          ? '🔒 Encrypted message'
                          : '🔒 Encrypted message')}
                    </p>
                  )}

                  {/* Message Timestamp & Delivery Status Ticks */}
                  <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] opacity-60">
                    <span>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {isMine && (
                      <StatusTicks
                        state={
                          message.failed
                            ? 'pending'
                            : message.status ?? (message.pending ? 'pending' : 'sent')
                        }
                      />
                    )}
                  </div>
                </div>

                {/* Hover / Touch Quick Action Bar — 3-dot menu + React + Reply */}
                <div className={`relative flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity self-center shrink-0`}>
                  {/* React Button */}
                  <button
                    onClick={() => setActiveReactionPickerMessageId(isPickerOpen ? null : msgId)}
                    className={`rounded-full p-1 text-sm shadow-sm transition hover:scale-110 ${
                      isHacker
                        ? 'bg-black/70 text-[#00FF66] border border-[#00FF66]/30'
                        : isDarkPro
                        ? 'bg-slate-800 text-slate-200 border border-slate-700'
                        : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                    }`}
                    title="React with emoji"
                    aria-label="React"
                  >
                    😊
                  </button>
                  {/* Reply Button */}
                  <button
                    onClick={() => handleStartReply(message)}
                    className={`rounded-full p-1 text-sm shadow-sm transition hover:scale-110 ${
                      isHacker
                        ? 'bg-black/70 text-[#00FF66] border border-[#00FF66]/30'
                        : isDarkPro
                        ? 'bg-slate-800 text-slate-200 border border-slate-700'
                        : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                    }`}
                    title="Reply to message"
                    aria-label="Reply"
                  >
                    ↩️
                  </button>
                  {/* 3-dot Message Menu */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveBubbleMenuId(activeBubbleMenuId === msgId ? null : msgId);
                      }}
                      className={`rounded-full p-1 text-sm shadow-sm transition hover:scale-110 font-bold ${
                        isHacker
                          ? 'bg-black/70 text-[#00FF66] border border-[#00FF66]/30'
                          : isDarkPro
                          ? 'bg-slate-800 text-slate-200 border border-slate-700'
                          : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                      }`}
                      title="More options"
                      aria-label="Message options"
                    >
                      ⋮
                    </button>
                    {activeBubbleMenuId === msgId && (
                      <div
                        ref={bubbleMenuRef}
                        onPointerDown={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className={`absolute z-50 mt-1 w-36 rounded-xl p-1 shadow-2xl border ${
                          isMine ? 'right-0' : 'left-0'
                        } ${
                          isHacker
                            ? 'bg-[#050D07] border-[#00FF66]/40 text-[#00FF66]'
                            : isMidnight
                            ? 'bg-[#121522] border-[#2A3146] text-white'
                            : isPro
                            ? 'bg-[#0F172A] border-slate-700 text-white'
                            : 'bg-white border-gray-200 text-[#111B21]'
                        }`}
                      >
                        {/* Copy */}
                        {message.text && (
                          <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyMessage(message.text!);
                              setActiveBubbleMenuId(null);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                              isHacker ? 'hover:bg-[#00FF66]/10' : isPro ? 'hover:bg-white/5' : 'hover:bg-gray-100'
                            }`}
                          >
                            <span>📋</span>
                            <span>Copy</span>
                          </button>
                        )}
                        {/* Forward */}
                        {message.text && (
                          <button
                            type="button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartForward(message);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                              isHacker ? 'hover:bg-[#00FF66]/10' : isPro ? 'hover:bg-white/5' : 'hover:bg-gray-100'
                            }`}
                          >
                            <span>↪</span>
                            <span>Forward</span>
                          </button>
                        )}
                        {/* Reply */}
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartReply(message);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition text-left ${
                            isHacker ? 'hover:bg-[#00FF66]/10' : isPro ? 'hover:bg-white/5' : 'hover:bg-gray-100'
                          }`}
                        >
                          <span>↩️</span>
                          <span>Reply</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Reaction Picker Popover */}
              {isPickerOpen && (
                <div
                  className={`mt-1 flex items-center gap-1 rounded-full px-2.5 py-1 shadow-lg z-20 animate-in fade-in zoom-in-95 duration-100 ${
                    isHacker
                      ? 'bg-[#07150A] border border-[#00FF66] shadow-[0_0_15px_rgba(0,255,102,0.3)]'
                      : isMidnight
                      ? 'bg-[#121522] border border-indigo-500/40 shadow-indigo-950/50 text-white'
                      : isPro
                      ? 'bg-[#1E293B] border border-blue-500/40 shadow-blue-900/30'
                      : 'bg-white border border-gray-200 shadow-md'
                  }`}
                >
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        onReact(msgId, emoji);
                        setActiveReactionPickerMessageId(null);
                      }}
                      className="rounded-full p-1 text-base transition hover:scale-125 hover:bg-black/5 active:scale-95"
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                  <button
                    onClick={() => setActiveReactionPickerMessageId(null)}
                    className="ml-1 text-xs opacity-50 hover:opacity-100"
                    aria-label="Close reaction picker"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Message Reactions Pills */}
              {message.reactions && message.reactions.length > 0 && (
                <div
                  className={`mt-1 flex flex-wrap gap-1 ${
                    isMine ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.reactions.map((r) => (
                    <button
                      key={r.emoji}
                      onClick={() => onReact(msgId, r.emoji)}
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shadow-sm transition hover:scale-105 select-none ${
                        r.byMe
                          ? isHacker
                            ? 'bg-[#00FF66]/25 border border-[#00FF66] text-[#00FF66]'
                            : isMidnight
                            ? 'bg-indigo-600/30 border border-indigo-400 text-indigo-300'
                            : isPro
                            ? 'bg-blue-500/25 border border-blue-400 text-blue-300'
                            : 'bg-emerald-100 border border-emerald-400 text-emerald-800'
                          : isHacker
                          ? 'bg-black/60 border border-[#00FF66]/30 text-[#00FF66]/80'
                          : isDarkPro
                          ? 'bg-slate-800/90 border border-slate-700 text-slate-300'
                          : 'bg-white/95 border border-gray-200 text-gray-700'
                      }`}
                      title={`Reacted by ${r.users.map((u) => u.displayName || u.pseudoId).join(', ')}`}
                    >
                      <span>{r.emoji}</span>
                      <span className="text-[11px] font-bold">{r.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Quote Reply Bar */}
      {replyingTo && (
        <div
          className={`flex items-center justify-between border-t px-3 py-2 text-xs transition z-20 ${
            isHacker
              ? 'border-[#00FF66]/30 bg-[#07150A] text-[#00FF66]'
              : isMidnight
              ? 'border-indigo-500/30 bg-[#121522] text-slate-200'
              : isPro
              ? 'border-blue-500/30 bg-[#0F172A] text-slate-200'
              : 'border-wa-green/30 bg-[#F0F2F5] text-gray-800'
          }`}
        >
          <div className="min-w-0 flex-1 border-l-4 border-wa-green pl-2.5">
            <p className="font-bold text-[11px] truncate">Replying to {replyingTo.senderName}</p>
            <p className="text-[11px] opacity-75 truncate">{replyingTo.textSnippet}</p>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
            className="ml-3 flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/10 text-xs font-bold"
            aria-label="Cancel reply"
            title="Cancel reply"
          >
            ✕
          </button>
        </div>
      )}

      {/* Emoji Picker Tray */}
      {emojiOpen && (
        <div
          className={`border-t shadow-lg z-20 flex flex-col max-h-60 animate-in slide-in-from-bottom-2 duration-150 ${
            isHacker
              ? 'bg-[#050D07] border-[#00FF66]/20'
              : isMidnight
              ? 'bg-[#121522] border-[#222738]'
              : isPro
              ? 'bg-[#0F172A] border-slate-800'
              : 'bg-[#F0F2F5] border-black/5'
          }`}
        >
          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5 border-b border-black/5 overflow-x-auto shrink-0">
            {EMOJI_CATEGORIES.map((cat, idx) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => setActiveEmojiCategory(idx)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition shrink-0 ${
                  activeEmojiCategory === idx
                    ? isHacker
                      ? 'bg-[#00FF66]/20 text-[#00FF66]'
                      : isMidnight
                      ? 'bg-indigo-600/30 text-indigo-300'
                      : isPro
                      ? 'bg-blue-600/30 text-blue-300'
                      : 'bg-white text-[#128C7E] shadow-sm'
                    : 'opacity-60 hover:opacity-100 hover:bg-black/5'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.name}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEmojiOpen(false)}
              className="ml-auto text-xs opacity-50 hover:opacity-100 px-2 py-0.5 rounded font-bold"
              title="Close emoji picker"
            >
              ✕
            </button>
          </div>

          {/* Emoji Grid */}
          <div className="p-3 overflow-y-auto grid grid-cols-8 sm:grid-cols-10 md:grid-cols-12 gap-1 max-h-44">
            {EMOJI_CATEGORIES[activeEmojiCategory].emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="h-8 w-8 flex items-center justify-center rounded-lg text-xl hover:scale-125 hover:bg-black/5 active:scale-95 transition select-none"
                onClick={() => setDraft((current) => current + emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Uploading Progress Indicator */}
      {uploadingFile && (
        <div
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold border-t transition animate-pulse z-20 ${
            isHacker
              ? 'bg-[#00FF66]/10 text-[#00FF66] border-[#00FF66]/30'
              : isPro
              ? 'bg-blue-600/10 text-blue-400 border-blue-500/20'
              : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
          }`}
        >
          <span className="animate-spin text-sm">⏳</span>
          <span>Encrypting & uploading {uploadingFile}…</span>
        </div>
      )}

      {/* Footer Input Bar or Blocked Notice */}
      {isPeerBlocked ? (
        <footer
          className={`sticky bottom-0 z-30 shrink-0 flex items-center justify-between gap-3 px-4 py-3 transition border-t ${
            isHacker
              ? 'bg-[#07150A] border-[#00FF66]/30 text-[#00FF66]'
              : isPro
              ? 'bg-[#0F172A] border-slate-800 text-slate-200'
              : 'bg-[#F0F2F5] border-[#E9EDEF] text-[#54656F]'
          }`}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="text-base">🚫</span>
            <span>You have blocked this contact. Unblock to send messages or make calls.</span>
          </div>
          {onUnblockUser && (
            <button
              onClick={onUnblockUser}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition shadow ${
                isHacker
                  ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                  : isPro
                  ? 'bg-blue-600 hover:bg-blue-500'
                  : 'bg-[#128C7E] hover:bg-[#075E54]'
              }`}
            >
              Unblock
            </button>
          )}
        </footer>
      ) : isRecordingVoice ? (
        /* Active Voice Note Recording Composer */
        <footer
          className={`sticky bottom-0 z-30 shrink-0 flex items-center justify-between gap-3 px-4 py-3 transition border-t ${
            isHacker
              ? 'bg-[#07150A] border-[#00FF66]/30 text-[#00FF66]'
              : isMidnight
              ? 'bg-[#121522] border-[#222738] text-slate-100'
              : isPro
              ? 'bg-[#0F172A] border-slate-800 text-slate-100'
              : 'bg-wa-panel border-black/5 text-[#111B21]'
          }`}
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <span className="relative flex h-3.5 w-3.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500" />
              </span>
              <span className="font-mono text-sm font-bold text-red-500">{formatVoiceDuration(voiceDuration)}</span>
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xs font-semibold text-red-400 truncate animate-pulse">
                Recording voice note…
              </span>
              <div className="flex items-center gap-1 opacity-70">
                <span className="inline-block w-1 h-3 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="inline-block w-1 h-5 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="inline-block w-1 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                <span className="inline-block w-1 h-4 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '450ms' }} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={cancelVoiceNote}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/15 text-red-500 hover:bg-red-500/25 text-lg transition"
              title="Cancel & delete voice note"
              aria-label="Cancel recording"
            >
              🗑️
            </button>
            <button
              onClick={sendVoiceNote}
              className={`flex h-10 w-10 items-center justify-center rounded-full text-white shadow-md transition ${
                isHacker
                  ? 'bg-[#00FF66] text-black hover:bg-[#00CC52]'
                  : isPro
                  ? 'bg-blue-600 hover:bg-blue-500'
                  : 'bg-wa-green hover:bg-wa-greenDark'
              }`}
              title="Send voice note"
              aria-label="Send voice note"
            >
              ➤
            </button>
          </div>
        </footer>
      ) : (
        <footer
          className={`sticky bottom-0 z-30 shrink-0 flex items-end gap-2 px-3 py-2.5 transition border-t ${
            isHacker
              ? 'bg-[#07150A] border-[#00FF66]/30'
              : isMidnight
              ? 'bg-[#121522] border-[#222738]'
              : isPro
              ? 'bg-[#0F172A] border-slate-800'
              : 'bg-wa-panel border-black/5'
          }`}
        >
          <button
            onClick={() => setEmojiOpen((open) => !open)}
            className="rounded-full p-2 text-xl hover:bg-white/10 transition shrink-0"
            aria-label="Emoji picker"
            title="Emojis"
          >
            🙂
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-full p-2 text-xl hover:bg-white/10 transition shrink-0"
            aria-label="Attach a file"
            title="Attach file"
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAttach(file);
              event.target.value = '';
            }}
          />

          {/* Walkie-Talkie Push-to-Talk Button in composer */}
          <button
            onPointerDown={(event) => startWalkieHold(event)}
            onPointerUp={stopWalkieHold}
            onPointerCancel={stopWalkieHold}
            onPointerLeave={(event) => event.buttons === 0 && stopWalkieHold()}
            onLostPointerCapture={stopWalkieHold}
            onContextMenu={(event) => event.preventDefault()}
            className={`touch-none rounded-full px-2.5 py-1.5 text-xs font-bold flex items-center gap-1.5 transition shrink-0 select-none ${
              isTransmitting
                ? 'bg-red-500 text-white animate-pulse shadow-md ring-2 ring-red-400'
                : isHacker
                ? 'bg-[#00FF66]/10 border border-[#00FF66]/30 text-[#00FF66] hover:bg-[#00FF66]/20'
                : isPro
                ? 'bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30'
                : isMidnight
                ? 'bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30'
                : isNordic
                ? 'bg-sky-50 border border-sky-300 text-sky-700 hover:bg-sky-100'
                : 'bg-emerald-100/90 border border-emerald-300 text-emerald-800 hover:bg-emerald-200'
            }`}
            aria-label="Walkie-Talkie Push-to-Talk"
            title="Hold to transmit; release to stop"
          >
            <span className="text-sm">📻</span>
            <span className="hidden sm:inline">{isTransmitting ? 'TALKING' : 'Walkie'}</span>
          </button>

          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={replyingTo ? `Replying to ${replyingTo.senderName}…` : 'Type a message...'}
            className={`max-h-32 min-h-[42px] flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-[14px] outline-none transition ${
              isHacker
                ? 'bg-black/60 border border-[#00FF66]/40 text-[#00FF66] placeholder-[#00FF66]/30 focus:border-[#00FF66] focus:ring-1 focus:ring-[#00FF66]'
                : isPro
                ? 'bg-[#1E293B] border border-slate-700 text-white placeholder-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                : isMidnight
                ? 'bg-[#151926] border border-[#272D40] text-white placeholder-slate-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                : isNordic
                ? 'bg-white border border-slate-200 text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm'
                : 'bg-white text-black outline-none ring-1 ring-black/5 focus:ring-wa-green/40'
            }`}
            onChange={(event) => {
              setDraft(event.target.value);
              onTyping(true);
              if (typingTimer.current) clearTimeout(typingTimer.current);
              typingTimer.current = setTimeout(() => onTyping(false), 1800);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {draft.trim() ? (
            <button
              onClick={submit}
              className={`mb-0.5 rounded-full p-3 text-white transition shrink-0 ${
                isHacker
                  ? 'bg-[#00FF66] text-black hover:bg-[#00CC52] font-bold shadow-[0_0_12px_rgba(0,255,102,0.4)]'
                  : isPro
                  ? 'bg-blue-600 hover:bg-blue-500 shadow-md'
                  : isMidnight
                  ? 'bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30'
                  : isNordic
                  ? 'bg-sky-600 hover:bg-sky-500 shadow-md shadow-sky-600/20'
                  : 'bg-wa-green hover:bg-wa-greenDark'
              }`}
              aria-label="Send"
              title="Send"
            >
              ➤
            </button>
          ) : (
            <button
              onClick={startVoiceNote}
              className={`mb-0.5 rounded-full p-3 text-white transition shrink-0 ${
                isHacker
                  ? 'bg-[#00FF66] text-black hover:bg-[#00CC52] font-bold shadow-[0_0_12px_rgba(0,255,102,0.4)]'
                  : isPro
                  ? 'bg-blue-600 hover:bg-blue-500'
                  : isMidnight
                  ? 'bg-indigo-600 hover:bg-indigo-500'
                  : isNordic
                  ? 'bg-sky-600 hover:bg-sky-500'
                  : 'bg-wa-green hover:bg-wa-greenDark'
              }`}
              aria-label="Record voice note"
              title="Record voice note"
            >
              🎙️
            </button>
          )}
        </footer>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 rounded-full px-4 py-2 text-xs font-semibold shadow-xl bg-black/85 text-white animate-in fade-in slide-in-from-bottom-2 duration-150">
          {toastMessage}
        </div>
      )}

      {/* Forward Modal */}
      {forwardModalData && (
        <ForwardModal
          isOpen={Boolean(forwardModalData)}
          onClose={() => setForwardModalData(null)}
          messageText={forwardModalData.text}
          senderName={forwardModalData.senderName}
          conversations={conversations}
          users={allUsers}
          currentUserId={currentUserPseudoId}
          onForwardToConversation={(targetConvoId) => {
            const textToForward = forwardModalData.text;
            setForwardModalData(null);
            const fwd = `↪ Forwarded:\n${textToForward}`;
            if (targetConvoId === conversation.id) {
              onSend(fwd, null);
              showToast('Forwarded to this chat');
            } else if (onForwardToConversation) {
              onForwardToConversation(targetConvoId, fwd);
              showToast('Message forwarded');
            } else {
              showToast('Forwarded');
            }
          }}
          onForwardToUser={(targetUser) => {
            const textToForward = forwardModalData.text;
            setForwardModalData(null);
            const fwd = `↪ Forwarded:\n${textToForward}`;
            if (onForwardToUser) {
              onForwardToUser(targetUser, fwd);
              showToast(`Forwarded to ${targetUser.displayName}`);
            } else {
              showToast('Forwarded');
            }
          }}
        />
      )}

      {/* Group Info Modal */}
      {conversation.type === 'GROUP' && groupInfoOpen && (
        <GroupInfoModal
          isOpen={groupInfoOpen}
          onClose={() => setGroupInfoOpen(false)}
          conversation={conversation}
          currentUserPseudoId={currentUserPseudoId}
          allUsers={allUsers}
          onMemberRemoved={(pseudoId) => {
            onMemberRemoved?.(pseudoId);
          }}
          onGroupLeft={() => {
            onGroupLeft?.();
          }}
          onGroupUpdated={() => {
            onGroupUpdated?.();
          }}
        />
      )}
    </section>
  );
}
