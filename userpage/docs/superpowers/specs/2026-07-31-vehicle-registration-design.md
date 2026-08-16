# Vehicle Registration — Car Pass Application — Design

**Date:** 2026-07-31
**Status:** Approved, ready for planning
**Scope:** The car-pass sticker application deferred from `2026-07-30-rbac-v2-design.md`.
Depends on RBAC v2 (merged), which gave OSS the `vehicle` write domain.

## Problem

`Vehicle` today has six fields: `owner_person_id`, `plate_number`, `rfid_uid`, `vehicle_type`,
`vehicle_model`, `photo_url`, `status`. The campus car-pass application is a printed form with
roughly thirty, including LTO registration numbers, driver details, a permanent address, and a
signed authorization.

There is no vehicle form anywhere in the frontend. `ParkingView` is read-only. OSS was
deliberately shipped without a Register tab in RBAC v2 because this form did not exist yet.

Three specific gaps:

1. **Nothing preserves what was submitted.** A campus pass is audited on its paperwork — LTO CR/OR
   numbers, the registered owner, the applicant's signature. None of it is stored.
2. **`Vehicle.owner_person_id` is `unique`,** so a person may own exactly one vehicle forever. A
   staff member with a car and a motorcycle is unrepresentable, and replacing a sold vehicle means
   editing the existing row and destroying its history.
3. **A pass never expires.** The form records a school year; the system has no notion of one.

## Decisions

| Question | Decision |
|---|---|
| What is stored | Two entities: an immutable `VehicleApplication` (the submitted document) and the `Vehicle` the gate reads. |
| Who submits | An OSS clerk transcribing the signed paper form. No student-facing screens, no review queue. |
| Cardinality | Many vehicles per person. The `unique` index on `owner_person_id` is **dropped**. |
| Applicant identity | Snapshotted onto the application, frozen. `Person` gains no new columns. |
| Expiry | `Vehicle.valid_until`; an expired tap is `denied` with `vehicle_expired`. |
| Signature | Its own collection keyed by application id, so it cannot be retroactively rewritten. |
| Write order | Application → signature → Vehicle. Fails closed. |
| Required fields | Deliberately few — the real paper form leaves most fields blank. |

## Why an application document, not just a richer Vehicle

A `Vehicle` row answers "may this sticker open the barrier right now". The paper form answers
"what was submitted, by whom, and what did they sign". Those are different questions with
different lifetimes, and collapsing them means an edit silently rewrites history — there would be
no record of what was actually signed.

Keeping them separate also makes renewals natural: a renewal is a new application against the same
vehicle, and the previous one remains intact.

## Data model

### `serverside/src/modules/vehicleApplications/vehicleApplications.model.ts`

```ts
export interface IVehicleApplication extends Document {
  _id: Types.ObjectId;

  // Classification
  category: 'new' | 'renewal';
  applicant_type: 'student' | 'employee';
  vehicle_type: 'motorcycle' | 'car' | 'tricycle' | 'other';

  // Links
  owner_person_id: Types.ObjectId;      // ref Person, required
  vehicle_id: Types.ObjectId | null;    // set exactly once, by the service

  // Applicant snapshot — frozen as written on the paper
  id_number: string;
  last_name: string;
  first_name: string;
  middle_name?: string;
  year_level?: string;
  school_year: string;                  // "26-27"
  email?: string;
  mobile_no?: string;
  tel_no?: string;
  permanent_address?: string;

  // Driver
  driver_name?: string;
  driver_license_no?: string;

  // LTO
  lto_cr_no?: string;
  lto_cr_date?: Date;
  lto_or_no?: string;
  lto_or_date?: Date;

  // Vehicle
  plate_no: string;
  mv_file_no?: string;
  make: string;
  model?: string;
  year?: string;
  color?: string;

  // Ownership
  registered_owner_name: string;
  relationship?: string;

  // Authorization
  signed_name: string;
  signed_date: Date;

  created_by: Types.ObjectId;           // ref User — the OSS clerk
  createdAt: Date;
}
```

Indexes: `owner_person_id`, `plate_no`, `school_year`, `createdAt`. **None unique** — an
application is a document, and the same plate legitimately appears across school years as renewals.

### Required fields are deliberately few

The sample filled form supplied by the client left **Email, Tel No, Driver's License No, LTO CR,
and Relationship blank**, and its OR No was `~`. A schema that marked those required would reject
real applications on the first day of use.

Required: `category`, `applicant_type`, `vehicle_type`, `owner_person_id`, `id_number`,
`last_name`, `first_name`, `school_year`, `plate_no`, `make`, `registered_owner_name`,
`signed_name`, `signed_date`. Everything else optional.

### Immutability is structural, not advisory

There is **no** `PATCH /vehicle-applications/:id` and no `DELETE`. A correction is a new
application; the older one stays and the newer supersedes it. Immutability enforced by the absence
of a route cannot be bypassed by a future caller, whereas immutability by convention is a comment.

The single exception is `vehicle_id`, which the service sets exactly once after creating the
Vehicle. The rule is precisely: **no field a human entered may ever change.** A system-set link is
not part of the signed document. The service must reject a second attempt to set it.

### `Vehicle` changes

```ts
owner_person_id: { type: ObjectId, ref: 'Person', required: true, index: true }  // unique REMOVED
plate_number:    { type: String, required: true, unique: true }                  // unchanged
rfid_uid:        { type: String, required: true, unique: true }                  // unchanged
vehicle_type:    { type: String, enum: ['motorcycle','car','tricycle','other'], required: true }
make:            { type: String }
vehicle_model:   { type: String }   // EXISTING field, kept — see below
color:           { type: String }
valid_until:     { type: Date, required: true, index: true }
status:          { type: String, enum: ['active','inactive'], default: 'active' }
```

**`vehicle_model` keeps its name.** The form's "Model" maps onto the existing field. Renaming it to
`model` would look tidier and is not worth it: six call sites depend on it across both repos —
`vehicles.model.ts`, `vehicles.schema.ts`, `dashboard.service.ts` (which returns it to the client),
`testSeed.ts`, `verifyRoles.ts`, and `ProfileView.tsx`, which renders it on a user-facing screen. A
cross-repo rename for cosmetic gain is exactly the unrelated refactor this design should not carry.

Dropping `unique` from `owner_person_id` is what allows a second vehicle. `plate_number` and
`rfid_uid` remain unique — those are the constraints that actually prevent duplicates.

### `vehicleApplicationSignatures`

`application_id` (unique), `data` (Buffer), `mime` (`image/png`), `byte_size`, `createdAt`.

Same shape as `personSignatures`, but keyed to the **application**. `personSignatures` is
deliberately mutable — its schema comments that "re-signing replaces the previous drawing" — so
referencing it would mean a later re-sign retroactively changes what every past application appears
to show. That is exactly what the frozen-document decision exists to prevent.

### Expiry default

`valid_until` defaults to the next occurrence of `SCHOOL_YEAR_END_MMDD` (default `03-31`). OSS may
override it with an explicit value.

**This subsystem introduces that variable.** It is named in the gadget-registry spec, but that spec
is unimplemented — the variable exists in no code, `.env`, or `.env.example` today. Adding it here
means it must be defined in `config/env.ts` with an `MM-DD` format validation that fails at startup
on a malformed value, documented in `.env.example` and the README environment table, and computed in
**local** time. A silently-invalid date here would set every pass's expiry to `Invalid Date`.

The validate-at-startup requirement is not gold-plating: `OCCUPANCY_RESET_TIME` shipped without it,
a review caught that a malformed value produced a silent `Invalid Date`, and the ruling then was
that failing closed at boot beats silent corruption. The same reasoning applies to a field that
governs whether a pass opens a barrier.

## API

All writes sit inside the OSS write domain established by RBAC v2, so `assertCanWrite(actor,
'vehicle')` guards them and **no new role logic is introduced**.

| Route | Guard | Notes |
|---|---|---|
| `POST /api/vehicle-applications` | superadmin, oss | The one submission endpoint. |
| `GET /api/vehicle-applications` | all four staff-side | Paginated; filter by `owner_person_id`, `plate_no`, `school_year`, `category`. |
| `GET /api/vehicle-applications/:id` | all four staff-side | One application, owner joined. |
| `POST /api/vehicle-applications/:id/signature` | superadmin, oss | Multipart, 1MB cap, magic-byte classified. |
| `GET /api/vehicle-applications/:id/signature` | all four staff-side | PNG bytes. **No gate-key access.** |

Reads are shared across the four staff-side roles, consistent with RBAC v2's "scoped writes, shared
reads". A gate has no use for a signature, matching the existing reasoning on the person-signature
route.

### Write sequence

There are no transactions — a standalone MongoDB has no replica set, a constraint `users.service`
already documents. The order therefore decides which side a partial failure leaves safe:

```
1. create VehicleApplication   → crash here: paperwork only, no access granted
2. store signature blob        → crash here: application exists, no access granted
3. create Vehicle (active)     → gate access begins only now
4. set application.vehicle_id  → system link, written once
```

This is the creation-side mirror of the rule `users.service` states for deactivation — the gate is
the first thing closed and the last thing opened. An incomplete registration is visible to OSS and
grants nobody access. The reverse order would leave a vehicle opening the barrier with no
supporting document, which is the failure a pass audit exists to catch.

## Gate behaviour

`scan.service.tap` gains one clause on the vehicle branch:

| Condition | `access_result` | `reason` |
|---|---|---|
| Active and not past `valid_until` | `granted` | `null` |
| Past `valid_until` | `denied` | `vehicle_expired` |
| `status: 'inactive'` | `denied` | `inactive_id` (existing) |

Only `vehicle_expired` is new.

**Expiry is evaluated in local time**, against the end of `valid_until`'s day, so a pass valid until
2027-03-31 works for all of that day. This codebase has paid for UTC-derived dates twice — the
attendance bucketing bug documented in the README, and the `/logs` filters that excluded the
selected day entirely. Use local `Date` components.

**Placement matters.** The expiry check belongs with the existing `inactive_id` check, **before**
the anti-passback block. An expired tap must never mutate occupancy state — the anti-passback design
establishes that only otherwise-granted taps may move it, precisely so a denied card cannot alter
anyone's inside/outside state.

`vehicle_expired` needs a human-readable entry in both `GateTerminal`'s reason map and
`lib/reasonText.ts`. Rendering a raw snake_case code on an operator screen has been a must-fix twice.

## Frontend

```
components/vehicles/VehicleApplicationForm.tsx   the counter form
components/admin/RegisterView.tsx                gains a Vehicle panel for OSS
lib/permissions.ts                               NAV_BY_ROLE.oss gains 'register'
lib/reasonText.ts                                + vehicle_expired
components/gate/GateTerminal.tsx                 + vehicle_expired
```

OSS finally gets its **Register** tab. RBAC v2 withheld it deliberately, on the grounds that a tab
opening an empty panel is worse than no tab; that condition no longer holds.

### The form is a counter tool

A clerk types from paper with a queue waiting. The form is grouped into the same sections as the
printed sheet — Category, Applicant, Vehicle, LTO, Ownership, Authorization — **in the same order**,
so the eye tracks paper to screen without hunting.

Optional fields are visibly marked optional. Given how much of a real form is blank, one that looks
like it demands everything will get filler typed into it.

### Owner selection is a search

`owner_person_id` is required and the directory is too large for a select. Reuse the debounced
search pattern `AccountsView` established, including its generation ref for discarding stale
responses.

When the selected person's `id_number` or name disagrees with what the clerk typed into the snapshot
fields, **show the mismatch without blocking submission**. The paper is the record, and a
discrepancy is exactly what a human should notice and resolve — not something the form should
silently normalise away.

### Signature capture

**Correction, found during implementation:** an earlier draft of this section said to "reuse the
canvas `PersonForm` already uses". That component does not exist — `PersonForm.tsx` contains no
signature or canvas code at all, and the only canvas in the codebase is `PhotoCapture.tsx`, which
captures a face photo. The implemented approach is therefore the alternative this section already
allowed: accept a scan or photo of the signed paper, re-encoded through a canvas to a real PNG so it
satisfies the PNG-only magic-byte check. Either way the
bytes land in `vehicleApplicationSignatures` against this application.

## Validation

Thin by design. Over-validation rejects genuine paperwork:

- `rfid_uid` must be hex, matching `tapSchema`'s existing constraint and what real readers emit.
  Rejected at registration rather than discovered at a barrier.
- `plate_no` is uppercased and trimmed, with **no format regex**. Philippine plates, MV file numbers
  and temporary plates vary too much; the client's own sample (`U510MX`) would fail a naive pattern.
- Dates are accepted as dates. **No cross-field ordering rule** between `lto_cr_date` and
  `lto_or_date` — the sample has a CR date in 2021 and an OR date in 2026.
- A duplicate `plate_no` or `rfid_uid` returns `409` naming which field collided.
- A malformed `:id` returns `422`, consistent with the treatment established elsewhere.

## Verification

Extends `serverside/src/config/verifyRoles.ts`. No test framework is added; that prohibition holds.

1. OSS submits a complete application → `201`; the Vehicle exists, is `active`, and carries
   `valid_until`.
2. Registrar → `403`; HR → `403`; student → `403`.
3. `PATCH` and `DELETE` on an application → route absent (`404`/`405`). This pins immutability
   structurally rather than trusting a comment.
4. A **second** vehicle for the same person succeeds. Without the dropped index this fails with a
   duplicate-key error, so this check is what proves the migration happened.
5. Duplicate `plate_no` → `409`; duplicate `rfid_uid` → `409`.
6. A minimal application omitting **every** optional field → `201`. The client's own sample data
   demands this.
7. An expired vehicle tapped at a parking gate → `denied` with `vehicle_expired`, **and** occupancy
   is unchanged afterwards.
8. `valid_until` defaults from `SCHOOL_YEAR_END_MMDD` when omitted.
9. The signature fetched for an application is the one uploaded to **that** application, and is
   unaffected by changing the owner's `personSignatures`.

Assertion discipline, carried from defects this codebase has already paid for: every assertion must
be able to fail; collection assertions need a length floor, because `.every()` on an empty array is
`true`; and any comparison must confirm both values are present rather than matching `undefined` to
`undefined`.

### Fixture cleanup is mandatory

`verifyRoles` deletes its own probe records via `PROBE_*` prefix arrays, after accumulation broke
harnesses twice. This subsystem adds **three** new collections to leak from — applications,
signatures, and the vehicles they create. All three must be covered by that cleanup, and the probe
prefixes registered alongside the existing ones.

## Migration

Dropping `unique` from `owner_person_id` requires dropping the existing index; Mongoose will not
alter it in place. The server already refuses to start on an occupancy index mismatch, and the
README documents that recovery — follow the same pattern: drop the stale index explicitly rather
than letting a silent build failure disable the constraint.

Existing `Vehicle` rows have no `valid_until`, which is `required`. Seeded data is small and
`seed:test` is idempotent, so wipe and reseed, consistent with every prior subsystem's ruling.

`seed:test` must also be updated: it currently creates vehicles without `valid_until`, `make`, or a
`vehicle_type` drawn from the new enum, so it would fail validation the moment the schema tightens.

## Out of scope

- **Renewals as a workflow.** `category: 'renewal'` is a recorded value; no renewal-specific flow,
  reminder, or expiry job exists. Expiry is evaluated at tap time.
- **Student-facing submission and a review queue.** The data model does not preclude adding
  `status`/`reviewed_by` later, but nothing here anticipates it.
- **The gadget registry** (`2026-07-27-gadget-registry-design.md`), still unimplemented. This
  subsystem does not depend on it; both use `SCHOOL_YEAR_END_MMDD`.
- **Monitor output v2** — richer person and vehicle tap screens. It will consume `make`, `model`,
  and `color`, which this subsystem creates.
- **Vehicle photos.** `Vehicle.photo_url` exists and is untouched; there is no upload pipeline for it.
- **Cross-entity RFID uniqueness.** The gadget spec documents that `Person.rfid_uid` and
  `Vehicle.rfid_uid` are unique per-collection but not across them, and proposes a shared
  `assertRfidAvailable`. That defect is real and pre-existing; this subsystem neither fixes nor
  worsens it, and the fix belongs with the gadget work that introduces a third UID space.
