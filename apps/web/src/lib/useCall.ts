'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import {
  startIncomingCallRingtone,
  stopIncomingCallRingtone,
  startOutgoingRingback,
  stopOutgoingRingtone,
  showBrowserNotification,
} from './sound';

export type CallPhase =
  | 'idle'
  | 'outgoing'
  | 'calling'
  | 'ringing'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'error';

export interface CallSession {
  roomId: string;
  conversationId: string | null;
  kind: 'AUDIO' | 'VIDEO';
  peerName: string;
  phase: CallPhase;
  error?: string;
  startedAt?: number;
  screenShare?: boolean;
}

export interface UseCallResult {
  call: CallSession | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
  start: (conversationId: string, kind: 'AUDIO' | 'VIDEO', peerName: string, screenShare?: boolean) => Promise<void>;
  accept: () => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

/**
 * Public STUN + TURN servers.
 * TURN relay is essential when devices are behind symmetric NAT (cellular 4G/5G,
 * Cloudflare Tunnels, double NAT) where direct P2P UDP hole-punching fails.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/**
 * Tune SDP parameters for Opus to guarantee high-definition, crystal-clear voice:
 * - inbandfec=1 (Forward Error Correction prevents audio glitching under packet loss)
 * - usedtx=1 (Discontinuous Transmission: mutes line during silence to prevent background hiss/noise)
 * - stereo=0, sprop-stereo=0 (clean mono microphone capture prevents phase hollow noise)
 */
function tuneOpusSdp(sdp: string): string {
  if (!sdp) return sdp;
  const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];
  const opusParams = 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0';
  const fmtpRegex = new RegExp(`a=fmtp:${pt}\\s+.*`, 'i');
  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, `a=fmtp:${pt} ${opusParams}`);
  }
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt}\\s+opus\\/48000\\/2[\\r\\n]+)`, 'i'),
    `$1a=fmtp:${pt} ${opusParams}\r\n`,
  );
}

/**
 * WebSocket audio stream player fallback.
 * Allows continuous voice audio streaming over WebSocket if WebRTC P2P fails behind NAT/Firewall.
 */
class StreamAudioPlayer {
  private mediaSource: MediaSource | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];

  start() {
    try {
      if (typeof window === 'undefined' || !window.MediaSource) return;
      this.mediaSource = new MediaSource();
      this.audioElement = new Audio();
      this.audioElement.src = URL.createObjectURL(this.mediaSource);
      this.audioElement.autoplay = true;

      this.mediaSource.onsourceopen = () => {
        try {
          const mime = 'audio/webm; codecs=opus';
          if (!MediaSource.isTypeSupported(mime)) return;
          this.sourceBuffer = this.mediaSource!.addSourceBuffer(mime);
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.onupdateend = () => {
            if (this.queue.length > 0 && !this.sourceBuffer?.updating) {
              const next = this.queue.shift();
              if (next) this.sourceBuffer?.appendBuffer(next);
            }
          };
          if (this.queue.length > 0 && !this.sourceBuffer.updating) {
            const next = this.queue.shift();
            if (next) this.sourceBuffer.appendBuffer(next);
          }
        } catch (err) {
          console.warn('SourceBuffer init error:', err);
        }
      };
      this.audioElement.play().catch(() => undefined);
    } catch (err) {
      console.warn('StreamAudioPlayer error:', err);
    }
  }

  pushChunk(chunk: ArrayBuffer) {
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        this.sourceBuffer.appendBuffer(chunk);
      } catch {
        this.queue.push(chunk);
      }
    } else {
      this.queue.push(chunk);
    }
  }

  stop() {
    this.queue = [];
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.src = '';
      this.audioElement = null;
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
  }
}

export function useCall(): UseCallResult {
  const [call, setCall] = useState<CallSession | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const phaseRef = useRef<CallPhase>('idle');
  const acceptedRef = useRef<boolean>(false);
  const currentRoomIdRef = useRef<string>('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const playerRef = useRef<StreamAudioPlayer | null>(null);

  const setPhase = useCallback((phase: CallPhase, error?: string) => {
    phaseRef.current = phase;
    setCall((current) => (current ? { ...current, phase, error } : current));
  }, []);

  /** Tear down every resource the call owns. Safe to call repeatedly. */
  const teardown = useCallback(() => {
    acceptedRef.current = false;
    currentRoomIdRef.current = '';

    if (screenTrackRef.current) {
      try {
        screenTrackRef.current.stop();
      } catch {}
      screenTrackRef.current = null;
    }
    setIsScreenSharing(false);

    try {
      recorderRef.current?.stop();
    } catch {
      // already stopped
    }
    recorderRef.current = null;

    stopIncomingCallRingtone();
    stopOutgoingRingtone();

    try {
      playerRef.current?.stop();
    } catch {
      // already stopped
    }
    playerRef.current = null;

    pcRef.current?.getSenders().forEach((sender) => {
      try {
        pcRef.current?.removeTrack(sender);
      } catch {
        /* already detached */
      }
    });
    pcRef.current?.close();
    pcRef.current = null;

    localRef.current?.getTracks().forEach((track) => track.stop());
    localRef.current = null;

    pendingOffer.current = null;
    pendingIce.current = [];
    setIsCameraOff(false);
    setLocalStream(null);
    setRemoteStream(null);
    setMuted(false);
  }, []);

  const endCall = useCallback(
    (reason: string) => {
      const active = currentRoomIdRef.current || call?.roomId;
      if (active) getSocket().emit('call:end', { roomId: active });
      teardown();
      setPhase('ended', reason);
      window.setTimeout(() => {
        setCall(null);
        phaseRef.current = 'idle';
      }, 1800);
    },
    [call?.roomId, setPhase, teardown],
  );

  // Helper to start WebSocket audio relay backup
  const startWebSocketMediaRelay = useCallback((stream: MediaStream, roomId: string) => {
    try {
      if (recorderRef.current) return;
      const mime = typeof window !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && currentRoomIdRef.current === roomId) {
          const buf = await e.data.arrayBuffer();
          getSocket().emit('call:media-chunk', { roomId, chunk: buf });
        }
      };
      recorder.start(150); // 150ms slices for smooth real-time delivery
      recorderRef.current = recorder;
    } catch (e) {
      console.warn('MediaRecorder relay setup:', e);
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Peer connection construction                                           */
  /* ---------------------------------------------------------------------- */

  const buildPeer = useCallback(
    async (
      roomId: string,
      kind: 'AUDIO' | 'VIDEO',
      initialScreenShare = false,
      enableCamera = false,
    ): Promise<RTCPeerConnection> => {
      const credentials = await api.callCredentials(roomId).catch(() => null);
      const iceServers: RTCIceServer[] = credentials?.iceServers && credentials.iceServers.length > 0
        ? [...(credentials.iceServers as RTCIceServer[]), ...DEFAULT_ICE_SERVERS]
        : DEFAULT_ICE_SERVERS;

      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: 'max-bundle',
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 10,
      });

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        getSocket().emit('call:signal', {
          roomId,
          type: 'ice',
          data: event.candidate.toJSON(),
        });
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStream(stream);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          stopOutgoingRingtone();
          stopIncomingCallRingtone();
          // WebRTC DTLS-SRTP is active: stop any fallback WebSocket streaming so there is zero duplicate audio
          if (recorderRef.current) {
            try {
              recorderRef.current.stop();
            } catch {
              // already stopped
            }
            recorderRef.current = null;
          }
          if (playerRef.current) {
            try {
              playerRef.current.stop();
            } catch {
              // already stopped
            }
            playerRef.current = null;
          }
          setPhase('active');
          setCall((c) => (c ? { ...c, phase: 'active', startedAt: c.startedAt || Date.now() } : c));
        } else if (pc.connectionState === 'failed') {
          stopOutgoingRingtone();
          stopIncomingCallRingtone();
          console.warn('Direct WebRTC path failed. Switching to Encrypted WebSocket Audio Relay...');
          try {
            pc.restartIce();
          } catch {
            // non-fatal
          }
          // Seamless fallback: keep call active via WebSocket audio streaming
          if (localRef.current) {
            startWebSocketMediaRelay(localRef.current, roomId);
          }
          setPhase('active');
          setCall((c) => (c ? { ...c, phase: 'active', startedAt: c.startedAt || Date.now() } : c));
        } else if (pc.connectionState === 'disconnected' && phaseRef.current === 'active') {
          // Temporarily reconnecting
        }
      };

      // Capture audio + optional video/screen share
      let videoTrack: MediaStreamTrack | null = null;
      if (initialScreenShare) {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
          videoTrack = displayStream.getVideoTracks()[0] ?? null;
          if (videoTrack) {
            screenTrackRef.current = videoTrack;
            setIsScreenSharing(true);
            videoTrack.onended = () => {
              void stopScreenShare();
            };
          }
        } catch (e) {
          console.warn('Screen share cancelled/failed on call start:', e);
        }
      }

      // Studio-quality voice capture: Hardware AEC + Noise Suppression + Automatic Gain Control + Mono
      // When screen sharing or when enableCamera is false, do NOT automatically open the camera!
      const needCamera = enableCamera && !videoTrack;
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: needCamera ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });

      setIsCameraOff(!needCamera);

      const combinedTracks = [...audioStream.getAudioTracks()];
      if (videoTrack) {
        combinedTracks.push(videoTrack);
      } else if (audioStream.getVideoTracks().length > 0) {
        combinedTracks.push(...audioStream.getVideoTracks());
      }
      const stream = new MediaStream(combinedTracks);

      localRef.current = stream;
      setLocalStream(stream);

      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === 'audio') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 64000;
            sender.setParameters(params).catch(() => undefined);
          } catch {
            // non-fatal
          }
        }
      }

      pcRef.current = pc;
      return pc;
    },
    [setPhase, startWebSocketMediaRelay],
  );

  /* ---------------------------------------------------------------------- */
  /* Screen Sharing Controls                                                */
  /* ---------------------------------------------------------------------- */

  const stopScreenShare = useCallback(async () => {
    if (screenTrackRef.current) {
      try {
        screenTrackRef.current.stop();
      } catch {}
      screenTrackRef.current = null;
    }
    setIsScreenSharing(false);

    if (!pcRef.current) return;
    const senders = pcRef.current.getSenders();
    const videoSender = senders.find((s) => s.track?.kind === 'video' || (s as unknown as { track: null }).track === null);

    if (call?.kind === 'VIDEO' && !isCameraOff) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        const camTrack = camStream.getVideoTracks()[0];
        if (camTrack && videoSender) {
          await videoSender.replaceTrack(camTrack);
          if (localRef.current) {
            const newStream = new MediaStream([...localRef.current.getAudioTracks(), camTrack]);
            localRef.current = newStream;
            setLocalStream(newStream);
          }
        }
      } catch (e) {
        console.warn('Reverting to camera failed:', e);
      }
    } else if (videoSender) {
      try {
        await videoSender.replaceTrack(null);
      } catch {}
      if (localRef.current) {
        const newStream = new MediaStream([...localRef.current.getAudioTracks()]);
        localRef.current = newStream;
        setLocalStream(newStream);
      }
    }
  }, [call?.kind, isCameraOff]);

  const toggleCamera = useCallback(async () => {
    const pc = pcRef.current;
    const stream = localRef.current;

    if (!isCameraOff) {
      // User turns camera OFF: remove camera tracks from stream and peer
      if (stream) {
        stream.getVideoTracks().forEach((track) => {
          if (track !== screenTrackRef.current) {
            track.enabled = false;
            try {
              track.stop();
            } catch {}
            stream.removeTrack(track);
          }
        });
      }

      if (pc) {
        const senders = pc.getSenders();
        const videoSender = senders.find(
          (s) => s.track && s.track !== screenTrackRef.current && s.track.kind === 'video',
        );
        if (videoSender) {
          try {
            await videoSender.replaceTrack(null);
          } catch {}
        }
      }

      setIsCameraOff(true);
      if (stream) {
        setLocalStream(new MediaStream(stream.getTracks()));
      }
    } else {
      // User turns camera ON: capture camera video and add to peer
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        const camTrack = camStream.getVideoTracks()[0];
        if (!camTrack) return;

        if (stream) {
          stream.addTrack(camTrack);
          setLocalStream(new MediaStream(stream.getTracks()));
        } else {
          localRef.current = camStream;
          setLocalStream(camStream);
        }

        if (pc) {
          const senders = pc.getSenders();
          const videoSender = senders.find(
            (s) => s.track?.kind === 'video' || (s as unknown as { track: null }).track === null,
          );
          if (videoSender) {
            await videoSender.replaceTrack(camTrack);
          } else {
            pc.addTrack(camTrack, stream ?? camStream);
          }

          // Renegotiate so peer sees the turned-on camera
          try {
            const rawOffer = await pc.createOffer();
            const tunedSdp = tuneOpusSdp(rawOffer.sdp || '');
            const offer: RTCSessionDescriptionInit = { type: rawOffer.type, sdp: tunedSdp };
            await pc.setLocalDescription(offer);
            getSocket().emit('call:signal', {
              roomId: currentRoomIdRef.current,
              type: 'offer',
              data: pc.localDescription,
            });
          } catch (e) {
            console.warn('Camera renegotiation error:', e);
          }
        }

        setIsCameraOff(false);
      } catch (err) {
        console.warn('Could not turn on camera:', err);
        alert('Could not access camera. Please check camera permissions.');
      }
    }
  }, [isCameraOff]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      await stopScreenShare();
      return;
    }

    try {
      // Request display capture with explicit constraints to avoid black screen.
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      screenTrackRef.current = screenTrack;
      setIsScreenSharing(true);

      screenTrack.onended = () => {
        void stopScreenShare();
      };

      // Update local stream immediately so the CallOverlay preview shows the
      // screen (not the camera). Do this BEFORE touching the peer connection.
      const currentAudioTracks = localRef.current?.getAudioTracks() ?? [];
      const screenStream = new MediaStream([...currentAudioTracks, screenTrack]);
      localRef.current = screenStream;
      setLocalStream(screenStream);

      if (pcRef.current) {
        const socket = getSocket();
        const senders = pcRef.current.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === 'video');

        if (videoSender) {
          // Replace camera → screen. replaceTrack() does NOT require renegotiation
          // per spec, but many TURN/relay setups need an explicit offer to actually
          // switch the stream on the receiver. We renegotiate to be safe.
          await videoSender.replaceTrack(screenTrack);
          // Renegotiate so the remote side reliably receives the new screen video
          try {
            const rawOffer = await pcRef.current.createOffer();
            const tunedSdp = tuneOpusSdp(rawOffer.sdp || '');
            const offer: RTCSessionDescriptionInit = { type: rawOffer.type, sdp: tunedSdp };
            await pcRef.current.setLocalDescription(offer);
            socket.emit('call:signal', {
              roomId: currentRoomIdRef.current,
              type: 'offer',
              data: pcRef.current.localDescription,
            });
          } catch (renegErr) {
            console.warn('Screen share renegotiation failed (non-fatal):', renegErr);
          }
        } else {
          // Audio-only call: add video track and renegotiate
          pcRef.current.addTrack(screenTrack, screenStream);
          const rawOffer = await pcRef.current.createOffer();
          const tunedSdp = tuneOpusSdp(rawOffer.sdp || '');
          const offer: RTCSessionDescriptionInit = { type: rawOffer.type, sdp: tunedSdp };
          await pcRef.current.setLocalDescription(offer);
          socket.emit('call:signal', {
            roomId: currentRoomIdRef.current,
            type: 'offer',
            data: pcRef.current.localDescription,
          });
        }
      }
    } catch (err) {
      console.warn('Screen share cancelled/failed:', err);
      setIsScreenSharing(false);
      screenTrackRef.current = null;
    }
  }, [isScreenSharing, stopScreenShare]);

  /* ---------------------------------------------------------------------- */
  /* Outbound Call                                                          */
  /* ---------------------------------------------------------------------- */

  const start = useCallback(
    async (conversationId: string, kind: 'AUDIO' | 'VIDEO', peerName: string, screenShare = false) => {
      const socket = getSocket();
      acceptedRef.current = true;
      setCall({ roomId: '', conversationId, kind, peerName, phase: 'calling', screenShare });
      phaseRef.current = 'calling';

      socket.emit('call:invite', { conversationId, kind, screenShare }, async (ack) => {
        if (!ack.ok) {
          setPhase('error', ack.error);
          return;
        }

        currentRoomIdRef.current = ack.roomId;
        const initialPhase: CallPhase = ack.peerOnline ? 'ringing' : 'calling';
        if (initialPhase === 'ringing') {
          startOutgoingRingback();
        }
        setCall((current) =>
          current ? { ...current, roomId: ack.roomId, phase: initialPhase } : current,
        );
        phaseRef.current = initialPhase;

        try {
          const enableCamera = kind === 'VIDEO' && !screenShare;
          const pc = await buildPeer(ack.roomId, kind, screenShare, enableCamera);
          const rawOffer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: kind === 'VIDEO' || screenShare,
          });
          const tunedSdp = tuneOpusSdp(rawOffer.sdp || '');
          const offer: RTCSessionDescriptionInit = { type: rawOffer.type, sdp: tunedSdp };
          await pc.setLocalDescription(offer);

          socket.emit('call:signal', {
            roomId: ack.roomId,
            type: 'offer',
            data: pc.localDescription,
          });
        } catch (error) {
          setPhase('error', error instanceof Error ? error.message : 'could not start call');
          teardown();
        }
      });
    },
    [buildPeer, setPhase, startWebSocketMediaRelay, teardown],
  );

  /* ---------------------------------------------------------------------- */
  /* Inbound Call (Accept)                                                  */
  /* ---------------------------------------------------------------------- */

  const accept = useCallback(async () => {
    const current = call;
    if (!current || current.phase !== 'incoming') return;

    acceptedRef.current = true;
    stopIncomingCallRingtone();
    stopOutgoingRingtone();
    setPhase('connecting');

    try {
      const isScreenShareCall = Boolean(current.screenShare);
      // When incoming call is a screen share, callee does NOT turn on their camera automatically!
      const enableCamera = current.kind === 'VIDEO' && !isScreenShareCall;
      const pc = await buildPeer(current.roomId, current.kind, false, enableCamera);
      pcRef.current = pc;

      // If the offer has already arrived:
      if (pendingOffer.current) {
        await pc.setRemoteDescription(pendingOffer.current);
        pendingOffer.current = null;

        for (const candidate of pendingIce.current) {
          await pc.addIceCandidate(candidate).catch(() => undefined);
        }
        pendingIce.current = [];

        if (pc.signalingState === 'have-remote-offer' || pc.signalingState === 'have-local-pranswer') {
          const rawAnswer = await pc.createAnswer();
          const tunedSdp = tuneOpusSdp(rawAnswer.sdp || '');
          const answer: RTCSessionDescriptionInit = { type: rawAnswer.type, sdp: tunedSdp };
          await pc.setLocalDescription(answer);

          getSocket().emit('call:signal', {
            roomId: current.roomId,
            type: 'answer',
            data: pc.localDescription,
          });
        }
      }
    } catch (error) {
      setPhase('error', error instanceof Error ? error.message : 'could not answer');
      teardown();
    }
  }, [buildPeer, call, setPhase, startWebSocketMediaRelay, teardown]);

  const hangup = useCallback(() => {
    stopIncomingCallRingtone();
    stopOutgoingRingtone();
    endCall('hangup');
  }, [endCall]);

  const toggleMute = useCallback(() => {
    const stream = localRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }, [muted]);

  /* ---------------------------------------------------------------------- */
  /* Socket wiring                                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const socket = getSocket();

    const onIncoming = (payload: {
      roomId: string;
      conversationId: string;
      kind: 'AUDIO' | 'VIDEO';
      fromDisplayName: string;
      screenShare?: boolean;
    }) => {
      if (phaseRef.current !== 'idle') {
        socket.emit('call:end', { roomId: payload.roomId });
        return;
      }
      currentRoomIdRef.current = payload.roomId;
      acceptedRef.current = false;

      // Acknowledge that the device is ringing
      socket.emit('call:ringing', { roomId: payload.roomId });

      // Play ringing melody & show system notification
      startIncomingCallRingtone();
      showBrowserNotification(
        payload.screenShare
          ? 'Incoming Screen Share'
          : `Incoming ${payload.kind === 'VIDEO' ? 'Video' : 'Voice'} Call`,
        {
          body: `${payload.fromDisplayName} is ${payload.screenShare ? 'sharing their screen...' : 'calling...'}`,
          tag: `call-${payload.roomId}`,
          requireInteraction: true,
        },
      );

      setCall({
        roomId: payload.roomId,
        conversationId: payload.conversationId,
        kind: payload.kind,
        peerName: payload.fromDisplayName,
        phase: 'incoming',
        screenShare: Boolean(payload.screenShare),
      });
      phaseRef.current = 'incoming';
    };

    const onRinging = (payload: { roomId: string }) => {
      if (currentRoomIdRef.current && payload.roomId !== currentRoomIdRef.current) return;
      if (phaseRef.current === 'calling' || phaseRef.current === 'outgoing') {
        setPhase('ringing');
        startOutgoingRingback();
      }
    };

    const onMediaChunk = (payload: { roomId: string; chunk: ArrayBuffer }) => {
      // If WebRTC is already connected, ignore WebSocket relay chunks so there is zero duplicate audio or double voice
      if (pcRef.current && pcRef.current.connectionState === 'connected') {
        return;
      }
      const activeRoom = currentRoomIdRef.current || call?.roomId;
      if (!activeRoom || payload.roomId !== activeRoom) return;
      stopOutgoingRingtone();
      stopIncomingCallRingtone();
      if (!playerRef.current) {
        playerRef.current = new StreamAudioPlayer();
        playerRef.current.start();
      }
      playerRef.current.pushChunk(payload.chunk);
      if (phaseRef.current === 'connecting' || phaseRef.current === 'ringing' || phaseRef.current === 'calling') {
        setPhase('active');
        setCall((c) => (c ? { ...c, phase: 'active', startedAt: c.startedAt || Date.now() } : c));
      }
    };

    const onSignal = async (payload: { roomId: string; type: string; data: unknown }) => {
      const activeRoom = currentRoomIdRef.current || call?.roomId;
      if (!activeRoom || payload.roomId !== activeRoom) return;

      try {
        if (payload.type === 'offer') {
          const offer = payload.data as RTCSessionDescriptionInit;
          if (!acceptedRef.current || !pcRef.current) {
            // Callee has not clicked Accept yet: queue offer
            pendingOffer.current = offer;
            return;
          }

          // Callee has already accepted and peer connection is constructed!
          await pcRef.current.setRemoteDescription(offer);
          pendingOffer.current = null;

          for (const candidate of pendingIce.current) {
            await pcRef.current.addIceCandidate(candidate).catch(() => undefined);
          }
          pendingIce.current = [];

          if (pcRef.current.signalingState === 'have-remote-offer' || pcRef.current.signalingState === 'have-local-pranswer') {
            const rawAnswer = await pcRef.current.createAnswer();
            const tunedSdp = tuneOpusSdp(rawAnswer.sdp || '');
            const answer: RTCSessionDescriptionInit = { type: rawAnswer.type, sdp: tunedSdp };
            await pcRef.current.setLocalDescription(answer);

            socket.emit('call:signal', { roomId: activeRoom, type: 'answer', data: pcRef.current.localDescription });
            setPhase('connecting');
          }
          return;
        }

        if (payload.type === 'answer') {
          const answer = payload.data as RTCSessionDescriptionInit;
          if (pcRef.current && pcRef.current.signalingState === 'have-local-offer') {
            await pcRef.current.setRemoteDescription(answer);
            for (const candidate of pendingIce.current) {
              await pcRef.current.addIceCandidate(candidate).catch(() => undefined);
            }
            pendingIce.current = [];
            setPhase('connecting');
          }
          return;
        }

        if (payload.type === 'ice') {
          const candidate = payload.data as RTCIceCandidateInit;
          if (!pcRef.current || !pcRef.current.remoteDescription) {
            pendingIce.current.push(candidate);
            return;
          }
          await pcRef.current.addIceCandidate(candidate).catch(() => undefined);
        }
      } catch (error) {
        setPhase('error', error instanceof Error ? error.message : 'signalling error');
      }
    };

    const onEnded = (payload: { roomId: string }) => {
      stopIncomingCallRingtone();
      stopOutgoingRingtone();
      const activeRoom = currentRoomIdRef.current || call?.roomId;
      if (!activeRoom || payload.roomId !== activeRoom) return;
      teardown();
      setPhase('ended', 'The other side hung up');
      window.setTimeout(() => {
        setCall(null);
        phaseRef.current = 'idle';
      }, 1800);
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:ringing', onRinging);
    socket.on('call:media-chunk', onMediaChunk);
    socket.on('call:signal', onSignal);
    socket.on('call:ended', onEnded);

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:ringing', onRinging);
      socket.off('call:media-chunk', onMediaChunk);
      socket.off('call:signal', onSignal);
      socket.off('call:ended', onEnded);
    };
  }, [call?.roomId, setPhase, teardown]);

  useEffect(() => () => teardown(), [teardown]);

  return {
    call,
    localStream,
    remoteStream,
    muted,
    isCameraOff,
    isScreenSharing,
    start,
    accept,
    hangup,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
  };
}
