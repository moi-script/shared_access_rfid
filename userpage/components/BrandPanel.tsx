import Image from "next/image";
import NcstMark from "./NcstMark";
import gateIllustration from "@/public/cartoonStylePic.png";

/**
 * Left-hand institutional brand panel for the auth screens.
 * Soft coral field, isometric RFID access illustration, charcoal type.
 * Purely presentational — no client state.
 *
 * The empty space below the subhead is deliberate. Do not fill it.
 */
export default function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-r border-coral/15 bg-coral-soft text-ink lg:flex lg:h-dvh lg:flex-col lg:p-12 xl:p-14">
      {/* top: wordmark */}
      <div className="reveal flex items-center gap-3 [animation-delay:0.05s]">
        <NcstMark className="h-11 w-11" />
        <div className="leading-tight">
          <p className="font-display text-lg font-700 tracking-tight text-ink">
            NCST
          </p>
          {/* Tracking is tighter than the 0.22em this line used to carry as
              "RFID Access": the full system name is twice as long, and the wide
              letterspacing pushed it past the panel's padding. */}
          <p className="text-[11px] font-500 uppercase tracking-[0.14em] text-ink-soft">
            Centralized RFID System
          </p>
        </div>
      </div>

      {/* min-h-0 lets the illustration shrink on short viewports instead of
          pushing the headline out of the panel */}
      <div className="reveal flex min-h-0 flex-1 items-center justify-center py-8 [animation-delay:0.18s]">
        {/* object-contain + max-h-full keeps the square art inside the panel's
            padding on any viewport height rather than cropping or overflowing */}
        <Image
          src={gateIllustration}
          alt=""
          priority
          sizes="(min-width: 1280px) 34rem, 28rem"
          className="h-auto max-h-full w-full max-w-[34rem] object-contain"
        />
      </div>

      {/* bottom: headline + one-line subhead, then nothing */}
      <div className="max-w-sm">
        <h1 className="reveal font-display text-4xl font-700 leading-[1.05] tracking-tight text-ink [animation-delay:0.28s] xl:text-[2.75rem]">
          One card for{" "}
          <span className="text-coral-600">every campus gate.</span>
        </h1>
        <p className="reveal mt-4 text-[15px] leading-relaxed text-ink-soft [animation-delay:0.36s]">
          One tap logs entry and exit across the campus.
        </p>
      </div>
    </aside>
  );
}
