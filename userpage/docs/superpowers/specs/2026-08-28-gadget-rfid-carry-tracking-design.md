# Gadget RFID and carry tracking

**Date:** 2026-08-28
**Status:** design, approved for planning
**Supersedes parts of:** `2026-08-05-gadget-registry-design.md`

## Problem

A gadget registration currently says "this person owns this laptop", permanently.
Nothing records that they *carried it in today*, and nothing checks that the same
device left with them. The registry's whole anti-theft claim rests on a guard
reading a serial number off a screen and comparing it, by eye, to a laptop in
someone's hands.

We want the campus to know, per day and per person: which devices came in, through
which gate, and whether each one went back out.

## What this reverses

Two decisions are documented in the code as permanent. This design overturns both,
deliberately, and every comment asserting them must be rewritten rather than left
standing as a lie.

**1. Gadgets have no RFID.** `gadgets.model.ts:44`:

> Deliberately absent: `rfid_uid` and `valid_until`. A gadget is identified at the
> gate through its OWNER'S person card, so it never enters the RFID namespace that
> persons and vehicles share.

**2. Gadgets are never a scan entity.** `scan.service.ts:227`:

> Gadgets are not a third case here and never will be.

Each gadget now carries its own RFID sticker and taps at the gate in its own right.

**What is NOT reversed:** the rule that the gadget registry never refuses passage.
`scan.service.ts:390` states there is no path from a laptop registration to a
refused tap, and `:315` states egress is never blocked because a stuck exit gate is
a physical safety problem. Both survive intact. A missing device produces a loud
warning and a logged reason, never a closed gate.

## The flow

**Entry, at the Gadget Lane** (`/gate/person-entry-gadget`):

1. The person taps their own card. Occupancy admits them as today.
2. The terminal opens a device prompt and stays there.
3. Each gadget tag tapped is confirmed on screen and admitted as its own
   occupancy row. Two laptops and a tablet means three taps.
4. The guard presses **Done**, or a 30-second idle timeout closes the prompt.
   Someone carrying nothing presses Done immediately.

**Exit, at the existing person exit** (`/gate/person-exit`, unchanged route):

1. The person taps their card. The tap response now carries `gadgets_inside` —
   their registered gadgets whose occupancy rows are still `inside`.
2. If that list is empty, the screen behaves exactly as it does today. Nothing
   changes for anyone who never used the gadget lane.
3. If it is not empty, the terminal shows the expected devices as a checklist and
   waits. Each gadget tag tapped releases that occupancy row and ticks its line.
4. When every expected device is ticked, the screen closes itself green.
5. If the guard presses Done, or the timeout fires, with devices still unticked,
   the screen shows a loud warning naming the missing devices. **The person's exit
   was already granted at step 1** and is not revisited.

## Architecture: gadget as a third occupancy entity

Chosen over a separate `GadgetCarry` collection. Occupancy already solves the hard
parts — the unique index that serialises simultaneous taps and surfaces passback as
an E11000, and the `lastResetBoundary` staleness rule. A parallel collection would
reimplement both and become a second source of truth about what is physically on
campus. The enum widening is mechanical and TypeScript points at every site.

"Which devices did this person bring in and not take out" becomes: *their active
gadgets whose occupancy row is `inside` and fresh*. No new state machine.

### Data model changes

**`Gadget`** gains one field:

```ts
rfid_uid: { type: String, unique: true, sparse: true }
```

Sparse, exactly like `Person.rfid_uid`: a gadget registered before it has a sticker
must not collide with every other stickerless gadget on `null`.

`valid_until` stays absent. A gadget registration still confers no access and
`status` is still the whole of revocation.

**`Occupancy.entity_type`** and **`ScanLog.entity_type`** enums both grow to
`'person' | 'vehicle' | 'gadget'`. `EntityType` in `occupancy.repository.ts:6`
widens with them.

### Three-way UID uniqueness

A UID belongs to exactly one of a person, a vehicle, or a gadget. This is currently
enforced pairwise between persons and vehicles, at six sites. Each gains a third
check, and each is a place where an omission makes a UID permanently unscannable —
the `CAV 8832` defect.

| Site | Today | Must add |
|---|---|---|
| `persons.service.create` | vehicle clash | gadget clash |
| `persons.service.reassignRfid` | vehicle clash | gadget clash |
| `vehicles.service.create` | person clash | gadget clash |
| `vehicles.service.update` | person clash | gadget clash |
| `vehicleApplications.service.create` | person clash | gadget clash |
| `gadgets.service.create` / `update` | none | person **and** vehicle clash |

The pattern to follow is `vehicles.service.ts:106`, which throws
`DUPLICATE_RFID` with a message naming the owning entity type, so a clerk is told
which registry already holds the tag.

To keep this from drifting again, the three lookups move into one helper in a
shared module, and every site calls it:

```ts
assertUidFree(uid: string, self?: { kind: 'person' | 'vehicle' | 'gadget'; id: string })
```

`self` is the record being edited, excluded from its own clash check so a PATCH
that re-sends a row's current UID does not reject itself — the same exclusion
`assertWithinLimit` takes `excludeId` for. Omitted on create. Six hand-written
pairs became a five-site omission risk the moment a third entity existed; one
helper cannot go partially stale.

**Blocklist.** `blockedCardRepo.isBlocked` is checked at every issue point and at
`scan.service.ts:94`. Gadget tags join that namespace unchanged — a retired gadget
sticker is blocked exactly as a retired person card is, and the check at tap time
already runs before any entity resolution, so it covers gadgets with no edit.

### Scan resolution

`scan.service.tap` gains a third resolution branch after the vehicle branch: if the
UID matches no person and no vehicle, try `gadgetRepo.findByRfid`. Order matters and
gadget goes last — persons and vehicles are the access-bearing entities and must
never be shadowed by a gadget lookup.

A gadget tap resolves to `entity_type: 'gadget'` and:

- **Never grants or denies passage on its own.** It is not a person and not a
  vehicle; the barrier is already open or shut based on the person's tap.
- **Writes no attendance.** `scan.service.ts:428` computes
  `attendancePersonId = entity_type === 'person' ? entity_id : companionPersonId`.
  A gadget tap is neither, so it already writes nothing. No change needed — this is
  safe by construction and the spec records it so nobody "fixes" it later.
- **Is excluded from `wrong_gate_type`.** `scan.service.ts:231` denies when
  `entity_type !== gate.type`. A gate's type is only ever `person` or `vehicle`, so
  a gadget would be denied by that guard as written. The condition becomes
  `entity_type !== 'gadget' && entity_type !== gate.type`. The comment above it,
  which currently promises gadgets will never be a third case, is rewritten to state
  the new rule and why gadgets sit outside it: a gadget has no gate of its own, it
  accompanies whoever is carrying it.

**Denial of a gadget tap** still happens for real reasons — blocked tag, unknown
tag, inactive gadget — and shows on the terminal without touching the barrier.

### Occupancy roster and counts

This is the one place where widening the enum breaks a documented invariant, and it
must be fixed in the same change rather than discovered later.

`countInside` (`occupancy.repository.ts:117`) counts by `entity_type` with an
explicit `if/else if`, so gadget rows are silently dropped from its totals.
`listInside` (`:133`) matches on `state` and `since` alone, so gadget rows **would**
appear in the roster. The comment at `:110` warns precisely about this: the
dashboard count and the roster are two views of one answer, and an admin who sees
"14 inside" and counts 13 rows cannot tell which one lied.

Resolution — both change together:

- `countInside` returns `{ persons, vehicles, gadgets }`.
- `listInside` adds a `$lookup` against `gadgets` and extends its `$ifNull` name
  chain so a gadget row shows its `brand_model`, with `serial_number` in the
  `id_number` slot.
- `OccupancyListRow` gains nothing structurally; the existing fields carry it.

This is not scope creep. It is what makes the Presence screen answer *who is inside
right now, and with what* — the question that started this work — as a consequence
of the model rather than as another feature.

### Gate terminal

`GATE_ROUTES` is unchanged: no new route. `person-entry-gadget` already exists and
`person-exit` keeps its id.

**New shared state** in `GateTerminal.tsx`: a device-prompt mode holding the
expected list (exit) or the accumulated list (entry), the tags read so far, and a
30-second idle timer. Taps arriving while the prompt is open post to the same
`/scan` endpoint — a gadget tap is an ordinary tap and needs no session on the
server. The prompt is presentation, not protocol; if the terminal reloads
mid-prompt, the occupancy rows already written stand on their own.

**Entry screen** (`gadgetFocus: true`) shows each confirmed device with its photo,
type, brand and serial. This absorbs the separately-approved gadget-photo work:
`gadgets.repository.findActiveByOwner` adds `photo_url` to its shared projection,
`scan.service` passes it through, and a `GadgetImage` component mirrors
`VehicleImage` at `GateTerminal.tsx:59`, falling back to the same neutral glyph.

**Exit screen** shows the checklist, ticking devices as they are read, and the
warning panel on an incomplete close. Gold, not red — consistent with the
no-device panel already built, and with the rule that this never refuses passage.

### Registering a tag to a gadget

`GadgetForm.tsx` gains an `rfid_uid` field with the same
`^[0-9A-Fa-f]{6,32}$` validation persons and vehicles use. A dedicated reassign
flow mirrors `persons.reassignRfid`, including blocking the retired tag on a
successful swap — the same fail-open-with-a-loud-log behaviour, for the same
reason: a retired UID that is neither assigned nor blocked is re-registrable and
would be granted again.

### Closing an incomplete exit prompt

The person's exit is logged the moment they tap, at step 1 — before anyone knows
whether the devices will be presented. So `gadget_not_returned` **cannot** be
attached to that row: it does not exist yet when the row is written, and scan logs
are append-only. Mutating the row afterwards would also destroy the timestamp
ordering the anomaly report reads.

Instead the terminal posts a close event when the prompt ends with devices
unticked, and the server writes a **second, separate** `ScanLog` row:

```
POST /scan/gadget-session   { gate_key, person_id, missing_gadget_ids[] }
→ ScanLog { entity_type: 'person', entity_id: person_id, direction: 'exit',
            access_result: 'granted', reason: 'gadget_not_returned' }
```

Two rows for one exit is correct here, not a duplicate: the first records that the
person left, the second records what they left without. This mirrors
`occupancyService.clear`, which writes its own append-only row precisely because
the state it describes is overwritten by the next tap.

The endpoint authenticates with `X-Gate-Key` like every other terminal call, and it
touches no occupancy state — the devices genuinely are still inside, and their rows
must stay `inside` so tomorrow's roster shows them.

### New reason codes

- `gadget_not_returned` — written by the close event above. Names the count, not
  the serials, so the log is not a shopping list for whoever reads it.
- `gadget_unknown_tag` — a tag that resolves to no gadget, tapped at the prompt.
- `gadget_not_owned` — a tag resolving to a gadget registered to someone else.

All three are granted-with-a-reason, matching the shape `exit_without_entry` and
`occupancy_unavailable` already use, and all three surface in `reports.anomalies`.

## Testing

A new `verify:gadget-carry` script, following the existing `verify:*` pattern
against a seeded database:

- A gadget tag entering and leaving produces `admitted` then `released`.
- A person who entered via the gadget lane with two devices reports exactly those
  two in `gadgets_inside` at exit.
- Tapping one of the two releases it; the other remains expected.
- Exit is **granted** when devices are left unticked, with `gadget_not_returned`.
- A gadget tag registered to another person yields `gadget_not_owned` and does not
  release anything.
- A UID already held by a person is refused at gadget registration, and vice versa,
  at all six write sites.
- A blocked gadget tag is refused at the prompt.
- `countInside().gadgets` and the count of gadget rows in `listInside` agree.

Existing suites that must still pass unchanged: `verify:gadgets`, `verify:roles`,
`verify:passback`, `verify:vehicles`, `verify:person-status`.

## Migration

Existing gadgets have no `rfid_uid` and stay that way. A gadget with no tag simply
never taps: it cannot be carried through the lane until a sticker is assigned, and
the exit prompt never expects it. No backfill, no data rewrite.

The seeded `Gadget Lane` gate added on 2026-08-28 is reused as-is.

## Out of scope

- Refusing exit on a missing device. Explicitly rejected; egress is never blocked.
- Gadget photos on the exit screen. The checklist is text; the serial is what gets
  compared.
- Any change to vehicle or person tap behaviour.
