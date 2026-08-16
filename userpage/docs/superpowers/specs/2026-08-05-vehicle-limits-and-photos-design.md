# Vehicle type limits, vehicle photos, and gate photo display

Date: 2026-08-05

## Problem

Three changes, all touching vehicle registration:

1. **Vehicle types don't match reality.** The enum is
   `motorcycle | car | tricycle | other`. The office actually registers
   multicabs, vans, pickups, AUVs, and trucks.
2. **One vehicle per person is too few.** `vehicles.service.ts` refuses to
   register a second active vehicle for any owner. The office needs a
   per-type allowance instead.
3. **Nobody can see the vehicle.** A guard at the parking barrier sees a name
   and a plate number, and has no way to check either against the car in
   front of them. Vehicles have a `photo_url` field that nothing ever writes,
   and the vehicle-tag scan path doesn't even send the *owner's* photo.

## Decisions

| Question | Decision |
| --- | --- |
| Type list | Replace the old four with six: `motorcycle`, `multicab`, `van`, `pickup`, `auv`, `truck` |
| Per-person limits | multicab 3, van 3, pickup 3, motorcycle 1, auv 1, truck 1 (12 total) |
| What counts toward a limit | Active **and** unexpired only |
| Gate resolution for multi-vehicle owners | Per-vehicle RFID sticker tags |
| Vehicle photo storage | MongoDB, mirroring `PersonPhoto` |
| Photo capture location | Both photos in the vehicle application form |
| Old rows | Migrated in place |

## Architecture

### Type and limit constants

New `serverside/src/constants/vehicleTypes.ts`:

```ts
export const VEHICLE_TYPES = [
  'motorcycle', 'multicab', 'van', 'pickup', 'auv', 'truck',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const VEHICLE_LIMITS: Record<VehicleType, number> = {
  motorcycle: 1, multicab: 3, van: 3, pickup: 3, auv: 1, truck: 1,
};
```

Every consumer reads from here: the Mongoose enum on `Vehicle` and
`VehicleApplication`, both zod schemas, and the limit check. The literal list
is currently repeated at eight sites, which is how the model and the schema
drift apart.

No `VEHICLE_TOTAL_LIMIT` constant. The total is the sum of the per-type
limits; a second number that must agree with the first is a defect waiting to
happen. Any check that needs a total derives it.

The frontend mirrors the list in `userpage/lib/vehicleTypes.ts` — it is a
separate deployable and cannot import from the server. The mirror carries a
comment naming the server file as authoritative.

### Per-person limits replace the one-vehicle rule

`vehicles.service.ts:64-72` throws `CONFLICT` when the owner has any active
vehicle. That block becomes a per-type count.

`vehicleRepo.findActiveByOwner` already returns exactly the right set (status
`active`, `valid_until >= asOf`) and already projects `vehicle_type`, so the
check needs no new query and no new index:

```ts
const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
const type = data.vehicle_type as VehicleType;
const used = active.filter((v) => v.vehicle_type === type).length;
if (used >= VEHICLE_LIMITS[type]) throw new ApiError('CONFLICT', ...);
```

Message names the owner, the type, the limit, and the remedy:
`"Maria Santos already has 3 active vans (the limit). Deactivate one first."`

The check runs at three call sites, because all three can arm the barrier:

- **`create`** — new registration.
- **`update`** — on the existing re-arming guard at `vehicles.service.ts:117`,
  which already fires for activation, owner reassignment, and `valid_until`
  extension. The vehicle being updated is excluded from the count, so a no-op
  PATCH on an already-active row does not reject itself. This mirrors how the
  current one-vehicle check already handles the same case.
- **`vehicleApplications.service.ts:125-131`** — pre-checked before the
  application row is written. Write order there is load-bearing (application,
  then vehicle), and applications are immutable, so a limit breach discovered
  at the vehicle insert would leave an orphan application that can never be
  edited or deleted. This is the same reasoning the existing
  `DUPLICATE_RFID`/`DUPLICATE_PLATE` pre-checks are there for.

### Gate resolution

Per-vehicle RFID stickers become the primary lane. `scan.service.ts` already
resolves a vehicle by its own UID at `:149`; that path needs no new logic,
only the photo fields below.

The owner-card path at `:107-118` is unchanged in behaviour but inverted in
meaning. `multiple_vehicles` was a safety net for rows predating the
one-vehicle rule; it is now the expected everyday answer when a
multi-vehicle owner taps their card at a vehicle gate. The code comment is
rewritten to say so, and `userpage/lib/reasonText.ts:17` becomes
**"Multiple vehicles — tap the vehicle's sticker."** A single-vehicle owner's
card still grants exactly as it does today, including the companion
occupancy and attendance writes.

Refusing to guess remains correct: granting on an owner card would write a
plate nobody verified into the scan log, the occupancy roster, and the
anomaly report.

### Photo fields on the tap response

`TapResult['person']` gains `vehicle_photo_url?: string`.

Two changes in `scan.service.ts`:

- **Vehicle-tag path (`:177-184`) omits the owner's `photo_url` entirely.**
  The owner-card path at `:126` sends it; this one does not. A sticker tap
  therefore shows no face today. Add `photo_url: owner?.photo_url`.
- Both grant paths add `vehicle_photo_url: <vehicle>.photo_url`.

The existing rule that identity is withheld on every denial is untouched:
`vehicle_photo_url` is set inside the same `personView` assignments that
`wrong_gate_type` already clears wholesale.

### Vehicle photos

New files in `serverside/src/modules/vehicles/`, mirroring the `PersonPhoto`
trio field for field:

- **`vehiclePhotos.model.ts`** — `vehicle_id` (unique, so re-upload replaces
  rather than orphans), `data`, `mime`, `byte_size`, `updatedAt`.
- **`vehiclePhotos.repository.ts`** — `findByVehicleId`, `upsert`,
  `deleteByVehicleId`. Includes the same lean()-read fix `personPhotos`
  carries: the driver returns a raw BSON `Binary`, and without converting it
  to a `Buffer`, `res.send()` silently JSON-serializes the wrapper instead of
  sending image bytes.
- **`vehiclePhotos.service.ts`** — `upload` / `get` / `remove`. Writes go
  through `assertCanWrite(actor, 'vehicle')`, the same authority the rest of
  the module uses. The declared Content-Type is ignored; `detectImageType`
  sniffs magic bytes. On success the service sets
  `vehicle.photo_url = '/vehicles/<id>/photo'`. `remove` only clears
  `photo_url` when it points at us, leaving an externally hosted URL alone.

Reuses the existing `uploadPhoto` middleware and its 1 MB cap.

Routes, in `vehicles.routes.ts`:

```ts
// BEFORE the router-level authorize
vehicleRoutes.get('/:id/photo', authenticateAny, vehicleController.getPhoto);
```

The ordering is load-bearing. `vehicles.routes.ts` applies
`authenticate, authorize(...)` at the router level, and a gate terminal has
no user session — it authenticates with `X-Gate-Key`. Declaring the GET after
that middleware makes every terminal fetch 401 and the photo silently never
render. `persons.routes.ts:24` uses the identical pattern for face photos.

`POST` and `DELETE` stay under the router-level guards, OSS-writable.

Unlike person photos, there is no ownership carve-out: a vehicle photo is
readable by any authenticated caller or gate. A person photo needs the
`actor.personId !== personId` check because a student may fetch their own and
no one else's; vehicles have no such self-service surface.

`createVehicleSchema.photo_url` stays `z.string().url()`. The internal path is
set on the document by the photo service, never through the validated request
body, so the two never meet.

### Registration form

`VehicleApplicationForm` gains:

- The six-type dropdown, read from `lib/vehicleTypes.ts`.
- A vehicle-photo `PhotoCapture`.
- An owner-photo `PhotoCapture`, rendered **only when the selected owner has
  no `photo_url`**. Re-capturing a face that is already on file is churn, and
  the gate already shows it.

Submission order is forced by the data: the vehicle id does not exist until
`POST /vehicle-applications` returns `{ application, vehicle }`. Photos
upload second, to `/vehicles/<vehicle.id>/photo` and
`/persons/<owner_person_id>/photo`.

**A failed photo upload does not roll back the registration.** The pass is
already valid and revoking gate access over a missing image is the worse
failure. The form reports
`"Registered — but the photo didn't upload. Add it from the profile."`
and treats the registration as successful.

### Gate terminal

`GateTerminal.tsx` renders two frames on a vehicle-gate grant: the vehicle
photo (large, left) and the owner's face (smaller, right), both through
`AuthedImage` with the `X-Gate-Key` header the component already accepts.
Person gates keep the single-avatar layout unchanged.

`lib/gateTerminal.ts` adds `vehicle_photo_url?: string` to the `person` shape
on `TapDecision`.

### Migration

`serverside/src/config/migrateVehicleTypes.ts`, run once via an npm script,
idempotent, over both `vehicles` and `vehicleapplications`:

| old | new |
| --- | --- |
| `car` | `pickup` |
| `tricycle` | `motorcycle` |
| `other` | `van` |
| `motorcycle` | *unchanged* |

Idempotent because the new names are disjoint from the old ones it matches:
a second run finds nothing to update. It reports per-collection counts so a
run against an already-migrated database is visibly a no-op rather than
ambiguously silent.

Seed and verification harness literals (`testSeed.ts`, `verifyGates.ts`,
`verifyRoles.ts` — roughly twenty sites) are updated to the new names, or
their POSTs begin failing validation with 422.

`verifyRoles.ts` and `verifyGates.ts` contain assertions built on the
one-active-vehicle rule. Those that assert the `CONFLICT` on a second
registration are rewritten to register up to a type's limit and assert the
rejection at limit+1.

## Error handling

- Limit breach → `CONFLICT` with a message naming owner, type, limit, and
  remedy. Same code the one-vehicle rule used, so no client-side handling
  changes.
- Non-image upload → `VALIDATION_ERROR` from magic-byte detection.
- Oversized upload → `PAYLOAD_TOO_LARGE` from the existing multer wrapper.
- Photo fetch with no photo on file → `NOT_FOUND`. The terminal falls back to
  initials for the owner and a neutral placeholder for the vehicle, exactly
  as `PersonAvatar` already does.
- Photo upload failure after a successful registration → surfaced as a
  warning on a successful result, never a rollback.

## Testing

Deliberately scoped down at the user's request.

- `tsc --noEmit` on `serverside`, production build on `userpage`.
- The migration script against the live database, then a second run to prove
  idempotence.
- One targeted script: register three vans for one owner, assert the fourth
  is refused; register a van and a truck for the same owner, assert both
  succeed; upload a vehicle photo and a person photo, tap the vehicle's
  sticker, assert the tap response carries both `photo_url` and
  `vehicle_photo_url`.

The full `verifyRoles` / `verifyGates` suites are updated for compilation and
correctness but not run end to end as part of this work.

## Out of scope

- Editing vehicle photos from anywhere other than the registration form.
- Per-type limits that vary by person type (student vs employee).
- Backfilling photos for already-registered vehicles.
