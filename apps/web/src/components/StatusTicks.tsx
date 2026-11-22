'use client';

/**
 * Message delivery state.
 *
 * `sent`/`delivered`/`read` map to the three tick states users expect from
 * WhatsApp. For a sealed-sender message the server cannot confirm authorship, so
 * receipts are the only signal and are rendered honestly.
 */
export function StatusTicks({ state }: { state: 'pending' | 'sent' | 'delivered' | 'read' }) {
  if (state === 'pending') {
    return <span className="text-[10px] opacity-50 font-normal" title="Sending...">🕒</span>;
  }
  if (state === 'sent') {
    return <span className="text-[12px] opacity-60 font-bold leading-none select-none" title="Sent (peer offline)">✓</span>;
  }
  const isRead = state === 'read';
  return (
    <span
      className={`text-[12px] font-bold leading-none select-none ${
        isRead ? 'text-[#53BDEB] drop-shadow-[0_0_2px_rgba(83,189,235,0.5)]' : 'opacity-60'
      }`}
      aria-label={state}
      title={isRead ? 'Seen (Blue Tick)' : 'Delivered (Double Tick)'}
    >
      ✓✓
    </span>
  );
}
