import type { IconType } from "react-icons";

/**
 * The one number-on-a-card tile. Replaces ProfileView's `border-l-4` stripe
 * variant, which fenced the tone off down the left edge and made three tiles in
 * a row read as three unrelated things.
 *
 * The tone is gone entirely: a count of Present, Late or Absent is not an alarm,
 * and the palette's orange and yellow cannot carry small text on white anyway
 * (see globals.css). What distinguishes the tiles now is the icon and the label,
 * which is what a reader actually scans for.
 */
export default function StatTile({
  label,
  value,
  icon: Icon,
  className = "",
}: {
  label: string;
  value?: number | string;
  icon: IconType;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-line bg-white p-5 ${className}`}>
      <div className="flex items-center gap-2 text-ink-soft">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <p className="text-[12px] font-600 uppercase tracking-[0.14em]">{label}</p>
      </div>
      <p className="mt-2 font-display text-3xl font-700 tracking-tight text-ink">
        {value ?? "—"}
      </p>
    </div>
  );
}
