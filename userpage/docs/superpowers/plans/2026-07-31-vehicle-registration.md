# Vehicle Registration (Car Pass Application) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an OSS clerk transcribe a signed car-pass application into the system, preserving the submitted form as an immutable document and issuing the RFID sticker the gate reads.

**Architecture:** Two entities. An immutable `VehicleApplication` holds the form exactly as submitted, with its signature in its own collection keyed by application id. Creating one writes application → signature → `Vehicle`, in that order, so a partial failure leaves paperwork with no access granted. The `Vehicle` gains `valid_until`, and the gate denies an expired tap with `vehicle_expired` before anti-passback can move occupancy.

**Tech Stack:** TypeScript, Express, Mongoose 8, Zod, multer (backend); Next.js 16 + React 19 + Tailwind 4 (frontend). Verification is black-box `ts-node` harnesses, not a unit-test framework.

**Spec:** `docs/superpowers/specs/2026-07-31-vehicle-registration-design.md`

## Global Constraints

- **No unit-test framework exists and none may be added.** Verification extends the black-box harnesses in `serverside/src/config/verify*.ts`, run via `npm run verify:roles`, `verify:gates`, `verify:signatures`, `verify:passback`.
- **The harnesses can now be run as a suite.** `VERIFY_BYPASS_TOKEN` is set in `.env` and `installVerifyBypass()` wraps `fetch` once per process, so `npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback` works at production rate limits. Use it; do not raise `RATE_LIMIT_MAX`.
- **Two repos.** Backend `C:\thesis_rfid\serverside`, frontend `C:\thesis_rfid\userpage`. Both are on `main`, clean and pushed. Create branch `feat/vehicle-registration` in each.
- **Commit style differs per repo.** `serverside` uses conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`). `userpage` uses plain sentence subjects with no prefix.
- **Next.js 16 is not the Next.js you know.** `userpage/AGENTS.md` requires reading the relevant guide in `node_modules/next/dist/docs/` before writing frontend code.
- **Never derive a calendar date with `toISOString()`.** This codebase has paid for it twice — attendance bucketing, and the `/logs` filters that excluded the selected day entirely. Use local `Date` components.
- **A dev server is already running on :3000 and auto-reloads edits.** Do NOT run `npm run dev` in `serverside` — it fails EADDRINUSE and orphans a process tree.
- **Every assertion must be able to fail.** Collection assertions need a length floor — `.every()` on `[]` is `true`, which has caused real defects here. Comparisons must confirm both values are present rather than matching `undefined` to `undefined`.
- **`npm run verify:roles` must produce byte-identical output on two consecutive runs**, and every probe record must be covered by the `PROBE_*` cleanup arrays.
- **Every commit must build:** `npm run build` and `npm run lint` clean.
- **Required fields stay few.** The client's real form left Email, Tel No, Driver's License No, LTO CR and Relationship blank, with OR No as `~`. A schema demanding them rejects real applications.

---

## File Structure

**Backend (`serverside`)**

| File | Responsibility |
|---|---|
| `src/config/env.ts` | modify — add `SCHOOL_YEAR_END_MMDD` with `MM-DD` validation |
| `src/utils/schoolYear.ts` | **create** — `nextSchoolYearEnd()`, local-time, pure |
| `src/modules/vehicles/vehicles.model.ts` | modify — drop `unique` on owner, add `make`/`color`/`valid_until`, enum `vehicle_type` |
| `src/modules/vehicles/vehicles.schema.ts` | modify — match the model |
| `src/modules/vehicles/vehicles.service.ts` | modify — remove the one-vehicle-per-owner check |
| `src/modules/vehicleApplications/*` | **create** — model, repo, service, controller, routes, schema |
| `src/modules/vehicleApplications/applicationSignatures.*` | **create** — model, repo, service |
| `src/middlewares/uploadImage.ts` | modify — export an `uploadApplicationSignature` handler |
| `src/modules/scan/scan.service.ts` | modify — `vehicle_expired` clause |
| `src/app.ts` | modify — mount `/vehicle-applications` |
| `src/config/testSeed.ts` | modify — seeded vehicles need `valid_until`, `make`, enum type |
| `src/config/verifyRoles.ts` | modify — application checks + probe cleanup |
| `src/config/verifyGates.ts` | modify — expiry at the gate |
| `.env.example`, `README.md` | modify — document `SCHOOL_YEAR_END_MMDD` |

**Frontend (`userpage`)**

| File | Responsibility |
|---|---|
| `lib/permissions.ts` | modify — `NAV_BY_ROLE.oss` gains `register` |
| `lib/reasonText.ts` | modify — `vehicle_expired` |
| `components/gate/GateTerminal.tsx` | modify — `vehicle_expired` |
| `components/vehicles/VehicleApplicationForm.tsx` | **create** — the counter form |
| `components/admin/RegisterView.tsx` | modify — Vehicle panel for OSS |

---

## Task 1: School-year expiry helper

**Files:**
- Modify: `serverside/src/config/env.ts`
- Create: `serverside/src/utils/schoolYear.ts`
- Modify: `serverside/.env.example`, `serverside/README.md`
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `env.SCHOOL_YEAR_END_MMDD` (string, `MM-DD`, default `03-31`) and `nextSchoolYearEnd(from?: Date): Date` — the next occurrence of that month/day at end-of-day, in **local** time. Tasks 3 and 5 both use it.

- [ ] **Step 1: Write the failing checks**

Add to `verifyRoles.ts` alongside the other pure-function blocks (import at top):

```ts
import { nextSchoolYearEnd } from '../utils/schoolYear';
```

```ts
  console.log('\n== school-year expiry helper ==');

  // Default is 03-31. A date before it in the same year resolves to this year.
  const beforeCutoff = nextSchoolYearEnd(new Date(2026, 6, 27)); // 2026-07-27 local
  expectEqual('expiry lands on the configured month', beforeCutoff.getMonth(), 2); // March
  expectEqual('expiry lands on the configured day', beforeCutoff.getDate(), 31);
  expectEqual('a July date rolls to next year', beforeCutoff.getFullYear(), 2027);

  // A date after the cutoff rolls forward a further year.
  const afterCutoff = nextSchoolYearEnd(new Date(2027, 4, 2)); // 2027-05-02 local
  expectEqual('a May date rolls to the following year', afterCutoff.getFullYear(), 2028);

  // Exactly ON the cutoff day is still valid that day — end-of-day, not midnight.
  const onCutoff = nextSchoolYearEnd(new Date(2027, 2, 31, 9, 0, 0));
  expectEqual('the cutoff day itself does not roll over', onCutoff.getFullYear(), 2027);
  expectEqual('expiry is end-of-day, not midnight', onCutoff.getHours(), 23);
  expectEqual('expiry minutes are end-of-day', onCutoff.getMinutes(), 59);

  // Local, never UTC: constructed from local components, so the local date
  // components round-trip regardless of the host timezone.
  const local = nextSchoolYearEnd(new Date(2026, 6, 27));
  expectEqual('expiry is built from local components', local.getDate(), 31);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:roles`
Expected: FAIL at compile — `Cannot find module '../utils/schoolYear'`.

- [ ] **Step 3: Write the implementation**

`env.ts` — add beside `OCCUPANCY_RESET_TIME`, matching its validate-at-startup shape:

```ts
  // Validated at startup for the same reason OCCUPANCY_RESET_TIME is: a
  // malformed value here silently becomes an Invalid Date, and this one decides
  // whether a vehicle pass opens a barrier. Failing closed at boot beats silent
  // corruption.
  SCHOOL_YEAR_END_MMDD: z
    .string()
    .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'SCHOOL_YEAR_END_MMDD must be MM-DD')
    .default('03-31'),
```

Create `src/utils/schoolYear.ts`:

```ts
import { env } from '../config/env';

/**
 * The next occurrence of SCHOOL_YEAR_END_MMDD, at the end of that day, in
 * LOCAL time.
 *
 * Local, not UTC, for the same reason scanService.dateKey() and
 * lastResetBoundary() are: this codebase buckets by the server's local
 * calendar, and a UTC-derived boundary lands on the wrong day for part of
 * every day outside UTC+0. That has caused two real defects here already.
 *
 * End-of-day rather than midnight so a pass valid until 2027-03-31 works for
 * all of that day, rather than expiring as it begins.
 */
export function nextSchoolYearEnd(from: Date = new Date()): Date {
  const [mm, dd] = env.SCHOOL_YEAR_END_MMDD.split('-').map((n) => parseInt(n, 10));
  const candidate = new Date(from.getFullYear(), mm - 1, dd, 23, 59, 59, 999);
  if (candidate.getTime() >= from.getTime()) return candidate;
  return new Date(from.getFullYear() + 1, mm - 1, dd, 23, 59, 59, 999);
}
```

Document `SCHOOL_YEAR_END_MMDD` in `.env.example` and the README environment table: default `03-31`, interpreted in the server's local timezone, and a malformed value stops the server at startup.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles
```

Then prove the checks can fail: temporarily change the helper to use `getUTCFullYear()`/`Date.UTC`, re-run, and confirm the local-components check fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/utils/schoolYear.ts .env.example README.md src/config/verifyRoles.ts
git commit -m "feat(vehicles): add validated school-year expiry helper"
```

---

## Task 2: Vehicle schema — many per person, plus expiry

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.model.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.schema.ts`
- Modify: `serverside/src/modules/vehicles/vehicles.service.ts:29-33`
- Modify: `serverside/src/config/testSeed.ts`
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Consumes: `nextSchoolYearEnd` (Task 1).
- Produces: a `Vehicle` with `make`, `color`, `valid_until`, an enum `vehicle_type`, and **no** uniqueness on `owner_person_id`. Task 3 creates these; Task 5 reads `valid_until`.

**Two traps here.**

`vehicleService.create` contains an explicit duplicate-owner check:

```ts
const existingOwner = await vehicleRepo.findByOwner(String(data.owner_person_id));
if (existingOwner) throw new ApiError('DUPLICATE_PLATE', 'Owner already has a vehicle');
```

Dropping the index alone leaves this in place, and a second vehicle still fails — with a *misleading* `DUPLICATE_PLATE` at that. It must be removed.

And **Mongoose will not drop an existing unique index for you.** The index already exists in the running database, so removing `unique: true` from the schema changes nothing until the old index is dropped explicitly. This project has been bitten by a stale index before — the server refuses to boot on an occupancy index mismatch, and the README documents that recovery.

- [ ] **Step 1: Write the failing check**

```ts
  console.log('\n== a person may hold several vehicles ==');

  const multiStamp = Date.now();
  const multiSuffix = (multiStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ownerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Multi Owner',
    type: 'student',
    id_number: `verify-rbac-multi-${multiStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'ACE0' + multiSuffix,
  });
  expectEqual('multi-vehicle owner created', ownerRes.status, CREATED);
  const multiOwner = ownerRes.json.data as { _id?: string; id?: string } | undefined;
  const multiOwnerId = String(multiOwner?._id ?? multiOwner?.id ?? '');
  expectEqual('multi-vehicle owner has an id', multiOwnerId.length > 0, true);

  const firstVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M1-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE1' + multiSuffix,
    vehicle_type: 'motorcycle',
    make: 'Honda',
  });
  expectEqual('first vehicle for this owner', firstVehicle.status, CREATED);

  // The whole point of dropping the unique index. Before it, this is a
  // duplicate-key error or the service's own "Owner already has a vehicle".
  const secondVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M2-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE2' + multiSuffix,
    vehicle_type: 'car',
    make: 'Toyota',
  });
  expectEqual('a SECOND vehicle for the same owner is allowed', secondVehicle.status, CREATED);

  // valid_until is defaulted, not left empty.
  const secondBody = secondVehicle.json.data as { valid_until?: string } | undefined;
  expectEqual('vehicle carries a valid_until', typeof secondBody?.valid_until, 'string');

  // Uniqueness that must SURVIVE: plate and rfid.
  const dupPlate = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M1-${multiSuffix}`,
    rfid_uid: 'BEE3' + multiSuffix,
    vehicle_type: 'car',
    make: 'Nissan',
  });
  expectEqual('duplicate plate is still rejected', dupPlate.status, 409);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:roles`
Expected: `a SECOND vehicle for the same owner is allowed` fails — the service returns `409` from its `findByOwner` check (message "Owner already has a vehicle"), not `201`.

- [ ] **Step 3: Write the implementation**

`vehicles.model.ts`:

```ts
export interface IVehicle extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: 'motorcycle' | 'car' | 'tricycle' | 'other';
  make?: string;
  vehicle_model?: string;
  color?: string;
  valid_until: Date;
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}
```

```ts
    // NOT unique: a person may hold several passes at once (a car and a
    // motorcycle), and a replaced vehicle is deactivated rather than deleted so
    // its history survives. plate_number and rfid_uid are what actually prevent
    // duplicates.
    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    plate_number: { type: String, required: true, unique: true },
    rfid_uid: { type: String, required: true, unique: true },
    vehicle_type: {
      type: String,
      enum: ['motorcycle', 'car', 'tricycle', 'other'],
      required: true,
    },
    make: { type: String },
    // Keeps its existing name deliberately: renaming to `model` would touch six
    // call sites across both repos including the user-facing ProfileView, for
    // cosmetic gain.
    vehicle_model: { type: String },
    color: { type: String },
    valid_until: { type: Date, required: true, index: true },
```

`vehicles.service.ts` — **delete** the `existingOwner` check entirely, and default `valid_until`:

```ts
  async create(data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    const existingPlate = await vehicleRepo.findByPlate(String(data.plate_number));
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');
    return vehicleRepo.create({ ...data, valid_until: data.valid_until ?? nextSchoolYearEnd() });
  },
```

`vehicles.repository.ts` has `findByOwner` and `findByRfid` but **no `findByPlate`** — add it:

```ts
  findByPlate: (plate_number: string) => VehicleModel.findOne({ plate_number }),
```

`findByOwner` becomes unused once the duplicate-owner check is deleted. Remove it too rather than leaving a dead helper that a future reader may take as evidence of a one-vehicle rule.

Update `vehicles.schema.ts` to match the model: `vehicle_type` as a Zod enum of the four values, `make`/`color` optional, `valid_until` an optional ISO date. `updateVehicleSchema` is `createVehicleSchema.partial()`, so it inherits `valid_until` automatically — which is what lets Task 5 backdate an expiry over HTTP.

`verifyRoles.ts` currently defines only `OK = 200` and `FORBIDDEN = 403` (around line 184). Add the two this plan uses:

```ts
const CREATED = 201;
const CONFLICT = 409;
```

Update `testSeed.ts`'s seeded vehicles with `make`, an enum-valid `vehicle_type`, and `valid_until: nextSchoolYearEnd()`, or they fail validation the moment the schema tightens.

**Fix the single-vehicle assumption this change breaks.** `dashboard.service.ts:191` does
`VehicleModel.findOne({ owner_person_id: personId })` and hands the result to the user profile. That
is correct only while a person can own one vehicle; once they can own several it returns an
arbitrary one, so a student with a car and a motorcycle sees whichever Mongo happens to return
first, with no sign there is another.

Change it to return them all:

```ts
      VehicleModel.find({ owner_person_id: personId }).sort({ createdAt: -1 }).lean(),
```

and rename the response field `vehicle` → `vehicles` (an array, possibly empty). Map each entry to
the same shape the single one used, so the only change a consumer sees is one-to-many.

`testSeed.ts:178` uses the same `findOne` for idempotency. Make it deterministic — match on
`plate_number`, which is unique, rather than on owner.

**This is a breaking change to the `/dashboard` response, and its one consumer is `ProfileView.tsx`
in the frontend repo, updated in Task 6.** Between this task and that one, a student profile will
render no vehicle. That is acceptable because the two repos deploy together off this plan, but say
so in your report so the reviewer does not read it as a regression you missed.

**Drop the stale index**, once, and record what you saw:

```bash
mongosh ncst_rfid --quiet --eval 'db.vehicles.getIndexes()'
mongosh ncst_rfid --quiet --eval 'db.vehicles.dropIndex("owner_person_id_1")'
mongosh ncst_rfid --quiet --eval 'db.vehicles.getIndexes()'
```

Then add a README troubleshooting entry: a pre-existing `owner_person_id_1` unique index silently prevents a second vehicle per person, and the recovery is to drop it — mirroring the existing occupancy-index entry.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run seed:test
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
```

All four must pass — `verify:gates` taps vehicles and is the regression check that matters most for a `Vehicle` schema change.

- [ ] **Step 5: Commit**

```bash
git add src/modules/vehicles src/config/testSeed.ts src/config/verifyRoles.ts README.md
git commit -m "feat(vehicles): allow several vehicles per person and add pass expiry"
```

---

## Task 3: VehicleApplication — the frozen document

**Files:**
- Create: `serverside/src/modules/vehicleApplications/vehicleApplications.model.ts`, `.repository.ts`, `.service.ts`, `.controller.ts`, `.routes.ts`, `.schema.ts`
- Modify: `serverside/src/app.ts`
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Consumes: `nextSchoolYearEnd` (Task 1); the `Vehicle` shape (Task 2); `Actor`, `assertCanWrite`, `actorOf` from `src/utils/authority.ts`.
- Produces: `POST /api/vehicle-applications`, `GET /api/vehicle-applications`, `GET /api/vehicle-applications/:id`; and `vehicleApplicationService.create(data, actor)` returning `{ application, vehicle }`. Task 4 attaches signatures; Task 6 consumes the POST.

- [ ] **Step 1: Write the failing checks**

```ts
  console.log('\n== vehicle applications ==');

  const appStamp = Date.now();
  const appSuffix = (appStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  const applicantRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Gabrielle G. Villareal',
    type: 'student',
    id_number: `verify-rbac-app-${appStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'DAD0' + appSuffix,
  });
  expectEqual('applicant person created', applicantRes.status, CREATED);
  const applicant = applicantRes.json.data as { _id?: string; id?: string } | undefined;
  const applicantId = String(applicant?._id ?? applicant?.id ?? '');
  expectEqual('applicant has an id', applicantId.length > 0, true);

  const fullApplication = {
    category: 'new',
    applicant_type: 'student',
    vehicle_type: 'motorcycle',
    owner_person_id: applicantId,
    id_number: `verify-rbac-app-${appStamp}`,
    last_name: 'Villareal',
    first_name: 'Gabrielle',
    middle_name: 'Garcia',
    year_level: '4th',
    school_year: '26-27',
    mobile_no: '09452610104',
    permanent_address: 'Dreamville 6 Imus, Cavite',
    driver_name: 'Gabrielle G. Villareal',
    lto_cr_date: '2021-09-30',
    lto_or_date: '2026-01-05',
    plate_no: `RBAC-A1-${appSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    make: 'Honda',
    model: 'Adv',
    year: '2021',
    color: 'Brown',
    registered_owner_name: 'Gabrielle G. Villareal',
    signed_name: 'Gabrielle G. Villareal',
    signed_date: '2026-06-30',
    rfid_uid: 'FAB0' + appSuffix,
  };

  // Authorization: OSS writes, the rest do not.
  await check('registrar cannot submit an application', registrar, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);
  await check('hr cannot submit an application', hr, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);
  await check('student cannot submit an application', student, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);

  const created = await request(oss, 'POST', '/vehicle-applications', fullApplication);
  expectEqual('oss submits an application', created.status, CREATED);
  const createdBody = created.json.data as
    | { application?: { _id?: string; vehicle_id?: string }; vehicle?: { _id?: string; status?: string; valid_until?: string } }
    | undefined;
  const applicationId = String(createdBody?.application?._id ?? '');
  expectEqual('application has an id', applicationId.length > 0, true);
  expectEqual('a vehicle was created and is active', createdBody?.vehicle?.status, 'active');
  expectEqual('the vehicle carries an expiry', typeof createdBody?.vehicle?.valid_until, 'string');
  expectEqual('the application links to its vehicle', typeof createdBody?.application?.vehicle_id, 'string');

  // Shared reads.
  await check('hr may read applications', hr, 'GET', '/vehicle-applications', OK);
  await check('registrar may read one application', registrar, 'GET', `/vehicle-applications/${applicationId}`, OK);
  await check('student may not read applications', student, 'GET', '/vehicle-applications', FORBIDDEN);

  // Immutability is structural — these routes must not exist.
  const patchAttempt = await request(oss, 'PATCH', `/vehicle-applications/${applicationId}`, { make: 'Yamaha' });
  expectEqual('applications cannot be edited', [404, 405].includes(patchAttempt.status), true);
  const deleteAttempt = await request(oss, 'DELETE', `/vehicle-applications/${applicationId}`);
  expectEqual('applications cannot be deleted', [404, 405].includes(deleteAttempt.status), true);

  // The client's real form left most fields blank. This must succeed.
  const minimal = await request(oss, 'POST', '/vehicle-applications', {
    category: 'new',
    applicant_type: 'student',
    vehicle_type: 'car',
    owner_person_id: applicantId,
    id_number: `verify-rbac-app-${appStamp}`,
    last_name: 'Villareal',
    first_name: 'Gabrielle',
    school_year: '26-27',
    plate_no: `RBAC-A2-${appSuffix}`,
    make: 'Toyota',
    registered_owner_name: 'Gabrielle G. Villareal',
    signed_name: 'Gabrielle G. Villareal',
    signed_date: '2026-06-30',
    rfid_uid: 'FAB1' + appSuffix,
  });
  expectEqual('a minimal application is accepted', minimal.status, CREATED);

  // Duplicate plate and duplicate rfid are still rejected, distinctly.
  const dupApp = await request(oss, 'POST', '/vehicle-applications', { ...fullApplication, plate_no: `RBAC-A1-${appSuffix}`, rfid_uid: 'FAB2' + appSuffix });
  expectEqual('duplicate plate rejected', dupApp.status, 409);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:roles`
Expected: every application check fails with `404` — the route does not exist yet. `registrar cannot submit` will *appear* to pass for the wrong reason (404 ≠ 403), so treat only the `oss submits` failure as the signal.

- [ ] **Step 3: Write the implementation**

Follow the `routes → controller → service → repository → model` layering every module uses. Read `src/modules/vehicles/` first and mirror its file shapes.

The model is the spec's `IVehicleApplication` verbatim. Indexes: `owner_person_id`, `plate_no`, `school_year`, `createdAt` — **none unique**; the same plate legitimately recurs across school years as renewals.

The service carries the ordering rule:

```ts
  /**
   * Write order is load-bearing, not stylistic. There are no transactions (a
   * standalone Mongo has no replica set), so a partial failure is possible and
   * the order decides which side it leaves safe:
   *   1. application  — crash here: paperwork only, nobody gained access
   *   2. vehicle      — gate access begins only now
   *   3. vehicle_id   — system link back onto the application
   *
   * The reverse order would leave a vehicle opening the barrier with no
   * supporting document, which is the failure a pass audit exists to catch.
   * This is the creation-side mirror of the rule users.service states for
   * deactivation: the gate is the first thing closed and the last thing opened.
   */
  async create(input: CreateApplicationInput, actor: Actor) {
    assertCanWrite(actor, 'vehicle');

    const owner = await personRepo.findById(input.owner_person_id);
    if (!owner) throw new ApiError('NOT_FOUND', 'Applicant not found');

    const application = await vehicleApplicationRepo.create({ ...input, created_by: actor.id });

    const vehicle = await vehicleService.create(
      {
        owner_person_id: application.owner_person_id,
        plate_number: input.plate_no,
        rfid_uid: input.rfid_uid,
        vehicle_type: input.vehicle_type,
        make: input.make,
        vehicle_model: input.model,
        color: input.color,
        valid_until: input.valid_until ?? nextSchoolYearEnd(),
      },
      actor
    );

    const linked = await vehicleApplicationRepo.linkVehicle(String(application._id), vehicle._id);
    return { application: linked, vehicle };
  },
```

`linkVehicle` must **refuse a second link** — it is the one system-set exception to immutability, and the rule is that no field a human entered may ever change:

```ts
  /**
   * vehicle_id is the ONLY mutable field on an application, and it is settable
   * exactly once. Everything a human entered is frozen; a system link written
   * by the service that created the vehicle is not part of the signed document.
   */
  async linkVehicle(applicationId: string, vehicleId: Types.ObjectId) {
    const updated = await VehicleApplicationModel.findOneAndUpdate(
      { _id: applicationId, vehicle_id: null },
      { $set: { vehicle_id: vehicleId } },
      { new: true }
    );
    if (!updated) throw new ApiError('CONFLICT', 'This application is already linked to a vehicle');
    return updated;
  },
```

The conditional filter (`vehicle_id: null`) is what makes "settable once" atomic rather than advisory — a check-then-write could be raced.

Routes — note what is **absent**:

```ts
export const vehicleApplicationRoutes = Router();

// Reads are shared across the staff-side console, consistent with RBAC v2's
// "scoped writes, shared reads". Writes are OSS-only, enforced in the service
// by assertCanWrite(actor, 'vehicle').
vehicleApplicationRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);

vehicleApplicationRoutes.get('/', vehicleApplicationController.list);
vehicleApplicationRoutes.get('/:id', vehicleApplicationController.get);
vehicleApplicationRoutes.post('/', validate(createApplicationSchema), vehicleApplicationController.create);

// Deliberately NO patch and NO delete. An application is the record of what was
// submitted and signed; a correction is a new application, and the older one
// stays. Immutability enforced by the absence of a route cannot be bypassed by
// a future caller, whereas immutability by convention is only a comment.
```

The Zod schema mirrors the spec's required list exactly: `category`, `applicant_type`, `vehicle_type`, `owner_person_id`, `id_number`, `last_name`, `first_name`, `school_year`, `plate_no`, `make`, `registered_owner_name`, `signed_name`, `signed_date`, `rfid_uid`. **Everything else `.optional()`.** `rfid_uid` uses `/^[0-9A-Fa-f]+$/`, matching `tapSchema`. `plate_no` is transformed with `.trim().toUpperCase()` and carries **no** format regex.

Register probe cleanup: add `'RBAC-'`-prefixed plates to the existing `PROBE_VEHICLE_PLATE_PREFIXES` coverage (already present), and extend `cleanupProbes` to delete applications whose `plate_no` matches the same regex. State in a comment that a new probe prefix needs both arrays updated.

Mount in `app.ts` beside the other module routers.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:roles   # twice — byte-identical
```

Then prove the immutability checks have teeth: temporarily add a `PATCH /:id` route that updates `make`, re-run, and confirm `applications cannot be edited` fails. Remove it.

- [ ] **Step 5: Commit**

```bash
git add src/modules/vehicleApplications src/app.ts src/config/verifyRoles.ts
git commit -m "feat(vehicles): add the immutable car pass application"
```

---

## Task 4: Application signature

**Files:**
- Create: `serverside/src/modules/vehicleApplications/applicationSignatures.model.ts`, `.repository.ts`, `.service.ts`
- Modify: `serverside/src/middlewares/uploadImage.ts`, the application controller and routes
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Consumes: Task 3's application. `uploadImage(field, maxBytes)` factory and `MAX_SIGNATURE_BYTES` (262144) already exist in `uploadImage.ts`; `detectImageType` is in `src/utils/imageType.ts`.
- Produces: `POST /api/vehicle-applications/:id/signature` and `GET /api/vehicle-applications/:id/signature`.

**Why not reuse `personSignatures`:** its `person_id` is `unique` and its schema comments that "re-signing replaces the previous drawing rather than orphaning it" — deliberately mutable and current. Referencing it would mean a later re-sign retroactively changes what every past application appears to show, which is precisely what the frozen-document decision exists to prevent.

- [ ] **Step 1: Write the failing check**

```ts
  console.log('\n== application signatures are frozen per application ==');

  // A 1x1 transparent PNG, as raw bytes — the smallest valid signature.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  async function uploadAppSignature(token: string, appId: string): Promise<number> {
    const form = new FormData();
    form.append('signature', new Blob([pngBytes], { type: 'image/png' }), 'sig.png');
    const res = await fetch(`${BASE}/vehicle-applications/${appId}/signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return res.status;
  }

  expectEqual('oss uploads an application signature', await uploadAppSignature(oss, applicationId), CREATED);
  expectEqual('registrar may not upload one', await uploadAppSignature(registrar, applicationId), FORBIDDEN);

  await check('hr may read the application signature', hr, 'GET', `/vehicle-applications/${applicationId}/signature`, OK);
  await check('student may not read it', student, 'GET', `/vehicle-applications/${applicationId}/signature`, FORBIDDEN);

  // The frozen property: changing the OWNER's personSignature must not change
  // what this application shows. Both are PNGs, so compare byte length after
  // uploading a deliberately different-sized image to the person.
  const before = await fetch(`${BASE}/vehicle-applications/${applicationId}/signature`, {
    headers: { Authorization: `Bearer ${oss}` },
  });
  const beforeBytes = (await before.arrayBuffer()).byteLength;
  expectEqual('application signature has bytes', beforeBytes > 0, true);

  const personForm = new FormData();
  const biggerPng = Buffer.concat([pngBytes, Buffer.alloc(64)]);
  personForm.append('signature', new Blob([biggerPng], { type: 'image/png' }), 'sig.png');
  await fetch(`${BASE}/persons/${applicantId}/signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superadmin}` },
    body: personForm,
  });

  const after = await fetch(`${BASE}/vehicle-applications/${applicationId}/signature`, {
    headers: { Authorization: `Bearer ${oss}` },
  });
  const afterBytes = (await after.arrayBuffer()).byteLength;
  expectEqual('the application signature is unchanged by a person re-sign', afterBytes, beforeBytes);
```

Note these use raw `fetch`; `installVerifyBypass()` supplies the rate-limit header automatically, so no manual header is needed. Do **not** pass a `Request` object — the wrapper rejects that shape deliberately.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:roles`
Expected: the upload returns `404` — the route does not exist.

- [ ] **Step 3: Write the implementation**

Model: `application_id` (ref VehicleApplication, **unique**, indexed), `data` (Buffer), `mime` (`'image/png'` enum), `byte_size`, `createdAt`. Unique because one application has one signature; immutability comes from there being no route that replaces it.

Add to `uploadImage.ts`:

```ts
export const uploadApplicationSignature = uploadImage('signature', MAX_SIGNATURE_BYTES);
```

The service mirrors `personSignatureService` but is simpler — there is no self-service case, because an application belongs to an office process rather than to the applicant's login:

- `upload`: `assertCanWrite(actor, 'vehicle')`; reject a missing file with `VALIDATION_ERROR`; classify with `detectImageType` and require `image/png`; **reject a second upload for the same application** with `CONFLICT`, since the document is frozen.
- `get`: staff-side read, returns the buffer with `Content-Type: image/png`. **No gate-key path** — a barrier has no use for a signature, matching the reasoning already recorded on the person-signature route.

Extend `cleanupProbes` to delete signatures whose `application_id` belongs to a deleted probe application. Order matters: delete signatures before applications, mirroring the existing comment about deleting vehicles before persons.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:roles   # twice — byte-identical
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/vehicleApplications src/middlewares/uploadImage.ts src/config/verifyRoles.ts
git commit -m "feat(vehicles): freeze the applicant signature per application"
```

---

## Task 5: Gate denies an expired pass

**Files:**
- Modify: `serverside/src/modules/scan/scan.service.ts`
- Test: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `Vehicle.valid_until` (Task 2).
- Produces: a new `reason` value `vehicle_expired`. Task 6 renders it.

- [ ] **Step 1: Write the failing check**

**`verifyGates.ts` is pure HTTP — it has no database connection** (its only imports are `detectImageType` and `installVerifyBypass`). So this check must go through the API, not Mongoose. That is possible because `updateVehicleSchema` is `createVehicleSchema.partial()` and therefore accepts `valid_until` once Task 2 adds it, and `GET /occupancy` (superadmin-only) exposes the roster.

Taps in this file are made by a local closure that POSTs to `${BASE}/scan/tap` with a headers object carrying `X-Gate-Key` (around line 377). Reuse it; do not add a new one.

```ts
  console.log('\n== an expired pass is denied ==');

  // The seeded vehicle used elsewhere in this harness.
  const expiredUid = 'E5F6A7B8';
  const superToken = await login('testadmin', 'Admin@123');

  // Find it over HTTP, and read its current expiry so the restore is exact
  // rather than assumed.
  const vehicleList = await request(superToken, 'GET', '/vehicles?limit=100');
  const vehicles = (vehicleList.json.data ?? []) as {
    _id: string;
    rfid_uid: string;
    valid_until: string;
  }[];
  expectEqual('vehicle list is non-empty', vehicles.length > 0, true);
  const target = vehicles.find((v) => v.rfid_uid === expiredUid);
  expectEqual(`seeded vehicle ${expiredUid} is present`, Boolean(target), true);
  const originalValidUntil = target!.valid_until;

  const backdated = new Date(Date.now() - 86_400_000).toISOString();
  const patched = await request(superToken, 'PATCH', `/vehicles/${target!._id}`, {
    valid_until: backdated,
  });
  expectEqual('expiry was backdated', patched.status, 200);

  const expiredTap = await tapWithKey(parkingEntranceKey, { rfid_uid: expiredUid });
  expectEqual('an expired pass is denied', expiredTap.json.data?.access_result, 'denied');
  expectEqual('the denial reason is vehicle_expired', expiredTap.json.data?.reason, 'vehicle_expired');

  // A denied tap must never move occupancy. Read the roster and confirm this
  // vehicle is not inside.
  const roster = await request(superToken, 'GET', '/occupancy?limit=100');
  const inside = (roster.json.data ?? []) as { entity_id?: string }[];
  expectEqual(
    'an expired tap did not put the vehicle inside',
    inside.some((r) => String(r.entity_id) === String(target!._id)),
    false
  );

  // Restore, and prove the pass works again — which also proves the denial
  // came from expiry rather than from some unrelated state.
  await request(superToken, 'PATCH', `/vehicles/${target!._id}`, {
    valid_until: originalValidUntil,
  });
  const restoredTap = await tapWithKey(parkingEntranceKey, { rfid_uid: expiredUid });
  expectEqual('the pass works again once restored', restoredTap.json.data?.access_result, 'granted');
```

Name `tapWithKey` and `parkingEntranceKey` to match whatever the file actually calls its tap closure and its Parking Entrance key variable — read them rather than assuming. The restored tap creates an occupancy row, so **release it with an exit tap** at Parking Exit before the block ends, or the next run starts with the vehicle already inside and `verify:gates` fails on a stale `already_inside`. That exact leak broke this harness once before.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:gates`
Expected: `an expired pass is denied` fails — the tap returns `granted`, because nothing reads `valid_until`.

- [ ] **Step 3: Write the implementation**

In `scan.service.tap`, inside the vehicle branch, beside the existing `status` check:

```ts
        if (vehicle.status !== 'active') {
          access_result = 'denied';
          reason = 'inactive_id';
        } else if (vehicle.valid_until.getTime() < scan_time.getTime()) {
          // Expiry is stored as end-of-day local (see nextSchoolYearEnd), so a
          // pass valid until 2027-03-31 works for all of that day.
          access_result = 'denied';
          reason = 'vehicle_expired';
        } else {
          access_result = 'granted';
          reason = null;
        }
```

**Placement is load-bearing.** This sits with the other identity checks, *before* the anti-passback block, which runs only on taps that are otherwise granted. That ordering is what stops a denied card from moving occupancy — the anti-passback design states it explicitly, and the harness check above pins it.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
```

Confirm `verify:gates` is re-runnable: run it twice and check both are 88/88 (87 plus your additions), byte-identical.

- [ ] **Step 5: Commit**

```bash
git add src/modules/scan/scan.service.ts src/config/verifyGates.ts
git commit -m "feat(scan): deny an expired vehicle pass at the gate"
```

---

## Task 6: The counter form

**Files:**
- Create: `userpage/components/vehicles/VehicleApplicationForm.tsx`
- Modify: `userpage/components/admin/RegisterView.tsx`, `userpage/lib/permissions.ts`, `userpage/lib/reasonText.ts`, `userpage/components/gate/GateTerminal.tsx`, `userpage/components/ProfileView.tsx`

**Interfaces:**
- Consumes: `POST /api/vehicle-applications` (Task 3), `POST /api/vehicle-applications/:id/signature` (Task 4), `vehicle_expired` (Task 5), and the `/dashboard` response field renamed `vehicle` → `vehicles` (Task 2).

**`ProfileView.tsx` must be updated in this task**, because Task 2 renamed that field. Until you do,
a student profile renders no vehicle at all. It currently reads `data.vehicle.vehicle_model` around
line 158 and declares `vehicle_model: string | null` around line 36; it now receives an **array**,
possibly empty, and should list every pass rather than showing one. A student with a car and a
motorcycle seeing only one, arbitrarily, is the defect this rename exists to remove — do not
reintroduce it by rendering `vehicles[0]`.

**Read `node_modules/next/dist/docs/` before writing components** — `AGENTS.md` requires it; this is Next.js 16.

- [ ] **Step 1: Write the failing check**

Log in as `testoss` / `Oss@12345` at `http://localhost:5173`.

Expected failure: there is **no Register tab** — RBAC v2 withheld it deliberately because this form did not exist. Record what you see.

- [ ] **Step 2: Confirm the failure is the predicted one**

If a Register tab is already present, stop and find out what added it before continuing.

- [ ] **Step 3: Write the implementation**

`lib/permissions.ts` — `NAV_BY_ROLE.oss` becomes:

```ts
  oss: [
    { id: "register", label: "Register" },
    { id: "directory", label: "Directory" },
    { id: "parking", label: "Parking" },
  ],
```

`lib/reasonText.ts` and `GateTerminal.tsx` both gain `vehicle_expired: "Pass expired"`. Rendering a raw snake_case code on an operator screen has been a must-fix twice in this project.

`RegisterView.tsx` currently offers "Single person" and "Bulk import". It gains a **Vehicle** panel.

Gate it on a write domain, not a role name. `lib/permissions.ts` already has `personTypesFor(role)`; add its sibling rather than testing `role === "oss"` inline:

```ts
/** Roles that may register a vehicle. Mirrors WRITE_DOMAINS on the server. */
export function canRegisterVehicles(role: Role): boolean {
  return role === "superadmin" || role === "oss";
}
```

Naming the domain rather than the role is what keeps superadmin working and keeps this in step with the server's `WRITE_DOMAINS`, where `oss` and `superadmin` both carry `'vehicle'`. The **person** panels must correspondingly be hidden when `personTypesFor(role)` is empty, or OSS sees a person form it is forbidden to submit.

`VehicleApplicationForm.tsx` — grouped in the **same order as the printed sheet**: Category, Applicant, Vehicle, LTO, Ownership, Authorization. A clerk types from paper with a queue behind them, so the eye must track paper→screen without hunting.

- Optional fields are **visibly marked optional**. Most of a real form is blank; one that looks like it demands everything gets filler typed into it.
- Owner selection is a **debounced search**, not a select — reuse `AccountsView`'s pattern including its generation ref, which discards a first-requested/last-arriving response.
- When the selected person's `id_number` or name disagrees with the typed snapshot fields, **show the mismatch without blocking submission**. The paper is the record; a discrepancy is for a human to notice, not for the form to normalise away.
- Signature: reuse the canvas `PersonForm` already uses. Submit the application first, then POST the signature to the returned application id — matching the server's own ordering.
- Disable the submit control while in flight; surface the server's error message (especially the `409` naming which of plate/RFID collided) rather than a generic failure.

- [ ] **Step 4: Verify in a real browser**

1. `npx tsc --noEmit` — clean. `npx eslint .` — **no new** errors; exactly 4 pre-exist in `PersonProfile.tsx` and `StudentsDirectory.tsx`, which this task must not touch. Report the count you see.
2. As `testoss`: the Register tab exists and opens the vehicle form.
3. Submit using the client's real sample data — Villareal, motorcycle, plate `U510MX`, Honda Adv 2021 Brown, **leaving Email, Tel, Driver's License, LTO CR and Relationship blank**. It must succeed.
4. Confirm the created vehicle appears with an expiry, and the application is readable.
5. Submit a duplicate plate — the error names the plate, not a generic failure.
6. As `testhr`: still **no** Register tab.
7. No console errors anywhere.

- [ ] **Step 5: Commit**

```bash
git add lib/permissions.ts lib/reasonText.ts components/gate/GateTerminal.tsx components/admin/RegisterView.tsx components/vehicles/VehicleApplicationForm.tsx
git commit -m "Add the car pass application form and give OSS a Register tab"
```

---

## Final verification

```bash
# serverside
npm run build && npm run lint
npm run seed:test
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:roles     # twice, byte-identical

# userpage
npx tsc --noEmit
npx eslint .             # only the 4 pre-existing errors
```

Then confirm by hand, since no harness covers these:

1. The client's sample form submits successfully with its real blanks.
2. A person can hold two vehicles at once.
3. An expired pass is refused at the parking gate and shows "Pass expired", not a raw code.
4. `mongosh ncst_rfid --eval 'db.vehicles.getIndexes()'` shows `owner_person_id_1` is **not** unique.
5. Probe records do not accumulate: note the application, signature and vehicle counts before and after a `verify:roles` run.
