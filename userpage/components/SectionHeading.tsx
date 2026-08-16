import type { ReactNode } from "react";
import type { IconType } from "react-icons";

/**
 * The panel heading used across every card section. Was a bare `<h2>` with the
 * same six utility classes copied into a dozen files; the icon gives each panel
 * something to recognise it by when the page is a stack of identical white
 * cards.
 */
export default function SectionHeading({
  icon: Icon,
  className = "",
  children,
}: {
  icon: IconType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      className={`flex items-center gap-2 text-[13px] font-600 uppercase tracking-[0.16em] text-ink-soft ${className}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {children}
    </h2>
  );
}
