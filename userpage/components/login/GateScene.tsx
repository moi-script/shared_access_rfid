import Image from "next/image";

/**
 * Illustration for the login brand panel — an isometric RFID access scene in
 * coral and white. The login screen's coral palette is derived from this artwork.
 *
 * `login-illustration.png` is derived from the full-resolution `cartoonStylePic.png`
 * (2048x2048): its solid black background is flood-filled to transparency from the
 * borders — so interior darks like the black car and the characters' hair survive —
 * then the transparent margin is trimmed off, giving 1933x1818 of real detail.
 * Regenerate it the same way if the source art changes.
 *
 * SWAP POINT — this file is the only thing that changes when the artwork is
 * replaced. Keep the contract: one default export, accepts `className`, renders a
 * single decorative image. `BrandPanel` and every other file stay untouched.
 *
 * The earlier hand-drawn flat-vector scene is in git history (commit 50449a0).
 */
export default function GateScene({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/login-illustration.png"
      alt=""
      aria-hidden="true"
      width={1933}
      height={1818}
      priority
      sizes="(min-width: 1280px) 34rem, (min-width: 1024px) 44vw, 0px"
      className={`object-contain ${className}`}
    />
  );
}
