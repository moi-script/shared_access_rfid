import Image from "next/image";
import NcstMark from "@/components/NcstMark";
import cardPortraitMale from "@/public/ncst_id_cards.png";
import cardPortraitFemale from "@/public/ncst_id_cards_female.png";

/**
 * The student ID cards the idle terminal holds just off the reader plate.
 *
 * A depiction of the physical NCST card, built from the design in
 * `components/template_id/ncst_card_temp.html` — white header carrying the
 * seal, navy banner naming the school, yellow body with the details beside a
 * black-framed portrait, and the name box across the foot. The template's
 * literal colours (#112952, #f7ca18, #f5f5f5, #a0a0a0) and its Helvetica stack
 * are kept rather than mapped onto the app's tokens and fonts: this draws a
 * real object that exists in the world, and matching the card in the guard's
 * hand matters more here than matching the palette of the screen around it.
 *
 * The inner card is laid out at the template's OWN 420x650 pixel dimensions and
 * scaled down with a transform, rather than having every size hand-converted
 * into a percentage of a small box. That keeps each number in this file
 * identical to the number in the template — the header really is 190px, the
 * name really is 30px — so the two can be diffed by eye, and a nudge to one
 * spacing cannot quietly throw off the proportions of everything else.
 *
 * DECORATIVE, and `aria-hidden` at the call site.
 *
 * The cards carry the templates' sample identities — Encee and Estee Bayani,
 * NCST Heroes — and the school's cartoon mascots as the portraits. That is a
 * deliberate reversal of the blank placeholder bars this card used to draw,
 * which existed so a guard could never misread the idle screen as a real tap.
 * Two things make the samples safe where a plausible "Alex Taylor Smith /
 * 2024-98765" would not have been: the mascot art is obviously an illustration
 * rather than a photograph of a person, and these cards render ONLY in
 * GateIdleScene, which a tap result replaces outright — they are never on
 * screen together with a real one.
 *
 * Portrait, and sized off its HEIGHT so the pair always clears the reader field
 * it floats in (h-72, sm:h-96). The width and the two scale factors all follow
 * from 420x650: 224px tall -> 144.7 wide -> 0.3446, 280 -> 180.9 -> 0.4307.
 */

/** The two sample students, matching the two templates in `template_id/`. */
const VARIANTS = {
  male: {
    portrait: cardPortraitMale,
    studentNumber: "1998-00001",
    name: "Encee Bayani",
  },
  female: {
    portrait: cardPortraitFemale,
    studentNumber: "1998-00002",
    name: "Estee Bayani",
  },
} as const;

export type GateIdCardVariant = keyof typeof VARIANTS;

export default function GateIdCard({
  variant = "male",
  scanDelay = 0,
}: {
  variant?: GateIdCardVariant;
  /** Seconds to offset the scan sweep, so a stack does not pulse in unison. */
  scanDelay?: number;
}) {
  const student = VARIANTS[variant];

  return (
    <div className="relative h-[14rem] w-[9.05rem] overflow-hidden rounded-xl border border-black/10 bg-white shadow-2xl shadow-black/50 sm:h-[17.5rem] sm:w-[11.3rem]">
      <div className="h-[650px] w-[420px] origin-top-left scale-[0.3446] font-[Helvetica_Neue,Helvetica,Arial,sans-serif] sm:scale-[0.4307]">
        <div className="flex h-full flex-col bg-white">
          {/* Header — the seal alone. The school's name lives in the banner
              below it on this design, so nothing is set under the mark. */}
          <div className="flex h-[190px] shrink-0 items-center justify-center pt-[15px]">
            <NcstMark className="h-auto w-[130px]" />
          </div>

          {/* Navy banner naming the school. */}
          <div className="shrink-0 bg-[#112952] px-[10px] py-[12px] text-center text-[21px] font-700 leading-tight tracking-[-0.5px] text-white">
            National College of Science &amp; Technology
          </div>

          {/* Yellow body. Nothing here grows: the template stacks the info row
              and the name box from the top and leaves the remaining yellow
              below them, rather than pushing the name box to the foot. */}
          <div className="flex flex-1 flex-col bg-[#f7ca18] px-[15px] pb-[15px] pt-[25px]">
            <div className="mb-[25px] flex items-start justify-between px-[5px]">
              <div className="mt-[35px] flex flex-col justify-end text-[#1a1a1a]">
                <div className="mb-[25px]">
                  <p className="mb-[3px] text-[16px] font-700 leading-tight">
                    Student Number
                  </p>
                  <p className="text-[26px] font-800 leading-tight">
                    {student.studentNumber}
                  </p>
                </div>
                <div>
                  <p className="mb-[3px] text-[16px] font-700 leading-tight">Course</p>
                  <p className="text-[21px] font-500 leading-tight">NCST Heroes</p>
                </div>
              </div>

              <div className="h-[200px] w-[195px] shrink-0 overflow-hidden border-[3px] border-black bg-[#f5f5f5]">
                <Image
                  src={student.portrait}
                  alt=""
                  sizes="195px"
                  className="h-full w-full object-cover"
                />
              </div>
            </div>

            <div className="border border-[#a0a0a0] bg-[#f5f5f5] px-[10px] py-[12px] text-center text-[#1a1a1a]">
              <p className="mb-[4px] text-[30px] font-800 leading-tight">{student.name}</p>
              <p className="text-[20px] font-400 leading-tight">NCST Nation Builders</p>
            </div>
          </div>
        </div>
      </div>

      {/* Scan bar sweeping the card — kept from the card this replaced. It is
          the terminal's proof of life: a frozen screen stops sweeping. The two
          cards in the stack are given different delays so the sweep reads as a
          reader passing over them rather than one card drawn twice. */}
      <div
        style={scanDelay ? { animationDelay: `${scanDelay}s` } : undefined}
        className="gate-scanline pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-white/45 to-transparent"
      />
    </div>
  );
}
