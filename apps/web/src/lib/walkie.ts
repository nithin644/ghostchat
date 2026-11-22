'use client';

import { getAudioContext, playWalkieChirpIn, playWalkieChirpOut } from './sound';
import { getSocket } from './socket';

interface ActiveTransmission {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  muteGain: GainNode;
  conversationId: string;
}

let activeTransmission: ActiveTransmission | null = null;
let transmissionGeneration = 0;
let nextPlayTime = 0;
let incomingEndTimeout: ReturnType<typeof setTimeout> | null = null;

type WalkieListener = (incomingSpeaker: { displayName: string; conversationId: string } | null) => void;
const listeners = new Set<WalkieListener>();

function notifyListeners(speaker: { displayName: string; conversationId: string } | null) {
  listeners.forEach((fn) => fn(speaker));
}

export function subscribeWalkieSpeaker(fn: WalkieListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Start transmitting push-to-talk audio to a conversation.
 */
export async function startWalkieTransmission(conversationId: string): Promise<boolean> {
  if (activeTransmission) {
    stopWalkieTransmission();
  }
  const generation = ++transmissionGeneration;

  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    if (generation !== transmissionGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    // Authentic walkie-talkie chirp
    playWalkieChirpIn();

    const socket = getSocket();
    socket.emit('walkie:start', { conversationId });

    const source = ctx.createMediaStreamSource(stream);
    // 2048 samples = ~42ms at 48kHz, providing ultra-low-latency real-time voice streaming
    const processor = ctx.createScriptProcessor(2048, 1, 1);

    // Muted gain node prevents feedback loop to user's own speakers
    const muteGain = ctx.createGain();
    muteGain.gain.setValueAtTime(0, ctx.currentTime);

    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(ctx.destination);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      socket.emit('walkie:chunk', {
        conversationId,
        chunk: pcm16.buffer,
        sampleRate: ctx.sampleRate,
      });
    };

    activeTransmission = {
      stream,
      source,
      processor,
      muteGain,
      conversationId,
    };

    return true;
  } catch (err) {
    console.error('Failed to start walkie-talkie:', err);
    return false;
  }
}

/**
 * Stop active push-to-talk transmission.
 */
export function stopWalkieTransmission(): void {
  transmissionGeneration++;

  if (!activeTransmission) return;

  const { stream, source, processor, muteGain, conversationId } = activeTransmission;
  activeTransmission = null;

  try {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    muteGain.disconnect();
    stream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    console.warn('Error tearing down walkie transmission:', err);
  }

  // Play roger bleep
  playWalkieChirpOut();

  const socket = getSocket();
  socket.emit('walkie:end', { conversationId });
}

export function isWalkieTransmitting(): boolean {
  return activeTransmission !== null;
}

/**
 * Attach global socket listeners to receive live walkie-talkie intercom audio.
 */
export function registerWalkieReceiver(): () => void {
  const socket = getSocket();

  const onIncoming = (payload: { conversationId: string; fromDisplayName: string; fromPseudoId: string }) => {
    // If currently talking, don't play incoming
    if (activeTransmission) return;

    if (incomingEndTimeout) {
      clearTimeout(incomingEndTimeout);
      incomingEndTimeout = null;
    }

    nextPlayTime = 0;
    playWalkieChirpIn();
    notifyListeners({ displayName: payload.fromDisplayName, conversationId: payload.conversationId });
  };

  const onAudio = (payload: {
    conversationId: string;
    fromDisplayName: string;
    fromPseudoId: string;
    chunk: ArrayBuffer;
    sampleRate?: number;
  }) => {
    if (activeTransmission) return;

    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }

    try {
      let pcm16: Int16Array;
      const chunk = payload.chunk as unknown;
      if (chunk instanceof ArrayBuffer) {
        pcm16 = new Int16Array(chunk);
      } else if (ArrayBuffer.isView(chunk as ArrayBufferView)) {
        const view = chunk as ArrayBufferView;
        pcm16 = new Int16Array(view.buffer, view.byteOffset, view.byteLength / 2);
      } else if (chunk && typeof chunk === 'object' && 'data' in chunk) {
        pcm16 = new Int16Array((chunk as { data: number[] }).data);
      } else {
        return;
      }
      if (pcm16.length === 0) return;

      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const sampleRate = payload.sampleRate || 48000;
      const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      // 30ms anti-jitter buffer for butter-smooth gapless playback
      if (nextPlayTime < now) {
        nextPlayTime = now + 0.03;
      }

      source.start(nextPlayTime);
      nextPlayTime += audioBuffer.duration;

      // Ensure banner stays visible while audio packets are arriving
      notifyListeners({ displayName: payload.fromDisplayName, conversationId: payload.conversationId });
      if (incomingEndTimeout) clearTimeout(incomingEndTimeout);
      incomingEndTimeout = setTimeout(() => {
        notifyListeners(null);
      }, 2500);
    } catch (err) {
      console.warn('Walkie audio playback error:', err);
    }
  };

  const onEnded = (payload: { conversationId: string; fromPseudoId: string }) => {
    if (activeTransmission) return;

    playWalkieChirpOut();
    if (incomingEndTimeout) clearTimeout(incomingEndTimeout);
    incomingEndTimeout = setTimeout(() => {
      notifyListeners(null);
    }, 600);
  };

  socket.on('walkie:incoming', onIncoming);
  socket.on('walkie:audio', onAudio);
  socket.on('walkie:ended', onEnded);

  return () => {
    socket.off('walkie:incoming', onIncoming);
    socket.off('walkie:audio', onAudio);
    socket.off('walkie:ended', onEnded);
  };
}
