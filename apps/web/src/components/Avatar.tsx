'use client';

/**
 * Deterministic initials avatar.
 *
 * No image is fetched unless the user uploaded one, and no gravatar-style
 * third-party lookup happens: an avatar fetch is a beacon, and this component
 * must never become one.
 */
export function Avatar({
  name,
  src,
  size = 44,
}: {
  name: string;
  src?: string | null;
  size?: number;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="rounded-full object-cover"
        referrerPolicy="no-referrer"
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-full bg-wa-green/15 font-semibold text-wa-greenDark"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials || '?'}
    </div>
  );
}
