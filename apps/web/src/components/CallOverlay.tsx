'use client';

import { useEffect, useRef, useState } from 'react';
import type { CallPhase } from '../lib/useCall';

export interface CallOverlayProps {
  kind: 'AUDIO' | 'VIDEO';
  peerName: string;
  state: CallPhase;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  isCameraOff?: boolean;
  isScreenSharing?: boolean;
  error?: string | null;
  onToggleMute: () => void;
  onToggleCamera?: () => void;
  onToggleScreenShare?: () => void;
  onHangup: () => void;
  onAccept?: () => void;
}

export function CallOverlay({
  kind,
  peerName,
  state,
  localStream,
  remoteStream,
  muted,
  isCameraOff = false,
  isScreenSharing = false,
  error,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onHangup,
  onAccept,
}: CallOverlayProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const [duration, setDuration] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);

  // Live timer for active calls
  useEffect(() => {
    if (state !== 'active') {
      setDuration(0);
      return;
    }
    const interval = setInterval(() => {
      setDuration((d) => d + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [state]);

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Video streams — reassign srcObject whenever the stream changes
  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    // Always update: clears stale camera stream when screen share starts
    el.srcObject = localStream;
    if (localStream) {
      el.play().catch(() => undefined);
    }
  }, [localStream]);

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (!el) return;
    el.srcObject = remoteStream;
    if (remoteStream) {
      el.play().catch((err) => console.warn('Remote video play:', err));
    }
  }, [remoteStream]);

  // Remote audio stream playback with cleanup
  useEffect(() => {
    const el = remoteAudioRef.current;
    if (el && remoteStream) {
      el.srcObject = remoteStream;
      el.play().catch((err) => console.warn('Remote audio play:', err));
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [remoteStream]);

  const label =
    state === 'incoming'
      ? 'Incoming call…'
      : state === 'calling'
      ? 'Calling…'
      : state === 'ringing' || state === 'outgoing'
      ? 'Ringing…'
      : state === 'connecting'
      ? 'Connecting…'
      : state === 'ended'
      ? 'Call ended'
      : state === 'error'
      ? (error ?? 'Call failed')
      : formatDuration(duration);

  // Minimized Floating Widget Mode (Allows full chat window interaction while in call)
  if (isMinimized) {
    return (
      <aside className="fixed top-3 left-1/2 -translate-x-1/2 z-[70] w-[95%] max-w-2xl pointer-events-auto select-none animate-in fade-in slide-in-from-top-3 duration-200">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        <div className="flex items-center justify-between gap-2.5 px-4 py-2.5 rounded-2xl bg-[#0B132B]/95 text-white shadow-2xl border border-blue-500/40 backdrop-blur-md">
          {/* Status info */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-xs sm:text-sm font-bold truncate leading-tight">{peerName}</p>
                <span className="text-[10px] font-mono text-emerald-400 font-bold bg-emerald-950/70 px-1.5 py-0.5 rounded border border-emerald-500/30 shrink-0">
                  {formatDuration(duration)}
                </span>
              </div>
              <p className="text-[10px] sm:text-[11px] text-white/70 truncate leading-tight flex items-center gap-1.5 mt-0.5">
                {isScreenSharing ? (
                  <span className="text-pink-400 font-semibold flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-pink-400 animate-pulse" />
                    Screen Sharing Active
                  </span>
                ) : (
                  <span>{kind === 'VIDEO' ? '🎥 Video Call' : '📞 Voice Call'}</span>
                )}
                <span>• In Background</span>
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Mic Toggle */}
            <button
              onClick={onToggleMute}
              disabled={!localStream}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm ${
                muted ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <span>{muted ? '🔇' : '🎙️'}</span>
              <span className="hidden md:inline text-[10px]">{muted ? 'MIC OFF' : 'MIC ON'}</span>
            </button>

            {/* Camera Toggle */}
            {onToggleCamera && (
              <button
                onClick={onToggleCamera}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm ${
                  isCameraOff ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
                title={isCameraOff ? 'Turn Camera ON' : 'Turn Camera OFF'}
              >
                <span>{isCameraOff ? '🚫' : '📹'}</span>
                <span className="hidden md:inline text-[10px]">{isCameraOff ? 'CAM OFF' : 'CAM ON'}</span>
              </button>
            )}

            {/* Screen Share toggle if available */}
            {onToggleScreenShare && (
              <button
                onClick={onToggleScreenShare}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm ${
                  isScreenSharing ? 'bg-[#E1436E] text-white ring-2 ring-pink-500/40' : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
                title={isScreenSharing ? 'Stop screen sharing' : 'Share screen'}
              >
                <span>🖥️</span>
                <span className="hidden md:inline text-[10px]">{isScreenSharing ? 'STOP' : 'SHARE'}</span>
              </button>
            )}

            {/* Maximize back to full overlay */}
            <button
              onClick={() => setIsMinimized(false)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-md transition hover:scale-105 active:scale-95"
              title="Maximize call screen"
            >
              <span>⛶</span>
              <span className="text-[10px]">MAXIMIZE</span>
            </button>

            {/* Hangup */}
            <button
              onClick={onHangup}
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold shadow-md transition hover:scale-105 active:scale-95"
              title="End call"
            >
              ✕
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const hasRemoteVideo = Boolean(remoteStream && remoteStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live'));
  const hasLocalVideo = !isCameraOff && Boolean(localStream && localStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live'));

  return (
    <div className="fixed inset-0 z-[70] h-[100dvh] w-screen overflow-hidden bg-[#05070A] text-white">
      {/* Call Header */}
      <header className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-4 pb-6 pt-[env(safe-area-inset-top)] bg-gradient-to-b from-black/75 via-black/35 to-transparent sm:px-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-emerald-400 font-semibold">
            🔒 {kind === 'VIDEO' ? 'End-to-End Encrypted Video Call' : 'End-to-End Encrypted Voice Call'}
          </p>
          <p className="text-xl font-bold mt-0.5">{peerName}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Minimize Button in Header */}
          <button
            onClick={() => setIsMinimized(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 border border-white/20 text-white text-xs font-bold shadow transition hover:scale-105 active:scale-95"
            title="Minimize call to view and send messages in chat"
          >
            <span>🗕</span>
            <span className="hidden sm:inline">Minimize to Chat</span>
          </button>
          {(state === 'calling' || state === 'ringing' || state === 'connecting') && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            </span>
          )}
          <p
            className={`text-sm font-semibold tracking-wide ${
              state === 'error' ? 'text-red-400' : state === 'active' ? 'text-emerald-400' : 'text-white/80'
            }`}
          >
            {label}
          </p>
        </div>
      </header>

      {/* Single remote audio output */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Main Call View */}
      <main className="absolute inset-0 z-10 flex items-center justify-center">
        {kind === 'VIDEO' || isScreenSharing || hasRemoteVideo ? (
          <>
            {isScreenSharing ? (
              /* ----------------------------------------------------------------
               * Screen Share Layout:
               * - Big view = local screen (so sharer sees exactly what's shared)
               * - Small PiP = remote peer's camera (top-right, only if active)
               * ---------------------------------------------------------------- */
              <>
                {/* Local screen — full background */}
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="absolute inset-0 h-full w-full bg-black object-contain"
                />
                {/* Screen Share banner */}
                <div className="absolute top-[calc(4.5rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full bg-emerald-600/90 px-4 py-1.5 text-xs font-bold text-white shadow-lg backdrop-blur-sm">
                  <span className="h-2 w-2 rounded-full bg-white animate-ping inline-block" />
                  <span>📺 SHARING YOUR SCREEN</span>
                </div>
                {/* Remote peer camera — small PiP top-right ONLY if active */}
                {hasRemoteVideo && (
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="absolute top-[calc(5rem+env(safe-area-inset-top))] right-3 z-30 h-[20vh] max-h-44 w-[25vw] max-w-32 rounded-xl border-2 border-white/30 bg-black object-cover shadow-2xl sm:right-6"
                  />
                )}
              </>
            ) : (
              /* ----------------------------------------------------------------
               * Normal VIDEO or remote screen share view:
               * - Big view = remote stream (peer's camera or their screen share)
               * - Small PiP = local camera (mirrored, bottom-right, only if active)
               * ---------------------------------------------------------------- */
              <>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="absolute inset-0 h-full w-full bg-black object-contain"
                />
                {hasLocalVideo && (
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="absolute bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 z-30 h-[22vh] max-h-52 w-[27vw] max-w-36 rounded-xl border-2 border-white/30 bg-black object-cover shadow-2xl sm:right-6 md:h-48 md:w-36 scale-x-[-1]"
                  />
                )}
              </>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-6">
            {/* Visualizer Circle */}
            <div className="relative flex items-center justify-center">
              {(state === 'calling' || state === 'ringing' || state === 'active') && (
                <div className="absolute h-40 w-40 rounded-full bg-emerald-500/20 animate-ping" />
              )}
              <div
                className={`flex h-32 w-32 items-center justify-center rounded-full text-5xl shadow-xl transition ${
                  state === 'active'
                    ? 'bg-emerald-600/30 border-2 border-emerald-400 text-emerald-300'
                    : 'bg-white/10 border border-white/20 text-white/90'
                }`}
              >
                🎙️
              </div>
            </div>

            <div className="text-center">
              <p className="text-xl font-bold">{peerName}</p>
              <p className="text-sm text-emerald-400 font-medium mt-1">
                {state === 'calling'
                  ? 'Calling (peer is offline)…'
                  : state === 'ringing'
                  ? 'Ringing…'
                  : state === 'connecting'
                  ? 'Connecting HD Audio…'
                  : state === 'active'
                  ? `HD Voice Connected • ${formatDuration(duration)}`
                  : state === 'error'
                  ? (error ?? 'Call failed')
                  : 'Call ended'}
              </p>
              <p className="text-xs text-white/40 mt-3 max-w-md">
                Ultra HD Voice (Opus 64kbps, Forward Error Correction, Noise Suppression).
                Audio is encrypted with DTLS-SRTP and never touches the server.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Footer Call Controls */}
      <footer className="absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-12 sm:pb-8">
        {state === 'incoming' && onAccept ? (
          <div className="flex items-center justify-center gap-6">
            <button
              onClick={onHangup}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition hover:bg-red-700 hover:scale-105 active:scale-95"
              aria-label="Decline call"
              title="Decline"
            >
              <span className="text-2xl leading-none">✕</span>
            </button>
            <button
              onClick={onAccept}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg transition hover:bg-emerald-500 hover:scale-105 active:scale-95 animate-bounce"
              aria-label="Accept call"
              title="Accept"
            >
              <span className="text-3xl leading-none">📞</span>
            </button>
          </div>
        ) : (
          <>
            {/* Button row */}
            <div className="flex items-center justify-center gap-4 sm:gap-5 flex-wrap">
              {/* Mute / Mic button with label */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={onToggleMute}
                  disabled={!localStream}
                  className={`flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-lg transition disabled:opacity-40 hover:scale-105 active:scale-95 ${
                    muted ? 'bg-white text-black ring-2 ring-red-500' : 'bg-white/15 text-white hover:bg-white/25'
                  }`}
                  title={muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-label="Toggle Mute"
                >
                  {muted ? '🔇' : '🎙️'}
                </button>
                <span className={`text-[10px] font-bold tracking-wider uppercase select-none ${muted ? 'text-red-400' : 'text-white/60'}`}>
                  {muted ? 'MIC OFF' : 'MIC ON'}
                </span>
              </div>

              {/* Camera ON / OFF button with label */}
              {onToggleCamera && (
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={onToggleCamera}
                    className={`flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-lg transition hover:scale-105 active:scale-95 ${
                      isCameraOff
                        ? 'bg-red-500/20 text-red-400 ring-2 ring-red-500/50'
                        : 'bg-white/15 text-white hover:bg-white/25'
                    }`}
                    title={isCameraOff ? 'Turn camera ON' : 'Turn camera OFF'}
                    aria-label="Toggle Camera"
                  >
                    {isCameraOff ? '🚫' : '📹'}
                  </button>
                  <span
                    className={`text-[10px] font-bold tracking-wider uppercase select-none ${
                      isCameraOff ? 'text-red-400' : 'text-white/60'
                    }`}
                  >
                    {isCameraOff ? 'CAM OFF' : 'CAM ON'}
                  </span>
                </div>
              )}

              {/* Screen Share button with label */}
              {onToggleScreenShare && (
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={onToggleScreenShare}
                    className={`flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-lg transition hover:scale-105 active:scale-95 ${
                      isScreenSharing
                        ? 'bg-[#E1436E] text-white ring-4 ring-pink-500/30'
                        : 'bg-white/15 text-white hover:bg-white/25'
                    }`}
                    title={isScreenSharing ? 'Stop screen sharing' : 'Share screen'}
                    aria-label="Toggle screen share"
                  >
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                      <path d="M12 13V7" />
                      <path d="M9 10l3-3 3 3" />
                    </svg>
                  </button>
                  <span className={`text-[10px] font-bold tracking-wider uppercase select-none ${isScreenSharing ? 'text-pink-400' : 'text-white/60'}`}>
                    {isScreenSharing ? 'STOP SHARE' : 'SHARE'}
                  </span>
                </div>
              )}

              {/* Minimize to Chats button */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={() => setIsMinimized(true)}
                  className="flex h-14 w-14 items-center justify-center rounded-full text-xl shadow-lg transition bg-white/15 text-white hover:bg-white/25 hover:scale-105 active:scale-95 border border-white/20"
                  title="Minimize to view and send chat messages"
                  aria-label="Minimize to Chats"
                >
                  🗕
                </button>
                <span className="text-[10px] font-bold tracking-wider uppercase text-white/60 select-none">
                  CHATS
                </span>
              </div>

              {/* End Call button with label */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={onHangup}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition hover:bg-red-700 hover:scale-105 active:scale-95"
                  title="End call"
                  aria-label="Hang up"
                >
                  <span className="text-2xl leading-none">📞</span>
                </button>
                <span className="text-[10px] font-bold tracking-wider uppercase text-white/60 select-none">END</span>
              </div>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
