# Monitor Output — Gate Terminal Detail — Design

**Date:** 2026-07-31
**Status:** Approved, ready for planning
**Scope:** The richer entry/exit terminal display deferred from `2026-07-30-rbac-v2-design.md`
and `2026-07-31-vehicle-registration-design.md`. Both of those are merged.

## Problem

When a card is tapped, the terminal shows the person's name, their `Person.type`, a photo, and a
reason. A guard standing at a barrier cannot see which section the person belongs to, or what that
person has registered.

The client asked for:

- **Person lane:** name, course/year/section, access status, and — if the person has something
  registered — its type and make.
- **Vehicle lane:** owner name, course/section, vehicle type, make, access status.

## Decisions

| Question | Decision |
|---|---|
| What "Gadget Type" means on a person tap | What that person has **registered**. Vehicles today; laptops slot into the same field when the gadget registry is built. |
| Course/year/section | Render the existing `Person.department_section` as stored, labelled by `Person.type`. **No migration, no structured split.** |
| Detail on denials | Name, photo and department follow today's rule (shown on a grant and on `inactive_id`, hidden on `wrong_gate_type`). The registered-items list appears **only on a grant**. |
| Lookup strategy | Query the person's vehicles on granted person taps. No denormalised summary on `Person`. |
| Which vehicles count | Active and unexpired only. |

## Why course/year/section is not split into fields

The client's phrasing ("Course Year Sectoin") suggests three values, but the stored data does not
support splitting:

```
student   | BSIT - 4A          | Juan Dela Cruz
student   | BSCS - 3B          | Maria Santos
student   | BSIT 4-A           | Demo Legacy Owner     <- different format
staff     | Registrar Office   | Ana Villanueva        <- not a course at all
student   | undefined          | (a probe row)
```

Three problems, each fatal to a naive migration:

1. **Student values are already formatted two ways** — `BSIT - 4A` and `BSIT 4-A`. Any parser
   picks one and mangles the other.
2. **Staff and employees have office names**, not courses. There is no course, year or section to
   split, so those fields would be permanently null for a whole population.
3. **At least one row is undefined**, so the migration needs a null story anyway.

Splitting would also touch `PersonForm`, the CSV import, the directory, and every seeded record —
a wide, risky change whose only benefit is cosmetic on one screen. The field is therefore rendered
as stored, and normalising the inconsistent values is left as separate data hygiene.

**The label is driven by the person's type:** "Course & Section" for `student`, "Department" for
`staff` and `employee`. `Registrar Office` beneath a heading reading "Course" would be actively
wrong. A missing value renders as an em dash, never the literal string `undefined`.

On a person tap that type is `person.type`; on a vehicle tap it is `person.owner_type`, because
`type` is the literal `'vehicle'` there. A consumer should read `owner_type ?? type` — falling back
keeps the rule in one expression rather than branching on the lane.

## Response shape

`TapResult.person` widens. Existing fields keep their names and meanings, so nothing that reads
them today breaks:

```ts
person?: {
  full_name: string;
  type: string;                    // person taps: student|staff|employee.
                                   // vehicle taps: the literal 'vehicle' — UNCHANGED, see below
  owner_type?: string;             // NEW — vehicle taps only: the OWNER's Person.type
  department_section: string | null;                   // NEW — as stored, may be null
  photo_url?: string;
  plate_number?: string;                               // vehicle taps, unchanged
  vehicle?: { vehicle_type: string; make?: string };   // NEW — vehicle taps
  registered?: { vehicle_type: string; make?: string }[];  // NEW — person taps, GRANTS ONLY
};
```

### Why `owner_type` exists rather than reusing `type`

On a vehicle tap the service sets `type: 'vehicle'` (`scan.service.ts`, vehicle branch) — a
discriminator, not the owner's `Person.type`. `GateTerminal` already renders that value as display
text when no `plate_number` is present, so changing its meaning would alter existing behaviour on
the person lane.

The owner's actual type is therefore carried in a **new** `owner_type` field, populated only on
vehicle taps. Without it, the label rule below is unimplementable on the vehicle lane, because the
owner's type is not in the response at all. This was missed in the first draft of this spec and
found during review of it.

`registered` is an **array**, and it is `[]` rather than absent when a granted person has nothing
registered. An absent field and an empty list mean different things to a consumer, and a UI that
distinguishes "nothing registered" from "we didn't look" is the one that can be trusted.

Laptops will appear in this same array once the gadget registry exists — its entries carry a type
and a brand exactly as vehicles do — so no consumer needs reshaping then.

## The denial rule

`scan.service.tap` already encodes a deliberate rule, and this design extends rather than replaces
it:

| Outcome | Name, photo, department | Registered items |
|---|:--:|:--:|
| `granted` | shown | **shown** |
| `denied` / `inactive_id` | shown | hidden |
| `denied` / `wrong_gate_type` | hidden (existing behaviour) | hidden |
| `denied` / `already_inside` | shown (existing behaviour) | hidden |
| `denied` / `unregistered_uid` | nothing to show | — |

Identity is shown on an `inactive_id` denial so a guard can distinguish a deactivated student from
an unregistered stranger — that reasoning is already recorded in `scan.service.ts` and stays.

### The vehicle lane, ruled explicitly

The table above enumerates person-lane reasons. The vehicle lane needs its own ruling, because this
design widens what a **denied vehicle tap** reveals: previously the owner's name and plate, now also
`owner_type`, `department_section`, and the vehicle's type and make.

Concretely: someone who finds a deactivated or expired parking tag and taps it now sees the owner's
course and section on the denial screen, which they did not see before.

**Ruling: this is accepted, and consistent with the person lane.** The same argument applies — a
guard resolving a denied vehicle tap needs to identify whose tag it is, and department is part of
that identification. `registered[]` remains withheld here as everywhere, so a denial still never
enumerates a person's *other* holdings. `wrong_gate_type` continues to clear identity entirely.

Recorded because it is a widening the first draft of this table did not cover, and it should be a
decision on record rather than a side effect.

**Registered items are withheld on every denial.** A guard resolving a denial needs to know *who*,
not what that person owns, and a denied tap is the case most likely to involve someone holding a
card that is not theirs. Withholding it costs the guard nothing and leaks nothing.

This must be enforced **in the service**, not by the UI declining to render it. A field the server
sends is a field that exists in the response, whoever is looking.

## Which vehicles count

`registered` includes only vehicles that are `status: 'active'` **and** not past `valid_until`.

Showing an expired pass would tell the guard the opposite of the truth — that the person has a
valid registration when the barrier would refuse it. Use the same comparison the gate itself
applies, in **local** time against the tap's own `scan_time`: this codebase has shipped two real
defects from UTC-derived dates, and `nextSchoolYearEnd()` stores expiry at local end-of-day.

## Lookup strategy

Query the person's vehicles on granted person taps, using the `owner_person_id` index that the
vehicle-registration work added when it dropped the unique constraint.

The rejected alternative is a denormalised summary cached on `Person`. It would be faster, but it
is a second copy that drifts: registering a vehicle would leave the cached summary stale until
something rewrote it. This project has refused that twice — the gadget-registry spec keeps identity
on `Person` and joins to it precisely so a section change cannot leave stale data on a device. One
indexed read on a small collection, only on grants, is the cheaper trade.

Denials skip the query entirely, which also means the most common abusive case (repeated taps of a
dead card) adds no load.

## Frontend

```
components/gate/GateTerminal.tsx    render department, registered items, vehicle detail
lib/gateTerminal.ts                 TapOutcome type widened to match the server
```

Layout, person lane:

```
GRANTED                    DENIED (inactive)        DENIED (wrong gate)
  Juan Dela Cruz             Juan Dela Cruz           — no identity —
  BSIT - 4A                  BSIT - 4A                Wrong gate for this card
  Motorcycle · Honda Adv     ID inactive              DENIED
  GRANTED                    DENIED
```

Vehicle lane — the vehicle is what tapped, so its details are the identity:

```
GRANTED
  Juan Dela Cruz        (owner)
  BSIT - 4A
  Motorcycle · Honda Adv · NCST-1234
  GRANTED
```

Constraints the terminal already lives under, which this must not break:

- It is read at a distance, quickly, by someone with a queue waiting. Added lines must not shrink
  the access verdict, which is the largest element on screen and the only one that matters at a
  glance.
- Green means granted, red denied, amber means the system did not decide. A network failure must
  never read as a grant.
- Reason codes are rendered through the shared `reasonText()` map. Adding a field must not
  reintroduce a raw snake_case code on an operator screen — that has been a must-fix twice.
- A missing photo already renders a placeholder; a missing department renders an em dash.

## Verification

Extends `serverside/src/config/verifyGates.ts`, which taps at real gates with gate keys.

1. A granted person tap returns `department_section` matching the seeded value.
2. A granted person tap for someone with an active vehicle returns `registered` containing that
   vehicle's `vehicle_type` and `make`.
3. A granted person tap for someone with **no** vehicle returns `registered: []` — an empty array,
   not `undefined`.
4. An `inactive_id` denial returns `full_name` and `department_section` but **no** `registered`
   field. This is the privacy rule; it must be pinned, not assumed.
5. A `wrong_gate_type` denial returns no identity at all — existing behaviour, re-pinned because
   this design adds fields that could regress it.
6. A vehicle tap returns the owner's `department_section` plus `vehicle.vehicle_type` and
   `vehicle.make`.
7. A vehicle whose `valid_until` has passed is **excluded** from its owner's `registered` list,
   while that owner's own person tap still grants.

Assertion discipline: every assertion must be able to fail; collection assertions need a length
floor, because `.every()` on an empty array is `true` and that has caused real defects here; and any
comparison must confirm both values are present rather than matching `undefined` to `undefined`.

Case 7 mutates a seeded vehicle's expiry. Wrap the backdate and restore in `try/finally` — a throw
between them leaves a seeded fixture permanently expired, which breaks every later run in a way that
looks like a product bug. That exact trap was found in review during the vehicle work.

## Out of scope

- **The gadget registry.** Laptops and tablets slot into `registered` unchanged when
  `2026-07-27-gadget-registry-design.md` is implemented. No part of this design blocks it or
  anticipates it beyond the array shape.
- **Normalising `department_section`.** The inconsistent `BSIT - 4A` / `BSIT 4-A` values and the
  undefined row are real, and are data hygiene rather than display work.
- **The Records and Presence screens.** They read scan history, not live taps.
- **Attendance semantics.** Nothing here changes what is recorded, only what is shown.
