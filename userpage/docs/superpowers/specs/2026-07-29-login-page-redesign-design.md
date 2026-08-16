# Login Page Redesign — Flat Vector / School Aesthetic

**Date:** 2026-07-29
**Status:** Implemented, with amendments — see "Amendment: supplied artwork" at the end.
The Visual System and Content sections below describe the *first* implementation
(hand-drawn flat-vector scene, beige panel). The amendment supersedes them.

## Problem

The login page's left panel is a dark navy field with blurred drifting halos, pulsing
RFID scan rings, a dotted grid overlay, and a bottom row of colored dots labeled
"Person gates · Vehicle gates · Live logs". The dot row in particular reads as generated
filler — a decorative list that conveys nothing a user needs at sign-in. The panel as a
whole says "security dashboard," not "college."

The system is a campus RFID access system for the National College of Science and
Technology. The sign-in screen should look like a school portal.

## Goal

Replace the dark tech panel with a light, warm, flat-vector illustrated panel in the
style of storyset.com — the aesthetic commonly called Flat Vector Illustration or
Corporate Doodle. Remove the chip row entirely.

## Scope

`/login` is the only sign-in surface. `/login/admin` and `/login/user` are `redirect()`
stubs pointing at `/login` and are not touched.

Authentication logic is out of scope. No change to `lib/auth`, the `POST /auth/login`
call, token storage, or role-based redirects.

## Approach

A hybrid illustration strategy: hand-build the flat-vector scene as inline SVG now, and
isolate it behind a one-file swap point so a professionally-drawn Storyset SVG can
replace it later without touching layout.

The two-column split layout is preserved. Only the left panel's *mood* inverts, from
dark to light.

## Files

### `components/login/GateScene.tsx` — new

The illustration and nothing else. A single default export taking `className`, rendering
one inline `<svg>` with a portrait viewBox (4:5). Holds no state, no text, no layout
opinions.

**This file is the swap point.** Replacing the hand-drawn art with a downloaded Storyset
SVG means rewriting this one file's body — either inlining the new SVG markup or
pointing it at an asset in `public/illustrations/`. `BrandPanel` and every other file
stay untouched. This contract is the reason the component exists separately rather than
being inlined into `BrandPanel`.

### `components/BrandPanel.tsx` — rewritten

Keeps its filename and its single import site in `LoginExperience`, so no other file
needs editing.

Becomes, top to bottom: `NcstMark` wordmark, `<GateScene />`, headline, subhead.

Deleted: the scan rings, the RFID-card hero, the blurred `drift` halos, the `dot-grid`
overlay, the gold diagonal slash, and the Person/Vehicle/Live-logs chip row.

### `components/LoginExperience.tsx` — restyled

Logic untouched. Only Tailwind classes and the tap-hint block change. See "Form side"
below.

### `app/globals.css`

The `.scan-ring`, `.drift`, and `.dot-grid` rules **stay** even though the login page
stops using them — `components/gate/GateTerminal.tsx` still depends on all three.
Removing them would break the gate terminal.

Changes here are additive only: the indicator-light pulse keyframe, plus its
`prefers-reduced-motion` guard alongside the existing ones.

## Visual system

### Panel separation

Left panel sits on `--color-blue-soft` (`#fff2d1`, warm beige). The form side stays on
`--color-paper` (`#fffaf0`). That warm-on-warm step plus a single `--color-line`
hairline is the entire separation between the columns. No border beyond the hairline, no
shadow, no gradient.

### Illustration constraints

Flat-vector discipline is mostly a list of prohibitions. In `GateScene`:

- No gradients.
- No blur filters.
- No drop shadows or glows.
- No strokes used as object outlines. Shapes are solid fills.
- The one shadow permitted is a flat ellipse beneath the character at ~8% navy.

Fill palette is capped at six values, all drawn from existing tokens:

| Role | Token | Hex |
|---|---|---|
| Hair, darkest garment | `--color-navy` | `#1e386a` |
| Primary masses | `--color-blue` | `#0c75ba` |
| Background architecture | `--color-blue` at 18% opacity | `#0c75ba` @ .18 |
| Reader indicator light, card chip | `--color-gold` | `#ffc437` |
| Exactly one element | `--color-red` | `#ee7a22` |
| Highlights | `--color-paper` | `#fffaf0` |

Faces get minimal features.

Behind the scene: two or three navy doodle marks at ~6% opacity — a paper-plane arc, a
couple of dashes. No more than three. Doodle density is what tips this style into
looking generated.

### Scene subject

A student mid-stride holding an ID card up to a reader post, gate arm lifting, school
building behind. The gate post carries the gold and orange accents so the art reads as
part of the brand rather than sitting on top of it.

### Motion

The existing `.reveal` stagger stays; it already respects `prefers-reduced-motion`.

One addition: the reader's gold indicator light does a slow 3s soft pulse. It is the
only animated element on the page, it lives inside `GateScene`, and it is disabled under
`prefers-reduced-motion`.

## Content

**Left panel.** Wordmark top-left, unchanged. Scene fills the middle. Beneath it, the
existing headline "One card for every campus gate." with "every campus gate." in gold —
retained as-is. The subhead shortens to one line; its current three-line length exists
only to balance the chip row that is being removed. The bottom of the panel stays empty.
Confident emptiness is deliberate and is not to be filled in during implementation.

**Form side.** Heading, fields, remember-me, and the RFID tap-hint card all keep their
positions. Restyling only:

- Input radius `rounded-xl` → `rounded-2xl`.
- Submit button loses `shadow-lg shadow-navy/10`. Flat design carries no elevation.
- Tap-hint's dashed box keeps its dashed `--color-line` border but swaps its
  `bg-white/60` for `--color-blue-soft`.
- Eye / EyeOff / Spinner icons unchanged.

**Mobile.** Unchanged. The panel stays `hidden lg:flex`; phones see the compact brand
row above the form. The illustration is deliberately *not* shown on mobile — a portrait
scene squeezed above a login form is what makes these pages feel padded.

## Accessibility

The scene is decorative; the headline carries the meaning. The SVG gets
`aria-hidden="true"` and no `role="img"`, keeping it out of the screen-reader tree.

Text contrast is re-checked against the new beige panel. Navy on `#fff2d1` clears AA
comfortably, but every `text-white/55` and `text-white/65` from the dark design must
become `--color-ink-soft` or it will fail.

## Verification

1. `npm run build` passes.
2. Lint passes.
3. Playwright screenshots at 1440px, 1024px, and 390px, confirming the split at desktop,
   the `lg` collapse, and the mobile brand row.
4. `/login/admin` and `/login/user` still redirect to `/login`.
5. The gate terminal still renders its scan rings — confirms the shared CSS survived.

No test suite covers this component and none is proposed. It is presentational, and a
snapshot test over hand-drawn SVG would be a change-detector, not a test.

## Out of scope

- Authentication logic, token handling, role redirects.
- The gate terminal, dashboard, and admin surfaces.
- Sourcing the final Storyset artwork. The swap point exists; using it is a later,
  separate task.
- Adding attribution UI for Storyset. Required only if a free-tier asset is actually
  adopted, which is deferred with the artwork itself.

## Amendment: supplied artwork (2026-07-29)

The swap point was used almost immediately. Final state:

**Artwork.** An isometric RFID access scene in coral and white. This is *not* the
flat-vector school scene specified above: it is isometric with gradients, and the
setting is a city street with cars and parking meters rather than a campus. That
trade was accepted deliberately in favour of professionally-drawn artwork.

Two files, both kept:

- `public/cartoonStylePic.png` — the 2048×2048 master, on a solid black background.
  Nothing renders this directly; it is the source the served asset is derived from.
- `public/login-illustration.png` — 1933×1818, what the page actually loads.

To regenerate the served asset from the master: flood-fill the black background to
transparency **from the borders only** — a global colour key would punch holes in the
black car, the characters' hair, and the door, which are legitimately near-black — then
trim the transparent margin. At the current 34rem display cap that leaves ~3.5 source
pixels per rendered CSS pixel, so high-DPI screens get real detail.

The hand-drawn flat-vector scene it replaced is preserved in commit `50449a0`.

**Palette.** The page now matches the artwork instead of the artwork matching the
page. A coral ramp is added to `globals.css`, scoped by convention to the login
screen; the rest of the app is untouched and stays on navy/blue.

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--color-coral` | `#ff7a68` | decorative fills, borders — never text | 2.6:1 |
| `--color-coral-600` | `#d94f3a` | large display accent on coral-soft | 3.7:1 |
| `--color-coral-700` | `#c94530` | button fill under white text | 4.8:1 |
| `--color-coral-800` | `#b83e2a` | small text and links | 5.1:1 |
| `--color-coral-soft` | `#fff1ed` | panel background, tinted cards | — |

The steps exist because one coral cannot serve all three roles: the vivid coral that
matches the illustration fails AA as text, so it is restricted to decoration.

Panel background is `coral-soft`; the form side is white. The white buildings in the
artwork need a tinted backdrop to read at all — on a white panel they disappear, which
is why the panel is not white.

**Known deviations, accepted:**

- The `NcstMark` glyph stays navy and gold on a coral page. It is the institution's
  mark and is shared with the gate terminal, so it was not recoloured.
- The illustration is capped at 34rem rather than filling the panel. Resolution is no
  longer the constraint — this is a framing choice, and it can be enlarged freely.
- The gate-arm pulse animation from the original design is gone with the hand-drawn
  scene. The login page now has no animation beyond the `.reveal` stagger. The
  `.gate-pulse` rule remains in `globals.css` but is unused.
