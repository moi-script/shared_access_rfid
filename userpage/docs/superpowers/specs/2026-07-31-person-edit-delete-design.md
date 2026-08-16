# Person Edit and Delete — Design

**Date:** 2026-07-31
**Status:** Approved, ready for planning
**Scope:** Editing and removing a registered person from the admin console.
Depends on RBAC v2 and the vehicle-registration work, both merged.

## Problem

People can be registered but never corrected or removed. A typo in a name, a student who
transfers section, a card that is lost, a cohort that graduates — none of it can be handled
from the console.

The backend is further along than the UI:

- `PATCH /persons/:id` (update), `PATCH /persons/:id/rfid` (reassign a card) and
  `PATCH /persons/:id/status` all exist, guarded by the actor's write domain.
- **There is no delete of any kind.**
- The frontend has **no person edit form at all** — the only `apiPatch` on an admin screen is
  the account status toggle in `AccountsView`.

## Decisions

| Question | Decision |
|---|---|
| What "delete" means | **Soft delete.** `Person` gains `deleted_at`, mirroring `User`. Nothing is destroyed. |
| Cascade | Deleting a person deactivates their **login** and **every vehicle they own**. |
| Restore | Superadmin only, and it restores the **person only** — vehicles are reactivated deliberately. |
| Who may delete | **Superadmin only**, matching `DELETE /users/:id`. |
| Who may edit | The write-domain owner: registrar for students, HR for staff/employees, superadmin for all. |
| `id_number` | **Read-only.** It is the person's login username; changing it silently desyncs the two. |
| Card replacement | A separate action on the existing dedicated RFID endpoint, not a field in the edit form. |
| The old card | **Always blocked, permanently.** Any UID that leaves a person's record — by replacement or by deletion — goes on a blocklist and is refused by every scanner. No prompt, no unblock. |

## Why soft delete

Eight collections reference a person: `attendance`, `occupancy`, `personphotos`,
`personsignatures`, `scan_logs`, `users`, `vehicles`, and `vehicleapplications`.

A hard delete would leave scan history pointing at a record that no longer exists — an attendance
row whose owner cannot be named, and a `VehicleApplication` that names an applicant who is gone,
which the vehicle spec deliberately made an immutable record of what someone signed.

`User` already solved this with `deleted_at`, and `userRepo.buildFilter` pins `deleted_at: null`
in one place so no list can resurrect a deleted account. This follows that precedent exactly.

## Data model

`Person` gains:

```ts
deleted_at: { type: Date, default: null, index: true },
```

No other schema change. `status` keeps its existing meaning (a live person who is temporarily
barred); `deleted_at` means removed from the roster entirely.

The two are independent on purpose: deactivating is reversible by any domain owner and shows in the
directory; deleting hides the record and is superadmin-reversible only.

## The cascade, and its write order

`DELETE /persons/:id` performs three writes. There are no transactions — a standalone MongoDB has
no replica set, a constraint `users.service` already documents — so the order decides which side a
partial failure lands on:

```
1. vehicles -> status: 'inactive'                     crash here: car refused, person still admitted
2. person   -> deleted_at set, status inactive,
               rfid_uid cleared                       crash here: both cards refused
3. login    -> is_active false, refreshTokenHash cleared
```

**Every partial failure leaves access more restricted, never less.** This is the same rule
`users.service` states for deactivation — the gate is the first thing closed and the last thing
opened — applied to a three-step cascade. The reverse order would leave a window where the person is
deleted but their car still opens the parking barrier.

Clearing `refreshTokenHash` matters: without it, an existing session could be refreshed back into
life after the account is deactivated. `userService.setStatus` already does this and the reasoning
is recorded there.

### Why the delete clears `rfid_uid` and blocks it

`Person.rfid_uid` is `unique: true, sparse: true`. Deleting clears it so the sparse-unique claim is
released, and simultaneously adds the UID to `blocked_cards`. The blocklist — not the person row —
becomes the single place that says "this card is dead".

Both steps are needed. Clearing alone would return the UID to the pool, which the always-block
ruling forbids. Blocking alone would leave a deleted person still holding a unique claim on a UID
that nothing can ever use.

History is unaffected: `scan_logs` stores `rfid_uid` as a plain string copied at tap time, not a
reference, so past scans still show which card was used.

`id_number` is **not** cleared and stays reserved. A student number should not be recycled, and it
is also the person's login username. A consequence worth stating plainly: **a deleted person cannot
be re-registered under the same `id_number`.** For a graduate that is correct. For a registration
created by mistake, the operator must restore the person and correct them rather than delete and
re-add — the edit form exists for precisely that, and the confirmation dialog should say so.

## The critical implementation risk

**`deleted_at: null` must be applied inside the repository's filter, not at each call site.**

`personRepo` exposes `findPaginated`, `findAll` (the CSV export path), `distinctSections`,
`findById`, `findByRfid`, and `findByIdNumber` — **six** read paths, all of which must exclude
deleted rows. `findByRfid` **is the gate lookup** — it is what `scan.service.tap` calls to resolve
a tapped card.

Miss that one and a deleted person's card still opens the barrier, while the directory shows them
as gone. That is the worst possible failure for this feature: it looks done and is not.

`userRepo.buildFilter` is the precedent — it pins `deleted_at: null` once, with a comment
explaining that putting it there is what stops "Activate All" resurrecting deleted accounts. Do the
same here, and add a check that a deleted person is refused at a gate.

## The blocklist

**Any UID that leaves a person's record is blocked, permanently.** One rule, two triggers:

| Trigger | Effect |
|---|---|
| Replace a card | old UID blocked |
| Delete a person | their UID blocked |

There is **no prompt** asking why, and **no unblock**. The operator makes no judgement call, so
there is no judgement call to get wrong.

Replacing a card already kills the old one by mechanism: `reassignRfid` overwrites
`Person.rfid_uid`, and `scan.service.tap` resolves through `findByRfid`, so the old UID stops
matching anything the instant a new one is assigned. The blocklist adds what that alone does not —
it stops the UID ever being issued to somebody else.

### `blocked_cards`

```ts
{
  rfid_uid: string;                            // unique
  source: 'card_replaced' | 'person_deleted';  // audit only, not an operator choice
  previous_person_id: Types.ObjectId | null;
  blocked_by: Types.ObjectId;                  // ref User
  blocked_at: Date;
}
```

`source` records how the block happened; it is derived from the action, never chosen.

### Gate behaviour

`scan.service.tap` checks the blocklist **first**, before resolving the UID to a person or vehicle:

| Condition | `access_result` | `reason` |
|---|---|---|
| UID is blocked | `denied` | `card_blocked` |

**No identity is revealed** — a blocked card may be in the wrong hands, the same reasoning that
clears identity on `wrong_gate_type`.

**It must not touch occupancy.** Like every other denial, this is evaluated before the anti-passback
block, so a blocked card can never move anyone's inside/outside state.

`card_blocked` needs a human-readable entry in `lib/reasonText.ts` and the terminal's map — a raw
snake_case code on an operator screen has been a must-fix twice here.

### The block holds at the point of issue too

`POST /persons`, `PATCH /persons/:id/rfid`, `POST /vehicles` and the vehicle-application submission
all reject a blocked UID with an error naming the block. A block enforced only at the barrier would
be no block at all — a blocked card could be re-registered and would then resolve normally.

### Accepted consequences

Both are real, and were chosen knowingly:

- **Cards are single-use.** Every replacement and every deletion consumes one permanently, so a
  graduating cohort's cards are scrapped and stock must be replenished each year.
- **There is no undo.** An accidental replacement or deletion kills that card forever. The
  confirmation dialogs must say so plainly, because nothing downstream can recover it.

## Restore

`POST /persons/:id/restore`, superadmin only. Clears `deleted_at` and returns the person to the
directory with `status: 'inactive'` — visible again but not yet admitted, so restoring is never
itself an act of granting access.

**It does not restore vehicles or the login.** Those are reactivated explicitly. A restore that
silently re-admitted a car would be the mirror of the cascade hole this design closes.

**A restored person has no card.** Deletion cleared their `rfid_uid` and blocked it permanently, so
restoring returns the record but not a working credential — they must be issued a **new** card
before they can pass a gate. The restore confirmation must say so, or an operator will restore
someone, watch them be refused at the barrier, and reasonably conclude the restore failed.

This is the always-block ruling's cost, and it is the reason restore is not a general-purpose undo:
it recovers the record and its history, not the person's access.

## Authorization

| Action | Who |
|---|---|
| `PATCH /persons/:id` (edit) | write-domain owner (`assertCanWrite` on both the existing and incoming type) |
| `PATCH /persons/:id/rfid` (replace card) | write-domain owner |
| `PATCH /persons/:id/status` | write-domain owner |
| `DELETE /persons/:id` | **superadmin only** |
| `POST /persons/:id/restore` | **superadmin only** |

Delete and restore are superadmin-only to match `DELETE /users/:id`. The earlier ruling was that
admins were granted "deactivate and activate", not deletion; deletion is an authority decision, and
here it also reaches into a login and a set of vehicles.

Editing stays with the domain owner, including the existing both-directions type-change guard that
stops a registrar pushing a student into HR's domain or claiming a staff record.

## Frontend

```
components/StudentsDirectory.tsx   row actions: Edit, Replace card, Delete; show-deleted filter
components/PersonEditForm.tsx      NEW — prefilled edit, id_number read-only
components/PersonProfile.tsx       surface the same actions where a person is viewed
```

**Edit** is a prefilled form over `PATCH /persons/:id`: full name, type (constrained to the actor's
write domain, exactly as `PersonForm` already constrains it), course/department, email. `id_number`
renders **read-only with a short note** — "this is also their login username" — so the restriction
reads as deliberate rather than as a bug.

**Replace card** is its own action, because a lost card is a real-world event distinct from
correcting a typo, and the endpoint behind it does a cross-record uniqueness check. It shows the
current UID and accepts a new one; the reader types straight into the field.

**Delete** confirms by naming what it will take with it — "This also deactivates their login and 2
vehicles" — with the counts fetched, not guessed. An operator should never discover the cascade
afterwards.

**Show deleted** is a superadmin-only filter in the directory, with **Restore** per row. Deleted
rows are visually distinct from merely inactive ones, because the two mean different things and the
recovery path differs.

Client-side gating is a usability layer; the server is the boundary, as established in RBAC v2.

## Verification

Extends `verifyRoles.ts`, and one case belongs in `verifyGates.ts`.

1. **A deleted person's card is refused at a gate** — `denied`, and the response carries no
   identity. This is the check that catches the repository-filter mistake, and it is the single
   most important assertion in this design.
2. **A deleted person's vehicle is refused at the parking gate**, proving the cascade reached it.
3. A deleted person disappears from `GET /persons`, from `GET /persons/sections`, and from the CSV
   export.
4. Their login cannot authenticate after deletion.
5. `DELETE /persons/:id` as registrar → `403`; as HR → `403`; as superadmin → `200`.
6. `POST /persons/:id/restore` as registrar → `403`; as superadmin → `200`, and the person returns
   with `status: 'inactive'`, **not** active.
7. After restore, their vehicles are **still inactive** — restore does not re-admit a car.
8. Editing: a registrar may edit a student and may not edit a staff member; the both-directions
   type-change guard still holds.
9. Replacing a card rejects a UID already held by another person or vehicle.
10. After deletion the `id_number` **cannot** be reused — the attempt returns `DUPLICATE_ID`. This
    pins the documented limitation so it is a known boundary rather than a surprise.
11. A restored person's past scan rows still resolve their name, proving nothing in the cascade
    broke history.
12. **After replacing a card, the old UID is denied with `card_blocked`** and reveals no identity.
13. **After deleting a person, their UID is denied with `card_blocked`** — the same rule, the other
    trigger. Both are needed: an implementation that blocked on one path only would pass a test for
    the other.
14. A blocked UID is refused by `POST /persons`, `PATCH /persons/:id/rfid`, `POST /vehicles`, and a
    vehicle-application submission — each with an error naming the block. A block that held only at
    the barrier and not at registration would be no block at all.
15. A blocked tap leaves occupancy unchanged, proving the check runs before the anti-passback block.
16. A blocked UID is denied at **every** gate type — person and vehicle lanes both — since the check
    precedes entity resolution.

Assertion discipline as everywhere in this project: every assertion must be able to fail;
collection assertions need a length floor, since `.every()` on an empty array is `true`; and
comparisons must confirm both values are present rather than matching `undefined` to `undefined`.

Fixture mutations must restore in a `finally`, and every probe record must be covered by the
`PROBE_*` cleanup arrays.

## Out of scope

- **Bulk delete.** Deletion is per-person and deliberate. The existing bulk status change already
  covers deactivating a cohort.
- **Cascading to vehicle applications.** An application is an immutable record of what was
  submitted and signed; deleting the applicant does not rewrite it. The application's own
  `owner_person_id` still resolves, because the person row survives.
- **Editing a vehicle or its application** from the person screen.
- **Merging duplicate people**, which is a different problem with its own data hazards.
- **Changing `id_number`**, and therefore renaming the linked login. If that becomes necessary it
  should be its own change, handling the case where the new username is already taken.
