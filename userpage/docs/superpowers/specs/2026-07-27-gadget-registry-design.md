# Gadget Registry — Design

**Date:** 2026-07-27
**Status:** SUPERSEDED by `2026-08-05-gadget-registry-design.md`. Never implemented.
**Scope:** Subsystem B of four. Depends on Subsystem A (role system), which is merged.

> **Superseded, kept for its reasoning.** The 08-05 spec is authoritative for everything
> this document describes: the data model, gate behaviour, permission matrix, and expiry
> design here are all obsolete. In particular a gadget carries **no RFID of its own** and
> can **never** deny a tap — the two assumptions this document is built on. See "What
> changed since 07-27" in the 08-05 spec for the full list.
>
> This file survives because two arguments in it are still worth having: the
> [Owner deactivation](#owner-deactivation-does-not-cascade) section, which is the clearest
> statement of why an access decision must not confiscate someone's property, and the
> descriptions of Subsystems C and D at the end.

## Problem

Students bring laptops and tablets onto campus. Nothing currently records whose device is
whose, so security at the exit has no way to tell a student carrying their own laptop from
one carrying somebody else's.

This subsystem registers a device to a person, issues an RFID sticker for it, and turns
the exit into a one-tap ownership check.

## What this is not

The gadget check answers **"is this device yours"**, not **"may you leave"**. Those are
different questions answered by different cards, and conflating them causes the design
error described under [Owner deactivation](#owner-deactivation).

## Decisions

| Question | Decision |
|---|---|
| Purpose | Anti-theft exit check, with an RFID sticker on the device. |
| Cardinality | Many gadgets per person. No unique constraint on owner. |
| Gate mechanic | Single tap on the gadget. It names its owner; the guard checks the face. |
| Who registers | Registrar and superadmin. |
| The "date" field | `valid_until`, an expiry that Subsystem D renews. |
| Owner deactivation | Does **not** cascade. Ownership still resolves; the owner's inactive status is shown as a notice. |
| Gate type | Gadget taps work at any gate. No `Gate.type` change, no reseed. |
| Serial numbers | Globally unique. The same physical device cannot be registered twice. |

## Data model

### `serverside/src/modules/gadgets/gadgets.model.ts`

```ts
export interface IGadget extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;   // ref Person — deliberately NOT unique
  rfid_uid: string;                  // unique, hex
  gadget_type: string;               // Laptop | Tablet | Phone | Other
  brand_model: string;               // "Dell Latitude 5420"
  serial_number: string;             // unique — the anti-theft anchor
  valid_until: Date;
  status: 'active' | 'inactive';
  photo_url?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes: `rfid_uid` unique, `serial_number` unique, `owner_person_id` non-unique,
`status` for filtering.

The five fields named in the original request map as follows. Name and course are **not**
stored on the gadget — they are joined from the owner's `Person` record, so a student who
changes section does not leave a stale course on their laptop registration.

| Requested | Where it lives |
|---|---|
| name | `Person.full_name` via `owner_person_id` |
| date | `valid_until` (registration date is `createdAt`) |
| course | `Person.department_section` via `owner_person_id` |
| gadget | `gadget_type` + `brand_model` |
| serial | `serial_number` |

### `rfid_uid` format

Hex, matching the constraint `tapSchema` already enforces (`/^[0-9A-Fa-f]+$/`) and the
format real readers emit. Non-hex values are rejected at registration, not discovered at
the gate.

## Cross-entity RFID uniqueness

`Person.rfid_uid` and `Vehicle.rfid_uid` are each unique **within their own collection**,
but nothing prevents the same UID existing in both. `scan.service.tap` resolves person
first, then vehicle, so a UID registered to both would always resolve as the person and
the vehicle would never scan — silently.

This is a live defect today, independent of this subsystem. Adding a third entity that
shares the same UID space makes it materially worse.

**This subsystem fixes it.** A shared helper is added and called by all three registration
and RFID-reassignment paths:

```ts
// serverside/src/utils/rfid.ts
/**
 * RFID UIDs share one namespace across persons, vehicles, and gadgets, because
 * scan.service.tap resolves them in sequence against a single UID. A duplicate would
 * make the later-resolved entity permanently unscannable, so collisions are rejected at
 * registration rather than discovered at a gate.
 */
export async function assertRfidAvailable(
  uid: string,
  ignore?: { collection: 'person' | 'vehicle' | 'gadget'; id: string }
): Promise<void>;
```

Throws `ApiError('DUPLICATE_RFID')` — an existing error code — naming which entity type
already holds the UID. The `ignore` parameter lets an update exclude the record being
edited.

Wiring it into the existing person and vehicle paths is in scope and is the point; a
helper nothing calls would leave the bug in place.

## Gate behaviour

`scan.service.tap` currently resolves person, then vehicle. It gains gadget as a third
step, in that order.

| Condition | `access_result` | `reason` |
|---|---|---|
| Active and not past `valid_until` | `granted` | `null` |
| Past `valid_until` | `denied` | `gadget_expired` |
| `status: 'inactive'` | `denied` | `inactive_id` |
| UID matches nothing | `denied` | `unregistered_uid` |

`inactive_id` and `unregistered_uid` are the strings the service already emits; only
`gadget_expired` is new. Expiry is evaluated against the end of `valid_until`'s day, so a
registration valid until 2027-03-31 works for all of that day.

### Response shape

`TapResult` gains an optional `gadget` field, mirroring the existing optional `person`:

```ts
gadget?: {
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  valid_until: Date;
  owner: { full_name: string; department_section: string; photo_url?: string };
  owner_status: 'active' | 'inactive' | 'pending';
};
```

`owner_status` is what lets the gate screen show an "OWNER ID INACTIVE" notice while still
confirming ownership.

### No attendance rollup

`scan.service` only writes attendance for granted **person** taps. Gadget taps must not
touch `AttendanceSummary` — a student carrying a laptop out is not an attendance event.

### No new gate type

`Gate.type` stays `'person' | 'vehicle'`. A gadget tap is accepted at any gate, because
the ownership check happens wherever security is standing. This avoids reseeding gates and
avoids a migration.

## Owner deactivation does not cascade

When a person is deactivated, their gadgets keep resolving. The gate shows the owner's
name and photo, flags `owner_status: 'inactive'` as a notice, and still returns `granted`.

The reasoning is worth recording, because the opposite is the intuitive answer and it is
wrong. Subsystem A established that one toggle produces every effect, which suggests
cascading here too. But deactivating a person answers "may they enter"; the gadget check
answers "is this theirs". Cascading would mean a suspended or graduated student cannot
prove their own laptop is theirs, so security holds their property — the system would
confiscate personal belongings as a side effect of an access decision.

Their own gate access is still denied, separately, by their own card. The two checks stay
independent by design.

Deactivating the **gadget** itself (a lost or revoked sticker) does deny, via
`inactive_id`.

## Expiry

`valid_until` defaults to the next occurrence of a configurable school-year end.

- New env var `SCHOOL_YEAR_END_MMDD`, default `03-31`, documented in `.env.example` and
  the README environment table.
- Registering on 2026-07-27 gives 2027-03-31. Registering on 2027-05-02 gives 2028-03-31.
- A registrar may override the computed default with an explicit `valid_until`.

Subsystem D renews this field. Nothing in this subsystem expires records automatically or
runs a scheduled job; expiry is evaluated at tap time.

## Permission matrix

Extends the matrix in `2026-07-26-role-system-design.md`. That document remains
authoritative for every route it lists; this table adds rows.

| Route | superadmin | registrar | staff | student |
|---|:--:|:--:|:--:|:--:|
| `GET /gadgets` | yes | yes | no | no |
| `GET /gadgets/:id` | yes | yes | no | no |
| `POST /gadgets` | yes | yes | no | no |
| `PATCH /gadgets/:id` | yes | yes | no | no |
| `PATCH /gadgets/:id/rfid` | yes | yes | no | no |
| `PATCH /gadgets/:id/status` | yes | no | no | no |
| `DELETE /gadgets/:id` | yes | no | no | no |

Status changes are superadmin-only, matching `PATCH /persons/:id/status`. Registrars
register devices and correct their details; revoking a sticker is an authority decision.

Students and staff reach their own gadgets only through `GET /dashboard`, which is already
role-aware, and only read-only.

## API

Standard CRUD following the `routes → controller → service → repository → model` layering
every other module uses.

- `GET /api/gadgets` — paginated, filterable by `owner_person_id`, `status`,
  `gadget_type`, and `search` (matches serial, brand/model, and owner name). Rows are
  joined to their owner, returning `{ id, rfid_uid, gadget_type, brand_model,
  serial_number, valid_until, status, owner: { id, full_name, department_section,
  id_number } }`.
- `GET /api/gadgets/:id` — one gadget with its owner.
- `POST /api/gadgets` — `{ owner_person_id, rfid_uid, gadget_type, brand_model,
  serial_number, valid_until?, photo_url? }`. Rejects a UID held by any person, vehicle,
  or gadget; rejects a duplicate `serial_number`; rejects an `owner_person_id` that does
  not exist. Defaults `valid_until` when omitted.
- `PATCH /api/gadgets/:id` — edit details. Cannot change `owner_person_id`; transferring a
  device means revoking and re-registering, so the audit trail shows it.
- `PATCH /api/gadgets/:id/rfid` — replace a damaged or lost sticker. Goes through
  `assertRfidAvailable`.
- `PATCH /api/gadgets/:id/status` — `{ status: 'active' | 'inactive' }`. Superadmin only.
- `DELETE /api/gadgets/:id` — soft delete via `deleted_at`, matching the pattern
  established for `User` in Subsystem A, and excluded from every list and lookup at the
  repository's filter builder rather than at three call sites.

### Dashboard

`GET /dashboard` gains gadget data per role, following the shape each role already gets:

- **superadmin** — `total_gadgets` and `expiring_soon` (active, `valid_until` within 30
  days) alongside the existing counts.
- **registrar** — `total_gadgets` added to the registration-focused summary. No scan or
  gate data, consistent with the ruling in Subsystem A.
- **staff and student** — `my_gadgets`, a read-only list of their own registered devices.

## Frontend

```
components/admin/GadgetsView.tsx     list, filters, register form, per-row status toggle
components/GadgetForm.tsx            single-device registration form
lib/permissions.ts                   'gadgets' added to AdminView and NAV_BY_ROLE
components/ProfileView.tsx           read-only "My registered devices" panel
```

`GadgetsView` follows `AccountsView`'s established shape: filters, a table joined to
owners, and a per-row status toggle for superadmin. It reuses the patterns that view
already proved — a generation ref discarding stale responses, a 250ms debounce on typed
filters, and disabled controls while a mutation is in flight.

Navigation gains a **Gadgets** tab for superadmin and registrar. Staff and student
navigation is unchanged; they see their devices on `/dashboard`.

The per-row status toggle is rendered only for superadmin, matching the permission matrix.
As established in Subsystem A, client-side gating is a usability measure — the server is
the enforcement boundary.

## Verification

Extends `serverside/src/config/verifyRoles.ts`, which is at 103 checks. No test framework
is added; the spec of Subsystem A forbids one and that holds here.

Assertions to add:

1. Every cell of the gadget permission matrix returns `2xx` or `403` as specified. A `401`
   is a failure, not a denial.
2. A registered, active, unexpired gadget tapped at a gate returns `access_result:
   'granted'` with the owner's name in the response.
3. A gadget with `valid_until` in the past returns `denied` with `reason:
   'gadget_expired'`.
4. A gadget with `status: 'inactive'` returns `denied` with `reason: 'inactive_id'`.
5. Deactivating the **owner** leaves the gadget `granted`, with `owner_status: 'inactive'`
   in the response. This is the non-obvious ruling and must be pinned by a test.
6. Registering a gadget with a UID already held by a **person** is rejected with
   `DUPLICATE_RFID`; likewise a UID held by a **vehicle**.
7. Registering a duplicate `serial_number` is rejected.
8. A soft-deleted gadget disappears from `GET /gadgets` and no longer resolves at a gate.
9. A gadget tap writes a `ScanLog` row but creates **no** `AttendanceSummary` row.
10. `valid_until` defaults to the next `SCHOOL_YEAR_END_MMDD` when omitted.

Every assertion must be able to fail. Assertions over collections need a length floor —
`.every()` on an empty array is `true`, a pattern that produced two defects during
Subsystem A. Any assertion comparing two values must confirm both are present rather than
comparing `undefined` to `undefined`, which produced a third.

The block must restore whatever it changes, and `npm run verify:roles` must produce
byte-identical output on two consecutive runs.

## Seed

`testSeed.ts` gains two gadgets, so the harness and the UI have data:

| Owner | Type | Model | Serial | RFID | Valid until |
|---|---|---|---|---|---|
| Juan Dela Cruz (`2025-0001`) | Laptop | Dell Latitude 5420 | `5CD1234ABC` | `A7B8C9D0` | next school-year end |
| Ana Villanueva (`EMP-1001`) | Tablet | iPad Air | `DMPX2LKQ1G` | `B8C9D0E1` | next school-year end |

RFID values are hex and must not collide with any seeded person or vehicle UID.

## Out of scope

- Renewal applications and the signed declaration (Subsystems C and D).
- Any change to `POST /scan/tap`'s authorization, which remains a documented deferred gap
  pending the gate hardware's auth mechanism.
- Automatic expiry jobs. Expiry is evaluated at tap time.
- Transferring a gadget between owners.
- Gadget photos beyond a `photo_url` string; there is no upload pipeline.
- Adding a test framework or MongoDB transactions.

## Relationship to later subsystems

- **C — Digital signature.** Adds signature capture to the user profile and terms
  acceptance. Independent of this subsystem; they meet in D.
- **D — Renewal applications.** A student applies to renew a gadget or vehicle
  registration and signs on submission; a reviewer approves and `valid_until` advances.
  Depends on this subsystem for the entity and its expiry field, on C for the signature,
  and on A for the reviewer role.
