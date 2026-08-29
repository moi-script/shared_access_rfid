import Image from "next/image";
import ncstLogo from "@/public/ncst-logo.png";

/**
 * The NCST institutional seal — the school's official mark.
 *
 * SWAP POINT: this file is the only thing that changes when the logo artwork is
 * replaced. Keep the contract — one default export, accepts `className`, renders
 * a single square mark — and every consumer (the dashboard header, AdminShell,
 * BrandPanel, ChangePasswordForm, LoginExperience, RegistrationForm, and the
 * gate terminals) picks the new artwork up untouched.
 *
 * `ncst-logo.png` is derived from the 6000x5935 source `ncst_logo.png`: its
 * fully-transparent margin is trimmed off, the remainder is centred on a square
 * transparent canvas so the round seal stays circular in any box, and it is
 * resized to 512px (2.2 MB -> 62 KB). Regenerate it the same way if the crest
 * changes, and regenerate app/icon.png, app/apple-icon.png and app/favicon.ico
 * from the same square so the tab icon never drifts from the in-app mark.
 *
 * The earlier placeholder glyph — a tap dot with three signal arcs — is in git
 * history; it was never the real school logo.
 *
 * Callers size this with `h-* w-*`, so the intrinsic 512px only ever scales
 * down. `loading="eager"` rather than `preload`: the mark sits above the fold on
 * every screen that renders it, but it is small enough that a preload `<link>`
 * would compete with the page's real content for bandwidth (see the Next.js 16
 * image docs, which recommend eager loading over preload in exactly this case).
 */
export default function NcstMark({ className = "" }: { className?: string }) {
  return (
    <Image
      src={ncstLogo}
      alt="National College of Science and Technology"
      loading="eager"
      sizes="96px"
      className={`object-contain ${className}`}
    />
  );
}
