'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api';
import { getActiveIdentitySeed } from '../lib/vault';

/** Entry point: bounce to the chat shell or to onboarding. */
export default function IndexPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(() => {
        if (!cancelled) {
          if (getActiveIdentitySeed()) {
            router.replace('/chat');
          } else {
            router.replace('/onboarding');
          }
        }
      })
      .catch(() => {
        if (!cancelled) router.replace('/onboarding');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="flex h-screen items-center justify-center bg-wa-panel">
      <div className="text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-wa-green border-t-transparent" />
        <p className="text-sm text-black/50">Opening GhostChat…</p>
      </div>
    </main>
  );
}
