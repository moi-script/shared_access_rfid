# Registration Logins, Change Password, and Profile Devices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registering a person creates their login in the same request, users can change their own password, and registered devices appear on the person profile.

**Architecture:** Three server changes and three client changes, split so each half is independently testable. The server extends `POST /persons` to optionally create the linked `User`, adds `POST /auth/change-password`, and adds `gadgets` to the person-overview payload. The client adds a required password field to the registration form, a change-password screen with a route guard, and a devices section with a register button. Person/login creation avoids MongoDB transactions — which this codebase uses nowhere — by pre-checking username availability and deleting the just-created person if the user insert fails.

**Tech Stack:** TypeScript, Express 4, Mongoose 8, Zod 3, bcrypt (backend); Next.js 16 App Router, React 19, Tailwind 4 (frontend).

## Global Constraints

- **Two separate git repositories.** Backend is `C:\thesis_rfid\serverside` (`moi-script/rdif_serverside`, **public**). Frontend is `C:\thesis_rfid\userpage` (`moi-script/ncst_rfid_access`, private). Commit in the repo you changed; never commit secrets to the backend repo.
- **No test framework exists.** Testing is black-box `verify:*` harnesses in `serverside/src/config/`, run against a live server. "Write the failing test" means adding checks to a harness. Do not introduce Jest/Vitest.
- **Harnesses need a running server and seeded data:** `npm run dev` in `serverside`, and `npm run seed:test` already applied.
- **Password minimum is 8 characters**, matching `users.schema.ts:6` (`z.string().min(8)`). Use exactly `.min(8)` everywhere.
- **Error codes come from `src/constants/errors.ts`.** Do not invent codes. Use `DUPLICATE_USERNAME`, `INVALID_CREDENTIALS`, `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`.
- **`ApiError` signature:** `new ApiError('CODE', 'optional message')`.
- **`sendSuccess` signature:** `sendSuccess(res, data, status?)` — status defaults to 200; use `201` for creates.
- **Next.js 16 has breaking changes from earlier versions.** Read the relevant guide in `userpage/node_modules/next/dist/docs/` before writing frontend code. Notably `next build` no longer runs ESLint, and the `eslint` key in `next.config.ts` is rejected.
- **Frontend API calls go through `lib/auth.ts` helpers** (`apiGet`, `apiPost`, `apiPatch`, `apiUpload`). Do not call `fetch` directly with a hand-rolled `Authorization` header.
- **Spec:** `userpage/docs/superpowers/specs/2026-08-07-registration-login-and-profile-devices-design.md`

---

### Task 1: Server — create the login alongside the person

**Files:**
- Modify: `serverside/src/modules/persons/persons.schema.ts:3-15` (add `password`), `:33` (omit it from import)
- Modify: `serverside/src/modules/persons/persons.service.ts:101-126` (`create`)
- Create: `serverside/src/config/verifyRegistration.ts`
- Modify: `serverside/package.json` (add `verify:registration` script)

**Interfaces:**
- Consumes: `assertCanCreateRole(actor: Actor, role: Role): void` and `assertCanWrite(actor: Actor, domain: Domain): void` from `src/utils/authority.ts`; `userRepo.findByUsername(username: string)` and `userRepo.create(data: Partial<IUser>)` from `src/modules/users/users.repository.ts`; `personRepo.create(data: Partial<IPerson>)` from `src/modules/persons/persons.repository.ts`; `ROLES` and `personDomain(type)` from `src/constants/roles.ts`.
- Produces: `POST /api/persons` accepts an optional `password: string` (min 8) and returns the created person document plus `login_created: boolean`. Task 4 consumes that response field.

- [ ] **Step 1: Write the failing test**

Create `serverside/src/config/verifyRegistration.ts`:

```ts
/**
 * Asserts registration-created logins from
 * docs/superpowers/specs/2026-08-07-registration-login-and-profile-devices-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:registration
 *
 * Restores everything it changes: every person it creates is soft-deleted in a
 * `finally`, so re-running the harness is safe.
 */
import { installVerifyBypass } from './verifyBypass';

installVerifyBypass();

const failures: string[] = [];
let checks = 0;

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    console.log(`  FAIL ${name} — ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    return;
  }
  console.log(`  ok   ${name}`);
}

function summary(): void {
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All registration checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;
const CONFLICT = 409;
const VALIDATION = 422;

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (!token) throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  return token;
}

async function request(
  token: string | null,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Unique per run so repeated runs never collide on id_number. */
const STAMP = Date.now().toString().slice(-8);
const STUDENT_ID = `T${STAMP}`;
const STAFF_ID = `S${STAMP}`;
const PASSWORD = 'RegTest@123';

async function main(): Promise<void> {
  const admin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const created: string[] = [];

  try {
    // --- a registrar registering a student with a password gets a login ---
    const reg = await request(registrar, 'POST', '/persons', {
      full_name: 'Reg Test Student',
      type: 'student',
      id_number: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('register student with password -> 201', reg.status, CREATED);
    const person = reg.json.data as { _id?: string; login_created?: boolean } | undefined;
    expectEqual('response reports login_created', person?.login_created, true);
    if (person?._id) created.push(person._id);

    // --- that login actually works, and carries the forced-change flag ---
    const auth = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('new student can sign in', auth.status, OK);
    const authed = auth.json.data as
      | { user?: { role?: string; mustChangePassword?: boolean } }
      | undefined;
    expectEqual('new login has the student role', authed?.user?.role, 'student');
    expectEqual('new login must change password', authed?.user?.mustChangePassword, true);

    // --- a password shorter than the minimum is rejected outright ---
    const short = await request(registrar, 'POST', '/persons', {
      full_name: 'Too Short',
      type: 'student',
      id_number: `${STUDENT_ID}X`,
      password: 'short',
    });
    expectEqual('password under 8 chars -> 422', short.status, VALIDATION);

    // --- a duplicate id_number is refused by the existing check ---
    const dupId = await request(registrar, 'POST', '/persons', {
      full_name: 'Duplicate Id',
      type: 'student',
      id_number: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('duplicate id_number -> 409', dupId.status, CONFLICT);

    // --- and a username taken by a login with NO matching person is refused
    // too. This is the case the new pre-check exists for: 'testhr' is a seeded
    // office login with no Person row, so the id_number check above cannot see
    // it. Without the username pre-check this would create the person and then
    // fail on the user insert, exercising the rollback path instead of failing
    // clean.
    const dupUser = await request(admin, 'POST', '/persons', {
      full_name: 'Username Collision',
      type: 'student',
      id_number: 'testhr',
      password: PASSWORD,
    });
    expectEqual('username taken by an office login -> 409', dupUser.status, CONFLICT);
    expectEqual('and reports DUPLICATE_USERNAME', dupUser.json.code, 'DUPLICATE_USERNAME');

    // --- that refusal left no person behind either ---
    const collisionHunt = await request(admin, 'GET', '/persons?search=testhr');
    const collisionRows = (collisionHunt.json.data ?? []) as unknown[];
    expectEqual('username collision left no person behind', collisionRows.length, 0);

    // --- domain rule still holds: a registrar cannot create a staff login ---
    const crossDomain = await request(registrar, 'POST', '/persons', {
      full_name: 'Reg Test Staff',
      type: 'staff',
      id_number: STAFF_ID,
      password: PASSWORD,
    });
    expectEqual('registrar registering staff -> 403', crossDomain.status, FORBIDDEN);

    // --- and the refused staff person was never created ---
    const orphanHunt = await request(admin, 'GET', `/persons?search=${STAFF_ID}`);
    const rows = (orphanHunt.json.data ?? []) as unknown[];
    expectEqual('refused registration left no person behind', rows.length, 0);

    // --- omitting the password still creates a person-only record ---
    const noPass = await request(admin, 'POST', '/persons', {
      full_name: 'No Login Person',
      type: 'student',
      id_number: `${STUDENT_ID}N`,
    });
    expectEqual('person without password -> 201', noPass.status, CREATED);
    const bare = noPass.json.data as { _id?: string; login_created?: boolean } | undefined;
    expectEqual('no login reported', bare?.login_created, false);
    if (bare?._id) created.push(bare._id);
  } finally {
    for (const id of created) {
      await request(admin, 'DELETE', `/persons/${id}`).catch(() => undefined);
    }
  }

  summary();
}

main().catch((err) => {
  console.error('[verify:registration] harness error', err);
  process.exit(1);
});
```

Add the script to `serverside/package.json`, after `"verify:gadgets"`:

```json
"verify:registration": "ts-node src/config/verifyRegistration.ts",
```

- [ ] **Step 2: Run test to verify it fails**

With `npm run dev` running in another terminal:

Run: `cd serverside && npm run verify:registration`
Expected: FAIL. `register student with password -> 201` passes (Zod strips the unknown `password` key), but `response reports login_created` fails with `got undefined, expected true`, and `new student can sign in` fails with `got 401, expected 200`.

- [ ] **Step 3: Add `password` to the schema**

In `serverside/src/modules/persons/persons.schema.ts`, add the field to `createPersonSchema` after `status`:

```ts
  status: z.enum(['active', 'inactive', 'pending']).optional(),
  // Optional here, required by the registration form. Bulk import shares this
  // schema and has no password column, so a mandatory field would break it —
  // and the alternative, plaintext passwords in a CSV, is worse than leaving
  // imported rows login-less. See importPersonsSchema below.
  password: z.string().min(8).optional(),
});
```

Then keep bulk import password-free by omitting it explicitly:

```ts
export const importPersonsSchema = z.object({
  rows: z.array(createPersonSchema.omit({ password: true })).min(1).max(500),
```

- [ ] **Step 4: Create the login in `persons.service.create`**

In `serverside/src/modules/persons/persons.service.ts`, add these imports at the top if absent:

```ts
import bcrypt from 'bcrypt';
import { ROLES, type Role } from '../../constants/roles';
import { assertCanCreateRole } from '../../utils/authority';
```

Add above `create`:

```ts
const BCRYPT_ROUNDS = 12;

/**
 * A person's type decides what kind of login they get. Employees share the
 * staff role because RANK treats them identically and there is no separate
 * employee role in ROLES.
 */
function roleForPersonType(type: 'student' | 'staff' | 'employee'): Role {
  return type === 'student' ? ROLES.STUDENT : ROLES.STAFF;
}
```

Replace the body of `create` (`persons.service.ts:101-126`). The existing checks are unchanged; the additions are the `assertCanCreateRole` call, the username pre-check, and the create-with-rollback at the end:

```ts
  async create(data: Partial<IPerson> & { password?: string }, actor: Actor) {
    if (!data.type) throw new ApiError('VALIDATION_ERROR', 'type is required');
    assertCanWrite(actor, personDomain(data.type));

    const { password, ...personData } = data;
    const role = roleForPersonType(data.type);
    // Rank check BEFORE any write. Domain authority (above) does not imply the
    // authority to mint a login at that level.
    if (password) assertCanCreateRole(actor, role);

    if (personData.id_number) {
      const dup = await personRepo.findByIdNumber(personData.id_number);
      if (dup) throw new ApiError('DUPLICATE_ID');
    }
    if (personData.rfid_uid) {
      const existing = await personRepo.findByRfid(personData.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
      // The reverse of the check in vehicleService.create: a UID belongs to a
      // person OR a vehicle, never both.
      const vehicleWithRfid = await vehicleRepo.findByRfid(personData.rfid_uid);
      if (vehicleWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
      }
      // A block enforced only at the barrier would be no block at all: a
      // retired UID could be re-registered here and would then resolve
      // normally at the gate. See scan.service.tap for the other half.
      if (await blockedCardRepo.isBlocked(personData.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    } else {
      personData.status = personData.status ?? 'pending';
    }

    // Username availability joins the pre-checks above rather than waiting for
    // the insert, so the realistic conflict fails with nothing written. This
    // codebase uses no transactions (grep startSession/withTransaction: none),
    // so the pre-check IS the atomicity strategy.
    if (password) {
      const takenBy = await userRepo.findByUsername(String(personData.id_number));
      if (takenBy) throw new ApiError('DUPLICATE_USERNAME');
    }

    const person = await personRepo.create(personData);
    if (!password) return { ...person.toObject(), login_created: false };

    try {
      await userRepo.create({
        username: String(personData.id_number),
        password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role,
        person_id: person._id,
        must_change_password: true,
        is_active: true,
      });
    } catch (err) {
      // Only an infrastructure failure reaches here — the username conflict was
      // already ruled out. The person is milliseconds old with nothing
      // referencing it, so a HARD delete is correct: softDelete would leave the
      // id_number and rfid_uid uniqueness slots occupied and block the
      // operator's immediate retry.
      await PersonModel.deleteOne({ _id: person._id });
      throw err;
    }

    return { ...person.toObject(), login_created: true };
  },
```

Add `import { userRepo } from '../users/users.repository';` if it is not already imported (it is, at `persons.service.ts:8`), and make sure `PersonModel` is imported from `./persons.model`.

- [ ] **Step 5: Run test to verify it passes**

Restart `npm run dev` (ts-node-dev reloads automatically), then:

Run: `cd serverside && npm run verify:registration`
Expected: PASS — `12/12 checks passed`, `All registration checks passed.`

- [ ] **Step 6: Confirm nothing else regressed**

Run: `cd serverside && npm run verify:roles && npm run verify:gadgets`
Expected: both suites pass. `verify:roles` exercises the same `assertCanWrite` path this task touched.

- [ ] **Step 7: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/modules/persons/persons.schema.ts src/modules/persons/persons.service.ts src/config/verifyRegistration.ts package.json
git commit -m "feat: create the linked login when a person is registered

A person registered through the UI had no login and could not sign in;
creating one was a separate, easy-to-forget step in the Accounts tab.

POST /persons now accepts an optional password and creates the User in the
same request, with the role derived from person type and the username taken
from id_number (already documented as the login username in persons.schema.ts).

Atomicity without transactions, which this codebase uses nowhere: username
availability is pre-checked alongside the existing id_number/rfid_uid checks,
so the realistic conflict writes nothing. An infrastructure failure between the
two inserts hard-deletes the just-created person, which frees its uniqueness
slots for an immediate retry.

Bulk import keeps its own schema without the field."
```

---

### Task 2: Server — change-password endpoint

**Files:**
- Modify: `serverside/src/modules/auth/auth.schema.ts` (add `changePasswordSchema`)
- Modify: `serverside/src/modules/auth/auth.service.ts` (add `changePassword`)
- Modify: `serverside/src/modules/auth/auth.controller.ts` (add `changePasswordController`)
- Modify: `serverside/src/modules/auth/auth.routes.ts:11` (mount the route)
- Modify: `serverside/src/config/verifyRegistration.ts` (add checks)

**Interfaces:**
- Consumes: `authenticate` middleware, which sets `req.user = { userId, role, personId }` (`middlewares/authenticate.ts:15`); `loginLimiter` from `middlewares/rateLimiter.ts`; `validate(schema)` from `middlewares/validate.ts`.
- Produces: `POST /api/auth/change-password` with body `{ currentPassword: string, newPassword: string }`, returning `{ success: true, data: { message: 'Password changed' } }`. Task 5 consumes this.

> **Deviation from the spec, on purpose.** The spec called for a separate
> `verify:password` harness. These checks live in `verifyRegistration.ts`
> instead because they need a login whose password is known and disposable, and
> Task 1 already creates exactly that. A separate harness would have to
> duplicate the fixture, and changing a seeded account's password would leave
> the shared demo data broken for everyone else.

- [ ] **Step 1: Write the failing test**

In `serverside/src/config/verifyRegistration.ts`, add these constants near `PASSWORD`:

```ts
const NEW_PASSWORD = 'RegTest@456';
```

Then insert this block inside `main()`, immediately before the `finally`:

```ts
    // --- change password: wrong current password is refused ---
    const studentToken = await login(STUDENT_ID, PASSWORD);
    const wrongCurrent = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: 'NotMyPassword@1',
      newPassword: NEW_PASSWORD,
    });
    expectEqual('change with wrong current password -> 401', wrongCurrent.status, 401);

    // --- reusing the current password defeats the forced change ---
    const sameAgain = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expectEqual('reusing the current password -> 422', sameAgain.status, VALIDATION);

    // --- the happy path ---
    const changed = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectEqual('change password -> 200', changed.status, OK);

    // --- the old password no longer works ---
    const oldPass = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('old password rejected after change', oldPass.status, 401);

    // --- the new one does, and the forced-change flag is cleared ---
    const newPass = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: NEW_PASSWORD,
    });
    expectEqual('new password accepted', newPass.status, OK);
    const after = newPass.json.data as
      | { user?: { mustChangePassword?: boolean } }
      | undefined;
    expectEqual('must_change_password cleared', after?.user?.mustChangePassword, false);

    // --- an anonymous caller cannot reach the endpoint at all ---
    const anon = await request(null, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectEqual('unauthenticated change -> 401', anon.status, 401);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd serverside && npm run verify:registration`
Expected: FAIL. `change with wrong current password -> 401` reports `got 404, expected 401` — the route does not exist yet.

- [ ] **Step 3: Add the schema**

In `serverside/src/modules/auth/auth.schema.ts`:

```ts
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  // The floor matches users.schema.ts. currentPassword deliberately has no
  // minimum: it is compared against a stored hash, and rejecting a short one
  // early would tell an attacker something about the existing password.
  newPassword: z.string().min(8),
});
```

- [ ] **Step 4: Add the service function**

In `serverside/src/modules/auth/auth.service.ts`, append:

```ts
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await UserModel.findOne({ _id: userId, is_active: true });
  // Same code as a failed login, deliberately: a distinct "no such user" here
  // would turn an authenticated endpoint into a probe for valid user ids.
  if (!user) throw new ApiError('INVALID_CREDENTIALS');

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) throw new ApiError('INVALID_CREDENTIALS');

  // Without this, a forced change is satisfiable by re-entering the password
  // the admin chose, which is exactly what must_change_password exists to stop.
  const unchanged = await bcrypt.compare(newPassword, user.password_hash);
  if (unchanged) {
    throw new ApiError('VALIDATION_ERROR', 'New password must differ from the current one');
  }

  user.password_hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.must_change_password = false;
  // Same invalidation resetPassword performs: a session opened with the old
  // credential must not be able to refresh itself past the change.
  user.refreshTokenHash = null;
  await user.save();
}
```

- [ ] **Step 5: Add the controller**

In `serverside/src/modules/auth/auth.controller.ts`, append:

```ts
export const changePasswordController = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Authentication required');
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user.userId, currentPassword, newPassword);
  // The refresh cookie is now dead server-side; clear it so the browser stops
  // sending a token that can only fail.
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  sendSuccess(res, { message: 'Password changed' });
});
```

- [ ] **Step 6: Mount the route**

In `serverside/src/modules/auth/auth.routes.ts`, add the import and the route:

```ts
import { changePasswordSchema, loginSchema } from './auth.schema';
import {
  loginController,
  refreshController,
  logoutController,
  changePasswordController,
} from './auth.controller';

// loginLimiter, not the global limiter: this endpoint accepts a password guess,
// so it belongs with the other credential-guessing surface.
authRoutes.post(
  '/change-password',
  loginLimiter,
  authenticate,
  validate(changePasswordSchema),
  changePasswordController
);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd serverside && npm run verify:registration`
Expected: PASS — `19/19 checks passed`.

- [ ] **Step 8: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/modules/auth/ src/config/verifyRegistration.ts
git commit -m "feat: let a user change their own password

must_change_password was set by users.service.create and resetPassword, read
by nothing, and there was no way for a user to change their own password at
all — only an admin reset. The flag was inert.

POST /auth/change-password verifies the current password, refuses a new one
equal to it (which would defeat a forced change), clears the flag, and nulls
refreshTokenHash so a session opened with the old credential cannot refresh
past the change. A wrong current password returns INVALID_CREDENTIALS, the
same code login returns, so the endpoint is not a user-id probe.

Rate-limited with loginLimiter rather than the global limiter."
```

---

### Task 3: Server — devices on the person overview

**Files:**
- Modify: `serverside/src/modules/dashboard/dashboard.service.ts:224-289` (`userView`)
- Modify: `serverside/src/config/verifyGadgets.ts` (add checks)

**Interfaces:**
- Consumes: `GadgetModel` from `src/modules/gadgets/gadgets.model.ts`, whose documents carry `owner_person_id`, `gadget_type`, `brand_model`, `serial_number`, `status`, `createdAt`.
- Produces: `GET /api/persons/:id/overview` and `GET /api/dashboard` (for a person-linked user) both return a `gadgets` array of `{ gadget_type: string; brand_model: string; serial_number: string; status: 'active' | 'inactive' }`. Task 6 consumes this.

- [ ] **Step 1: Write the failing test**

In `serverside/src/config/verifyGadgets.ts`, add this block inside its `main()`, before the `finally`. It uses the seeded laptop `5CD1234ABC`, which belongs to student `2025-0001`:

```ts
  // --- registered devices appear on the owner's overview ---
  const owner = await request(admin, 'GET', '/persons?search=2025-0001');
  const ownerRows = (owner.json.data ?? []) as { _id: string }[];
  expectEqual('seeded student found', ownerRows.length > 0, true);
  const ownerId = ownerRows[0]?._id;

  const overview = await request(admin, 'GET', `/persons/${ownerId}/overview`);
  expectEqual('overview -> 200', overview.status, OK);
  const gadgets = ((overview.json.data as Record<string, unknown>)?.gadgets ?? []) as {
    serial_number?: string;
    brand_model?: string;
    status?: string;
  }[];
  expectEqual('overview includes gadgets', Array.isArray(gadgets), true);
  expectEqual(
    'seeded laptop is listed',
    gadgets.some((g) => g.serial_number === '5CD1234ABC'),
    true
  );
  expectEqual(
    'listed device carries its model',
    gadgets.find((g) => g.serial_number === '5CD1234ABC')?.brand_model,
    'Dell Latitude 5420'
  );

  // --- the student sees their own devices on their own dashboard ---
  const studentToken = await login('2025-0001', 'Student@123');
  const dash = await request(studentToken, 'GET', '/dashboard');
  const myGadgets = ((dash.json.data as Record<string, unknown>)?.gadgets ?? []) as {
    serial_number?: string;
  }[];
  expectEqual(
    'student dashboard lists their own device',
    myGadgets.some((g) => g.serial_number === '5CD1234ABC'),
    true
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd serverside && npm run verify:gadgets`
Expected: FAIL. `seeded laptop is listed` reports `got false, expected true` — `userView` returns no `gadgets` key, so the array defaults to empty.

- [ ] **Step 3: Add the query to `userView`**

In `serverside/src/modules/dashboard/dashboard.service.ts`, import the model near the other model imports:

```ts
import { GadgetModel } from '../gadgets/gadgets.model';
```

Add the query to the destructured `Promise.all` in `userView` — add `gadgets` to the array on the left and this entry after the `VehicleModel.find(...)` line:

```ts
    const [person, vehicles, gadgets, today, recent, statusAgg, scans] = await Promise.all([
      PersonModel.findOne({ _id: personId, deleted_at: null }).lean(),
      VehicleModel.find({ owner_person_id: personId }).sort({ createdAt: -1 }).lean(),
      // Inactive rows included on purpose. A replaced device is deactivated
      // rather than deleted so its history survives (gadgets.model.ts:18-22),
      // and "this laptop was swapped" is exactly what someone opening a profile
      // is trying to find out. The status badge distinguishes them.
      GadgetModel.find({ owner_person_id: personId }).sort({ createdAt: -1 }).lean(),
```

Then add to the returned object, immediately after the `vehicles` mapping:

```ts
      gadgets: gadgets.map((gadget) => ({
        gadget_type: gadget.gadget_type,
        brand_model: gadget.brand_model,
        serial_number: gadget.serial_number,
        status: gadget.status,
      })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd serverside && npm run verify:gadgets`
Expected: PASS — all checks pass, including the six new ones.

- [ ] **Step 5: Commit**

```bash
cd C:/thesis_rfid/serverside
git add src/modules/dashboard/dashboard.service.ts src/config/verifyGadgets.ts
git commit -m "feat: return registered devices on the person overview

userView fetched vehicles and never queried GadgetModel, so a device could be
registered and then appear nowhere a person is viewed — not on the admin's
per-person profile, and not on the student's own dashboard, which renders the
same payload.

Inactive rows are included rather than filtered: a replaced device is
deactivated to preserve its history, and that is the answer someone opening a
profile is usually looking for."
```

---

### Task 4: Client — password field on the registration form

**Files:**
- Modify: `userpage/components/PersonForm.tsx:26-33` (form state), `:53-61` (payload), `:233-241` (fields)
- Modify: `userpage/components/admin/RegisterView.tsx:44-48` (`handleCreated`), `:72-76` (notice)
- Modify: `userpage/components/RegistrationForm.tsx` (`PersonRecord` type)

**Interfaces:**
- Consumes: `POST /api/persons` accepting `password` and returning `login_created: boolean` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `login_created` to the record type**

In `userpage/components/RegistrationForm.tsx`, add the optional field to `PersonRecord`:

```ts
  /** Set by POST /persons: whether a login was created alongside the person. */
  login_created?: boolean;
```

- [ ] **Step 2: Add the password field to the form**

In `userpage/components/PersonForm.tsx`, add `password: ""` to the `useState` initializer:

```ts
  const [form, setForm] = useState({
    full_name: "",
    type: allowedTypes[0] ?? "student",
    id_number: "",
    department_section: "",
    contact_email: "",
    rfid_uid: "",
    password: "",
  });
```

Include it in the payload — it is required here, so it is set unconditionally rather than through the optional-fields loop:

```ts
    const payload: Record<string, string> = {
      full_name: form.full_name.trim(),
      type: form.type,
      id_number: form.id_number.trim(),
      password: form.password,
    };
```

Add the input between the RFID field and the submit button:

```tsx
        <label className="block text-[13px] font-600 text-ink-soft">
          Password — the person signs in with this and their ID number
          <input
            required
            type="text"
            minLength={8}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder="Min. 8 characters"
            className={`mt-1 ${inputCls}`}
          />
          <span className="mt-1 block text-[12px] font-400 text-ink-soft">
            Write this on the printed form. They must change it at first sign-in.
          </span>
        </label>
```

`type="text"` rather than `password`, deliberately: the registrar is typing a credential they must read back to the person, and masking it invites transcription errors on a value nobody can recover later.

- [ ] **Step 3: Report the login in the success notice**

In `userpage/components/admin/RegisterView.tsx`, widen the stored value:

```ts
  const [lastCreated, setLastCreated] = useState<PersonRecord | null>(null);
```

Update the handler:

```ts
  function handleCreated(person: PersonRecord) {
    clearNotices();
    setLastCreated(person);
    setFormKey((k) => k + 1);
  }
```

And the notice, so the operator is told whether the person can actually sign in:

```tsx
      {lastCreated && (
        <Notice tone="info" className="text-sm text-ink">
          Registered {lastCreated.full_name}.{" "}
          {lastCreated.login_created
            ? `They can sign in with ID number ${lastCreated.id_number}.`
            : "No login was created — add one from the Accounts tab."}{" "}
          The form is ready for the next person.
        </Notice>
      )}
```

- [ ] **Step 4: Verify the build and lint pass**

Run: `cd userpage && npx tsc --noEmit && npx eslint components/PersonForm.tsx components/admin/RegisterView.tsx components/RegistrationForm.tsx`
Expected: no type errors; no new lint errors. (Four pre-existing `react-hooks/set-state-in-effect` errors exist elsewhere in the repo — `app/admin/page.tsx`, `app/dashboard/page.tsx`, `components/PersonProfile.tsx`, `components/StudentsDirectory.tsx`. Do not fix them here; just confirm you added none.)

- [ ] **Step 5: Verify by hand**

With both servers running (`serverside`: `npm run dev`; `userpage`: `npm run dev`), sign in at `http://localhost:5173/login` as `testadmin` / `Admin@123`, open **Register → Single person**, and register a student with a password. Confirm the notice names their ID number. Then sign out and sign in as that ID number with the password you typed.
Expected: sign-in succeeds.

- [ ] **Step 6: Commit**

```bash
cd C:/thesis_rfid/userpage
git add components/PersonForm.tsx components/admin/RegisterView.tsx components/RegistrationForm.tsx
git commit -m "feat: set a password when registering a person

The registration form now requires a password and the person's login is
created with the record, so 'registered' and 'can sign in' stop being two
different states that a second, easily-forgotten screen sat between.

The field is type=text on purpose: the registrar is transcribing a credential
onto a printed form for someone else, and masking a value nobody can recover
later invites silent typos."
```

---

### Task 5: Client — change-password screen and route guard

**Files:**
- Create: `userpage/app/change-password/page.tsx`
- Create: `userpage/components/ChangePasswordForm.tsx`
- Modify: `userpage/lib/auth.ts` (add `updateStoredUser`, extend `redirectForRole`)
- Modify: `userpage/components/LoginExperience.tsx` (honour the flag after login)
- Modify: `userpage/app/admin/page.tsx`, `userpage/app/dashboard/page.tsx` (guard)

**Interfaces:**
- Consumes: `POST /api/auth/change-password` (Task 2); `apiPost`, `getStoredUser`, `storeAuth`, `clearAuth` from `lib/auth.ts`.
- Produces: `updateStoredUser(patch: Partial<AuthUser>): void` in `lib/auth.ts`, and `redirectForRole(role: Role, mustChangePassword?: boolean): "/admin" | "/dashboard" | "/change-password"`.

- [ ] **Step 1: Add the storage helper and extend the redirect**

In `userpage/lib/auth.ts`, add after `storeAuth`:

```ts
/**
 * Rewrites the stored user in whichever store holds it, preserving the
 * remember-me choice. Used after a password change so the client stops
 * believing a change is still required.
 */
export function updateStoredUser(patch: Partial<AuthUser>): void {
  if (typeof window === "undefined") return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    const raw = store.getItem(USER_KEY);
    if (!raw) continue;
    try {
      store.setItem(USER_KEY, JSON.stringify({ ...JSON.parse(raw), ...patch }));
    } catch {
      // A corrupt entry is not worth failing the change over — the next login
      // overwrites it anyway.
    }
  }
}
```

Replace `redirectForRole`:

```ts
/** Where a role lands after signing in. A forced password change outranks role. */
export function redirectForRole(
  role: Role,
  mustChangePassword?: boolean,
): "/admin" | "/dashboard" | "/change-password" {
  if (mustChangePassword) return "/change-password";
  return role === "superadmin" || role === "registrar" ? "/admin" : "/dashboard";
}
```

- [ ] **Step 2: Create the form component**

Create `userpage/components/ChangePasswordForm.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiPost,
  getStoredUser,
  redirectForRole,
  updateStoredUser,
  type AuthUser,
} from "@/lib/auth";
import Notice from "@/components/Notice";
import NcstMark from "@/components/NcstMark";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue/12";

export default function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Checked here as well as by the input pattern, because a mismatch is the
    // one error the server cannot see: it only ever receives one new password.
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      updateStoredUser({ mustChangePassword: false });
      const user = getStoredUser() as AuthUser | null;
      router.replace(user ? redirectForRole(user.role, false) : "/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-white p-8"
      >
        <div className="flex items-center gap-3">
          <NcstMark className="h-10 w-10" />
          <div className="leading-tight">
            <h1 className="font-display text-lg font-700 tracking-tight text-ink">
              Change your password
            </h1>
            <p className="text-[13px] text-ink-soft">
              Choose a password only you know before continuing.
            </p>
          </div>
        </div>

        {error && (
          <Notice compact className="text-[13px] text-ink">
            {error}
          </Notice>
        )}

        <label className="block text-[13px] font-600 text-ink-soft">
          Current password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          New password
          <input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="Min. 8 characters"
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <label className="block text-[13px] font-600 text-ink-soft">
          Confirm new password
          <input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </label>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-navy px-4 py-2.5 text-sm font-600 text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Change password"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create the page**

Create `userpage/app/change-password/page.tsx`:

```tsx
import ChangePasswordForm from "@/components/ChangePasswordForm";

export const metadata = {
  title: "Change password · NCST RFID Access",
};

export default function ChangePasswordPage() {
  return <ChangePasswordForm />;
}
```

- [ ] **Step 4: Honour the flag right after login**

In `userpage/components/LoginExperience.tsx`, change the post-login redirect:

```tsx
      router.push(redirectForRole(user.role, user.mustChangePassword));
```

- [ ] **Step 5: Guard the landing pages**

In `userpage/app/admin/page.tsx`, inside the existing `useEffect`, add this check immediately after the `!getToken() || !stored` guard and before the `isStaffSide` check:

```tsx
    if (stored.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
```

Apply the identical block in `userpage/app/dashboard/page.tsx`, in the same position within its `useEffect`.

Without this, typing `/admin` directly walks straight past the change screen — the login redirect alone is not a guard.

- [ ] **Step 6: Verify the build and lint pass**

Run: `cd userpage && npx tsc --noEmit && npx eslint app/change-password components/ChangePasswordForm.tsx lib/auth.ts components/LoginExperience.tsx`
Expected: no type errors; no new lint errors.

- [ ] **Step 7: Verify by hand**

Register a fresh student (Task 4 flow), sign out, then sign in as that new student.
Expected: you land on `/change-password`, not `/dashboard`. Manually navigating to `/dashboard` bounces back. Change the password; you land on `/dashboard`. Sign out and back in with the new password; you go straight to `/dashboard`. The old password is rejected.

Also confirm the seeded accounts are unaffected: sign in as `testadmin` / `Admin@123`.
Expected: straight to `/admin` — the seed sets `must_change_password: false`.

- [ ] **Step 8: Commit**

```bash
cd C:/thesis_rfid/userpage
git add app/change-password components/ChangePasswordForm.tsx lib/auth.ts components/LoginExperience.tsx app/admin/page.tsx app/dashboard/page.tsx
git commit -m "feat: change-password screen with a route guard

mustChangePassword arrived in the login payload and nothing read it. Users now
land on /change-password when the flag is set, and the admin and dashboard
pages carry the same guard so typing a URL directly cannot walk past it — the
login redirect alone would not have been a guard.

redirectForRole takes the flag because a forced change outranks role."
```

---

### Task 6: Client — devices section and register button

**Files:**
- Modify: `userpage/components/ProfileView.tsx:30-53` (`PersonOverview`), `:154-183` (sections)
- Modify: `userpage/components/PersonProfile.tsx:27-34` (refetch), `:59-76` (actions)

**Interfaces:**
- Consumes: `gadgets` on the overview payload (Task 3); `GadgetForm` with props `{ onCreated: (gadget: GadgetRecord) => void; onClose: () => void }` from `components/gadgets/GadgetForm.tsx`; `canRegisterGadgets(role: Role): boolean` from `lib/permissions.ts:104`; `gadgetTypeLabel` from `lib/gadgetTypes.ts`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `gadgets` to the overview type**

In `userpage/components/ProfileView.tsx`, add to `PersonOverview` after `vehicles`:

```ts
  gadgets: {
    // GadgetType, not string: gadgetTypeLabel() is typed to the union, and the
    // server projects straight off a Mongoose enum, so widening to string here
    // only buys a cast at the call site.
    gadget_type: GadgetType;
    brand_model: string;
    serial_number: string;
    status: string;
  }[];
```

Add the type import at the top of the file:

```ts
import { gadgetTypeLabel, type GadgetType } from "@/lib/gadgetTypes";
```

- [ ] **Step 2: Render the devices section**

In the same file, add `TfiDesktop` to the existing `react-icons/tfi` import:

```ts
import {
  TfiCar,
  TfiCheckBox,
  TfiDesktop,
  TfiNa,
  TfiPulse,
  TfiAgenda,
  TfiTime,
  TfiTimer,
} from "react-icons/tfi";
```

Add this section immediately after the "Registered vehicles" `</section>`, inside the same `grid gap-4 sm:grid-cols-2` wrapper — which then holds three cards and wraps naturally:

```tsx
        <section className="rounded-2xl border border-line bg-white p-5">
          <SectionHeading icon={TfiDesktop}>Registered devices</SectionHeading>
          {data.gadgets.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {data.gadgets.map((g, i) => (
                <li
                  key={`${g.serial_number}-${i}`}
                  className={i > 0 ? "border-t border-line/60 pt-3" : ""}
                >
                  <div className="space-y-2 text-[15px]">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-700 text-ink">{g.serial_number}</span>
                      <span
                        className={`rounded-lg px-2.5 py-1 text-[12px] font-600 capitalize ${
                          g.status === "active"
                            ? "border border-blue bg-blue/25 text-ink"
                            : "border border-red bg-red/25 text-ink"
                        }`}
                      >
                        {g.status}
                      </span>
                    </div>
                    <p className="text-ink-soft">
                      {gadgetTypeLabel(g.gadget_type)} · {g.brand_model}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[15px] text-ink-soft">No device on file.</p>
          )}
        </section>
```

The inactive badge is red rather than grey because a deactivated device that still shows on a profile is a fact someone needs to notice, not decoration.

- [ ] **Step 3: Add the register button to the admin profile only**

In `userpage/components/PersonProfile.tsx`, add imports:

```tsx
import GadgetForm from "@/components/gadgets/GadgetForm";
import { canRegisterGadgets } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
```

Extract the fetch so it can be re-run, replacing the existing `useEffect`:

```tsx
  const [showGadget, setShowGadget] = useState(false);
  const myRole = (getStoredUser()?.role ?? "staff") as Role;
  const canGadget = canRegisterGadgets(myRole);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<PersonOverview>(`/persons/${personId}/overview`)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [personId]);

  useEffect(() => {
    load();
  }, [load]);
```

Add `useCallback` to the React import. Then add the button beside "Print form":

```tsx
            {canGadget && (
              <button
                onClick={() => setShowGadget(true)}
                className="rounded-xl border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-ink"
              >
                Register device
              </button>
            )}
```

And the form, next to the other conditional dialogs:

```tsx
      {showGadget && (
        <GadgetForm
          onCreated={() => {
            setShowGadget(false);
            load();
          }}
          onClose={() => setShowGadget(false)}
        />
      )}
```

The button lives here, not in `ProfileView`, because `ProfileView` also renders the student's own dashboard — a button there would offer every student a form the server rejects.

- [ ] **Step 4: Verify the build and lint pass**

Run: `cd userpage && npx tsc --noEmit && npx eslint components/ProfileView.tsx components/PersonProfile.tsx`
Expected: no type errors. `PersonProfile.tsx` has one pre-existing `react-hooks/set-state-in-effect` error; confirm the count did not increase.

- [ ] **Step 5: Verify by hand**

Sign in as `testadmin` / `Admin@123`, open **Directory → Juan Dela Cruz**.
Expected: a "Registered devices" card shows `5CD1234ABC · Laptop · Dell Latitude 5420` with an active badge, and a "Register device" button appears in the header.

Register a second device from that button.
Expected: the dialog closes and the new device appears without a page reload.

Sign in as `2025-0001` / `Student@123` and open the dashboard.
Expected: the devices card is present and shows the laptop, with **no** register button.

Sign in as `testregistrar` / `Registrar@123` and open the same person.
Expected: devices are visible, register button absent — the registrar's `WRITE_DOMAINS` is `person:student` only.

- [ ] **Step 6: Commit**

```bash
cd C:/thesis_rfid/userpage
git add components/ProfileView.tsx components/PersonProfile.tsx
git commit -m "feat: show registered devices on the profile, and register from it

A device could be registered and then appear nowhere a person is viewed. The
devices card sits beside vehicles in ProfileView, so the student's own
dashboard gets it for free from the same payload.

The Register device button is in PersonProfile rather than ProfileView because
ProfileView also renders the student dashboard, and it is gated on
canRegisterGadgets — superadmin and OSS, matching WRITE_DOMAINS."
```

---

### Task 7: Update the deployment and demo docs

**Files:**
- Modify: `userpage/docs/DEMO-ACCOUNTS.md`
- Modify: `serverside/DEPLOYMENT.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1–6.
- Produces: nothing.

- [ ] **Step 1: Record the forced-change behaviour for demos**

In `userpage/docs/DEMO-ACCOUNTS.md`, add before the "Before this holds real student data" section:

```markdown
## Newly registered accounts differ from the seeded ones

Registering a person now creates their login in the same request, with
`must_change_password: true`, and the client enforces it — the first sign-in
lands on `/change-password` and cannot be navigated past.

The eight seeded accounts above are set to `false` by `testSeed.ts` and are
unaffected, so `testadmin` / `Admin@123` still goes straight to the console.
Anyone registered live during a demo will be asked to change their password
before they see anything.
```

- [ ] **Step 2: Note the new harness**

In `serverside/DEPLOYMENT.md`, in the table under "Which script to run where", add a row after the existing entries:

```markdown
| Verify registration, logins and password changes (local, server running) | `npm run verify:registration` |
```

- [ ] **Step 3: Commit both repos**

```bash
cd C:/thesis_rfid/userpage
git add docs/DEMO-ACCOUNTS.md
git commit -m "docs: note that registered accounts force a password change"

cd C:/thesis_rfid/serverside
git add DEPLOYMENT.md
git commit -m "docs: list the verify:registration harness"
```

---

## Final verification

- [ ] **Run every backend harness**

With `npm run dev` running:

```bash
cd C:/thesis_rfid/serverside
npm run verify:roles && npm run verify:gates && npm run verify:registration && npm run verify:gadgets && npm run verify:vehicles && npm run verify:signatures && npm run verify:passback
```

Expected: every suite reports all checks passed.

- [ ] **Build both applications**

```bash
cd C:/thesis_rfid/serverside && npm run build && npm run lint
cd C:/thesis_rfid/userpage && NEXT_PUBLIC_API_BASE_URL=https://ncst-rfid-api.onrender.com/api npx next build
```

Expected: both succeed.

- [ ] **Confirm no secrets are staged in the public repo**

```bash
cd C:/thesis_rfid/serverside
git status --porcelain
git diff HEAD --stat
```

Expected: `.env.production` and `.gate-keys.local.txt` appear nowhere.

## Deployment note

Both repos deploy from `main`, and Render auto-deploys on push. This branch of
work should be merged to `main` in both repos only after the final verification
above passes — a push to `main` in `serverside` deploys to production
immediately.
