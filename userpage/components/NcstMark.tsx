/** NCST contactless / RFID glyph — a tap dot with three signal arcs. */
export default function NcstMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="NCST RFID mark"
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
