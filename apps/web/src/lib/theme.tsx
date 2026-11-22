'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

export type ThemeType = 'normal' | 'hacker' | 'pro' | 'midnight' | 'nordic';

export const ALL_THEMES: { id: ThemeType; label: string; icon: string; subtitle: string }[] = [
  { id: 'normal', label: 'Normal', icon: '🌿', subtitle: 'WhatsApp Classic' },
  { id: 'pro', label: 'Executive', icon: '💼', subtitle: 'Corporate Navy' },
  { id: 'midnight', label: 'Midnight', icon: '🌌', subtitle: 'Obsidian OLED' },
  { id: 'nordic', label: 'Nordic', icon: '❄️', subtitle: 'Clean Minimalist' },
  { id: 'hacker', label: 'Hacker', icon: '⚡', subtitle: 'Terminal Matrix' },
];

interface ThemeContextValue {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'normal',
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeType>('normal');

  useEffect(() => {
    const saved = localStorage.getItem('ghostchat_theme') as ThemeType | null;
    const valid = ALL_THEMES.some((t) => t.id === saved);
    if (saved && valid) {
      setThemeState(saved);
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      setThemeState('normal');
      document.documentElement.setAttribute('data-theme', 'normal');
    }
  }, []);

  const setTheme = (newTheme: ThemeType) => {
    setThemeState(newTheme);
    localStorage.setItem('ghostchat_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
