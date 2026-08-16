# Gadget Registry — Design

**Date:** 2026-08-05
**Status:** Approved, ready for planning
**Supersedes:** `2026-07-27-gadget-registry-design.md`

That document is kept, not deleted: it holds the reasoning for Subsystems C (digital
signature) and D (renewal applications), and its owner-deactivation argument is still the
clearest statement of why an access decision must not confiscate someone's property. Its
data model, gate behaviour, permission matrix, and expiry design are all obsolete — see
[What changed since 07-27](#what-changed-since-07-27).

## Problem

Students bring laptops onto campus. Nothing records whose device is whose, so a guard at
the exit cannot tell a student carrying their own laptop from one carrying somebody else's.

This subsystem lets the OSS office register a laptop to a person and turns the existing
person-card tap into an ownership prompt: the terminal shows the cardholder's registered
laptop so the guard can compare the serial against the device in their hands.

## What this is not

The laptop line answers **"is this device yours"**. It never answers **"may you leave"**.
Those are different questions, and the second one is already answered — correctly and
independently — by the person's own card. Nothing in this subsystem can deny a tap.

## Decisions

| Question | Decision |
|---|---|
| Identification | The **owner's person card**. The laptop carries no RFID of its own. |
| Gate effect | **Display only.** `access_result` is never influenced. No new reason codes. |
| Cardinality | **One active laptop per person**, enforced at registration. |
| Expiry | **None.** A registration is active until someone deactivates it. |
| Gadget types | `laptop` only, behind a constant so a second type is a one-line change. |
| Who registers | **OSS and superadmin** — the `'gadget'` write domain that already exists. |
| Serial numbers | Globally unique, **normalised** (trim + uppercase) before the check. |
| Owner transfer | Not supported. Deactivate and re-register, so the audit trail shows it. |

### Why no RFID sticker

The 07-27 spec gave each device its own sticker and made the gadget a third entity in the
RFID namespace. That design carried real cost: a third resolution branch in
`scan.service.tap`, a shared `assertRfidAvailable` helper wired into every registration
path, and a per-device consumable to buy, apply, and replace.

Identifying the laptop through its owner's existing card gets the same guard-facing
outcome — a name, a face, a brand/model and a serial on one screen — for none of that. The
tradeoff is that a laptop cannot be verified without its owner present, which is precisely
the situation the check is for.

### Why no expiry

`valid_until` existed on the 07-27 model to give Subsystem D something to renew. Since a
registration here confers no access, an expired one would deny nothing and grant nothing —
it would only stop displaying, which is indistinguishable from being deactivated. One
status field does the whole job.

## Data model

### `serverside/src/constants/gadgetTypes.ts`

Mirrors `constants/vehicleTypes.ts`, which is the established pattern: one list on the
server, one mirror in the browser, no third copy anywhere.

```ts
export const GADGET_TYPES = ['laptop'] as const;
export type GadgetType = (typeof GADGET_TYPES)[number];

/** Per-person allowance over ACTIVE gadgets only. */
export const GADGET_LIMITS: Record<GadgetType, number> = { laptop: 1 };
```

A single-element list is deliberate rather than a placeholder. The Mongoose enum, the Zod
enum, the limit check, and the form's `<select>` all read from it, so adding `tablet` means
editing this file and `userpage/lib/gadgetTypes.ts` — not eight call sites. The comment at
the top of `vehicleTypes.ts` explains what happened the last time a list like this was
repeated; the same note belongs here.

### `serverside/src/modules/gadgets/gadgets.model.ts`

```ts
export interface IGadget extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;   // ref Person — deliberately NOT unique
  gadget_type: GadgetType;
  brand_model: string;               // "Dell Latitude 5420"
  serial_number: string;             // unique — the anti-theft anchor
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes: `serial_number` unique, `owner_person_id` non-unique, `status` for filtering.

`owner_person_id` is non-unique for the same reason `Vehicle.owner_person_id` is: a
replaced laptop is deactivated rather than deleted, so its history survives, and the old
row must not consume the owner's slot forever. `serial_number` is what actually prevents
duplicates.

There is no `rfid_uid` and no `valid_until`.

### Serial normalisation

`serial_number` is trimmed and uppercased in the service before both the uniqueness check
and the write.

This is load-bearing, not cosmetic. Without it `5cd1234abc`, `5CD1234ABC`, and
`5CD1234ABC ` are three rows for one physical device — so a stolen laptop is re-registered
to a second owner by typing its serial in a different case, and the system then agrees with
both claimants. The unique index is the anti-theft anchor; an un-normalised index anchors
nothing.

Normalisation happens at exactly one point in the service, not in the Zod schema and not
in a Mongoose setter, so that the value compared against the index and the value written
are the same expression.

### Error code

`constants/errors.ts` gains one entry, alongside `DUPLICATE_PLATE`:

```ts
DUPLICATE_SERIAL: { status: 409, message: 'Serial number already registered' },
```

## API

`/api/gadgets`, mounted in `app.ts` next to `/api/vehicles`, following the
`routes → controller → service → repository → model` layering every other module uses.

| Route | superadmin | oss | registrar / hr | staff / student |
|---|:--:|:--:|:--:|:--:|
| `GET /gadgets` | yes | yes | yes | no |
| `GET /gadgets/:id` | yes | yes | yes | no |
| `GET /gadgets/:id/photo` | yes | yes | yes | yes¹ |
| `POST /gadgets` | yes | yes | no | no |
| `PATCH /gadgets/:id` | yes | yes | no | no |
| `PATCH /gadgets/:id/status` | yes | yes | no | no |
| `POST /gadgets/:id/photo` | yes | yes | no | no |
| `DELETE /gadgets/:id/photo` | yes | yes | no | no |

¹ `authenticateAny` accepts a gate device key **or** any user JWT, so the photo route is
readable by every authenticated session including staff and student — it is not
role-gated. This matches `vehicles.routes.ts:19` and `persons.routes.ts:24` exactly and is
recorded here as an accepted property of that middleware, not a new one this subsystem
introduces. Tightening it is a change to all three routes at once or none.

Writes are enforced in the service by `assertCanWrite(actor, 'gadget')`. That function and
the `'gadget'` domain already exist in `constants/roles.ts` and `utils/authority.ts`, and
`WRITE_DOMAINS` already lists `'gadget'` for `superadmin` and `oss` — RBAC v2 put it there
in anticipation of this work. No change to either file is needed, which is also why the
matrix above assigns writes to OSS rather than to the registrar the 07-27 spec named.

Reads are shared with registrar and HR, matching `vehicles.routes.ts`: OSS cannot attach an
owner to a laptop without reading a person that the registrar created, and the same
courtesy runs the other way.

### Route ordering

`GET /:id/photo` is declared **before** the router-level `authenticate` / `authorize`, using
`authenticateAny`, exactly as `vehicles.routes.ts:19` and `persons.routes.ts:24` do. A gate
terminal has no user session — it authenticates with `X-Gate-Key`, which `authenticate`
rejects. Below the `.use()`, every terminal fetch 401s, `AuthedImage` falls back to its
placeholder, and the failure presents as "the photo didn't upload" rather than "the route is
unreachable". Copy the comment along with the line.

### Service behaviour

`create` — `assertCanWrite(actor, 'gadget')`, then, in order:

1. Owner exists, via `personRepo.findById`, which is deleted-filtered. A deleted or
   dangling `owner_person_id` is refused here rather than producing a laptop whose owner
   cannot be shown at the gate. Mirrors `vehicles.service.create`.
2. Serial not already taken, after normalisation → `DUPLICATE_SERIAL`.
3. `assertWithinGadgetLimit` — the owner's active laptops, counted from
   `gadgetRepo.findActiveByOwner`, against `GADGET_LIMITS`. Modelled on
   `assertWithinLimit` in `vehicles.service.ts`, including its `excludeId` parameter so a
   no-op `PATCH` that re-sends an already-active gadget's own fields does not reject
   itself.

`update` — `owner_person_id` is rejected outright rather than silently ignored; a silent
ignore is how a user believes a transfer happened. Serial changes re-run normalisation and
the uniqueness check, excluding this row.

The only field that can re-arm anything is `status → 'active'`, so the limit check runs on
exactly one condition. This is worth contrasting with `vehicles.service.update`, whose
four-field re-arming guard (`status`, `owner_person_id`, `valid_until`, `vehicle_type`) and
its 40 lines of comment exist because vehicles have a mutable owner, an expiry, and
per-type limits. Dropping all three from this design is what collapses that logic — not
cleverness, and not something to reintroduce piecemeal later without also reintroducing the
guard.

`setStatus` delegates to `update`, as vehicles does.

### Photos

`gadgetPhotos.model.ts` / `.repository.ts` / `.service.ts`, copied from the `vehiclePhotos.*`
triplet, storing bytes in Mongo and serving them through the ETag-and-`Cache-Control` path
in `vehicles.controller.getPhoto`. The `uploadPhoto` middleware is reused unchanged.

The photo is for the console and the record, not the gate — see
[Terminal rendering](#terminal-rendering).

## Gate behaviour

One insertion, in the block at `scan.service.ts:301` that already attaches `registered[]`:

```ts
if (access_result === 'granted' && entity_type === 'person' && entity_id && personView) {
  const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
  personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));
  const gadgets = await gadgetRepo.findActiveByOwner(entity_id);
  personView.gadgets = gadgets.map((g) => ({
    gadget_type: g.gadget_type,
    brand_model: g.brand_model,
    serial_number: g.serial_number,
  }));
}
```

`TapResult['person']` gains:

```ts
gadgets?: { gadget_type: string; brand_model: string; serial_number: string }[];
```

`gadgetRepo.findActiveByOwner` takes no `asOf` — there is no expiry to evaluate — and
projects only the three displayed fields.

That placement is the design, and it buys four properties without a guard of its own:

- **It can never deny.** It runs after `access_result` and `reason` are final, and nothing
  above it reads `gadgets`. There is no path from a laptop registration to a refused tap.
- **It is withheld on every denial**, by the same `granted` condition that already withholds
  `registered` — and for the reason recorded in the comment there: a denied tap is the case
  most likely to involve someone holding a card that is not theirs, and handing that person
  a list of the cardholder's laptop serials inverts the entire purpose of the feature. This
  is enforced by the server, not by the UI declining to render — a field the server sends is
  a field that exists in the response, whoever is looking.
- **Vehicle gates are unaffected.** The single-card owner path sets `entity_type = 'vehicle'`
  before this block, so the condition does not hold there. The parking barrier does not
  prompt for a laptop.
- **Nothing else moves.** No new `reason` codes, so no `reasonText()` entries. The
  `wrong_gate_type` guard, the anti-passback block, `ScanLog`, and `AttendanceSummary` are
  all untouched. The comment at `scan.service.ts:204` reserving gadgets from the gate-type
  check can be updated to note that gadgets never become an `entity_type` at all.

### Terminal rendering

`GateTerminal.tsx` gains one block after the `registered` block at line 353, in the same
`text-2xl` treatment:

```
Laptop · Dell Latitude 5420 · SN 5CD1234ABC
```

Deliberately text, and deliberately **not** a third image frame beside the owner's face and
the vehicle photo. The serial is the only field the guard can physically compare against the
device; a photograph of a black laptop distinguishes it from no other black laptop, and a
third frame competes for the screen space the owner's face needs.

## Console (`userpage`)

```
lib/gadgetTypes.ts                   browser mirror of constants/gadgetTypes.ts
lib/permissions.ts                   canRegisterGadgets + "registerGadgets" ability
components/gadgets/GadgetForm.tsx    registration form
components/admin/RegisterView.tsx    fourth panel button
components/admin/types.ts            total_gadgets stat
components/gate/GateTerminal.tsx     the laptop line
```

`lib/permissions.ts` mirrors the server matrix:

```ts
/** Roles that may register a gadget. Mirrors WRITE_DOMAINS on the server. */
export function canRegisterGadgets(role: Role): boolean {
  return role === "superadmin" || role === "oss";
}
```

with `"registerGadgets"` added to `Action` and to the `superadmin` and `oss` entries of
`ABILITIES`. As established in Subsystem A, this is a usability layer; the API is the
enforcement boundary.

**No new nav tab.** Registration lives in the existing **Register** tab, which OSS already
has. `RegisterView.tsx` adds `"gadget"` to its `Panel` union and a fourth button
(`TfiDesktop` — react-icons/tfi has no laptop glyph, verified against the installed
package) beside *Single person*, *Bulk import*, and *Vehicle*, gated on
`canRegisterGadgets` and failing closed the way the existing buttons do — the default role
of `"staff"` when no stored user is found returns `false`, so the button hides rather than
offering a form the server will reject. The panel reuses the established `formKey`
remount-to-clear and the `lastCreated` notice.

`GadgetForm.tsx` is a new component rather than a fifth section of
`VehicleApplicationForm.tsx`, which is already 896 lines. Fields: owner picker, gadget type,
brand/model, serial number, optional photo via the existing `PhotoCapture`. The owner-search
interaction — debounce, generation ref discarding stale responses, controls disabled while a
mutation is in flight — is lifted from `VehicleApplicationForm` rather than reinvented.

The gadget type control is a `<select>` bound to `GADGET_TYPES`, not a hidden field or a
hardcoded string. It renders one locked option today; when a second type is added it needs
no change.

`components/admin/types.ts` gains `total_gadgets` on `AdminDashboard` and a tile in `STATS`,
served by a matching count in `dashboard.service`.

## Verification

New `serverside/src/config/verifyGadgets.ts`, registered as `npm run verify:gadgets`,
structured exactly like `verifyVehicles.ts`: same `expectEqual` / `summary` scaffold, same
`installVerifyBypass()`, same `TINY_PNG` so the photo path exercises what a browser would.
No test framework is added; the Subsystem A spec forbids one and that still holds.

Assertions:

1. Every cell of the permission matrix returns `2xx` or `403` as specified. A `401` is a
   failure, not a denial. OSS writes succeed; registrar and HR get `403` on write and `200`
   on read.
2. A second active laptop for the same owner is `409 CONFLICT`. Deactivating the first frees
   the slot and the second then succeeds.
3. A duplicate `serial_number` is `409 DUPLICATE_SERIAL` — **including** a lowercase variant
   and a whitespace-padded variant of an existing serial. Without those two cases the
   assertion passes trivially and pins nothing.
4. `PATCH /gadgets/:id` carrying a different `owner_person_id` does not move the gadget; the
   stored owner is re-read and compared.
5. A granted person tap returns the owner's laptop in `person.gadgets`, with the serial
   present.
6. A denied person tap (inactive card) returns no `gadgets` field at all.
7. An owner-card tap at a **vehicle** gate returns no `gadgets` field.
8. A person tap with a laptop registered writes no additional `ScanLog` row and no additional
   `AttendanceSummary` row — counts taken before and after are equal.
9. Deactivating the gadget removes it from the next granted tap while leaving the row visible
   in `GET /gadgets`.

Every assertion must be able to fail. Assertions over collections need a length floor —
`.every()` on an empty array is `true`, a pattern that produced two defects during Subsystem
A. Any assertion comparing two values must confirm both are present rather than comparing
`undefined` to `undefined`, which produced a third.

The block must restore whatever it changes, and the run must produce byte-identical output on
two consecutive runs.

`verifyRoles.ts` gains one check asserting `canRegisterGadgets`' server counterpart —
`WRITE_DOMAINS[ROLES.OSS]` containing `'gadget'` — alongside the existing line at
`verifyRoles.ts:328`.

## Seed

`testSeed.ts` gains one laptop, idempotent by `serial_number` the way vehicles are
idempotent by `plate_number`:

| Owner | Type | Brand / model | Serial |
|---|---|---|---|
| Juan Dela Cruz (`2025-0001`) | laptop | Dell Latitude 5420 | `5CD1234ABC` |

One row, not two: the limit is one active laptop per person, so a second seeded row would
have to belong to a second owner and would only re-assert what assertion 2 already covers.

## What changed since 07-27

Recorded so the two documents are not read as alternatives.

| 07-27 | Now | Why |
|---|---|---|
| RFID sticker per device | Owner's person card | Removes a third UID namespace, a resolution branch, and a consumable. |
| Gadget taps granted / denied at the gate | Display only | The check answers ownership, not access. Cannot lock anyone out. |
| `valid_until` + `SCHOOL_YEAR_END_MMDD` | No expiry | A registration that confers no access cannot meaningfully expire. |
| Laptop, Tablet, Phone, Other | `laptop` only, behind a constant | Scoped to what OSS registers today. |
| Registrar registers | OSS registers | RBAC v2 moved the `'gadget'` domain to OSS. |
| `assertRfidAvailable` shared helper | Not needed | The person↔vehicle UID collision it targeted was fixed by the single-card-access work. |
| Soft delete via `deleted_at` | Status only | Nothing here needs to disappear from history; deactivation is the revocation. |
| Many gadgets per person | One active laptop | A long serial list on the gate screen weakens the check. |
| `GadgetsView.tsx` + nav tab | Panel in the existing Register tab | OSS already has that tab; a tab per record type does not scale. |
| Dashboard `my_gadgets` for staff/student | Deferred | See below. |

## Out of scope

- **Student-facing view.** `ProfileView` and `GET /dashboard` gaining a read-only "my
  registered laptop" panel is a natural follow-up, but it serves a different audience than
  the OSS console this subsystem is for.
- **Application / approval / signature flow** of the kind `vehicleApplications` has. OSS
  registers directly, the way `POST /vehicles` works.
- **Transferring a laptop between owners.**
- **Any change to `POST /scan/tap`'s authorization**, which remains a documented deferred gap
  pending the gate hardware's auth mechanism.
- Adding a test framework or MongoDB transactions.

## Relationship to later subsystems

Subsystem D (renewal applications) was to renew this entity's `valid_until`. With no expiry
here, gadgets drop out of D entirely and it narrows to vehicles. Subsystem C (digital
signature) was always independent.
