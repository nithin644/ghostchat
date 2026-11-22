'use client';

import { useEffect } from 'react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled app error:', error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-wa-panel px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-7 text-center shadow-sm ring-1 ring-black/5">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-black/85">Something went wrong</h2>
        <p className="mt-2 text-xs text-black/50">
          {error?.message || 'An unexpected error occurred while loading GhostChat.'}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={() => reset()}
            className="w-full rounded-lg bg-wa-green py-2.5 text-sm font-semibold text-white hover:bg-wa-greenDark"
          >
            Try Again
          </button>
          <button
            onClick={() => {
              window.location.href = '/onboarding';
            }}
            className="w-full rounded-lg border border-black/10 py-2.5 text-sm font-medium text-black/70 hover:bg-black/5"
          >
            Return to Onboarding
          </button>
        </div>
      </div>
    </main>
  );
}
