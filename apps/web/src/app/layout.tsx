import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { StoreProvider } from '../store/StoreProvider';

export const metadata: Metadata = {
  title: 'GhostChat',
  description: 'Key-based, end-to-end encrypted messaging.',
  // Nothing here should be indexed: a messaging app's URL in a search engine is
  // a leak, not a growth channel.
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#075E54',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
