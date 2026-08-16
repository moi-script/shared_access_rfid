# Role System — Design

**Date:** 2026-07-26
**Status:** Approved, ready for planning
**Scope:** Subsystem A of four. See "Relationship to later subsystems" at the end.

## Problem

The system has two login roles, `admin` and `user`. The client needs four distinct
capabilities:

- A **registrar** who registers people and nothing else.
- A **superadmin** who can activate and deactivate accounts, including in bulk.
- **Staff** and **students**, who see only their own profile.

Today `User.role` (`admin | user`) and `Person.type` (`student | staff | employee`) are
separate concepts that the client's description conflates. This design settles the
relationship: `User.role` governs permissions, `Person.type` stays a profile attribute.

A second problem is structural. `authorize(ROLES.ADMIN)` guards seven route files.
Renaming `admin` to `superadmin` without touching those guards would lock the registrar
out of every endpoint they need. Every guard is rewritten with an explicit role list.

## Decisions

| Question | Decision |
|---|---|
| Role set | `superadmin`, `registrar`, `staff`, `student`. `admin` becomes `superadmin`; `user` splits into `staff` and `student`. |
| Registrar scope | Create persons and logins, browse the directory, edit records, bulk CSV import, reassign RFID. No deactivation, deletion, password resets, logs, or reports. |
| What "deactivate" turns off | Both login and gate access, from one toggle. |
| Deactivate All scope | Acts on the current filter, requires typing `DEACTIVATE`, never touches superadmin or registrar accounts or the acting user. |
| Login page | No role picker. Username and password only; the server returns the role and the client routes on it. |
| Console routing | One `/admin` shell with role-filtered nav, split into per-view components. |
| Migration | None. Wipe and reseed. |

## Data model

### `constants/roles.ts`

```ts
export const ROLES = {
  SUPERADMIN: 'superadmin',
  REGISTRAR:  'registrar',
  STAFF:      'staff',
  STUDENT:    'student',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Roles with access to the staff-side console at /admin. */
export const STAFF_SIDE = [ROLES.SUPERADMIN, ROLES.REGISTRAR] as const;

/** Roles that may never be deactivated by a bulk action. */
export const BULK_PROTECTED = [ROLES.SUPERADMIN, ROLES.REGISTRAR] as const;
```

### `users.model.ts`

The `role` enum changes to the four values above. Two audit fields are added:

```ts
deactivated_at: Date | null;   // default null
deactivated_by: Types.ObjectId | null;  // ref 'User', default null
```

Both are set when an account is deactivated and cleared when it is reactivated. They
record who performed a bulk action, which matters because a single request can affect
hundreds of rows.

No other model changes. `Person`, `Vehicle`, `Gate`, `ScanLog`, and `AttendanceSummary`
are untouched.

## Permission matrix

This table is the specification. `lib/permissions.ts` on the client and the route guards
on the server must both match it, and `verifyRoles.ts` asserts every cell.

| Route | superadmin | registrar | staff | student |
|---|:--:|:--:|:--:|:--:|
| `GET /persons` | yes | yes | no | no |
| `GET /persons/sections` | yes | yes | no | no |
| `GET /persons/export` | yes | yes | no | no |
| `GET /persons/:id` | yes | yes | no | no |
| `GET /persons/:id/overview` | yes | yes | no | no |
| `POST /persons` | yes | yes | no | no |
| `POST /persons/import` | yes | yes | no | no |
| `PATCH /persons/:id` | yes | yes | no | no |
| `PATCH /persons/:id/rfid` | yes | yes | no | no |
| `PATCH /persons/:id/status` | yes | no | no | no |
| `GET /users` | yes | yes | no | no |
| `POST /users` | yes | yes | no | no |
| `PATCH /users/:id/status` (new) | yes | no | no | no |
| `GET /users/bulk-status/preview` (new) | yes | no | no | no |
| `POST /users/bulk-status` (new) | yes | no | no | no |
| `PATCH /users/:id/password` | yes | no | no | no |
| `DELETE /users/:id` | yes | no | no | no |
| `GET|POST|PATCH /vehicles/*` | yes | no | no | no |
| `GET /logs` | yes | no | no | no |
| `GET /reports/*` | yes | no | no | no |
| `GET /scan/logs` | yes | no | no | no |
| `GET /attendance/summary/:person_id` | yes | no | no | no |
| `GET /attendance` | yes | no | yes | yes |
| `GET /gates` | yes | yes | yes | yes |
| `GET /dashboard` | yes | yes | yes | yes |

`GET /dashboard` is role-aware in the service, not the guard: superadmin gets the full
admin summary, registrar gets a registration-focused summary (counts and recent
registrations, no scan or gate data), staff and students get their own profile overview.

`GET /gates` remains available to all authenticated roles, as it is today.

`GET /attendance` is guarded to superadmin, staff, and student. Registrars are excluded
deliberately: they register people and have no attendance duties. The exclusion is
declared on the route rather than left to emerge from the service layer — a registrar has
no linked person record, so the service's own-record branch would deny them anyway, but
as an accident of missing data rather than as a stated policy. An explicit guard says what
is intended and fails the same way every time.

### Vehicles stay superadmin-only

Vehicle registration is deliberately not granted to the registrar in this subsystem.
Vehicle and gadget registration are reworked in subsystems B and D, and the registrar's
role in them is decided there rather than guessed now.

### `POST /scan/tap` is unchanged

`scanRoutes` applies `authenticate` but no `authorize` to `POST /tap`, so any
authenticated user — including a student — can post a scan for an arbitrary RFID UID.
This is a genuine authorization hole.

It is **out of scope and left unchanged**, because the ESP/Raspberry Pi gate readers
authenticate against this endpoint by an unknown mechanism, and tightening it blind would
break the hardware integration. Closing it needs an answer to: what credential do the
gate readers present? The likely fix is a dedicated `device` role with per-gate
credentials. Tracked as an open item, not silently altered here.

## API additions

### `PATCH /api/users/:id/status`

Request `{ "active": boolean }`. Superadmin only.

Applies both effects atomically:

- `User.is_active = active`
- If `User.person_id` is set, `Person.status = active ? 'active' : 'inactive'`
- Deactivating stamps `deactivated_at = now` and `deactivated_by = req.user.userId`;
  activating sets both to `null`

Rejects with `FORBIDDEN` if the target is the acting user. A superadmin may deactivate
another superadmin individually — only the *bulk* path protects privileged roles — but
never themselves, so the system cannot be locked out in one click.

Response: the updated user with its linked person summary.

### `GET /api/users/bulk-status/preview`

Query `{ type?, department_section?, search? }`. Superadmin only.

Returns `{ matched: number, excluded: number }` using exactly the same filter resolution
as the bulk mutation. The confirmation modal shows this number, so the count the user
confirms is the count that changes.

### `POST /api/users/bulk-status`

Request `{ "active": boolean, "filter": { type?, department_section?, search? } }`.
Superadmin only.

Resolves the filter against users joined to their persons, then **excludes server-side**:

- any user whose `role` is in `BULK_PROTECTED`
- the acting user

The exclusions are enforced in the service, not only in the UI, so a crafted request
cannot bypass them.

Applies the same dual effect as the single-user endpoint to every remaining match, and
returns `{ matched, modified, excluded }`.

An empty filter is permitted and means "every student and staff account," which is a
legitimate end-of-semester action. The confirmation modal makes the count explicit.

## Frontend

### New and changed files

```
lib/permissions.ts               NAV_BY_ROLE and can(role, action); mirrors the matrix
lib/auth.ts                      AuthUser.role -> 4-role union; add redirectForRole()
components/admin/
  AdminShell.tsx                 header, role-filtered nav, auth guard
  OverviewView.tsx               lifted from app/admin/page.tsx
  ParkingView.tsx                lifted from app/admin/page.tsx
  RegisterView.tsx               wraps existing PersonForm + ImportPersons
  AccountsView.tsx               per-row toggle + Deactivate All (superadmin only)
app/admin/page.tsx               reduced to guard + shell + view switch
components/LoginExperience.tsx   role toggle and sub-toggle removed
```

`app/admin/page.tsx` is 427 lines and holds the overview and parking markup inline.
Adding two more views would push it past 700. The views are extracted so each file stays
within a readable range; this is refactoring in service of the feature, not unrelated
cleanup.

`StudentsDirectory.tsx` and `PersonProfile.tsx` are reused as the Directory view without
modification.

### Navigation by role

| Role | Tabs | Landing route |
|---|---|---|
| superadmin | Overview, Directory, Parking, Register, Accounts | `/admin` |
| registrar | Register, Directory | `/admin` |
| staff | — | `/dashboard` |
| student | — | `/dashboard` |

`AdminShell` redirects any role outside `STAFF_SIDE` to `/dashboard`, and `/dashboard`
redirects `STAFF_SIDE` roles to `/admin`. Client-side gating is a usability measure; the
server matrix is the enforcement boundary.

### Login

The `User ⇄ Admin` toggle and the `Student / Staff` sub-toggle are removed. The form
submits `{ username, password, remember }`. On success the client reads `user.role` from
the response and calls `redirectForRole(role)`.

This removes the possibility of a user picking the wrong tab and receiving a confusing
error, and stops the form from revealing which usernames are privileged.

### Accounts view

A table of users joined to their person records: name, username, role, type, department,
RFID, and status. Filters mirror the Directory view (type, department, search) so the
bulk action's scope is visually obvious.

Each row has an Active/Inactive toggle. Above the table, when a superadmin is viewing,
sits `Deactivate All (N shown)`, where N comes from the preview endpoint.

The confirmation modal states the filter in words, states the count, warns that affected
people can neither log in nor pass any gate, notes that superadmin and registrar accounts
are excluded, and requires typing `DEACTIVATE` before the confirm button enables.

An `Activate All` action uses the same flow with `active: true` and no typed
confirmation, since it is not destructive.

## Seed

No migration. Existing data is wiped and reseeded.

- `seed.ts` creates the superadmin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` with
  `role: 'superadmin'`. Gate seeding is unchanged.
- `testSeed.ts` adds `testregistrar` / `Registrar@123` with `role: 'registrar'`, and the
  three existing test students are created with `role: 'student'`.
- `serverside/README.md` test-account table and the "Data model" section are updated to
  describe four roles.

## Verification

Neither project has a test framework, and this design does not add one. The existing
`src/config/verifyTest.ts` establishes a script-based verification convention, which this
follows.

`src/config/verifyRoles.ts`, run as `npm run verify:roles`, logs in as each of the four
seeded roles and asserts:

1. **Every cell of the permission matrix** returns `200`/`2xx` where the matrix says yes
   and `403` where it says no. A row that returns `401` fails, since that indicates a
   broken token rather than a correct denial.
2. `PATCH /users/:id/status { active: false }` sets both `User.is_active` to `false` and
   the linked `Person.status` to `'inactive'`.
3. Reactivating restores both and clears `deactivated_at` and `deactivated_by`.
4. A gate scan for a deactivated person's RFID returns `access_result: 'denied'` with
   `reason: 'inactive_id'`.
5. `POST /users/bulk-status` excludes superadmin and registrar accounts even when the
   filter would otherwise match them.
6. `POST /users/bulk-status` excludes the acting user.
7. `PATCH /users/:id/status` on the acting user's own id returns `403`.
8. `GET /users/bulk-status/preview` returns the same `matched` count that a subsequent
   `POST /users/bulk-status` reports.

The script exits non-zero on the first failed assertion and prints the expected and
actual status for that cell.

Frontend verification is manual: log in as each of the four seeded accounts and confirm
the landing route and visible tabs match the navigation table.

## Out of scope

- Gadget and laptop registration (subsystem B)
- Digital signature capture and terms acceptance (subsystem C)
- Renewal applications (subsystem D)
- Closing the `POST /scan/tap` authorization hole (needs the gate hardware's auth
  mechanism; see above)
- Any change to the `Person`, `Vehicle`, `Gate`, `ScanLog`, or `AttendanceSummary` models
- Adding a test framework

## Relationship to later subsystems

The build order is forced by dependency: A, then B, then C, then D.

- **B — Gadget registry.** A new model for laptops and gadgets (name, date, course,
  gadget, serial) with an RFID tag, plus registration UI. Depends on A because its route
  guards need the role set defined here, and because the registrar's authority over
  gadgets is decided against this matrix.
- **C — Digital signature.** Signature capture on the user profile and terms-and-
  conditions acceptance. Depends on A for who may view and verify a stored signature.
- **D — Renewal applications.** A student applies to renew a vehicle or gadget
  registration and signs on submission; a reviewer approves. Depends on B for the
  gadget entity, on C for the signature, and on A for the reviewer role.

Each gets its own design document and implementation plan.
