/**
 * The gate terminal's resting state: what the screen shows between taps.
 *
 * The direction banner is the largest thing on the panel. A person walking up
 * needs to know they are at the entry lane before they read anything else,
 * because tapping an entry card at an exit reader is the most common way a tap
 * gets denied. Entry is gold, exit is blue, so the lane is readable from far
 * enough away that nobody has to reach the reader to find out.
 *
 * Composition is off-centre: text left at display scale, reader field right.
 * Centred text on a 1080p wall panel looks like an error dialog.
 *
 * Nothing in the scene ever finishes. The card floats and the waves loop
 * outward without the card landing, so a glance from across the lobby reads as
 * "waiting" rather than "done".
 */

import GateIdCard from "./GateIdCard";

type Direction = "entry" | "exit";

const LANE: Record<Direction, { word: string; accent: string; ring: string }> = {
  entry: {
    word: "Entry",
    accent: "text-gold",
    ring: "border-gold/45 bg-gold/10",
  },
  exit: {
    // Beige, not the light blue. #0c75ba on the navy ink background only reaches
    // about 2:1 — far too dim to carry a wall panel — and every other palette
    // colour that is bright enough is a warm that reads as a sibling of gold.
    // Beige is unmistakably not gold at lobby distance, and clears 13:1.
    word: "Exit",
    accent: "text-beige",
    ring: "border-beige/55 bg-beige/12",
  },
};

export default function GateIdleScene({
  gateType,
  direction,
}: {
  gateType: "person" | "vehicle";
  direction: Direction;
}) {
  const lane = LANE[direction];

  return (
    <div className="grid w-full items-center gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-8">
      {/* ---- Instruction ---- */}
      <div className="order-2 flex flex-col items-center text-center lg:order-1 lg:items-start lg:text-left">
        {/* ---- Which lane this is ---- */}
        <div
          className={`inline-flex items-center gap-4 rounded-full border px-6 py-3 ${lane.ring}`}
        >
          <DirectionArrow direction={direction} className={`h-7 w-7 ${lane.accent}`} />
          <span
            className={`font-display text-3xl font-700 uppercase leading-none tracking-[0.16em] sm:text-4xl ${lane.accent}`}
          >
            {lane.word}
          </span>
        </div>

        <p className="mt-4 font-mono text-xs uppercase tracking-[0.42em] text-white/45">
          {gateType === "vehicle" ? "Vehicle lane" : "Person lane"}
        </p>

        <h1 className="mt-6 font-display text-5xl font-700 uppercase leading-[0.9] tracking-tight sm:text-6xl xl:text-7xl">
          Tap
          <br />
          your <span className="text-gold">card</span>
        </h1>

        <p className="mt-5 text-lg text-white/60 sm:text-xl">
          Hold it flat against the reader.
        </p>
      </div>

      {/* ---- Reader field ---- */}
      <div className="relative order-1 grid h-72 place-items-center sm:h-96 lg:order-2">
        {/* Ambient glow, well behind everything. */}
        <div
          aria-hidden
          className="drift pointer-events-none absolute h-80 w-80 rounded-full bg-gold/12 blur-3xl sm:h-96 sm:w-96"
        />

        {/* Contactless waves: the brand glyph's three arcs, at scale. They also
            double as the proof that the terminal is alive and not frozen. */}
        <div aria-hidden className="absolute grid h-64 w-64 place-items-center sm:h-80 sm:w-80">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{ animationDelay: `${i}s` }}
              className="gate-wave absolute inset-0 rounded-full border-2 border-gold/45"
            />
          ))}
          {/* The tap point the waves originate from. */}
          <span className="h-3 w-3 rounded-full bg-gold shadow-[0_0_28px_6px] shadow-gold/35" />
        </div>

        {/* The cards, held just off the plate. Two of them — the school issues
            a female and a male design, and showing both keeps the idle screen
            from reading as one gendered card.

            Laid out SIDE BY SIDE on one row, tops and bottoms flush, rather
            than fanned or stacked. An overlap always hides part of the card
            behind it, and on a wall panel read from across a lane the pair has
            to say "either of these works" at a glance — which it only does when
            both cards are whole. Neither is recessed for the same reason: they
            are peers here, not a stack with a front.

            The two scan sweeps are offset so the row does not pulse in unison;
            that reads as one reader passing across both. */}
        <div aria-hidden className="gate-float-row flex items-center gap-2 sm:gap-3">
          <GateIdCard variant="male" />
          <GateIdCard variant="female" scanDelay={1.8} />
        </div>
      </div>
    </div>
  );
}

/**
 * Entry points into a wall, exit points away from one. The wall is on the side
 * the arrow meets, which keeps the two glyphs distinguishable at a glance even
 * for anyone who cannot pick the colours apart.
 */
function DirectionArrow({
  direction,
  className,
}: {
  direction: Direction;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      {direction === "entry" ? (
        <>
          <path
            d="M3 12h12m0 0-4-4m4 4-4 4"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M20 3.5v17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path
            d="M9 12h12m0 0-4-4m4 4-4 4"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4 3.5v17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
