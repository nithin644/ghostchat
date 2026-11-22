'use client';

import React, { useEffect, useState } from 'react';
import {
  playBombExplosionSound,
  playFireSound,
  playLoveSound,
  triggerHapticVibration,
} from '@/lib/sound';

export type ChatEffectType = 'bomb' | 'fire' | 'love' | null;

interface ChatEffectsProps {
  effect: ChatEffectType;
  onComplete?: () => void;
}

interface Particle {
  id: number;
  emoji: string;
  tx: string;
  ty: string;
  size: string;
  rotation: number;
  delay: string;
}

interface FloatingItem {
  id: number;
  emoji: string;
  left: string;
  size: string;
  duration: string;
  delay: string;
  horizontalDrift: string;
}

const BOMB_PARTICLES = ['💥', '🔥', '⚡', '✨', '💨', '💣', '🔥', '💥', '✨', '⚡', '🔥', '💥', '💨', '✨', '🔥', '💥', '⚡', '💨'];
const FIRE_EMOJIS = ['🔥', '🔥', '💥', '✨', '⚡', '🔥', '🌟', '🔥', '💥', '🔥', '✨', '🔥', '⚡', '🔥', '🌟', '🔥', '💥', '🔥', '✨', '🔥'];
const LOVE_EMOJIS = ['❤️', '💖', '💕', '💘', '🥰', '💓', '💗', '🌸', '✨', '💝', '💞', '🌷', '❤️', '💖', '💕', '💘', '🥰', '💓', '💗', '🌸', '✨', '💝', '💞', '🌷', '❤️', '💖', '💕', '💘'];

export default function ChatEffects({ effect, onComplete }: ChatEffectsProps) {
  const onCompleteRef = React.useRef(onComplete);
  onCompleteRef.current = onComplete;

  const [bombPhase, setBombPhase] = useState<'idle' | 'dropping' | 'exploding'>('idle');
  const [bombParticles, setBombParticles] = useState<Particle[]>([]);
  const [floatingItems, setFloatingItems] = useState<FloatingItem[]>([]);

  useEffect(() => {
    if (!effect) {
      setBombPhase('idle');
      setFloatingItems([]);
      return;
    }

    // Hard 2-second timeout for all special effects
    const effectTimer = setTimeout(() => {
      setBombPhase('idle');
      setFloatingItems([]);
      onCompleteRef.current?.();
    }, 2000);

    if (effect === 'bomb') {
      const generated: Particle[] = BOMB_PARTICLES.map((emoji, index) => {
        const angle = (index / BOMB_PARTICLES.length) * 2 * Math.PI + (Math.random() * 0.4 - 0.2);
        const distance = 140 + Math.random() * 180;
        const tx = `${Math.round(Math.cos(angle) * distance)}px`;
        const ty = `${Math.round(Math.sin(angle) * distance)}px`;
        const size = `${Math.round(24 + Math.random() * 26)}px`;
        const rotation = Math.round(Math.random() * 360);
        const delay = `${Math.round(Math.random() * 80)}ms`;
        return { id: index, emoji, tx, ty, size, rotation, delay };
      });
      setBombParticles(generated);
      setBombPhase('dropping');

      const explodeTimer = setTimeout(() => {
        setBombPhase('exploding');
        playBombExplosionSound();
        triggerHapticVibration();
      }, 350);

      return () => {
        clearTimeout(explodeTimer);
        clearTimeout(effectTimer);
      };
    }

    if (effect === 'fire') {
      // Setup fire rising embers & sparks tuned for 2.0s duration
      const items: FloatingItem[] = Array.from({ length: 26 }).map((_, i) => ({
        id: i,
        emoji: FIRE_EMOJIS[i % FIRE_EMOJIS.length] || '🔥',
        left: `${Math.round(Math.random() * 94 + 3)}%`,
        size: `${Math.round(22 + Math.random() * 24)}px`,
        duration: `${(1.1 + Math.random() * 0.4).toFixed(2)}s`,
        delay: `${Math.round(Math.random() * 280)}ms`,
        horizontalDrift: `${Math.round(Math.random() * 50 - 25)}px`,
      }));
      setFloatingItems(items);
      playFireSound();
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([80, 50, 120, 60, 180]); } catch {}
      }

      return () => {
        clearTimeout(effectTimer);
      };
    }

    if (effect === 'love') {
      // Setup floating romantic hearts tuned for strictly 2.0s duration
      const items: FloatingItem[] = Array.from({ length: 30 }).map((_, i) => ({
        id: i,
        emoji: LOVE_EMOJIS[i % LOVE_EMOJIS.length] || '❤️',
        left: `${Math.round(Math.random() * 90 + 5)}%`,
        size: `${Math.round(24 + Math.random() * 26)}px`,
        duration: `${(1.2 + Math.random() * 0.4).toFixed(2)}s`,
        delay: `${Math.round(Math.random() * 250)}ms`,
        horizontalDrift: `${Math.round(Math.random() * 60 - 30)}px`,
      }));
      setFloatingItems(items);
      playLoveSound();
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate([100, 120, 150]); } catch {}
      }

      return () => {
        clearTimeout(effectTimer);
      };
    }
  }, [effect]);

  if (!effect) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden"
      aria-hidden="true"
    >
      {/* ======================= BOMB EFFECT ======================= */}
      {effect === 'bomb' && (
        <>
          {bombPhase === 'exploding' && (
            <div className="animate-bomb-flash absolute inset-0 bg-gradient-to-r from-amber-500/30 via-red-500/40 to-orange-500/30 backdrop-blur-[1px]" />
          )}

          {bombPhase === 'dropping' && (
            <div className="relative flex flex-col items-center animate-bomb-drop">
              <div className="absolute -top-7 right-4 animate-fuse-flame text-3xl">
                ✨
              </div>
              <div className="text-8xl select-none filter drop-shadow-[0_15px_30px_rgba(0,0,0,0.6)]">
                💣
              </div>
            </div>
          )}

          {bombPhase === 'exploding' && (
            <div className="relative flex items-center justify-center">
              <div className="animate-bomb-shockwave absolute h-44 w-44 rounded-full border-4 border-amber-400 bg-orange-500/25 shadow-[0_0_60px_rgba(255,152,0,0.8)]" />
              <div
                className="animate-bomb-shockwave absolute h-32 w-32 rounded-full border-4 border-red-500 bg-red-600/30 shadow-[0_0_40px_rgba(244,67,54,0.9)]"
                style={{ animationDelay: '60ms' }}
              />

              {bombParticles.map((p) => (
                <div
                  key={p.id}
                  className="absolute select-none font-bold transition-all"
                  style={{
                    fontSize: p.size,
                    transform: `translate(${p.tx}, ${p.ty}) rotate(${p.rotation}deg)`,
                    animation: `bombParticleFly 0.9s cubic-bezier(0.15, 0.85, 0.25, 1) forwards`,
                    animationDelay: p.delay,
                  }}
                >
                  {p.emoji}
                </div>
              ))}

              <div className="relative z-10 flex flex-col items-center animate-ping select-none">
                <span className="text-9xl filter drop-shadow-[0_0_35px_rgba(255,100,0,1)]">
                  💥
                </span>
              </div>

              <div className="absolute z-20 -bottom-10 rounded-full border-2 border-amber-300 bg-gradient-to-r from-red-600 via-orange-600 to-amber-500 px-6 py-1.5 shadow-[0_0_25px_rgba(255,87,34,0.8)]">
                <span className="text-xl font-black tracking-widest text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                  💥 BOOM! 💥
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {/* ======================= FIRE EFFECT ======================= */}
      {effect === 'fire' && (
        <>
          {/* Warm Screen Blaze Glow */}
          <div className="animate-fire-glow absolute inset-0 bg-gradient-to-t from-red-600/35 via-orange-500/20 to-transparent backdrop-blur-[0.5px]" />

          {/* Bottom Inferno Flame Wall */}
          <div className="absolute bottom-0 inset-x-0 flex justify-around items-end overflow-hidden h-40">
            {['🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥', '🔥'].map((f, i) => (
              <span
                key={i}
                className="text-6xl md:text-7xl select-none animate-fire-flicker transform translate-y-3"
                style={{
                  animationDelay: `${(i * 45) % 220}ms`,
                  filter: 'drop-shadow(0 0 20px rgba(255, 69, 0, 0.9))',
                }}
              >
                {f}
              </span>
            ))}
          </div>

          {/* Rising Sparks & Floating Fire Embers */}
          {floatingItems.map((item) => (
            <div
              key={item.id}
              className="absolute select-none"
              style={{
                left: item.left,
                bottom: '10px',
                fontSize: item.size,
                animation: `risingFlame ${item.duration} cubic-bezier(0.2, 0.7, 0.3, 1) forwards`,
                animationDelay: item.delay,
                filter: 'drop-shadow(0 0 10px rgba(255, 140, 0, 0.8))',
              }}
            >
              {item.emoji}
            </div>
          ))}

          {/* Central Blazing Flame Emblem & Badge */}
          <div
            className="relative z-20 flex flex-col items-center select-none"
            style={{ animation: 'emblemPopInOut 1.95s ease-in-out forwards' }}
          >
            <span className="text-9xl filter drop-shadow-[0_0_40px_rgba(255,87,34,1)] animate-fire-flicker">
              🔥
            </span>
            <div className="mt-2 rounded-full border-2 border-amber-300 bg-gradient-to-r from-red-600 via-orange-600 to-amber-500 px-7 py-1.5 shadow-[0_0_30px_rgba(255,100,0,0.9)]">
              <span className="text-xl font-black tracking-widest text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                🔥 ON FIRE! 🔥
              </span>
            </div>
          </div>
        </>
      )}

      {/* ======================= LOVE EFFECT ======================= */}
      {effect === 'love' && (
        <>
          {/* Soft Romantic Ambient Glow */}
          <div className="animate-love-glow absolute inset-0 bg-gradient-to-b from-rose-500/15 via-pink-500/20 to-rose-600/25 backdrop-blur-[0.5px]" />

          {/* Floating Fountain of Hearts Across Chat */}
          {floatingItems.map((item) => (
            <div
              key={item.id}
              className="absolute select-none"
              style={{
                left: item.left,
                bottom: '-30px',
                fontSize: item.size,
                animation: `loveHeartFloat ${item.duration} cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards`,
                animationDelay: item.delay,
                filter: 'drop-shadow(0 0 12px rgba(244, 63, 94, 0.85))',
              }}
            >
              {item.emoji}
            </div>
          ))}

          {/* Pulsing Central Sweet Heart Emblem */}
          <div
            className="relative z-20 flex flex-col items-center select-none"
            style={{ animation: 'emblemPopInOut 1.95s ease-in-out forwards' }}
          >
            <span className="text-9xl filter drop-shadow-[0_0_35px_rgba(244,63,94,1)] animate-heart-pulse">
              💖
            </span>
            <div className="mt-2 rounded-full border-2 border-pink-300 bg-gradient-to-r from-rose-600 via-pink-600 to-fuchsia-500 px-7 py-1.5 shadow-[0_0_25px_rgba(244,63,94,0.9)]">
              <span className="text-xl font-black tracking-widest text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                💖 WITH LOVE 💖
              </span>
            </div>
          </div>
        </>
      )}

      {/* CSS Keyframes for particles, flames, and hearts */}
      <style jsx>{`
        @keyframes emblemPopInOut {
          0% {
            transform: scale(0.3);
            opacity: 0;
          }
          15% {
            transform: scale(1.12);
            opacity: 1;
          }
          25% {
            transform: scale(1);
            opacity: 1;
          }
          75% {
            transform: scale(1);
            opacity: 1;
          }
          100% {
            transform: scale(0.65);
            opacity: 0;
          }
        }
        @keyframes bombParticleFly {
          0% {
            transform: translate(0, 0) scale(0.4);
            opacity: 1;
          }
          65% {
            opacity: 1;
          }
          100% {
            transform: translate(var(--tx, 0), var(--ty, 0)) scale(1.1);
            opacity: 0;
          }
        }
        @keyframes risingFlame {
          0% {
            transform: translateY(0) scale(0.5) rotate(0deg);
            opacity: 0;
          }
          20% {
            opacity: 1;
          }
          80% {
            opacity: 0.9;
          }
          100% {
            transform: translateY(-90vh) scale(1.3) rotate(20deg);
            opacity: 0;
          }
        }
        @keyframes loveHeartFloat {
          0% {
            transform: translateY(0) scale(0.4) rotate(0deg);
            opacity: 0;
          }
          15% {
            opacity: 1;
            transform: translateY(-15vh) scale(1.1) rotate(-8deg);
          }
          60% {
            opacity: 0.95;
            transform: translateY(-55vh) scale(1.2) rotate(10deg);
          }
          100% {
            transform: translateY(-105vh) scale(0.85) rotate(-12deg);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}
