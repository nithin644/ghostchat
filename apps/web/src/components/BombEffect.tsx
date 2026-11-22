'use client';

import React from 'react';
import ChatEffects, { ChatEffectType } from './ChatEffects';

interface BombEffectProps {
  active: boolean;
  onComplete?: () => void;
}

export default function BombEffect({ active, onComplete }: BombEffectProps) {
  return <ChatEffects effect={active ? 'bomb' : null} onComplete={onComplete} />;
}

export { ChatEffects };
export type { ChatEffectType };
