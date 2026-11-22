'use client';

import { useRef, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { makeStore, type AppStore } from './index';
import { ThemeProvider } from '../lib/theme';

export function StoreProvider({ children }: { children: ReactNode }) {
  const ref = useRef<AppStore | null>(null);
  if (!ref.current) ref.current = makeStore();
  return (
    <Provider store={ref.current}>
      <ThemeProvider>{children}</ThemeProvider>
    </Provider>
  );
}
