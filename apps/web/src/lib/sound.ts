'use client';

let audioCtx: AudioContext | null = null;
let ringtoneInterval: ReturnType<typeof setInterval> | null = null;
let ringbackInterval: ReturnType<typeof setInterval> | null = null;
let incomingMasterGain: GainNode | null = null;
let outgoingMasterGain: GainNode | null = null;

export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioCtx();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => undefined);
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Initialize and unlock audio context on user gesture to conform to browser autoplay policies.
 */
export function initAudioOnUserGesture(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
}

/**
 * Play a crisp, pleasant WhatsApp-style incoming message notification chime.
 * Synthesized using dual-tone sine waves with an exponential decay envelope.
 */
export function playMessageNotificationSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;

    // Tone 1: High note (880 Hz / A5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(0.24, now + 0.01);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.1);

    // Tone 2: Melodic resolution note (1318.5 Hz / E6)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1318.5, now + 0.08);
    gain2.gain.setValueAtTime(0, now + 0.08);
    gain2.gain.linearRampToValueAtTime(0.3, now + 0.095);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.45);
  } catch (err) {
    console.warn('Could not play message notification sound:', err);
  }
}

/**
 * Trigger physical haptic vibration pulses on supported mobile devices.
 */
export function triggerHapticVibration(): void {
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      // Impact pulse sequence: initial spark, heavy blast thump, rumble tail
      navigator.vibrate([60, 40, 180, 50, 320, 60, 200]);
    } catch {}
  }
}

/**
 * Play a cinematic bomb explosion sound effect with sub-bass detonation thump,
 * filtered shockwave noise, and deep reverberation.
 */
export function playBombExplosionSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;

    // 1. Initial fuse crackle/spark (0.0 to 0.12s)
    const fuseLen = Math.floor(ctx.sampleRate * 0.12);
    const fuseBuf = ctx.createBuffer(1, fuseLen, ctx.sampleRate);
    const fuseData = fuseBuf.getChannelData(0);
    for (let i = 0; i < fuseLen; i++) {
      fuseData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.06));
    }
    const fuseSrc = ctx.createBufferSource();
    fuseSrc.buffer = fuseBuf;
    const fuseFilter = ctx.createBiquadFilter();
    fuseFilter.type = 'highpass';
    fuseFilter.frequency.setValueAtTime(3200, now);
    const fuseGain = ctx.createGain();
    fuseGain.gain.setValueAtTime(0.25, now);
    fuseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    fuseSrc.connect(fuseFilter);
    fuseFilter.connect(fuseGain);
    fuseGain.connect(ctx.destination);
    fuseSrc.start(now);

    // Detonation instant
    const detTime = now + 0.08;

    // 2. Punchy Sub-Bass Impact (detonation thump)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(180, detTime);
    subOsc.frequency.exponentialRampToValueAtTime(30, detTime + 0.55);
    subGain.gain.setValueAtTime(0, detTime);
    subGain.gain.linearRampToValueAtTime(0.9, detTime + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.001, detTime + 0.85);
    subOsc.connect(subGain);
    subGain.connect(ctx.destination);
    subOsc.start(detTime);
    subOsc.stop(detTime + 0.9);

    // 3. Dense Explosion Blast Noise (white noise filtered through sweeping low-pass)
    const blastDur = 1.4;
    const blastLen = Math.floor(ctx.sampleRate * blastDur);
    const blastBuf = ctx.createBuffer(1, blastLen, ctx.sampleRate);
    const blastData = blastBuf.getChannelData(0);
    for (let i = 0; i < blastLen; i++) {
      blastData[i] = Math.random() * 2 - 1;
    }
    const blastSrc = ctx.createBufferSource();
    blastSrc.buffer = blastBuf;

    const blastFilter = ctx.createBiquadFilter();
    blastFilter.type = 'lowpass';
    blastFilter.frequency.setValueAtTime(1600, detTime);
    blastFilter.frequency.exponentialRampToValueAtTime(60, detTime + blastDur);

    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(0, detTime);
    blastGain.gain.linearRampToValueAtTime(0.85, detTime + 0.03);
    blastGain.gain.exponentialRampToValueAtTime(0.0001, detTime + blastDur);

    blastSrc.connect(blastFilter);
    blastFilter.connect(blastGain);
    blastGain.connect(ctx.destination);
    blastSrc.start(detTime);
    blastSrc.stop(detTime + blastDur);
  } catch (err) {
    console.warn('Could not play bomb explosion sound:', err);
  }
}

/**
 * Play a roaring blaze / crackling fire sound effect.
 */
export function playFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;
    const dur = 2.0;

    // 1. Roaring low flame whoosh (filtered noise with swelling gain)
    const flameLen = Math.floor(ctx.sampleRate * dur);
    const flameBuf = ctx.createBuffer(1, flameLen, ctx.sampleRate);
    const flameData = flameBuf.getChannelData(0);
    let lastOut = 0.0;
    // Pink noise integration for deep warm flame body
    for (let i = 0; i < flameLen; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      flameData[i] = lastOut * 3.5;
    }
    const flameSrc = ctx.createBufferSource();
    flameSrc.buffer = flameBuf;

    const flameFilter = ctx.createBiquadFilter();
    flameFilter.type = 'lowpass';
    flameFilter.frequency.setValueAtTime(350, now);
    flameFilter.frequency.linearRampToValueAtTime(500, now + 0.6);
    flameFilter.frequency.exponentialRampToValueAtTime(180, now + dur);

    const flameGain = ctx.createGain();
    flameGain.gain.setValueAtTime(0, now);
    flameGain.gain.linearRampToValueAtTime(0.7, now + 0.25);
    flameGain.gain.linearRampToValueAtTime(0.5, now + 1.2);
    flameGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    flameSrc.connect(flameFilter);
    flameFilter.connect(flameGain);
    flameGain.connect(ctx.destination);
    flameSrc.start(now);
    flameSrc.stop(now + dur);

    // 2. High-frequency crackle / embers popping
    const crackleCount = 18;
    for (let c = 0; c < crackleCount; c++) {
      const popTime = now + 0.05 + Math.random() * 1.5;
      const popOsc = ctx.createOscillator();
      const popGain = ctx.createGain();
      popOsc.type = 'triangle';
      popOsc.frequency.setValueAtTime(1400 + Math.random() * 2200, popTime);
      popOsc.frequency.exponentialRampToValueAtTime(200, popTime + 0.035);

      popGain.gain.setValueAtTime(0, popTime);
      popGain.gain.linearRampToValueAtTime(0.18 + Math.random() * 0.15, popTime + 0.005);
      popGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.04);

      popOsc.connect(popGain);
      popGain.connect(ctx.destination);
      popOsc.start(popTime);
      popOsc.stop(popTime + 0.05);
    }
  } catch (err) {
    console.warn('Could not play fire sound:', err);
  }
}

/**
 * Play a dreamy, romantic harp / music-box arpeggio chime chord for /love.
 */
export function playLoveSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;

    // Romantic major-9th sweet arpeggio: F5 (698.5Hz), A5 (880Hz), C6 (1046.5Hz), E6 (1318.5Hz), G6 (1568Hz)
    const notes = [698.46, 880.0, 1046.5, 1318.51, 1567.98];
    notes.forEach((freq, idx) => {
      const noteTime = now + idx * 0.09;

      // Primary sweet sine wave
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, noteTime);

      gain.gain.setValueAtTime(0, noteTime);
      gain.gain.linearRampToValueAtTime(0.3, noteTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 1.2);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(noteTime);
      osc.stop(noteTime + 1.25);

      // Shimmer sparkle harmonic overtone (octave + fifth)
      const shimmer = ctx.createOscillator();
      const shimmerGain = ctx.createGain();
      shimmer.type = 'triangle';
      shimmer.frequency.setValueAtTime(freq * 2, noteTime);

      shimmerGain.gain.setValueAtTime(0, noteTime);
      shimmerGain.gain.linearRampToValueAtTime(0.1, noteTime + 0.015);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 0.6);

      shimmer.connect(shimmerGain);
      shimmerGain.connect(ctx.destination);
      shimmer.start(noteTime);
      shimmer.stop(noteTime + 0.65);
    });
  } catch (err) {
    console.warn('Could not play love sound:', err);
  }
}

/**
 * Start playing incoming call ringtone.
 * Plays a continuous melodic smartphone ringtone sequence until stopped.
 */
export function startIncomingCallRingtone(): void {
  stopIncomingCallRingtone();
  stopOutgoingRingtone();

  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => undefined);
  }

  incomingMasterGain = ctx.createGain();
  incomingMasterGain.gain.setValueAtTime(1.0, ctx.currentTime);
  incomingMasterGain.connect(ctx.destination);

  const playPhrase = () => {
    if (!ctx || !incomingMasterGain) return;

    try {
      const now = ctx.currentTime;
      // Melodic Rhodes/marimba ringtone sequence
      const notes = [
        { f: 523.25, t: 0.0, d: 0.12 }, // C5
        { f: 659.25, t: 0.13, d: 0.12 }, // E5
        { f: 783.99, t: 0.26, d: 0.12 }, // G5
        { f: 1046.5, t: 0.39, d: 0.35 }, // C6
        { f: 880.0, t: 0.82, d: 0.12 },  // A5
        { f: 1046.5, t: 0.95, d: 0.12 }, // C6
        { f: 1318.5, t: 1.08, d: 0.42 }, // E6
      ];

      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(note.f, now + note.t);
        gain.gain.setValueAtTime(0, now + note.t);
        gain.gain.linearRampToValueAtTime(0.3, now + note.t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.t + note.d);
        osc.connect(gain);
        gain.connect(incomingMasterGain);
        osc.start(now + note.t);
        osc.stop(now + note.t + note.d);
      }
    } catch {
      // non-fatal
    }
  };

  playPhrase();
  ringtoneInterval = setInterval(playPhrase, 2000);
}

/**
 * Stop the incoming call ringtone immediately.
 */
export function stopIncomingCallRingtone(): void {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (incomingMasterGain) {
    try {
      if (audioCtx) {
        incomingMasterGain.gain.setValueAtTime(0, audioCtx.currentTime);
      }
      incomingMasterGain.disconnect();
    } catch {
      // non-fatal
    }
    incomingMasterGain = null;
  }
}

/**
 * Start playing outgoing telephone ringback tone ("brrr... brrr...") while caller waits.
 */
export function startOutgoingRingback(): void {
  stopOutgoingRingtone();
  stopIncomingCallRingtone();

  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => undefined);
  }

  outgoingMasterGain = ctx.createGain();
  outgoingMasterGain.gain.setValueAtTime(1.0, ctx.currentTime);
  outgoingMasterGain.connect(ctx.destination);

  const playBeep = () => {
    if (!ctx || !outgoingMasterGain) return;

    try {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(440, now);
      osc2.frequency.setValueAtTime(480, now);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
      gain.gain.setValueAtTime(0.12, now + 1.15);
      gain.gain.linearRampToValueAtTime(0.0001, now + 1.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(outgoingMasterGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 1.2);
      osc2.stop(now + 1.2);
    } catch {
      // non-fatal
    }
  };

  playBeep();
  ringbackInterval = setInterval(playBeep, 3200);
}

/**
 * Stop the outgoing telephone ringback tone immediately.
 */
export function stopOutgoingRingtone(): void {
  if (ringbackInterval) {
    clearInterval(ringbackInterval);
    ringbackInterval = null;
  }
  if (outgoingMasterGain) {
    try {
      if (audioCtx) {
        outgoingMasterGain.gain.setValueAtTime(0, audioCtx.currentTime);
      }
      outgoingMasterGain.disconnect();
    } catch {
      // non-fatal
    }
    outgoingMasterGain = null;
  }
}

/**
 * Request notification permissions from the browser.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch {
    return false;
  }
}

/**
 * Display a native browser notification if granted.
 */
export function showBrowserNotification(
  title: string,
  options?: NotificationOptions & { onClick?: () => void },
): Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  if (Notification.permission !== 'granted') return null;

  try {
    const notif = new Notification(title, {
      badge: '/favicon.ico',
      icon: '/favicon.ico',
      ...options,
    });
    if (options?.onClick) {
      notif.onclick = () => {
        window.focus();
        options.onClick!();
        notif.close();
      };
    }
    return notif;
  } catch {
    return null;
  }
}

/**
 * Play authentic walkie-talkie chirp sounds (synthesized sine sweep).
 */
export function playWalkieChirpIn(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1350, now + 0.06);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  } catch {}
}

export function playWalkieChirpOut(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(650, now + 0.07);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch {}
}
