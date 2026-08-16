# RBAC v2 — Rank, Admin Domains, and Scan Records — Design

**Date:** 2026-07-30
**Status:** Approved, ready for planning
**Scope:** Extends Subsystem A (role system, merged). Not part of the original A–D sequence;
the vehicle registration and monitor output work depend on it. Supersedes two specific
rulings in `2026-07-26-role-system-design.md`; see
[Deliberate reversals](#deliberate-reversals).

## Problem

The role system has four flat roles: `superadmin`, `registrar`, `staff`, `student`. The
client now needs three *kinds* of administrator, each registering a different population,
and a rule that no account may create or destroy an account of its own authority level.

Three concrete gaps:

1. **No peer protection.** A superadmin can currently deactivate another superadmin. There
   is no notion of authority level, so "cannot add or remove an account at your own level"
   is not expressible.
2. **One registrar for every population.** Students, employed staff, and vehicles/devices
   are registered by different campus offices. Today one `registrar` role does all of it,
   and `PersonForm` lets whoever holds it pick any `type`.
3. **No way to read entry/exit history in the UI.** `GET /api/logs` exists and has no
   frontend consumer at all, so "see records in and out" is not answerable from the app.

## Decisions

| Question | Decision |
|---|---|
| Role set | Six: `superadmin`, `registrar`, `hr`, `oss`, `staff`, `student`. `registrar` keeps its name so its existing routes and harness checks survive. |
| Representation | Flat role values. Rank and write-domain are **derived lookup tables**, not stored fields. |
| Authority rule | Strict rank, all verbs: an actor may act on an account only if that account's rank is strictly lower. Peers and superiors are always denied. |
| Domain rule | Scoped writes, shared reads. Every admin reads the whole directory; each writes only its own domain. |
| Rank vs. domain on the status toggle | **Domain wins.** An admin may act on an account only if its linked person is in the actor's write domain, so HR cannot deactivate a student. See [cross-rule interaction 1](#1-the-single-toggle-spans-both-rules--and-domain-wins). |
| Superadmin provisioning | Seed creates the first. A break-glass CLI promotes further ones. Never over the API. |
| Enforcement | Service-layer asserts for single targets; the rank rule compiled into the Mongo filter for the bulk path. |
| `BULK_PROTECTED` | Deleted, replaced by a derived `rolesBelow()`. |
| New page | Records — scan history over `/api/logs`, superadmin only. |
| Migration | None. Wipe and reseed, as Subsystem A ruled. |

## Two independent rules

The design turns on keeping these apart:

- **Rank** governs actions on *login accounts* (`User`).
- **Write-domain** governs actions on *records* (`Person`, `Vehicle`, `Gadget`).

They are different rules because a `Person` is not a `User`. HR creating Ana's profile and
HR creating Ana's login are two separate authorizations. Conflating them produces an admin
who can mint a peer by way of a profile.

## Data model

### `serverside/src/constants/roles.ts`

```ts
export const ROLES = {
  SUPERADMIN: 'superadmin',
  REGISTRAR:  'registrar',
  HR:         'hr',
  OSS:        'oss',
  STAFF:      'staff',
  STUDENT:    'student',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Authority level. Derived, never stored on a document. */
const RANK: Record<Role, 1 | 2 | 3> = {
  superadmin: 3,
  registrar:  2,
  hr:         2,
  oss:        2,
  staff:      1,
  student:    1,
};

export function rankOf(role: Role): 1 | 2 | 3;

/** Every role strictly below `actor`. Replaces BULK_PROTECTED. */
export function rolesBelow(actor: Role): Role[];

/** Roles that get the staff-side console at /admin. */
export const STAFF_SIDE: readonly Role[] =
  [ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS];

export type Domain =
  | 'person:student' | 'person:staff' | 'person:employee'
  | 'vehicle' | 'gadget';

export const WRITE_DOMAINS: Record<Role, readonly Domain[]> = {
  superadmin: ['person:student', 'person:staff', 'person:employee', 'vehicle', 'gadget'],
  registrar:  ['person:student'],
  hr:         ['person:staff', 'person:employee'],
  oss:        ['vehicle', 'gadget'],
  staff:      [],
  student:    [],
};
```

`RANK` is not exported directly. Callers use `rankOf` and `rolesBelow`, so the numeric
levels stay an implementation detail and no call site can compare ranks its own way.

`BULK_PROTECTED` is **deleted, not extended**. Adding `hr` and `oss` to it would work today
and silently fail the next time a role is added — a hand-maintained list of privileged
roles is a defect waiting on the next commit. `rolesBelow()` is derived from `RANK` and
cannot go stale.

### Bulk actions never reach an admin

`rolesBelow()` alone is **not** the bulk predicate. The old `BULK_PROTECTED` list did two
jobs, and only one of them was peer protection: it also kept a **superadmin's** bulk action
off registrar accounts. Replacing it with `rolesBelow()` alone would let one mis-filtered
"Deactivate All" disable every Registrar, HR, and OSS account at once, leaving only the
acting superadmin — since all of them rank below 3.

Bulk therefore carries a floor as well as the rank rule:

```ts
/** Roles a bulk action may touch: below the actor AND never an admin. */
export function bulkEligibleRoles(actor: Role): Role[] {
  return rolesBelow(actor).filter((r) => RANK[r] < 2);
}
```

Still derived, so it cannot go stale. Deactivating an admin remains possible one at a time
through `PATCH /users/:id/status`, where the actor is choosing a specific target rather than
a filter. The blast radius of a filter is the thing being limited, not the authority.

### `users.model.ts`

The `role` enum widens to the six values. No new fields. Rank is derived, and storing it
would let a bad row grant authority that the code cannot account for.

## The three guards

All in `serverside/src/utils/authority.ts`, each throwing `ApiError('FORBIDDEN', ...)`.

| Guard | Rule | Applied to |
|---|---|---|
| `assertCanActOn(actor, target)` | `rankOf(target.role) < rankOf(actor.role)` **and** `target._id !== actor.id` | status change, delete, password reset |
| `assertCanCreateRole(actor, role)` | `rankOf(role) < rankOf(actor.role)` | `POST /users` |
| `assertCanWrite(actor, domain)` | `WRITE_DOMAINS[actor.role].includes(domain)` | person, vehicle, gadget writes |

### Why `assertCanCreateRole` is not redundant

On create there is no target row to compare against, so the rule must apply to the
**requested** role. Without this guard an HR admin could `POST /users { role: 'hr' }` and
mint a peer — precisely the thing peer protection exists to prevent — and it would pass a
target-based check because no target exists yet.

`POST /users { role: 'superadmin' }` is therefore 403 for **everyone**, superadmins
included, since `rankOf('superadmin') < rankOf('superadmin')` is false.

### Self-targeting

`assertCanActOn` also rejects the actor's own id. The existing code already rejects
self-deactivation; this preserves it in one place instead of at each call site.

## Enforcement placement

Route guards answer *who may attempt*. The asserts answer *on whom*. Both layers are
required: `authorize()` cannot express rank because it sees only the actor's role, and an
assert alone would let a student reach the handler.

### Single-target verbs

The service loads the target and calls the relevant assert before mutating. This yields a
clean `403 FORBIDDEN` distinguishable from a `404`, which matters for an access-control
system that has to be demonstrable.

### The bulk path

`POST /users/bulk-status` acts on a **filter**, not an id, so there is no single target to
compare. The rank rule is compiled into the query:

```ts
UserModel.updateMany(
  {
    ...clientFilter,
    role: { $in: rolesBelow(actor.role) },
    _id:  { $ne: actor.id },
    deleted_at: null,
  },
  { $set: { is_active } }
);
```

No filter a client can send reaches a peer or a superior: those rows match zero documents
rather than being filtered out afterward. This is the same reasoning anti-passback applied
to occupancy — put the guarantee in the query when a post-hoc check could be raced or
bypassed.

**The preview must use the same predicate.** `GET /users/bulk-status/preview` exists and
tells the operator how many accounts a filter will affect. If the predicate is added to the
apply path alone, the preview counts peers the operation will not touch: it says "12
accounts" and 9 change, with no error and nothing in the log to explain the gap. Both paths
must build the filter through one shared function, not two similar literals. The
verification below pins preview and apply agreeing on the same filter.

**Declaration order is load-bearing.** `users.routes.ts` carries a comment explaining that
the bulk routes must be registered above `/:id/status`, because Express matches in order and
`bulk-status` would otherwise be captured by `:id`. Widening these guards must not reorder
them.

## Cross-rule interactions

These are the cases where the two rules meet, and each is a place a naive implementation
leaves a hole.

### 1. The single toggle spans both rules — and domain wins

Subsystem A ruled that one switch turns off **both** login and gate access. Deactivating a
student therefore touches a `User` **and** a `Person`. That path must satisfy
`assertCanActOn` (the account) **and** `assertCanWrite` (the profile).

This creates a collision that has to be settled explicitly, because three otherwise-correct
rules cannot all hold at once:

| Rule | Implies |
|---|---|
| Rank | HR (2) may act on a student account (1) |
| Write-domain | HR may not write a `person:student` record |
| One toggle | Deactivating an account writes its `Person` too |

**Ruling: domain wins.** An admin may act on an account only if the account's linked person
is in the actor's write domain. Concretely:

| Actor | Target | Result |
|---|---|---|
| HR | staff/employee account | allowed |
| HR | student account | `403` |
| Registrar | student account | allowed |
| Registrar | staff account | `403` |
| superadmin | any rank-1 account | allowed |
| any rank-2 admin | another office account (`person_id: null`) | `403` by rank |

Each office manages its own population end to end, and one rule explains every denial. The
alternative — treating the `Person` write as a mere side effect exempt from the domain rule —
would let HR shut off a student's campus access, which is not what "HR registers employed
staff" means.

**Two consequences worth stating:**

- **`resetPassword` is rank-only.** It does not touch `Person`, so no domain check applies.
  This is a real asymmetry, not an oversight: HR may reset a student's password but not
  deactivate them. If that is undesirable it should be changed deliberately, not by adding a
  domain check that has no `Person` write to justify it.
- **Office accounts have no linked person**, so only rank governs them, and only a superadmin
  outranks rank 2. Registrar, HR, and OSS accounts are therefore superadmin-managed, which is
  the same answer peer protection already gave.
- **A dangling `person_id`** (a `User` pointing at a deleted `Person`) has no gate side to
  write, so rank alone governs. Do not fail closed on it — that would make a data-integrity
  problem look like a permissions bug.

### 1b. The bulk path inherits the domain rule

Because domain wins, `resolveBulkTargets` cannot filter on role alone. It must also exclude
candidates whose linked person is outside the actor's write domain, counting them in
`excluded` exactly as it counts peers. Filtering only by role would let HR's "Deactivate All"
sweep every student on campus — the single most damaging hole in this subsystem, and the one
a role-only predicate leaves wide open.

### 2. `POST /users` needs the domain rule too

A login is created *for a person*. If only `assertCanCreateRole` ran, OSS could create
student logins: rank-legal, domain-illegal. When `person_id` is present, the linked
person's `type` must be in the actor's write domain. This is what keeps OSS out of account
creation entirely, without a special case naming OSS.

### 3. Type-change escalation

`PATCH /persons/:id` that changes `type` moves a record between domains. It checks the
domain of the **existing** type and of the **incoming** type. Checking one direction only
leaves the other open: a Registrar could flip a student to `staff` (pushing it out of
reach, and out of HR's expectations) or, in the reverse-only case, claim a staff record by
flipping it to `student`.

### 4. Reads are genuinely wider than before

OSS and HR can read the full person directory. This is the deliberate consequence of
shared reads: `Vehicle.owner_person_id` references a `Person`, so OSS cannot attach an
owner to a vehicle without looking up a student that Registrar created. The cost is that
HR can read student records. Recorded here rather than discovered later.

## Superadmin provisioning

No superadmin may create a peer, so the API can never produce one. Combined with the
README's instruction to remove `ADMIN_PASSWORD` from production `.env` after first seed,
the naive reading leaves no recovery path through the application at all — a lost
superadmin account would require direct MongoDB access.

The escape hatch is a break-glass script, outside the API:

- `npm run seed` creates the first superadmin, unchanged.
- `npm run grant:superadmin -- <username>` promotes an existing account. Runnable only by
  whoever has server and `.env` access.
- It writes an audit row recording who was promoted and when.
- It refuses to run against an account that does not exist, and is idempotent against an
  account that is already superadmin.

`POST /users { role: 'superadmin' }` remains 403 for every caller. The rule holds for
everyone who is logged in; the only way to add a superadmin is shell access to the server.

## API surface

Guards widen as follows. Every row also applies the asserts named in the last column.

| Route | Current guard | New guard | Assert |
|---|---|---|---|
| `GET /users` | superadmin, registrar | + hr, oss | — |
| `POST /users` | superadmin, registrar | + hr, oss | `assertCanCreateRole` + domain of linked person |
| `PATCH /users/:id/status` | superadmin | + registrar, hr, oss | `assertCanActOn` **+** `assertCanWrite` on the linked person |
| `GET /users/bulk-status/preview` | superadmin | + registrar, hr, oss | rank **and** domain exclusion |
| `POST /users/bulk-status` | superadmin | + registrar, hr, oss | rank **and** domain exclusion |
| `DELETE /users/:id` | superadmin | unchanged | `assertCanActOn` **+** `assertCanWrite` on the linked person |
| password reset | superadmin | unchanged | `assertCanActOn` only — no `Person` write |
| `/persons/*` router-level | superadmin, registrar | + hr, oss | `assertCanWrite` per write verb |
| `PATCH /persons/:id/status` | superadmin | + registrar, hr, oss | `assertCanWrite` |
| `/vehicles/*` | superadmin | + registrar, hr, oss | `assertCanWrite('vehicle')` |
| `/logs/*` | superadmin | unchanged | — |
| `/reports/*` | superadmin | unchanged | — |

`DELETE` stays superadmin-only. The requirement was that admins "deactivate and activate";
deletion was not granted, and the narrower reading is kept deliberately.

Opening `/persons` to `oss` gives OSS **read** access; `assertCanWrite` denies every person
write because `WRITE_DOMAINS.oss` contains no `person:*` domain. The route guard and the
domain guard do different jobs here, and that asymmetry is the point.

`GET /dashboard` is role-aware in the service. It gains `hr` and `oss` arms. A role with no
arm currently falls through to a shape the frontend does not expect, so this is required,
not cosmetic.

## Records page

### Backend change required

`GET /api/logs` returns raw `ScanLog` rows: `entity_id` is a bare `ObjectId` and nothing is
joined. Rendering it directly would show `66f1a3…` where a name belongs. `scanService.listLogs`
therefore gains a join resolving `entity_id` to a name, conditional on `entity_type`
(`person` → `Person.full_name`, `vehicle` → `Vehicle.plate_number` plus its owner's name).

`reports.service` already performs this join for the anomaly report and was verified correct
during anti-passback, including that its `$lookup` projection cannot leak `password_hash`.
That implementation is the reference; this must not invent a second approach.

Two constraints carried from that review:

- `Types.ObjectId` conversion is required in `$match`. Mongoose does **not** cast `$match`
  inside an aggregation pipeline, and a string compared against an `ObjectId` matches
  nothing silently. This was a real bug found in `gateActivity`.
- The response must expose the total and a truncation flag if a cap is applied. The anomaly
  report shipped without them and it was raised as a must-fix, for the same reason the
  presence roster was: a silently truncated list is indistinguishable from a short one.
  **Use the existing `buildMeta` shape** — `{ pagination: { total, page, limit, pages } }` —
  with `truncated` added alongside it, so `meta.pagination.total` reads the same here as on
  every other list endpoint. A lone endpoint with a flat `meta.total` is a contract every
  future consumer gets wrong once and then works around permanently.

### Response shape

```ts
{
  id: string;
  scan_time: Date;
  direction: 'entry' | 'exit';
  access_result: 'granted' | 'denied';
  reason: string | null;
  gate: { id: string; name: string } | null;   // null on manual overrides
  entity_type: 'person' | 'vehicle';
  subject: { full_name: string; id_number?: string; plate_number?: string } | null;
  rfid_uid: string;
}
```

`gate` is nullable because manual occupancy overrides write a `ScanLog` row with
`gate_id: null`. `subject` is nullable because a scan of an unregistered UID has no entity
to resolve.

### Filters

Date range, gate, direction, and access result. Paginated with the existing helpers. The
existing `listLogs` filter already supports `gate_id`, `direction`, and a `from`/`to`
range; `access_result` is added.

**Date handling.** Any date filter must derive its boundaries the way the server does —
local `Date` components, never `toISOString()`. `scanService.dateKey()` and `isLate()` both
use local time, and the README records that a UTC-derived "today" queries the wrong bucket
for part of every day in any non-UTC timezone. This caused a real intermittent test failure
during development and must not be reintroduced in a new consumer.

## Frontend

```
lib/auth.ts                        Role union += 'hr' | 'oss'
lib/permissions.ts                 AdminView += 'records'; ABILITIES and NAV_BY_ROLE entries
components/admin/RecordsView.tsx   NEW — scan history, filters, pagination
components/admin/AccountsView.tsx  + create-account form; rank-based row protection
components/admin/AdminShell.tsx    Records tab wiring
components/PersonForm.tsx          type select constrained to the actor's write domain
```

### Exhaustiveness hazard

`can()` is `ABILITIES[role].includes(action)` where `ABILITIES` is `Record<Role, Action[]>`.
Widening the `Role` union without adding map entries is a **runtime TypeError**
(`undefined.includes`), not a compile error at the call site. The same applies to
`NAV_BY_ROLE` and `defaultViewFor`, which indexes `NAV_BY_ROLE[role][0]`.

Both maps must be updated in the same commit as the union, and the implementation must
include a check that every role has an entry in both.

### Navigation

| Role | Tabs |
|---|---|
| superadmin | Overview, Directory, Parking, Presence, **Records**, Register, Accounts |
| registrar | Register, Directory |
| hr | Register, Directory |
| oss | Directory, Parking |

OSS has **no Register tab**. Its registration surface is the vehicle form, which belongs to
a later subsystem; a tab opening an empty panel is worse than no tab.

### Scoped person form

`PersonForm`'s `type` select renders only the options in the actor's write domain:
Registrar sees Student, HR sees Staff and Employee. When exactly one option is available it
renders as a disabled field showing that value, not a single-option dropdown that looks
interactive.

As Subsystem A established, client-side gating is a usability layer; the server is the
enforcement boundary. The form omitting an option is not what stops a Registrar creating a
staff record — `assertCanWrite` is.

### Account creation

`AccountsView` gains a create form: username, role, temporary password, optional
`person_id`. The role select offers only `rolesBelow(actor.role)`, so Superadmin is never
rendered for anyone.

Row protection becomes a rank **and** domain comparison, mirroring the server. The current
hardcoded expression — `r.role === "superadmin" || r.role === "registrar" || r.id === selfId`
— is replaced by a check that a row is protected when its rank is at or above the actor's,
when it is the actor's own row, **or** when its linked person's type is outside the actor's
write domain. The users list already joins each account's person, so the type is available
without another request.

Without the domain half, HR would see an enabled toggle on every student row that the server
then rejects with a 403 — an interface that invites an action it cannot perform.

### Reused patterns

`RecordsView` follows `AccountsView` and `PresenceView`, whose behaviours were verified
during earlier reviews: a generation ref that discards stale responses (a
first-requested/last-arriving reply must not overwrite fresher data), a 250ms debounce on
typed filters, disabled controls while a mutation is in flight, and a visible
"Showing N of M" banner whenever a cap is hit.

## Error handling

- Every denial is `403` with code `FORBIDDEN`. A `401` in place of a `403` is a bug, not a
  denial — it means the token was rejected rather than the action.
- A missing target is `404`, distinguishable from `403`. This is why the single-target path
  uses service asserts rather than query predicates.
- Malformed `:id` returns `422`, matching the treatment the anomaly report received after
  review found it returning `500` with a leaked BSON message.
- `grant:superadmin` fails loudly on an unknown username and exits non-zero.

## Seed

`seed.ts` is unchanged apart from the widened role enum.

`seed:test` gains two rank-2 accounts and one staff person, so the harness has a
cross-domain target to be denied on:

| Role | Username | Password |
|---|---|---|
| HR | `testhr` | `Hr@12345` |
| OSS | `testoss` | `Oss@12345` |

Local testing credentials only, consistent with the existing test accounts.

## Verification

Extends `serverside/src/config/verifyRoles.ts` (currently 103 checks). No test framework is
added; Subsystem A's spec forbids one and that holds.

Every cell of the route table above must return `2xx` or `403` as specified. Beyond that,
these cases must each be pinned, because each is a hole a plausible implementation leaves:

1. `POST /users { role: 'hr' }` as HR → `403`. Peer creation.
2. `POST /users { role: 'superadmin' }` as superadmin → `403`.
3. HR deactivating a Registrar → `403` (rank). HR deactivating a **student** → `403`
   (domain — see the ruling in cross-rule interaction 1). HR deactivating a **staff**
   account → `200`. Registrar deactivating a staff account → `403`; a student → `200`.
   These four together are what pin "domain wins"; any one of them alone passes against a
   rank-only implementation.
4. Registrar `PATCH /persons/:id` changing `type` from `student` to `staff` → `403`.
5. `bulk-status` as HR with a filter that *would* match a Registrar **and** every student →
   the Registrar row and a student row are both re-read afterward and confirmed unchanged.
   Asserting only the response count would pass against an implementation that filtered
   nothing, and checking only the Registrar would pass against a role-only predicate that
   still swept every student.
6. OSS `POST /persons` → `403`; OSS `GET /persons` → `200`. The read/write asymmetry.
7. OSS `POST /vehicles` → `201`; Registrar `POST /vehicles` → `403`.
8. `grant:superadmin` promotes an account, and that account then gets `403` creating a peer.
9. Self-deactivation → `403`, for each of the four staff-side roles.
10. `GET /logs` as a resolved row: `subject.full_name` is present and non-empty for a
    person scan, confirming the join actually joined.
11. `bulk-status/preview` and `bulk-status` agree: the preview count for a given filter
    equals the number of rows the apply path actually changes, checked with a filter that
    would match a peer. A preview that over-counts is the specific defect this pins.

Assertion discipline, carried from defects the earlier subsystems paid for:

- Every assertion must be able to fail. An implementation returning a blanket `403` must
  break the positive checks.
- Collection assertions need a length floor. `.every()` on an empty array is `true`; that
  produced two real defects in Subsystem A.
- Any comparison must confirm both values are present rather than matching `undefined` to
  `undefined`, which produced a third.
- The block restores whatever it changes, and `npm run verify:roles` must produce
  byte-identical output on two consecutive runs.

### Harness hazards to document

Two rate-limit hazards, both observed rather than theorised:

- Adding HR and OSS raises `verifyRoles`' login count above the current 6. The README's
  `LOGIN_RATE_LIMIT_MAX` guidance names that number and must be updated to the new one.
- Running all four `verify:*` scripts back-to-back trips `globalLimiter`
  (`RATE_LIMIT_MAX=200` per 60s), not the login limiter. `verifyPassback` then fails with
  `TypeError: Cannot read properties of undefined (reading 'find')` because it dereferences
  a body the `429` never sent. Raising `LOGIN_RATE_LIMIT_MAX` does not help. The harnesses
  must report a `429` as a `429`; a rate-limited run currently looks like a code defect.

## Deliberate reversals

Two rulings in `2026-07-26-role-system-design.md` are reversed. Both were correct under the
flat role model and are wrong under a ranked one. Recording them so neither is mistaken for
drift, and so nobody "restores" them:

1. **"A superadmin may deactivate another superadmin individually — only the *bulk* path
   protects privileged roles."** Reversed. Under strict rank, peer actions are denied on
   every path, single and bulk alike.
2. **"Vehicles stay superadmin-only."** Reversed. `/vehicles` opens to all four staff-side
   roles for reads and to OSS for writes, because vehicle registration is OSS's entire
   purpose.

That document remains authoritative for every route and rule it states that this one does
not contradict.

## Out of scope

- **The vehicle registration form** (car-pass sticker: applicant type, LTO CR/OR numbers
  and dates, plate, make, model, year, colour, registered owner, relationship, permanent
  address, mobile, applicant signature, RFID). Its own subsystem. This spec only grants OSS
  the authority to use it.
- **The gadget registry.** Already specced at `2026-07-27-gadget-registry-design.md` and
  unimplemented. `WRITE_DOMAINS.oss` includes `'gadget'` so no authority change is needed
  when it lands, but no gadget code is written here.
- **Monitor output v2** (richer person and vehicle tap screens). Depends on data the vehicle
  and gadget subsystems create.
- **Structured course / year / section.** `Person.department_section` stays a single string.
  Splitting it touches the directory, CSV import, and every seeded record, and it belongs
  with the monitor output work that needs it.
- **A raw database browser.** "See database" is answered by the Records page and the
  existing Directory; a generic collection viewer is a separate decision.
- **An audit trail view.** `actor_user_id` exists on `scan_logs` and `deactivated_by` on
  `User`, so the data is being captured, but no screen reads it here.
- Password policy, session management, and 2FA. Unchanged.

## Relationship to other subsystems

- **A — Role system.** Merged. This extends it and reverses two of its rulings.
- **B — Gadget registry.** Specced, unimplemented. This grants OSS the authority it will
  need, and its permission matrix (which names only registrar and superadmin) should be
  read as superseded by the table above.
- **C — Digital signature.** Merged. Independent.
- **Anti-passback.** Merged. The Records page reads the `ScanLog` rows it writes, including
  the `gate_id: null` override rows and the `actor_user_id` field it added.
- **Vehicle registration v2** and **Monitor output v2** both depend on this subsystem for
  their authority model.
