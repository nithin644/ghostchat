'use client';

export function VerifiedBadge({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-sky-500 text-white shadow-sm"
      style={{ width: size, height: size, fontSize: size * 0.72, lineHeight: 1 }}
      title="Verified account"
      aria-label="Verified account"
    >
      ✓
    </span>
  );
}
