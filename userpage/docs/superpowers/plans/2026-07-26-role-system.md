# Role System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-role (`admin`/`user`) authorization model with four roles — `superadmin`, `registrar`, `staff`, `student` — and give superadmin single and bulk activate/deactivate that disables both login and gate access.

**Architecture:** `constants/roles.ts` is the single source of truth on the server; `lib/permissions.ts` mirrors it on the client. Every `authorize(ROLES.ADMIN)` guard is replaced with an explicit role list drawn from the permission matrix in the spec. Deactivation is one service method that writes both `User.is_active` and the linked `Person.status`. The `/admin` console becomes a shell with role-filtered navigation, with its existing views extracted into components.

**Tech Stack:** TypeScript, Express 4, Mongoose 8, Zod 3 (backend) · Next.js 16 App Router, React 19, Tailwind CSS v4 (frontend)

**Spec:** `docs/superpowers/specs/2026-07-26-role-system-design.md`

## Global Constraints

- **Two separate git repositories.** `C:\thesis_rfid\serverside` and `C:\thesis_rfid\userpage` each have their own `.git`. Commit in the repo you changed. Never try to commit both in one command.
- **No test framework, and do not add one.** Neither `package.json` has a test runner. Verification is the `verifyRoles.ts` script plus `npm run lint` and `npm run build`. Do not install Jest, Vitest, Supertest, or any test dependency.
- **No new runtime dependencies at all.** Everything in this plan uses packages already in `package.json`.
- **No migration script.** Existing data is wiped and reseeded. Do not write migration or backfill code.
- **Role string values are exactly:** `'superadmin'`, `'registrar'`, `'staff'`, `'student'`. Lowercase, no underscores.
- **The permission matrix in the spec is authoritative.** If a step here appears to contradict it, the spec wins — stop and flag it.
- **`req.user` shape is `{ userId: string; role: Role; personId: string | null }`.** The id field is `userId`, not `id` or `_id`. Set in `src/middlewares/authenticate.ts`.
- **The gate denial reason for an inactive ID is the existing string `'inactive_id'`.** `scan.service.ts` already emits it. Do not introduce a new constant and do not modify `scan.service.ts`.
- **`POST /scan/tap` stays guarded by `authenticate` only.** It is a known authorization gap, deliberately out of scope. Do not "fix" it in this plan.
- **Backend runs on port 3000, frontend dev server on port 5173** (`next dev -p 5173`).

## Sequencing note

Tasks 1–3 are a single breaking change spread over three commits: after Task 1 the project will not compile until Task 2 lands, and logins will not work until Task 3 reseeds. This is intentional — the alternative is one unreviewable commit. **Do not stop and deploy between Tasks 1 and 3.** Task 4 is the first point where the system is verifiably working again.

---

### Task 1: Role constants and User model

**Files:**
- Modify: `serverside/src/constants/roles.ts` (whole file)
- Modify: `serverside/src/modules/users/users.model.ts:20` (role enum) and the `IUser` interface

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ROLES` with keys `SUPERADMIN`, `REGISTRAR`, `STAFF`, `STUDENT`
  - `type Role = 'superadmin' | 'registrar' | 'staff' | 'student'`
  - `STAFF_SIDE: readonly Role[]` — roles with `/admin` console access
  - `BULK_PROTECTED: readonly Role[]` — roles a bulk action may never touch
  - `IUser.deactivated_at: Date | null`, `IUser.deactivated_by: Types.ObjectId | null`

- [ ] **Step 1: Replace `constants/roles.ts` entirely**

```ts
export const ROLES = {
  SUPERADMIN: 'superadmin',
  REGISTRAR: 'registrar',
  STAFF: 'staff',
  STUDENT: 'student',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Roles that get the staff-side console at /admin. */
export const STAFF_SIDE: readonly Role[] = [ROLES.SUPERADMIN, ROLES.REGISTRAR];

/** Roles a bulk status change may never affect, regardless of filter. */
export const BULK_PROTECTED: readonly Role[] = [ROLES.SUPERADMIN, ROLES.REGISTRAR];

/** Every valid role, for Zod enums and Mongoose enums. */
export const ALL_ROLES: readonly Role[] = [
  ROLES.SUPERADMIN,
  ROLES.REGISTRAR,
  ROLES.STAFF,
  ROLES.STUDENT,
];
```

- [ ] **Step 2: Verify the build now fails**

Run: `cd C:\thesis_rfid\serverside && npm run build`

Expected: FAIL. Multiple `error TS2339: Property 'ADMIN' does not exist on type ...` and the same for `'USER'`, across roughly 14 sites. This confirms the constant is the real chokepoint and nothing references the old roles by string literal.

Record the list of failing files — Task 2 must fix exactly these and no others.

- [ ] **Step 3: Add audit fields to the User model**

In `serverside/src/modules/users/users.model.ts`, add to the `IUser` interface after `is_active`:

```ts
  deactivated_at: Date | null;
  deactivated_by: Types.ObjectId | null;
```

In the schema, replace the `role` line and add the two fields:

```ts
    role: { type: String, enum: ALL_ROLES, required: true },
```

```ts
    deactivated_at: { type: Date, default: null },
    deactivated_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
```

Update the import at the top of the file:

```ts
import { ROLES, Role, ALL_ROLES } from '../../constants/roles';
```

`ROLES` may now be unused in this file — if `npm run lint` flags it, drop it from the import and keep `Role` and `ALL_ROLES`.

- [ ] **Step 4: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/constants/roles.ts src/modules/users/users.model.ts
git commit -m "feat(roles): define four-role constants and user audit fields

Build is intentionally broken until the guard update in the next commit."
```

---

### Task 2: Route guards and role-aware branches

**Files:**
- Modify: `serverside/src/modules/persons/persons.routes.ts:17`
- Modify: `serverside/src/modules/users/users.routes.ts:11`
- Modify: `serverside/src/modules/vehicles/vehicles.routes.ts:11`
- Modify: `serverside/src/modules/logs/logs.routes.ts:9`
- Modify: `serverside/src/modules/reports/reports.routes.ts:9`
- Modify: `serverside/src/modules/scan/scan.routes.ts:14`
- Modify: `serverside/src/modules/attendance/attendance.routes.ts:11`
- Modify: `serverside/src/modules/attendance/attendance.service.ts:22`
- Modify: `serverside/src/modules/dashboard/dashboard.service.ts:91`
- Modify: `serverside/src/modules/users/users.service.ts:30`

**Interfaces:**
- Consumes: `ROLES`, `Role`, `STAFF_SIDE` from Task 1
- Produces: route guards matching the spec's permission matrix. No new exports.

- [ ] **Step 1: Split the persons routes by privilege**

`persons.routes.ts` currently applies one blanket guard on line 17. Registrar needs everything there except `PATCH /:id/status`. Replace the blanket guard and reorder so the superadmin-only route carries its own guard:

```ts
personRoutes.use(authenticate, authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR));

personRoutes.get('/', personController.list);
personRoutes.get('/sections', personController.sections);
personRoutes.get('/export', personController.export);
personRoutes.get('/:id/overview', personController.overview);
personRoutes.get('/:id', personController.get);
personRoutes.post('/', validate(createPersonSchema), personController.create);
personRoutes.post('/import', validate(importPersonsSchema), personController.import);
personRoutes.patch('/:id', validate(updatePersonSchema), personController.update);
personRoutes.patch('/:id/rfid', validate(reassignRfidSchema), personController.reassignRfid);

// Superadmin only — activation is not a registrar action.
personRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN),
  validate(statusSchema),
  personController.setStatus
);
```

- [ ] **Step 2: Split the users routes by privilege**

Replace the blanket guard in `users.routes.ts`:

```ts
userRoutes.use(authenticate);

// Registrar may create logins and check for duplicates.
userRoutes.get('/', authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR), userController.list);
userRoutes.post(
  '/',
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR),
  validate(createUserSchema),
  userController.create
);

// Superadmin only.
userRoutes.patch(
  '/:id/password',
  authorize(ROLES.SUPERADMIN),
  validate(resetPasswordSchema),
  userController.resetPassword
);
userRoutes.delete('/:id', authorize(ROLES.SUPERADMIN), userController.remove);
```

Leave room below the `POST /` line — Tasks 7 and 8 add the status routes here.

- [ ] **Step 3: Point the remaining blanket guards at superadmin**

In each of these files, change `ROLES.ADMIN` to `ROLES.SUPERADMIN`:

- `vehicles.routes.ts:11` — `vehicleRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));`
- `logs.routes.ts:9` — `logRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));`
- `reports.routes.ts:9` — `reportRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));`
- `scan.routes.ts:14` — `scanRoutes.get('/logs', authorize(ROLES.SUPERADMIN), scanController.logs);`
- `attendance.routes.ts:11` — `attendanceRoutes.get('/summary/:person_id', authorize(ROLES.SUPERADMIN), attendanceController.summary);`

Do **not** touch `scan.routes.ts` line 13 (`POST /tap`). It stays `authenticate`-only per the global constraints.

- [ ] **Step 4: Update the two role-aware service branches**

`attendance.service.ts:22` — an admin sees all attendance, a user sees their own. Registrar has no attendance duties, so treat only superadmin as privileged:

```ts
    if (actor.role === ROLES.SUPERADMIN) {
```

`dashboard.service.ts:91` — superadmin and registrar both need a console dashboard, but registrar must not receive scan or gate data. For this task, route registrar to the same admin view; Task 6 does not change it and no later task in this plan narrows it:

```ts
    if (actor.role === ROLES.SUPERADMIN || actor.role === ROLES.REGISTRAR) {
      return this.adminView();
    }
```

Note in the commit message that the registrar dashboard is intentionally the full admin view for now, and that narrowing it is deferred. The spec describes a registration-focused registrar dashboard; that refinement is not required for the role system to be correct and is not in this plan's task list.

- [ ] **Step 5: Fix the hardcoded role in user creation**

`users.service.ts:30` hardcodes `role: ROLES.USER`. Task 5 makes this configurable properly. For now, keep the build green with the closest equivalent:

```ts
      role: ROLES.STUDENT,
```

- [ ] **Step 6: Verify the build passes**

Run: `cd C:\thesis_rfid\serverside && npm run build`

Expected: PASS, zero errors. Every file from Task 1 Step 2's failure list is now fixed.

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules
git commit -m "feat(roles): apply four-role permission matrix to all route guards

Registrar gets person read/write and user creation; superadmin keeps
everything else. POST /scan/tap deliberately unchanged.
Registrar dashboard temporarily returns the full admin view."
```

---

### Task 3: Seeds and README

**Files:**
- Modify: `serverside/src/config/seed.ts:27`
- Modify: `serverside/src/config/testSeed.ts:133,322` and the `HARDCODED_PEOPLE` array
- Modify: `serverside/README.md` (test-account table, data-model section)

**Interfaces:**
- Consumes: `ROLES` from Task 1
- Produces: seeded accounts `testadmin` (superadmin), `testregistrar` (registrar), three students, one staff — used by every later verification step.

- [ ] **Step 1: Update the production seed**

`seed.ts:27` — change `role: ROLES.ADMIN` to:

```ts
      role: ROLES.SUPERADMIN,
```

Also update the two log lines in that block from `admin` to `superadmin` so the output is not misleading:

```ts
    console.log(`[seed] superadmin '${env.ADMIN_USERNAME}' already exists — skipping`);
```

```ts
    console.log(`[seed] created superadmin '${env.ADMIN_USERNAME}'`);
```

- [ ] **Step 2: Give test people their real roles**

`testSeed.ts` — the `HARDCODED_PEOPLE` array has a `type` field (`'student' | 'staff'`) that already matches the role names. In `ensurePerson`, replace `role: ROLES.USER` on line 133 with a mapping from the person's type:

```ts
      role: p.type === 'student' ? ROLES.STUDENT : ROLES.STAFF,
```

This gives Juan, Maria, and Pedro `role: 'student'` and Ana Villanueva `role: 'staff'`, which is exactly the coverage the verification script needs.

- [ ] **Step 3: Make the test admin a superadmin and add a registrar**

`testSeed.ts:322` — change `role: ROLES.ADMIN` to `role: ROLES.SUPERADMIN`.

Add a constant next to `HARDCODED_ADMIN` near the top of the file:

```ts
const HARDCODED_REGISTRAR = {
  username: 'testregistrar',
  password: 'Registrar@123',
};
```

In `seedTest()`, directly after the admin block and before the legacy-cleanup block, add:

```ts
  // ---- Registrar ----
  const existingRegistrar = await UserModel.findOne({ username: HARDCODED_REGISTRAR.username });
  if (existingRegistrar) {
    console.log(`[test-seed] registrar '${HARDCODED_REGISTRAR.username}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(HARDCODED_REGISTRAR.password, 12);
    await UserModel.create({
      username: HARDCODED_REGISTRAR.username,
      password_hash,
      role: ROLES.REGISTRAR,
      person_id: null,
      must_change_password: false,
      is_active: true,
    });
    console.log(
      `[test-seed] created registrar '${HARDCODED_REGISTRAR.username}' (password: ${HARDCODED_REGISTRAR.password})`
    );
  }
```

- [ ] **Step 4: Wipe and reseed**

The old documents carry `role: 'admin'` and `role: 'user'`, which now violate the model enum. Drop the users collection and reseed.

Run, from `C:\thesis_rfid\serverside`:

```bash
node -e "require('dotenv').config();const m=require('mongoose');m.connect(process.env.MONGODB_URI).then(async()=>{await m.connection.collection('users').deleteMany({});console.log('users cleared');await m.disconnect();})"
npm run seed
npm run seed:test
```

Expected: the seed logs `created superadmin ...`, and the test seed logs `created registrar 'testregistrar'` plus four person logins. Persons, gates, scans, and attendance are preserved; only logins are rebuilt.

- [ ] **Step 5: Confirm the seeded roles**

Run: `npx ts-node src/config/verifyTest.ts`

Expected: the USERS table lists `testadmin` as `superadmin`, `testregistrar` as `registrar`, `2025-0001`/`2025-0002`/`2025-0003` as `student`, and `EMP-1001` as `staff`. No row shows `admin` or `user`.

- [ ] **Step 6: Update the README**

In `serverside/README.md`, replace the test-accounts table with:

| Role | Username | Password |
|------|----------|----------|
| Superadmin | `testadmin` | `Admin@123` |
| Registrar | `testregistrar` | `Registrar@123` |
| Student — Juan Dela Cruz | `2025-0001` | `Student@123` |
| Student — Maria Santos | `2025-0002` | `Student@123` |
| Student — Pedro Reyes | `2025-0003` | `Student@123` |
| Staff — Ana Villanueva | `EMP-1001` | `Staff@123` |

In the "Data model" section, replace the `User` bullet with:

```markdown
- **User** — a login account with one of four roles: `superadmin` (full control,
  including single and bulk activate/deactivate), `registrar` (registers people and
  creates their logins), `staff`, and `student` (own profile only). A person's login
  links to their profile via `person_id`.
```

In the "Notes" section, replace the first bullet with:

```markdown
- No public registration. The superadmin is seeded; registrars and user logins are created through the API.
```

- [ ] **Step 7: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/config/seed.ts src/config/testSeed.ts README.md
git commit -m "feat(roles): seed superadmin and registrar, document four roles"
```

---

### Task 4: Verification harness and the existing-route matrix

**Files:**
- Create: `serverside/src/config/verifyRoles.ts`
- Modify: `serverside/package.json` (scripts)

**Interfaces:**
- Consumes: seeded accounts from Task 3
- Produces:
  - `login(username, password): Promise<string>` — returns an access token
  - `check(name, token, method, path, expected, body?): Promise<void>` — asserts a status code
  - `expectEqual(name, actual, expected): void`
  - a module-level `failures: string[]` and `summary(): void` that exits non-zero
  These helpers are extended by Tasks 5–8, which append their own assertion blocks.

- [ ] **Step 1: Write the harness with the existing-route matrix**

Create `serverside/src/config/verifyRoles.ts`. Node 20 has global `fetch`, so no HTTP dependency is needed. The server must already be running on port 3000.

```ts
/**
 * Asserts the permission matrix in
 * docs/superpowers/specs/2026-07-26-role-system-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:roles
 */

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const failures: string[] = [];
let checks = 0;

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (!token) {
    throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  }
  return token;
}

async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no body; the status is what matters.
  }
  return { status: res.status, json };
}

/**
 * A 401 is always a failure even when a denial was expected — it means the
 * token is broken, not that authorization worked.
 */
async function check(
  name: string,
  token: string,
  method: string,
  path: string,
  expected: number,
  body?: unknown
): Promise<void> {
  checks++;
  const { status } = await request(token, method, path, body);
  if (status === 401 && expected !== 401) {
    failures.push(`${name}: got 401 (bad token) — expected ${expected}`);
    console.log(`  FAIL ${name} — 401, expected ${expected}`);
    return;
  }
  if (status !== expected) {
    failures.push(`${name}: got ${status}, expected ${expected}`);
    console.log(`  FAIL ${name} — ${status}, expected ${expected}`);
    return;
  }
  console.log(`  ok   ${name} — ${status}`);
}

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
  console.log('All role checks passed.');
}

const OK = 200;
const FORBIDDEN = 403;

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const staff = await login('EMP-1001', 'Staff@123');

  console.log('\n== persons: superadmin and registrar may read ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
  ] as const) {
    await check(`${name} GET /persons`, token, 'GET', '/persons', OK);
    await check(`${name} GET /persons/sections`, token, 'GET', '/persons/sections', OK);
  }
  for (const [name, token] of [
    ['student', student],
    ['staff', staff],
  ] as const) {
    await check(`${name} GET /persons denied`, token, 'GET', '/persons', FORBIDDEN);
  }

  console.log('\n== superadmin-only areas ==');
  for (const path of ['/logs', '/reports/attendance', '/scan/logs', '/vehicles']) {
    await check(`superadmin GET ${path}`, superadmin, 'GET', path, OK);
    await check(`registrar GET ${path} denied`, registrar, 'GET', path, FORBIDDEN);
    await check(`student GET ${path} denied`, student, 'GET', path, FORBIDDEN);
  }

  console.log('\n== open to every authenticated role ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /dashboard`, token, 'GET', '/dashboard', OK);
    await check(`${name} GET /gates`, token, 'GET', '/gates', OK);
    await check(`${name} GET /attendance`, token, 'GET', '/attendance', OK);
  }

  console.log('\n== users list ==');
  await check('superadmin GET /users', superadmin, 'GET', '/users', OK);
  await check('registrar GET /users', registrar, 'GET', '/users', OK);
  await check('student GET /users denied', student, 'GET', '/users', FORBIDDEN);

  summary();
}

main().catch((err) => {
  console.error('\nverifyRoles crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the script**

In `serverside/package.json`, add to `scripts`, after `"seed:test"`:

```json
    "verify:roles": "ts-node src/config/verifyRoles.ts",
```

- [ ] **Step 3: Run it against the running server**

In one terminal: `cd C:\thesis_rfid\serverside && npm run dev`

In another: `cd C:\thesis_rfid\serverside && npm run verify:roles`

Expected: PASS — every check `ok`, final line `All role checks passed.`

If any `GET /persons` for registrar returns 403, Task 2 Step 1 was not applied. If any login throws, Task 3 was not reseeded.

- [ ] **Step 4: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/config/verifyRoles.ts package.json
git commit -m "test(roles): add verify:roles script covering the existing route matrix"
```

---

### Task 5: Role-aware user creation

**Files:**
- Modify: `serverside/src/modules/users/users.schema.ts`
- Modify: `serverside/src/modules/users/users.service.ts` (`CreateUserInput`, `create`)
- Modify: `serverside/src/config/verifyRoles.ts` (add assertions)

**Interfaces:**
- Consumes: `check`, `login`, `request` from Task 4; `ROLES`, `Role` from Task 1
- Produces: `userService.create(input, actorRole)` where
  `input: { username: string; password: string; role: Role; person_id?: string | null }`
  and `actorRole: Role`. Throws `ApiError('FORBIDDEN')` when a registrar attempts to create a privileged account.

- [ ] **Step 1: Add the failing assertions first**

In `verifyRoles.ts`, insert this block immediately before `summary();` in `main()`:

```ts
  console.log('\n== user creation is role-aware ==');
  const CREATED = 201;
  const stamp = Date.now();

  // Registrar may create a student login.
  await check(
    'registrar creates student login',
    registrar,
    'POST',
    '/users',
    CREATED,
    { username: `verify-stu-${stamp}`, password: 'Verify@12345', role: 'student' }
  );

  // Registrar may not create privileged accounts.
  await check(
    'registrar cannot create registrar',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-reg-${stamp}`, password: 'Verify@12345', role: 'registrar' }
  );
  await check(
    'registrar cannot create superadmin',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-sa-${stamp}`, password: 'Verify@12345', role: 'superadmin' }
  );

  // Superadmin may create a registrar.
  await check(
    'superadmin creates registrar',
    superadmin,
    'POST',
    '/users',
    CREATED,
    { username: `verify-reg2-${stamp}`, password: 'Verify@12345', role: 'registrar' }
  );

  // The stored role must be what was requested.
  const createdList = await request(superadmin, 'GET', '/users?limit=100');
  const createdItems = (createdList.json.data ?? []) as { username: string; role: string }[];
  const madeStudent = createdItems.find((u) => u.username === `verify-stu-${stamp}`);
  expectEqual('created student has role student', madeStudent?.role, 'student');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run verify:roles`

Expected: FAIL. `registrar creates student login` returns 422, because `createUserSchema` still pins `role` to `z.enum(['user'])` and rejects `'student'`. The two `cannot create` checks return 422 as well rather than the 403 they must return.

- [ ] **Step 3: Widen the schema**

Replace `createUserSchema` in `users.schema.ts`:

```ts
import { z } from 'zod';
import { ALL_ROLES } from '../../constants/roles';

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(ALL_ROLES as unknown as [string, ...string[]]),
  person_id: z.string().nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
});
```

`role` is now required rather than defaulted, so a caller must state intent instead of silently getting a student account.

- [ ] **Step 4: Enforce privilege in the service**

In `users.service.ts`, replace `CreateUserInput` and `create`:

```ts
interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
  person_id?: string | null;
}

  async create(input: CreateUserInput, actorRole: Role) {
    // A registrar registers people; only a superadmin mints privileged accounts.
    if (actorRole !== ROLES.SUPERADMIN && BULK_PROTECTED.includes(input.role)) {
      throw new ApiError('FORBIDDEN', 'Only a superadmin can create privileged accounts');
    }

    const existing = await userRepo.findByUsername(input.username);
    if (existing) throw new ApiError('DUPLICATE_USERNAME');

    const password_hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const created = await userRepo.create({
      username: input.username,
      password_hash,
      role: input.role,
      person_id: (input.person_id as unknown as IUser['person_id']) ?? null,
      must_change_password: true,
      is_active: true,
    });
    return {
      id: String(created._id),
      username: created.username,
      role: created.role,
      person_id: created.person_id,
      must_change_password: created.must_change_password,
    };
  },
```

`BULK_PROTECTED` is exactly the set of privileged roles (`superadmin`, `registrar`), so it is reused here rather than declaring a second list that could drift.

Update the imports at the top of `users.service.ts`:

```ts
import { ROLES, Role, BULK_PROTECTED } from '../../constants/roles';
```

- [ ] **Step 5: Pass the actor's role from the controller**

In `users.controller.ts`, replace `create`:

```ts
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.create(req.body, req.user!.role), 201);
  }),
```

- [ ] **Step 6: Run and watch it pass**

Run: `npm run build` — expected PASS.
Restart `npm run dev`, then run `npm run verify:roles`.

Expected: PASS, including the four new creation checks and the stored-role check.

- [ ] **Step 7: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules/users src/config/verifyRoles.ts
git commit -m "feat(users): role-aware creation, registrars cannot mint privileged accounts"
```

---

### Task 6: Users list with person data and filters

**Files:**
- Modify: `serverside/src/modules/users/users.repository.ts`
- Modify: `serverside/src/modules/users/users.service.ts` (`list`)
- Modify: `serverside/src/config/verifyRoles.ts` (add assertions)

**Interfaces:**
- Consumes: `check`, `expectEqual`, `request` from Task 4
- Produces:
  - `userRepo.buildFilter(q: UserListQuery): Promise<FilterQuery<IUser>>` — resolves person-based filters to a user filter. **Tasks 7 and 8 both call this**, so the filter semantics live in exactly one place.
  - `interface UserListQuery { type?: string; department_section?: string; search?: string }`
  - `userRepo.findPaginatedWithPerson(filter, p)` returning rows shaped
    `{ id, username, role, is_active, deactivated_at, person: { id, full_name, type, department_section, rfid_uid, status } | null }`

- [ ] **Step 1: Add the failing assertions first**

In `verifyRoles.ts`, insert before `summary();`:

```ts
  console.log('\n== users list carries person data and filters ==');
  const listRes = await request(superadmin, 'GET', '/users?limit=100');
  const listRows = (listRes.json.data ?? []) as {
    username: string;
    role: string;
    is_active: boolean;
    person: { full_name: string; type: string; department_section: string } | null;
  }[];

  const juan = listRows.find((u) => u.username === '2025-0001');
  expectEqual('list joins person name', juan?.person?.full_name, 'Juan Dela Cruz');
  expectEqual('list exposes person type', juan?.person?.type, 'student');

  const testadminRow = listRows.find((u) => u.username === 'testadmin');
  expectEqual('superadmin row has no person', testadminRow?.person, null);

  const filtered = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const filteredRows = (filtered.json.data ?? []) as { person: { type: string } | null }[];
  expectEqual(
    'type=student returns only students',
    filteredRows.every((u) => u.person?.type === 'student'),
    true
  );

  const bySection = await request(
    superadmin,
    'GET',
    `/users?department_section=${encodeURIComponent('BSIT - 4A')}&limit=100`
  );
  const sectionRows = (bySection.json.data ?? []) as { username: string }[];
  expectEqual(
    'department filter narrows to that section',
    sectionRows.some((u) => u.username === '2025-0001') &&
      !sectionRows.some((u) => u.username === '2025-0002'),
    true
  );
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run verify:roles`

Expected: FAIL — `list joins person name` reports `undefined`, because `findPaginated` returns raw user documents with no person join and ignores the filters.

- [ ] **Step 3: Add the shared filter builder and the joined query**

In `users.repository.ts`, add the import and the two new members. Keep the existing `findPaginated` — nothing else depends on the new shape yet.

```ts
import { FilterQuery, Types } from 'mongoose';
import { UserModel, IUser } from './users.model';
import { PersonModel } from '../persons/persons.model';
import { PaginationParams } from '../../utils/pagination';
```

```ts
export interface UserListQuery {
  type?: string;
  department_section?: string;
  search?: string;
}

export interface UserWithPerson {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  deactivated_at: Date | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}
```

Add to the `userRepo` object:

```ts
  /**
   * Resolves a person-oriented query into a user filter.
   *
   * `type` and `department_section` describe people, not logins, so they are
   * resolved to person ids first. A query naming either one can only ever match
   * users that have a linked person — accounts without one (superadmin,
   * registrar) drop out, which is what the Accounts view wants.
   *
   * Shared by list, bulk preview, and bulk mutate so all three agree.
   */
  async buildFilter(q: UserListQuery): Promise<FilterQuery<IUser>> {
    const personFilter: FilterQuery<Record<string, unknown>> = {};
    if (q.type) personFilter.type = q.type;
    if (q.department_section) personFilter.department_section = q.department_section;
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      personFilter.$or = [{ full_name: rx }, { id_number: rx }, { rfid_uid: rx }];
    }

    const usesPersonFields = Object.keys(personFilter).length > 0;
    if (!usesPersonFields) return {};

    const personIds = (await PersonModel.find(personFilter).select('_id').lean()).map(
      (p) => p._id as Types.ObjectId
    );
    return { person_id: { $in: personIds } };
  },

  async findPaginatedWithPerson(filter: FilterQuery<IUser>, p: PaginationParams) {
    const [docs, total] = await Promise.all([
      UserModel.find(filter)
        .select(SAFE_FIELDS)
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .populate('person_id', 'full_name type department_section rfid_uid status')
        .lean(),
      UserModel.countDocuments(filter),
    ]);

    const items: UserWithPerson[] = docs.map((d) => {
      const raw = d as unknown as {
        _id: Types.ObjectId;
        username: string;
        role: string;
        is_active: boolean;
        deactivated_at: Date | null;
        person_id:
          | {
              _id: Types.ObjectId;
              full_name: string;
              type: string;
              department_section: string;
              rfid_uid?: string;
              status: string;
            }
          | null;
      };
      return {
        id: String(raw._id),
        username: raw.username,
        role: raw.role,
        is_active: raw.is_active,
        deactivated_at: raw.deactivated_at ?? null,
        person: raw.person_id
          ? {
              id: String(raw.person_id._id),
              full_name: raw.person_id.full_name,
              type: raw.person_id.type,
              department_section: raw.person_id.department_section,
              rfid_uid: raw.person_id.rfid_uid ?? null,
              status: raw.person_id.status,
            }
          : null,
      };
    });

    return { items, total };
  },
```

- [ ] **Step 4: Use them in the service**

Replace `list` in `users.service.ts`:

```ts
  async list(query: Record<string, string | undefined>) {
    const p = getPagination(query);
    const filter = await userRepo.buildFilter({
      type: query.type,
      department_section: query.department_section,
      search: query.search,
    });
    const { items, total } = await userRepo.findPaginatedWithPerson(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
```

- [ ] **Step 5: Run and watch it pass**

Run: `npm run build` — expected PASS. Restart `npm run dev`, then `npm run verify:roles`.

Expected: PASS, all five new checks included.

- [ ] **Step 6: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules/users src/config/verifyRoles.ts
git commit -m "feat(users): join person data into the users list and add shared filters"
```

---

### Task 7: Single-user activate/deactivate

**Files:**
- Modify: `serverside/src/modules/users/users.schema.ts` (add `statusSchema`)
- Modify: `serverside/src/modules/users/users.service.ts` (add `setStatus`)
- Modify: `serverside/src/modules/users/users.controller.ts` (add `setStatus`)
- Modify: `serverside/src/modules/users/users.routes.ts` (add the route)
- Modify: `serverside/src/config/verifyRoles.ts` (add assertions)

**Interfaces:**
- Consumes: `userRepo.findById`, `userRepo.updateById`, `personRepo.updateById`, `check`/`expectEqual`/`request`
- Produces: `userService.setStatus(id: string, active: boolean, actorUserId: string)` returning
  `{ id, is_active, person_status: 'active' | 'inactive' | null }`.
  **Task 8 reuses the exact same dual-write semantics**, so keep them in this one method.

- [ ] **Step 1: Add the failing assertions first**

In `verifyRoles.ts`, insert before `summary();`:

```ts
  console.log('\n== single-user activate / deactivate ==');

  // Find Juan's user id and person id via the joined list.
  const forStatus = await request(superadmin, 'GET', '/users?limit=100');
  const statusRows = (forStatus.json.data ?? []) as {
    id: string;
    username: string;
    person: { id: string; status: string } | null;
  }[];
  const juanRow = statusRows.find((u) => u.username === '2025-0001');
  if (!juanRow?.person) throw new Error('seed missing: student 2025-0001 with a person');
  const juanUserId = juanRow.id;
  const selfRow = statusRows.find((u) => u.username === 'testadmin');
  if (!selfRow) throw new Error('seed missing: testadmin');

  // Only superadmin may flip status.
  await check(
    'registrar cannot deactivate',
    registrar,
    'PATCH',
    `/users/${juanUserId}/status`,
    FORBIDDEN,
    { active: false }
  );
  await check(
    'student cannot deactivate',
    student,
    'PATCH',
    `/users/${juanUserId}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Superadmin cannot deactivate themselves.
  await check(
    'superadmin cannot deactivate self',
    superadmin,
    'PATCH',
    `/users/${selfRow.id}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Deactivating flips both the login and the gate status.
  await check(
    'superadmin deactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: false }
  );

  const afterOff = await request(superadmin, 'GET', '/users?limit=100');
  const offRow = ((afterOff.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login disabled', (offRow as unknown as { is_active: boolean })?.is_active, false);
  expectEqual('person marked inactive', offRow?.person?.status, 'inactive');

  // A deactivated account cannot log in.
  const deniedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '2025-0001', password: 'Student@123' }),
  });
  expectEqual('deactivated user cannot log in', deniedLogin.status, 401);

  // The gate denies the card with the existing reason string.
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gateList = (gatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const mainGate = gateList.find((g) => g.name === 'Main Entrance');
  const gateId = (mainGate?._id ?? mainGate?.id) as string;
  const tap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: 'RFID-STU-0001',
    gate_id: gateId,
    direction: 'entry',
  });
  const tapData = (tap.json.data ?? {}) as { access_result?: string; reason?: string };
  expectEqual('gate denies inactive card', tapData.access_result, 'denied');
  expectEqual('denial reason is inactive_id', tapData.reason, 'inactive_id');

  // Reactivating restores both and clears the audit stamp.
  await check(
    'superadmin reactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: true }
  );
  const afterOn = await request(superadmin, 'GET', '/users?limit=100');
  const onRow = ((afterOn.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login re-enabled', (onRow as unknown as { is_active: boolean })?.is_active, true);
  expectEqual('person re-activated', onRow?.person?.status, 'active');
  expectEqual(
    'audit stamp cleared',
    (onRow as unknown as { deactivated_at: string | null })?.deactivated_at,
    null
  );
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run verify:roles`

Expected: FAIL — every `PATCH /users/:id/status` returns 404, since the route does not exist.

- [ ] **Step 3: Add the schema**

Append to `users.schema.ts`:

```ts
export const userStatusSchema = z.object({
  active: z.boolean(),
});
```

- [ ] **Step 4: Add the service method**

In `users.service.ts`, import the person repository at the top:

```ts
import { personRepo } from '../persons/persons.repository';
```

Add to the `userService` object:

```ts
  /**
   * One toggle, two effects: the login and the RFID card.
   *
   * Deactivating clears refreshTokenHash so an existing session cannot be
   * refreshed back into life, and stamps who did it. Reactivating clears the
   * stamp. Task 8's bulk path applies these same rules.
   */
  async setStatus(id: string, active: boolean, actorUserId: string) {
    if (id === actorUserId) {
      throw new ApiError('FORBIDDEN', 'You cannot change your own account status');
    }

    const target = await userRepo.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', 'User not found');

    await userRepo.updateById(id, {
      is_active: active,
      refreshTokenHash: active ? undefined : null,
      deactivated_at: active ? null : new Date(),
      deactivated_by: active
        ? null
        : (actorUserId as unknown as IUser['deactivated_by']),
    });

    let person_status: 'active' | 'inactive' | null = null;
    if (target.person_id) {
      person_status = active ? 'active' : 'inactive';
      await personRepo.updateById(String(target.person_id), { status: person_status });
    }

    return { id, is_active: active, person_status };
  },
```

- [ ] **Step 5: Add the controller and route**

In `users.controller.ts`, add to the object:

```ts
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.setStatus(req.params.id, req.body.active, req.user!.userId)
    );
  }),
```

In `users.routes.ts`, import `userStatusSchema` alongside the existing schema imports, and add the route below `POST /`:

```ts
userRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN),
  validate(userStatusSchema),
  userController.setStatus
);
```

- [ ] **Step 6: Run and watch it pass**

Run: `npm run build` — expected PASS. Restart `npm run dev`, then `npm run verify:roles`.

Expected: PASS. Note the script leaves Juan reactivated, so it is safe to re-run.

- [ ] **Step 7: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules/users src/config/verifyRoles.ts
git commit -m "feat(users): superadmin activate/deactivate disables login and gate access"
```

---

### Task 8: Bulk activate/deactivate with preview

**Files:**
- Modify: `serverside/src/modules/users/users.schema.ts` (add `bulkStatusSchema`)
- Modify: `serverside/src/modules/users/users.service.ts` (add `bulkPreview`, `bulkSetStatus`)
- Modify: `serverside/src/modules/users/users.controller.ts`
- Modify: `serverside/src/modules/users/users.routes.ts`
- Modify: `serverside/src/config/verifyRoles.ts` (add assertions)

**Interfaces:**
- Consumes: `userRepo.buildFilter` from Task 6; the dual-write rules from Task 7
- Produces:
  - `userService.bulkPreview(query, actorUserId): Promise<{ matched: number; excluded: number }>`
  - `userService.bulkSetStatus(active, filter, actorUserId): Promise<{ matched: number; modified: number; excluded: number }>`

- [ ] **Step 1: Add the failing assertions first**

In `verifyRoles.ts`, insert before `summary();`:

```ts
  console.log('\n== bulk activate / deactivate ==');

  // Only superadmin.
  await check(
    'registrar cannot bulk deactivate',
    registrar,
    'POST',
    '/users/bulk-status',
    FORBIDDEN,
    { active: false, filter: { type: 'student' } }
  );
  await check(
    'registrar cannot preview bulk',
    registrar,
    'GET',
    '/users/bulk-status/preview?type=student',
    FORBIDDEN
  );

  // Preview count must match what the mutation reports.
  const preview = await request(
    superadmin,
    'GET',
    '/users/bulk-status/preview?type=student'
  );
  const previewData = (preview.json.data ?? {}) as { matched: number; excluded: number };
  expectEqual('preview matches the three seeded students', previewData.matched, 3);

  const bulkOff = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: { type: 'student' },
  });
  const bulkData = (bulkOff.json.data ?? {}) as {
    matched: number;
    modified: number;
    excluded: number;
  };
  expectEqual('bulk matched equals preview', bulkData.matched, previewData.matched);
  expectEqual('bulk modified all three', bulkData.modified, 3);

  // Every student is now off, in both places.
  const afterBulk = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const bulkRows = (afterBulk.json.data ?? []) as {
    is_active: boolean;
    person: { status: string } | null;
  }[];
  expectEqual(
    'all students deactivated',
    bulkRows.length === 3 && bulkRows.every((u) => u.is_active === false),
    true
  );
  expectEqual(
    'all student cards inactive',
    bulkRows.every((u) => u.person?.status === 'inactive'),
    true
  );

  // Privileged accounts survive an unfiltered bulk deactivate.
  const bulkAll = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: {},
  });
  const bulkAllData = (bulkAll.json.data ?? {}) as { excluded: number };
  const afterAll = await request(superadmin, 'GET', '/users?limit=100');
  const allRows = (afterAll.json.data ?? []) as {
    username: string;
    role: string;
    is_active: boolean;
  }[];
  expectEqual(
    'superadmin still active after deactivate-all',
    allRows.find((u) => u.username === 'testadmin')?.is_active,
    true
  );
  expectEqual(
    'registrar still active after deactivate-all',
    allRows.find((u) => u.username === 'testregistrar')?.is_active,
    true
  );
  expectEqual('exclusions were counted', bulkAllData.excluded >= 2, true);

  // Restore everyone so the script is re-runnable.
  await check('bulk reactivate all', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });
  const restored = await request(superadmin, 'GET', '/users?limit=100');
  expectEqual(
    'everyone restored',
    ((restored.json.data ?? []) as { is_active: boolean }[]).every((u) => u.is_active),
    true
  );
```

**On the acting-user exclusion:** the spec lists "bulk excludes the acting user" as a
separate assertion, but it cannot be observed through the API. Only a superadmin may call
this endpoint, and `superadmin` is already in `BULK_PROTECTED`, so the actor is always
excluded by role before the self-check is ever reached. The `superadmin still active
after deactivate-all` assertion covers the observable behaviour. Keep the `isSelf` check
in `resolveBulkTargets` regardless — it is the guard that survives any future change to
which roles may call this endpoint.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run verify:roles`

Expected: FAIL — the bulk routes return 404.

- [ ] **Step 3: Add the schema**

Append to `users.schema.ts`:

```ts
export const bulkStatusSchema = z.object({
  active: z.boolean(),
  filter: z
    .object({
      type: z.string().optional(),
      department_section: z.string().optional(),
      search: z.string().optional(),
    })
    .default({}),
});
```

An empty filter is allowed and means every non-privileged account — the end-of-semester lockout case. The typed confirmation in the UI is what guards it.

- [ ] **Step 4: Add the service methods**

In `users.service.ts`, add to the object. Both methods derive their target set the same way, so a preview can never disagree with the mutation that follows it:

```ts
  /**
   * The set a bulk action would touch: the filter, minus privileged accounts,
   * minus the actor. Exclusions are applied here — server-side — so a crafted
   * request cannot reach a superadmin or registrar account.
   */
  async resolveBulkTargets(query: UserListQuery, actorUserId: string) {
    const base = await userRepo.buildFilter(query);
    const candidates = await UserModel.find(base).select('_id role').lean();

    const targets: string[] = [];
    let excluded = 0;
    for (const c of candidates) {
      const isProtected = BULK_PROTECTED.includes(c.role as Role);
      const isSelf = String(c._id) === actorUserId;
      if (isProtected || isSelf) {
        excluded++;
        continue;
      }
      targets.push(String(c._id));
    }
    return { targets, excluded };
  },

  async bulkPreview(query: UserListQuery, actorUserId: string) {
    const { targets, excluded } = await this.resolveBulkTargets(query, actorUserId);
    return { matched: targets.length, excluded };
  },

  async bulkSetStatus(active: boolean, query: UserListQuery, actorUserId: string) {
    const { targets, excluded } = await this.resolveBulkTargets(query, actorUserId);
    if (targets.length === 0) return { matched: 0, modified: 0, excluded };

    const now = new Date();
    const result = await UserModel.updateMany(
      { _id: { $in: targets } },
      {
        $set: {
          is_active: active,
          refreshTokenHash: null,
          deactivated_at: active ? null : now,
          deactivated_by: active ? null : new Types.ObjectId(actorUserId),
        },
      }
    );

    // Mirror onto the linked person records so gates agree with logins.
    const affected = await UserModel.find({ _id: { $in: targets } })
      .select('person_id')
      .lean();
    const personIds = affected
      .map((u) => u.person_id)
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (personIds.length) {
      await PersonModel.updateMany(
        { _id: { $in: personIds } },
        { $set: { status: active ? 'active' : 'inactive' } }
      );
    }

    return { matched: targets.length, modified: result.modifiedCount, excluded };
  },
```

Add these imports at the top of `users.service.ts`:

```ts
import { Types } from 'mongoose';
import { UserModel } from './users.model';
import { PersonModel } from '../persons/persons.model';
import { UserListQuery } from './users.repository';
```

Note `refreshTokenHash` is cleared on both paths here — reactivating in bulk should not restore a stale refresh token.

- [ ] **Step 5: Add the controller methods**

In `users.controller.ts`:

```ts
  bulkPreview: asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    sendSuccess(
      res,
      await userService.bulkPreview(
        { type: q.type, department_section: q.department_section, search: q.search },
        req.user!.userId
      )
    );
  }),

  bulkSetStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.bulkSetStatus(req.body.active, req.body.filter ?? {}, req.user!.userId)
    );
  }),
```

- [ ] **Step 6: Add the routes**

In `users.routes.ts`, import `bulkStatusSchema`. **Register the bulk routes above `PATCH /:id/status`** — Express matches in order, and `/bulk-status` would otherwise be captured by the `:id` parameter:

```ts
userRoutes.get(
  '/bulk-status/preview',
  authorize(ROLES.SUPERADMIN),
  userController.bulkPreview
);
userRoutes.post(
  '/bulk-status',
  authorize(ROLES.SUPERADMIN),
  validate(bulkStatusSchema),
  userController.bulkSetStatus
);
```

- [ ] **Step 7: Run and watch it pass**

Run: `npm run build` — expected PASS. Restart `npm run dev`, then `npm run verify:roles`.

Expected: PASS, entire suite. The script restores every account at the end, so re-running gives the same result.

- [ ] **Step 8: Commit**

```bash
cd C:\thesis_rfid\serverside
git add src/modules/users src/config/verifyRoles.ts
git commit -m "feat(users): bulk activate/deactivate with preview and server-side exclusions"
```

---

### Task 9: Client auth types and the permission map

**Files:**
- Modify: `userpage/lib/auth.ts:3-9` (`AuthUser`), plus a new export
- Create: `userpage/lib/permissions.ts`

**Interfaces:**
- Consumes: the four role strings
- Produces:
  - `type Role = 'superadmin' | 'registrar' | 'staff' | 'student'` from `lib/auth.ts`
  - `AuthUser.role: Role`
  - `redirectForRole(role: Role): '/admin' | '/dashboard'`
  - `type AdminView = 'overview' | 'directory' | 'parking' | 'register' | 'accounts'`
  - `NAV_BY_ROLE: Record<Role, { id: AdminView; label: string }[]>`
  - `isStaffSide(role: Role): boolean`
  - `can(role: Role, action: Action): boolean` with
    `type Action = 'manageStatus' | 'registerPeople' | 'viewDirectory' | 'viewReports'`
  Tasks 10–13 all import from these two modules.

- [ ] **Step 1: Widen `AuthUser`**

In `userpage/lib/auth.ts`, replace the interface at the top:

```ts
export type Role = "superadmin" | "registrar" | "staff" | "student";

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  personId: string | null;
  mustChangePassword: boolean;
}
```

Append to the same file:

```ts
/** Where a role lands after signing in. */
export function redirectForRole(role: Role): "/admin" | "/dashboard" {
  return role === "superadmin" || role === "registrar" ? "/admin" : "/dashboard";
}
```

- [ ] **Step 2: Create `lib/permissions.ts`**

This mirrors the server's permission matrix. It drives navigation only — the server is the enforcement boundary.

```ts
import type { Role } from "./auth";

export type AdminView =
  | "overview"
  | "directory"
  | "parking"
  | "register"
  | "accounts";

export type Action =
  | "manageStatus"
  | "registerPeople"
  | "viewDirectory"
  | "viewReports";

/**
 * Mirrors the server matrix in
 * docs/superpowers/specs/2026-07-26-role-system-design.md.
 * This is a usability layer; the API enforces the real boundary.
 */
const ABILITIES: Record<Role, Action[]> = {
  superadmin: ["manageStatus", "registerPeople", "viewDirectory", "viewReports"],
  registrar: ["registerPeople", "viewDirectory"],
  staff: [],
  student: [],
};

export function can(role: Role, action: Action): boolean {
  return ABILITIES[role].includes(action);
}

export function isStaffSide(role: Role): boolean {
  return role === "superadmin" || role === "registrar";
}

export const NAV_BY_ROLE: Record<Role, { id: AdminView; label: string }[]> = {
  superadmin: [
    { id: "overview", label: "Overview" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
    { id: "register", label: "Register" },
    { id: "accounts", label: "Accounts" },
  ],
  registrar: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
  ],
  staff: [],
  student: [],
};

/** The view a role sees when it opens /admin with no tab selected. */
export function defaultViewFor(role: Role): AdminView | null {
  return NAV_BY_ROLE[role][0]?.id ?? null;
}
```

- [ ] **Step 3: Verify the type change surfaces every stale comparison**

Run: `cd C:\thesis_rfid\userpage && npx tsc --noEmit`

Expected: FAIL, with errors in `components/LoginExperience.tsx` (around lines 99, 102, 117) and `app/admin/page.tsx` and `app/dashboard/page.tsx` where `user.role === "admin"` is compared against the new union. These are exactly the sites Tasks 10 and 11 fix.

Record the error list.

- [ ] **Step 4: Commit**

```bash
cd C:\thesis_rfid\userpage
git add lib/auth.ts lib/permissions.ts
git commit -m "feat(roles): four-role client types and permission map

Type errors at the role comparison sites are expected until the login and
admin shell tasks land."
```

---

### Task 10: Login without the role picker

**Files:**
- Modify: `userpage/components/LoginExperience.tsx`
- Modify: `userpage/app/login/user/page.tsx`
- Modify: `userpage/app/login/admin/page.tsx`
- Modify: `userpage/README.md`

**Interfaces:**
- Consumes: `redirectForRole`, `AuthUser`, `storeAuth`, `API_BASE` from `lib/auth`
- Produces: `<LoginExperience />` with no props.

- [ ] **Step 1: Strip the mode state and derived labels**

In `components/LoginExperience.tsx`:

- Delete the `Mode`, `UserKind` types and the `USER_KINDS` array.
- Change the signature to `export default function LoginExperience() {` and delete the `initialMode` prop and the `mode` / `userKind` state.
- Delete `isAdmin`, `roleLabel`, `usernameLabel`, `usernamePlaceholder` and the `accent` ternary. Replace `accent` with the fixed blue theme:

```ts
  const accent = {
    bg: "bg-blue",
    hover: "hover:bg-navy-500",
    text: "text-blue",
    soft: "bg-blue-soft",
  };
```

- Update the import to add `redirectForRole`:

```ts
import { API_BASE, redirectForRole, storeAuth, type AuthUser } from "@/lib/auth";
```

- [ ] **Step 2: Replace the post-login branch**

Around lines 98–117 the component asserts the chosen tab matches the account role, then redirects. Delete the mismatch check entirely and replace the redirect:

```ts
      storeAuth(accessToken, user, remember);
      showNotice("success", `Signed in as “${user.username}”. Redirecting…`);
      router.push(redirectForRole(user.role));
```

- [ ] **Step 3: Remove the toggle markup**

Delete the `role="tablist"` block (mode toggle, around line 160) and the student/staff sub-toggle block (around line 202), through to where the username field begins.

Replace the username label and placeholder — which were derived from the deleted state — with fixed copy:

```tsx
              Username
```

```tsx
              placeholder="Student number, staff or admin username"
```

Replace the submit button label (around line 312) with:

```tsx
                <>Sign in</>
```

- [ ] **Step 4: Collapse the deep-link routes**

`/login/user` and `/login/admin` only existed to preselect a tab that no longer exists. Keep the URLs working by redirecting.

Replace the entire contents of `app/login/user/page.tsx` and `app/login/admin/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

export default function Page() {
  redirect("/login");
}
```

- [ ] **Step 5: Verify types and lint**

Run: `cd C:\thesis_rfid\userpage && npx tsc --noEmit`

Expected: the `LoginExperience.tsx` errors from Task 9 Step 3 are gone. Errors in `app/admin/page.tsx` and `app/dashboard/page.tsx` remain — Task 11 fixes those.

Run: `npm run lint`

Expected: no errors in `LoginExperience.tsx`. Remove any import left unused by the deletions.

- [ ] **Step 6: Verify by hand**

With the backend running and `npm run dev` on the frontend, open `http://localhost:5173/login` and sign in as each account. Confirm:

| Account | Password | Lands on |
|---|---|---|
| `testadmin` | `Admin@123` | `/admin` |
| `testregistrar` | `Registrar@123` | `/admin` |
| `2025-0001` | `Student@123` | `/dashboard` |
| `EMP-1001` | `Staff@123` | `/dashboard` |

Also confirm `http://localhost:5173/login/admin` redirects to `/login`.

- [ ] **Step 7: Update the README**

In `userpage/README.md`, replace the Screens table with:

| Route | Purpose |
| --- | --- |
| `/login` | Username and password; the server's role decides the destination |
| `/login/user`, `/login/admin` | Legacy deep links, redirect to `/login` |
| `/` | Redirects to `/login` |

Replace the "Behaviour" bullets with:

```markdown
- One form for every role. The API returns the account's role on success and the
  client routes on it: superadmin and registrar to `/admin`, staff and students to
  `/dashboard`. There is no role picker, so nobody can choose the wrong one and
  the form never reveals which usernames are privileged.
- Responsive (brand panel collapses under `lg`), accessible (labelled inputs), and
  respects `prefers-reduced-motion`.
```

Delete the "Not yet wired" section — the form has been wired since the backend landed, and it now describes behaviour that no longer exists.

- [ ] **Step 8: Commit**

```bash
cd C:\thesis_rfid\userpage
git add components/LoginExperience.tsx app/login README.md
git commit -m "feat(login): drop the role picker, route on the server's role"
```

---

### Task 11: Admin shell with role-filtered navigation

**Files:**
- Create: `userpage/components/admin/AdminShell.tsx`
- Create: `userpage/components/admin/OverviewView.tsx`
- Create: `userpage/components/admin/ParkingView.tsx`
- Create: `userpage/components/admin/types.ts`
- Modify: `userpage/app/admin/page.tsx` (reduced to a guard plus the shell)
- Modify: `userpage/app/dashboard/page.tsx:24-27` (staff-side redirect)

**Interfaces:**
- Consumes: `NAV_BY_ROLE`, `defaultViewFor`, `isStaffSide`, `AdminView` from Task 9
- Produces:
  - `components/admin/types.ts` exporting `GateStatus`, `ScanRow`, `ParkingRow`, `AdminDashboard`, `fmtDateTime` — **moved verbatim** from `app/admin/page.tsx:6-49`, and imported by Tasks 12 and 13
  - `<OverviewView data={AdminDashboard} />`
  - `<ParkingView data={AdminDashboard} />`
  - `<AdminShell user={AuthUser} />` owning nav state, data fetch, and logout

- [ ] **Step 1: Extract the shared types**

Create `components/admin/types.ts` and move `GateStatus`, `ScanRow`, `ParkingRow`, `AdminDashboard`, the `StatKey` type, the `STATS` array, and `fmtDateTime` out of `app/admin/page.tsx` unchanged. Export each one. Do not alter any field — the shapes match the API responses already in use.

- [ ] **Step 2: Extract the two existing views**

Create `components/admin/OverviewView.tsx` and `components/admin/ParkingView.tsx`. Move the corresponding JSX out of `app/admin/page.tsx` verbatim. Each takes `{ data }: { data: AdminDashboard }` and imports its types from `./types`. Both start with `"use client";`.

Change nothing visually. This step is a pure move, so any rendering difference afterwards is a mistake.

- [ ] **Step 3: Write the shell**

Create `components/admin/AdminShell.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NcstMark from "@/components/NcstMark";
import StudentsDirectory from "@/components/StudentsDirectory";
import PersonProfile from "@/components/PersonProfile";
import OverviewView from "./OverviewView";
import ParkingView from "./ParkingView";
import type { AdminDashboard } from "./types";
import { apiGet, logout, type AuthUser } from "@/lib/auth";
import { NAV_BY_ROLE, defaultViewFor, type AdminView } from "@/lib/permissions";

export default function AdminShell({ user }: { user: AuthUser }) {
  const router = useRouter();
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<AdminView | null>(defaultViewFor(user.role));
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const nav = NAV_BY_ROLE[user.role];

  useEffect(() => {
    apiGet<AdminDashboard>("/dashboard")
      .then(setData)
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [router]);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  function go(v: AdminView) {
    setSelected(null);
    setView(v);
  }

  return (
    <main className="min-h-dvh bg-paper">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <NcstMark className="h-9 w-9" />
            <div className="leading-tight">
              <p className="font-display text-base font-700 tracking-tight text-navy">
                NCST RFID
              </p>
              <p className="text-[11px] font-500 uppercase tracking-[0.18em] text-ink-soft">
                {user.role === "superadmin" ? "Administration" : "Registrar"}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:border-red/40 hover:text-red"
          >
            Sign out
          </button>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 px-6">
          {nav.map((item) => (
            <button
              key={item.id}
              onClick={() => go(item.id)}
              aria-current={view === item.id ? "page" : undefined}
              className={
                view === item.id
                  ? "border-b-2 border-navy px-4 py-3 text-sm font-600 text-navy"
                  : "border-b-2 border-transparent px-4 py-3 text-sm font-500 text-ink-soft transition hover:text-navy"
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
        {error && (
          <p className="rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-soft">
            Couldn&apos;t load dashboard data: {error}
          </p>
        )}
        {loading && <p className="text-ink-soft">Loading…</p>}

        {!loading && view === "overview" && data && <OverviewView data={data} />}
        {!loading && view === "parking" && data && <ParkingView data={data} />}
        {!loading && view === "directory" &&
          (selected ? (
            <PersonProfile
              personId={selected.id}
              name={selected.name}
              onBack={() => setSelected(null)}
            />
          ) : (
            <StudentsDirectory onView={(id, name) => setSelected({ id, name })} />
          ))}
      </div>
    </main>
  );
}
```

These prop names are the real ones, confirmed against the components:

- `StudentsDirectory({ onView }: { onView: (personId: string, name: string) => void })`
- `PersonProfile({ personId, name, onBack }: { personId: string; name?: string; onBack: () => void })`

The `onView` callback takes two positional arguments, so it cannot be passed `setSelected`
directly — the arrow wrapper above is required.

The `register` and `accounts` views are added by Tasks 12 and 13.

- [ ] **Step 4: Reduce the page to a guard**

Replace `app/admin/page.tsx` entirely:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import { getStoredUser, getToken, type AuthUser } from "@/lib/auth";
import { isStaffSide } from "@/lib/permissions";

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = getStoredUser();
    if (!getToken() || !stored) {
      router.replace("/login");
      return;
    }
    if (!isStaffSide(stored.role)) {
      router.replace("/dashboard");
      return;
    }
    setUser(stored);
  }, [router]);

  if (!user) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper text-ink-soft">
        Loading…
      </main>
    );
  }

  return <AdminShell user={user} />;
}
```

- [ ] **Step 5: Fix the dashboard's inverse guard**

`app/dashboard/page.tsx:24-27` still redirects on `stored.role === "admin"`. Replace with:

```tsx
    if (isStaffSide(stored.role)) {
      router.replace("/admin");
      return;
    }
```

Add the import:

```tsx
import { isStaffSide } from "@/lib/permissions";
```

- [ ] **Step 6: Verify types, lint, and behaviour**

Run: `npx tsc --noEmit` — expected PASS, zero errors. Every site from Task 9 Step 3 is now fixed.
Run: `npm run lint` — expected PASS.

By hand, with both servers running:
- Sign in as `testadmin` → `/admin` shows tabs Overview, Directory, Parking. Overview and Parking render exactly as before the extraction.
- Sign in as `testregistrar` → `/admin` shows only Directory (Register arrives in Task 12), and the header reads "Registrar".
- Sign in as `2025-0001` → lands on `/dashboard`; manually visiting `/admin` bounces back to `/dashboard`.

- [ ] **Step 7: Commit**

```bash
cd C:\thesis_rfid\userpage
git add components/admin app/admin/page.tsx app/dashboard/page.tsx
git commit -m "refactor(admin): extract views into an AdminShell with role-filtered nav"
```

---

### Task 12: Register view

**Files:**
- Create: `userpage/components/admin/RegisterView.tsx`
- Modify: `userpage/components/admin/AdminShell.tsx` (wire the view)

**Interfaces:**
- Consumes: existing `PersonForm` and `ImportPersons` components
- Produces: `<RegisterView />`, rendered for the `register` view id

- [ ] **Step 1: Note the props these components actually require**

Both were written for a modal context and take two **required** props each:

```ts
PersonForm({ onCreated, onClose }: {
  onCreated: (person: PersonRecord) => void;   // PersonRecord from @/components/RegistrationForm
  onClose: () => void;
})

ImportPersons({ onDone, onClose }: {
  onDone: () => void;
  onClose: () => void;
})
```

`RegisterView` renders them inline rather than in a modal, so it must still supply all
four. `onClose` becomes "collapse this panel back to its button," which gives both props
honest behaviour instead of a no-op.

- [ ] **Step 2: Write the view**

Create `components/admin/RegisterView.tsx`:

```tsx
"use client";

import { useState } from "react";
import PersonForm from "@/components/PersonForm";
import ImportPersons from "@/components/ImportPersons";
import type { PersonRecord } from "@/components/RegistrationForm";

type Panel = "single" | "import" | null;

export default function RegisterView() {
  const [panel, setPanel] = useState<Panel>("single");
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const [importedAt, setImportedAt] = useState<number | null>(null);

  // Remounting clears the form between registrations.
  const [formKey, setFormKey] = useState(0);

  function handleCreated(person: PersonRecord) {
    setLastCreated(person.full_name);
    setFormKey((k) => k + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Register</h1>
        <p className="text-sm text-ink-soft">
          Create a person record and assign their RFID card. One card per person works at
          every campus gate.
        </p>
      </div>

      {lastCreated && (
        <p className="rounded-xl border border-blue/30 bg-blue-soft px-4 py-3 text-sm text-blue">
          Registered {lastCreated}. The form is ready for the next person.
        </p>
      )}
      {importedAt && (
        <p className="rounded-xl border border-blue/30 bg-blue-soft px-4 py-3 text-sm text-blue">
          Import finished. Check the Directory tab to review the new records.
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setPanel("single")}
          className={
            panel === "single"
              ? "rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
              : "rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
          }
        >
          Single person
        </button>
        <button
          onClick={() => setPanel("import")}
          className={
            panel === "import"
              ? "rounded-xl bg-navy px-4 py-2 text-sm font-600 text-white"
              : "rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy"
          }
        >
          Bulk import
        </button>
      </div>

      {panel === "single" && (
        <section className="rounded-2xl border border-line bg-white p-6">
          <PersonForm
            key={formKey}
            onCreated={handleCreated}
            onClose={() => setPanel(null)}
          />
        </section>
      )}

      {panel === "import" && (
        <section className="rounded-2xl border border-line bg-white p-6">
          <ImportPersons
            onDone={() => setImportedAt(Date.now())}
            onClose={() => setPanel(null)}
          />
        </section>
      )}
    </div>
  );
}
```

If `PersonRecord` is not exported from `components/RegistrationForm.tsx`, type the
`handleCreated` parameter as `{ full_name: string }` rather than adding a new export.

- [ ] **Step 3: Wire it into the shell**

In `AdminShell.tsx`, add the import and the branch:

```tsx
import RegisterView from "./RegisterView";
```

```tsx
        {!loading && view === "register" && <RegisterView />}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` and `npm run lint` — expected PASS.

By hand: sign in as `testregistrar`. The Register tab is the landing view and shows both panels. Register a person with a unique ID number and RFID, then switch to Directory and confirm they appear. Sign in as `testadmin` and confirm the Register tab is present there too.

- [ ] **Step 5: Commit**

```bash
cd C:\thesis_rfid\userpage
git add components/admin
git commit -m "feat(admin): add the register view for registrars and superadmins"
```

---

### Task 13: Accounts view with Deactivate All

**Files:**
- Create: `userpage/components/admin/AccountsView.tsx`
- Modify: `userpage/components/admin/AdminShell.tsx` (wire the view)
- Modify: `userpage/lib/auth.ts` (add `apiPatch` and `apiPost` if absent)

**Interfaces:**
- Consumes: `GET /users`, `PATCH /users/:id/status`, `GET /users/bulk-status/preview`, `POST /users/bulk-status` from Tasks 6–8; `can` from Task 9
- Produces: `<AccountsView />`, rendered for the `accounts` view id

- [ ] **Step 1: Add `apiPatch`**

`lib/auth.ts` already exports `apiGet`, `apiGetList`, `apiPost`, and `apiGetBlob`. There
is **no** `apiPatch`, and this view needs one. Add it directly below `apiPost`, mirroring
that function exactly so error handling stays uniform:

```ts
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !parsed || parsed.success !== true) {
    const failure = parsed as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return parsed.data;
}
```

`ApiError` is the existing local interface in that file — do not redeclare it.

Note that `apiGet<T>` returns `parsed.data`, so `apiGet<AccountRow[]>("/users?…")`
resolves to the array itself, not to a `{ items }` wrapper.

- [ ] **Step 2: Write the view**

Create `components/admin/AccountsView.tsx`. The typed confirmation and the live preview count are the point of this screen — both must be present.

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type Role } from "@/lib/auth";

interface AccountRow {
  id: string;
  username: string;
  role: Role;
  is_active: boolean;
  deactivated_at: string | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}

const CONFIRM_WORD = "DEACTIVATE";

export default function AccountsView() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [type, setType] = useState("");
  const [section, setSection] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<{ matched: number; excluded: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (section) p.set("department_section", section);
    if (search) p.set("search", search);
    return p;
  }, [type, section, search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = query();
      p.set("limit", "100");
      const list = await apiGet<AccountRow[]>(`/users?${p.toString()}`);
      setRows(list);
      const pv = await apiGet<{ matched: number; excluded: number }>(
        `/users/bulk-status/preview?${query().toString()}`,
      );
      setPreview(pv);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleOne(row: AccountRow) {
    setBusy(true);
    try {
      await apiPatch(`/users/${row.id}/status`, { active: !row.is_active });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(active: boolean) {
    setBusy(true);
    try {
      await apiPost("/users/bulk-status", {
        active,
        filter: {
          ...(type ? { type } : {}),
          ...(section ? { department_section: section } : {}),
          ...(search ? { search } : {}),
        },
      });
      setConfirming(false);
      setTyped("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filterWords = [
    type ? `type ${type}` : null,
    section ? `section ${section}` : null,
    search ? `matching “${search}”` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-700 text-navy">Accounts</h1>
        <p className="text-sm text-ink-soft">
          Deactivating an account blocks both the web portal and the person&apos;s RFID
          card at every gate.
        </p>
      </div>

      {error && (
        <p className="rounded-xl border border-red/30 bg-red/5 px-4 py-3 text-sm text-red">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
          >
            <option value="">All</option>
            <option value="student">Student</option>
            <option value="staff">Staff</option>
            <option value="employee">Employee</option>
          </select>
        </label>

        <label className="text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Section
          <input
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="e.g. BSIT - 4A"
            className="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="flex-1 text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, ID number or RFID"
            className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
          />
        </label>

        <button
          onClick={() => setConfirming(true)}
          disabled={busy || !preview || preview.matched === 0}
          className="rounded-xl bg-red px-4 py-2 text-sm font-600 text-white transition hover:bg-red-deep disabled:opacity-40"
        >
          Deactivate all ({preview?.matched ?? 0})
        </button>
        <button
          onClick={() => void runBulk(true)}
          disabled={busy || !preview || preview.matched === 0}
          className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-600 text-ink-soft transition hover:text-navy disabled:opacity-40"
        >
          Activate all
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.12em] text-ink-soft">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Section</th>
              <th className="px-4 py-3">RFID</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3 font-500 text-ink">
                  {r.person?.full_name ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-soft">{r.username}</td>
                <td className="px-4 py-3 text-ink-soft">{r.role}</td>
                <td className="px-4 py-3 text-ink-soft">
                  {r.person?.department_section ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                  {r.person?.rfid_uid ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      r.is_active
                        ? "rounded-full bg-blue-soft px-2 py-1 text-xs font-600 text-blue"
                        : "rounded-full bg-red/10 px-2 py-1 text-xs font-600 text-red"
                    }
                  >
                    {r.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => void toggleOne(r)}
                    disabled={busy}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-600 text-ink-soft transition hover:text-navy disabled:opacity-40"
                  >
                    {r.is_active ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-soft">
                  No accounts match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-navy/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6">
            <h2 className="font-display text-lg font-700 text-navy">
              Deactivate {preview?.matched ?? 0} account
              {preview?.matched === 1 ? "" : "s"}?
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              {filterWords.length
                ? `This affects accounts with ${filterWords.join(", ")}.`
                : "This affects every student and staff account."}{" "}
              They will not be able to sign in, and their RFID cards will be refused at
              every gate.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Superadmin and registrar accounts are never affected
              {preview?.excluded ? ` (${preview.excluded} excluded)` : ""}.
            </p>

            <label className="mt-4 block text-xs font-600 uppercase tracking-[0.12em] text-ink-soft">
              Type {CONFIRM_WORD} to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 block w-full rounded-xl border border-line px-3 py-2 text-sm text-ink"
                autoFocus
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setConfirming(false);
                  setTyped("");
                }}
                className="rounded-xl border border-line px-4 py-2 text-sm font-600 text-ink-soft"
              >
                Cancel
              </button>
              <button
                onClick={() => void runBulk(false)}
                disabled={typed !== CONFIRM_WORD || busy}
                className="rounded-xl bg-red px-4 py-2 text-sm font-600 text-white disabled:opacity-40"
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the shell**

In `AdminShell.tsx`:

```tsx
import AccountsView from "./AccountsView";
```

```tsx
        {!loading && view === "accounts" && <AccountsView />}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` and `npm run lint` — expected PASS.

By hand, signed in as `testadmin`:
1. Open Accounts. Every seeded account is listed with its person's name and section.
2. Deactivate `2025-0002` with the row button. The badge flips to Inactive.
3. In a private window, try signing in as `2025-0002` / `Student@123` — it must fail.
4. Reactivate the row; the sign-in works again.
5. Set the Type filter to `student`. The Deactivate all button reads `Deactivate all (3)`.
6. Click it. Confirm the modal names the filter, the Deactivate button is disabled until `DEACTIVATE` is typed exactly, and Cancel closes without changes.
7. Confirm it. All three students flip to Inactive, and `testadmin` and `testregistrar` stay Active.
8. Click Activate all to restore.

Confirm `testregistrar` has no Accounts tab.

- [ ] **Step 5: Commit**

```bash
cd C:\thesis_rfid\userpage
git add components/admin lib/auth.ts
git commit -m "feat(admin): accounts view with single and bulk activate/deactivate"
```

---

### Task 14: Full-system verification

**Files:**
- Modify: `userpage/README.md` (project-structure section)

**Interfaces:**
- Consumes: everything above
- Produces: no code

- [ ] **Step 1: Reseed from clean and run the backend suite**

```bash
cd C:\thesis_rfid\serverside
node -e "require('dotenv').config();const m=require('mongoose');m.connect(process.env.MONGODB_URI).then(async()=>{await m.connection.collection('users').deleteMany({});await m.disconnect();})"
npm run seed
npm run seed:test
npm run build
npm run lint
```

Then with `npm run dev` running, in a second terminal:

```bash
npm run verify:roles
```

Expected: `All role checks passed.` and exit code 0. Confirm the exit code with `echo $?` (Git Bash) or `echo $LASTEXITCODE` (PowerShell).

- [ ] **Step 2: Run the frontend checks**

```bash
cd C:\thesis_rfid\userpage
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Walk the role matrix by hand**

With both servers running, sign in as each account and confirm:

| Account | Lands on | Tabs visible | Must NOT see |
|---|---|---|---|
| `testadmin` | `/admin` | Overview, Directory, Parking, Register, Accounts | — |
| `testregistrar` | `/admin` | Register, Directory | Overview, Parking, Accounts |
| `2025-0001` | `/dashboard` | own profile | `/admin` (bounces back) |
| `EMP-1001` | `/dashboard` | own profile | `/admin` (bounces back) |

- [ ] **Step 4: Update the frontend project structure docs**

In `userpage/README.md`, replace the "Project structure" block with the current tree, including `components/admin/` and `lib/permissions.ts`. List each file with a one-line description, matching the existing style of that section.

- [ ] **Step 5: Commit and report**

```bash
cd C:\thesis_rfid\userpage
git add README.md
git commit -m "docs: update project structure for the admin shell and permissions"
```

Report to the user: the verify:roles pass count, the result of each build and lint command, and the hand-walk table with any deviation noted. Do not describe the work as complete unless every command above passed — if something failed, say which and show the output.

---

## Deferred, deliberately

These are named so a reviewer can see they were considered and not forgotten:

- **`POST /scan/tap` authorization.** Any authenticated user can post a scan for an arbitrary RFID UID. Out of scope pending an answer to how the ESP/Raspberry Pi readers authenticate; the likely fix is a `device` role with per-gate credentials.
- **Registrar dashboard.** The spec describes a registration-focused view; Task 2 Step 4 routes registrar to the full admin view instead. Functionally harmless — registrar sees counts they are allowed to see — but it should be narrowed when the registrar dashboard is designed.
- **`userRepo.findPaginated`.** Superseded by `findPaginatedWithPerson` but left in place; remove it once nothing imports it.
- **Subsystems B, C, D** — gadget registry, digital signature, renewal applications. Each gets its own spec and plan.
