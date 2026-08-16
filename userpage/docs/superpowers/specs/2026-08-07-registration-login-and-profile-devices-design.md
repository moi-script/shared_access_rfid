# Registration creates a login; devices on the profile

Date: 2026-08-07

## Problem

Three gaps, discovered while tracing what password a newly registered student
receives. The answer is: none.

**Registering a person creates no login.** `persons.service.create`
(`persons.service.ts:101`) writes a Person and stops. Every `userRepo` call in
that file — lines 190, 315 — reads or updates an existing login; none creates
one. A student registered through the UI has an RFID card and a profile and
cannot sign in to anything. The login is a separate, manual step in the
Accounts tab, where the operator types a password into a field labelled
"Temporary password" (`AccountsView.tsx:218`). Nothing links the two screens,
so the second step is easy to never perform.

The seeded testers hide this. `2025-0001` / `Student@123` came from
`testSeed.ts`, which writes Person and User together with hardcoded passwords.
They are the only students who can log in.

**`must_change_password` is inert.** `users.service.create` sets it to `true`
on every account (`users.service.ts:55`), `resetPassword` sets it again
(`users.service.ts:77`), and the login response carries it through to
`AuthUser.mustChangePassword` (`lib/auth.ts:10`). Nothing reads it. There is no
`POST /auth/change-password`, no change-password screen, and no route guard —
grep finds `must_change_password` in exactly one frontend file, the type
declaration. A user cannot change their own password by any means; only an
admin reset can.

**Devices are invisible on the profile.** `dashboard.service.userView`
(`dashboard.service.ts:224`) fetches vehicles and returns them, but never
queries `GadgetModel`, so `PersonOverview` has a `vehicles` array and no
`gadgets` (`ProfileView.tsx:45`). Devices can be registered from the Register
tab, and then never appear anywhere a person is viewed — not on the admin's
per-person profile, and not on the student's own dashboard, which renders the
same component from the same endpoint.

## Decisions

| Question | Decision |
| --- | --- |
| Password at registration | Required in the form, optional in the API |
| Username | The person's `id_number` |
| Role | Derived from person type — student → student, staff/employee → staff |
| Atomicity | Pre-check, then create person → user, roll back person on failure |
| Bulk import | Unchanged; still creates person-only records |
| Change password | New `POST /auth/change-password` + a screen, enforced by a route guard |
| `must_change_password` | Stays `true` on created accounts, and now means something |
| Devices on profile | Section in `ProfileView`; register button in `PersonProfile` only |
| Who may register a device | `canRegisterGadgets` — superadmin and OSS, matching `WRITE_DOMAINS` |

The API keeps `password` optional even though the form requires it, because
`POST /persons/import` shares the same service path. Making it mandatory in the
schema would break bulk import, and the alternative — plaintext passwords in a
CSV column — is worse than leaving imported records login-less.

## Architecture

### Atomicity without transactions

The codebase uses no MongoDB sessions or transactions anywhere; `grep` for
`startSession|withTransaction|session:` across `src/` returns nothing.
Introducing them for one call site adds a pattern and a failure mode for a
problem that can be closed more cheaply.

The dominant failure is a taken username, and that is knowable in advance.
`persons.service.create` already pre-checks `findByIdNumber`, `findByRfid`, the
cross-entity vehicle RFID collision, and the blocked-card list before writing
anything (`persons.service.ts:105-121`). A `findByUsername` check joins that
group, so the realistic conflict fails with nothing written.

What remains is an infrastructure failure between the two inserts. In that
window the Person is milliseconds old and nothing references it — no scans, no
attendance, no vehicles, no gadgets — so deleting it and rethrowing is safe and
leaves no orphan. This is a hard delete, not `softDelete`: a record that never
became visible should not occupy its `id_number` and `rfid_uid` uniqueness
slots, which would block the operator's immediate retry.

```
assertCanWrite(person domain)                 // existing
assertCanCreateRole(actor, derived role)      // existing, only when password given
check id_number / rfid_uid / blocked card     // existing
check username availability                   // NEW, before any write
create Person
  create User  ──── on failure ──→ delete Person, rethrow
return { person, login_created }
```

### Server: registration

`persons.schema.ts` — `password: z.string().min(8).optional()`, matching the
bound in `users.schema.ts:6`.

`persons.service.create` — when `password` is present:

- Derive the role from `data.type`: `student` → `ROLES.STUDENT`, `staff` and
  `employee` → `ROLES.STAFF`.
- Call `assertCanCreateRole(actor, role)` before writing. No new authority is
  introduced: a registrar creating a student login already satisfies both the
  rank rule (2 > 1) and the domain rule (`person:student`), which is what the
  Accounts screen relies on today.
- Create the user with `must_change_password: true` and `is_active: true`.

No guard is needed for a missing `id_number`: `personCreateSchema` already
requires it (`persons.schema.ts:6`). Using it as the username is not a new
convention either — `persons.schema.ts:21` already documents that `id_number`
"is also the linked User's login username", which is why the edit schema omits
it from the updatable fields.

The response gains `login_created: boolean` so the client can report what
happened rather than assuming.

### Server: change password

`POST /auth/change-password`, authenticated, body
`{ currentPassword, newPassword }`, both `min(8)`.

- Verify `currentPassword` against the stored hash; a wrong one is
  `INVALID_CREDENTIALS`, the same code login returns, so the endpoint does not
  become a password oracle that distinguishes "wrong password" from "no such
  user".
- Reject `newPassword === currentPassword` with `VALIDATION_ERROR`. Otherwise a
  forced change can be satisfied by re-entering the password the admin chose,
  which defeats the flag.
- Write the new hash, set `must_change_password: false`, and null
  `refreshTokenHash` — the same invalidation `resetPassword` performs
  (`users.service.ts:78`), so a session opened with the old credential cannot
  be refreshed.
- Mount behind `loginLimiter`, not the global limiter. It accepts a password
  guess, so it belongs with the other credential-guessing surface.

### Client: change-password gate

A new `/change-password` route with current/new/confirm fields.

`redirectForRole` (`lib/auth.ts:269`) currently decides the post-login
destination from role alone. It gains a `mustChangePassword` check that sends
the user to `/change-password` first, regardless of role. The admin and
dashboard pages already read `getStoredUser()` on mount and redirect when the
user is wrong for the page; they gain the same guard, so navigating directly to
`/admin` with the flag set bounces to the change screen rather than skipping it.

On success the stored user is rewritten with `mustChangePassword: false` and
the user continues to their normal landing page. Because the refresh token was
invalidated server-side, the client keeps using its existing access token until
expiry and then re-authenticates normally.

### Server: devices on the overview

`dashboard.service.userView` gains a `GadgetModel.find({ owner_person_id })`
in its existing `Promise.all`, sorted `createdAt: -1`, projected to
`gadget_type`, `brand_model`, `serial_number`, `status`.

Inactive rows are included rather than filtered. A deactivated gadget is
retained deliberately so its history survives (`gadgets.model.ts:18-22`), and
the profile is the screen where "this laptop was replaced" is the answer
someone is looking for. The status badge distinguishes them, exactly as the
vehicles list already does.

This is a read, and reads are deliberately not domain-restricted
(`roles.ts`, `WRITE_DOMAINS` comment), so every staff-side role that can open a
profile sees devices. No authorization change.

### Client: devices section and register button

`ProfileView` gains a `gadgets` field on `PersonOverview` and a "Registered
devices" section beside "Registered vehicles", following that section's markup:
serial in mono, status badge, type and model beneath.

The **Register device** button goes in `PersonProfile`, next to "Print form" —
not in `ProfileView`. `ProfileView` is shared with the student's own dashboard
(`dashboard.service.dashboard` routes a personId to `userView`), so a button
placed there would offer every student a device-registration form the server
would reject. In `PersonProfile` it is gated on `canRegisterGadgets(role)`,
which mirrors `WRITE_DOMAINS`: superadmin and OSS.

The button opens the existing `GadgetForm` with the person pre-selected. On
success the overview is refetched so the new device appears without a reload.

## Testing

Extend the existing black-box harnesses rather than adding a framework; there
is none, and `verify:*` is the established pattern.

`verify:roles` — a registrar registering a student with a password produces a
working login; the created account carries `must_change_password: true`; a
registrar cannot register a staff person with a password (domain); a duplicate
`id_number` leaves no user behind.

`verify:gadgets` — `/persons/:id/overview` returns registered devices, includes
an inactive one, and a student's own `/dashboard` shows their devices.

A new `verify:password` — change password with the correct current password
succeeds and clears the flag; a wrong current password returns
`INVALID_CREDENTIALS`; reusing the current password is rejected; the old
refresh token stops working afterward.

Manual: register a student end to end, sign in as them with the typed password,
confirm the change-password screen appears and cannot be navigated past.

## Out of scope

**Bulk import** keeps creating person-only records. Passwords in a CSV column
is a worse problem than the one being solved.

**Existing person records with no login** — every person registered before this
change, plus every imported row. Creating their logins remains the Accounts
tab. A "create login" button on the profile is the natural follow-up and is
deliberately not bundled here.

**Password reset by the user** (forgot-password over email). There is no mail
transport in this system; admin reset stays the recovery path.
