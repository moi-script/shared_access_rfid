import type { ReactNode } from "react";
import { TfiAlert, TfiAnnouncement, TfiInfoAlt } from "react-icons/tfi";

export type NoticeTone = "error" | "info" | "warn";

const GLYPH = {
  error: TfiAlert,
  warn: TfiAnnouncement,
  info: TfiInfoAlt,
} as const;

/**
 * The one inline message panel. Replaces the old
 * `border-l-4 border-<tone> bg-<tone>/15` stripe, which put a heavy colour wash
 * behind body text on every form, dialog and view.
 *
 * The surface is white with the same hairline the cards use, so a notice sits
 * inside a card without fighting it. The tone rides on a small icon chip
 * instead of the whole panel. Orange and yellow are both under the 3:1 floor on
 * white (see the palette note in globals.css), so the glyph itself stays ink and
 * the tone shows as a tint behind it — the same reasoning as ProfileView's
 * SummaryTile stripe.
 */
export default function Notice({
  tone = "error",
  compact = false,
  className = "",
  children,
}: {
  tone?: NoticeTone;
  /** Tighter padding and a smaller chip, for notices inside dense panels. */
  compact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const chip =
    tone === "info" ? "bg-blue/20" : tone === "warn" ? "bg-gold/40" : "bg-red/25";
  const Glyph = GLYPH[tone];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-xl border border-line bg-white ${
        compact ? "px-3 py-2" : "px-4 py-3"
      } ${className}`}
    >
      <span
        className={`grid shrink-0 place-items-center rounded-lg text-ink ${chip} ${
          compact ? "h-5 w-5" : "h-6 w-6"
        }`}
      >
        <Glyph aria-hidden className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
