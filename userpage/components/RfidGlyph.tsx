/**
 * Contactless / RFID glyph — a tap dot with three signal arcs.
 *
 * This is NOT the school logo. It is an abstract icon for the ACT of tapping a
 * card, and it lives on wherever the meaning is "hold your card to the reader"
 * rather than "this is NCST" — currently the login screen's tap hint.
 *
 * It used to be the placeholder for the institutional mark, before the real
 * NCST seal existed. It stayed behind rather than being replaced along with it
 * for two reasons: the seal is a detailed crest that turns into an unreadable
 * navy blob below roughly 32px, and this glyph says something the seal does not
 * say at all. See [[NcstMark]] for the actual logo.
 */
export default function RfidGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="Contactless card reader"
      className={className}
      fill="none"
    >
      <rect x="1" y="1" width="46" height="46" rx="13" fill="var(--color-navy-700)" />
      <rect
        x="1"
        y="1"
        width="46"
        height="46"
        rx="13"
        stroke="var(--color-gold)"
        strokeWidth="1.5"
        opacity="0.85"
      />
      {/* tap dot */}
      <circle cx="17" cy="24" r="3.4" fill="var(--color-gold)" />
      {/* signal arcs */}
      <path
        d="M24 16.5a10.6 10.6 0 0 1 0 15"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M29 13a16.4 16.4 0 0 1 0 22"
        stroke="#ffffff"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.72"
      />
      <path
        d="M34 9.5a22 22 0 0 1 0 29"
        stroke="var(--color-red)"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
