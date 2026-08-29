import NcstMark from "@/components/NcstMark";

/**
 * The student ID card the idle terminal holds just off the reader plate.
 *
 * A depiction of the physical NCST card, built from the design in
 * `components/template_id/ic_card.html` — white header carrying the seal, navy
 * name banner, yellow body with the photo frame, white footer under a yellow
 * rule. The template's literal colours are kept rather than mapped onto the
 * app's tokens: this draws a real object that exists in the world, and matching
 * the card in the guard's hand matters more here than matching the palette of
 * the screen around it.
 *
 * DECORATIVE, and `aria-hidden` at the call site. Every field is a blank
 * placeholder bar rather than a sample name and student number, which is the
 * rule the abstract card this replaced already followed: this sits on a LIVE
 * gate terminal, and a plausible-looking "Alex Taylor Smith / 2024-98765" on
 * screen is something a guard can misread as a real tap. The card is here to
 * say "hold one of these to the reader", nothing more.
 *
 * Portrait, and sized off its HEIGHT so it always clears the reader field it
 * floats in (h-72, sm:h-96) — the width follows from the template's 280:440.
 */
export default function GateIdCard() {
  return (
    <div className="relative h-[14rem] w-[8.9rem] overflow-hidden rounded-xl border border-black/10 bg-white shadow-2xl shadow-black/50 sm:h-[17.5rem] sm:w-[11.15rem]">
      <div className="flex h-full flex-col">
        {/* Header — the seal, with the semester validation sticker beside it. */}
        <div className="relative flex h-[20%] items-center justify-center bg-white">
          {/* The green sticker reads bottom-to-top on the real card. */}
          <div
            className="absolute left-1.5 top-1.5 flex h-[58%] w-[9%] items-center justify-center bg-[#1ed75f] text-center text-[5px] font-700 leading-tight text-black shadow-sm sm:text-[6px]"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            26-27 1ST SEM
          </div>
          <div className="text-center">
            <NcstMark className="mx-auto h-8 w-8 sm:h-10 sm:w-10" />
            <p className="mt-0.5 text-[4px] uppercase tracking-[0.08em] text-[#555] sm:text-[5px]">
              National College of Science &amp; Technology
            </p>
          </div>
        </div>

        {/* Navy name banner. */}
        <div className="bg-[#2e3185] py-[3px] text-center text-[5px] font-500 uppercase tracking-[0.06em] text-white sm:text-[6px]">
          NCST Centralized RFID System
        </div>

        {/* Yellow body — details on the left, photo frame on the right. */}
        <div className="flex flex-1 items-start justify-between bg-[#e2dc12] px-2.5 py-3">
          <div className="mt-3 space-y-1">
            <div className="h-[3px] w-9 rounded-full bg-black/35" />
            <div className="h-[5px] w-14 rounded-full bg-black/70" />
            <div className="h-[3px] w-7 rounded-full bg-black/35 !mt-3" />
            <div className="h-[5px] w-10 rounded-full bg-black/70" />
          </div>
          {/* Empty frame: a stand-in face would be a person who does not exist.
              Filled with a flat grey rather than the .dot-grid utility used
              elsewhere on this screen — that utility draws WHITE dots, for dark
              panels, and is invisible against this white frame. */}
          <div className="mt-1 h-[52px] w-[42px] shrink-0 border-2 border-black bg-neutral-200 sm:h-16 sm:w-[54px]" />
        </div>

        {/* Footer — name and course, then the signature rule. */}
        <div className="flex h-[27%] flex-col items-center border-t-[3px] border-[#e2dc12] bg-white px-3 pt-2.5">
          <div className="h-[5px] w-24 rounded-full bg-black/70" />
          <div className="mt-1.5 h-[3px] w-16 rounded-full bg-black/30" />
          <div className="mt-2.5 h-[2px] w-full bg-[#e2dc12]" />
          <div className="flex flex-1 items-center opacity-60">
            <svg viewBox="0 0 200 60" className="h-5 w-16" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M 20 40 C 30 10, 50 10, 40 45 S 70 20, 80 40 S 110 5, 100 35 S 130 50, 120 20 S 150 25, 160 45 C 170 55, 180 15, 190 30"
                fill="transparent"
                stroke="black"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* Scan bar sweeping the face — kept from the card this replaced. It is
          the terminal's proof of life: a frozen screen stops sweeping. */}
      <div className="gate-scanline pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-white/45 to-transparent" />
    </div>
  );
}
