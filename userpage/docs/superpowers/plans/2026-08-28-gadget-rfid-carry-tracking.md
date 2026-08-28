# Gadget RFID and Carry Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each gadget its own RFID tag so the system records which devices came in with whom, through which gate, and whether each one left again.

**Architecture:** A gadget becomes a third `entity_type` in the existing Occupancy and ScanLog models, reusing the unique-index passback detection and `lastResetBoundary` staleness rule rather than building a parallel carry-session collection. A gadget tap never grants or denies passage; it only moves that gadget's own occupancy row. The two-step gate prompt is terminal-side presentation over ordinary single taps — there is no server session.

**Tech Stack:** Node 22, Express 4, Mongoose 8, TypeScript, Zod (backend); Next.js 16 App Router, React 19, Tailwind (frontend).

**Spec:** `userpage/docs/superpowers/specs/2026-08-28-gadget-rfid-carry-tracking-design.md`

## Global Constraints

- **There is no unit-test framework in this repo.** No jest, no vitest, no mocha. Verification is `src/config/verify*.ts` scripts that drive the live HTTP API against a seeded database. Every "write the failing test" step below means *add a check to a verify script*, and every "run the test" step means *run that script against a running server*. Do not introduce a test framework as part of this work.
- **Prerequisites for every test step:** `npm run dev` running in `serverside/` (port 3000), and `npm run seed:test` already applied. Verify scripts call `installVerifyBypass()` as their first statement.
- Backend commands run from `C:\thesis_rfid\serverside`; frontend from `C:\thesis_rfid\userpage`.
- **Typecheck gate:** `npx tsc --noEmit` must exit 0 in both packages before every commit.
- **Lint gate:** `npm run lint` must pass in `serverside`. In `userpage`, `npx eslint <changed files>` must pass. Note: `components/StudentsDirectory.tsx:108` has a **pre-existing** `react-hooks/set-state-in-effect` error unrelated to this work — do not fix it here and do not let it block an unrelated commit.
- **RFID format everywhere:** `/^[0-9A-Fa-f]{6,32}$/`. Copy this regex exactly; it is what `persons.schema.ts` and `scan.schema.ts` already use.
- **The gadget registry must never refuse passage.** No task may add a code path where a gadget causes `access_result = 'denied'` for a *person* or *vehicle*. A gadget tap may itself be denied; a human's passage may not be denied because of one.
- **Egress is never blocked.** `scan.service.ts:315` — do not add an exit denial.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

**Backend — created:**
- `src/utils/assertUidFree.ts` — the single three-way UID uniqueness check
- `src/config/verifyGadgetCarry.ts` — end-to-end verification for this feature

**Backend — modified:**
- `src/modules/gadgets/gadgets.model.ts` — `rfid_uid` field
- `src/modules/gadgets/gadgets.schema.ts` — `rfid_uid` validation, reassign schema
- `src/modules/gadgets/gadgets.repository.ts` — `findByRfid`, projection widening
- `src/modules/gadgets/gadgets.service.ts` — UID checks, reassign
- `src/modules/gadgets/gadgets.routes.ts`, `gadgets.controller.ts` — reassign route
- `src/modules/persons/persons.service.ts` — UID checks via helper
- `src/modules/vehicles/vehicles.service.ts` — UID checks via helper
- `src/modules/vehicleApplications/vehicleApplications.service.ts` — UID checks via helper
- `src/modules/occupancy/occupancy.model.ts`, `occupancy.repository.ts` — third entity type, roster and counts
- `src/modules/scan/scan.model.ts` — third entity type
- `src/modules/scan/scan.service.ts` — gadget resolution branch, `gadgets_inside`, session close
- `src/modules/scan/scan.routes.ts`, `scan.controller.ts`, `scan.schema.ts` — session-close endpoint
- `src/modules/dashboard/*` — `countInside` consumers (gadgets count)

**Frontend — modified:**
- `lib/gateTerminal.ts` — payload types for `gadgets_inside` and gadget photo
- `components/gate/GateTerminal.tsx` — device prompt state, entry and exit screens
- `components/gadgets/GadgetForm.tsx` — `rfid_uid` field

Tasks 1–4 are backend and strictly ordered. Task 5 (registration UI) depends only on Task 1. Tasks 6–7 depend on Task 3. Task 8 depends on everything.

---

### Task 1: Gadget RFID field and the three-way UID guard

**Files:**
- Create: `serverside/src/utils/assertUidFree.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.model.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.schema.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.repository.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.service.ts` (create ~line 105, update ~line 140)
- Modify: `serverside/src/modules/persons/persons.service.ts` (create ~line 127, reassignRfid ~line 290)
- Modify: `serverside/src/modules/vehicles/vehicles.service.ts` (create ~line 106, update ~line 148)
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts` (~line 135)
- Test: `serverside/src/config/verifyGadgetCarry.ts` (created here, extended in Task 8)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `assertUidFree(uid: string, self?: { kind: 'person' | 'vehicle' | 'gadget'; id: string }): Promise<void>` — throws `ApiError('DUPLICATE_RFID', ...)` naming the owning registry.
  - `gadgetRepo.findByRfid(rfid_uid: string)` — returns the lean gadget or `null`.
  - `IGadget.rfid_uid?: string`.

- [ ] **Step 1: Write the failing test**

Create `serverside/src/config/verifyGadgetCarry.ts`. This file is the harness for Task 8 too; build it now so later tasks only add checks.

```ts
/**
 * Asserts gadget RFID tags and carry tracking:
 * docs/superpowers/specs/2026-08-28-gadget-rfid-carry-tracking-design.md
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gadget-carry
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
  console.log('All gadget-carry checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';
const OK = 200;
const CREATED = 201;
const CONFLICT = 409;

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
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no JSON body; the status is what matters.
  }
  return { status: res.status, json };
}

function idOf(json: Record<string, unknown>): string {
  const data = json.data as { _id?: string; id?: string } | undefined;
  return String(data?._id ?? data?.id ?? '');
}

/** Run-scoped identifiers, so a crashed run never collides with the next. */
const RUN = Date.now().toString().slice(-9);
const hex = (n: number) => (RUN + String(n)).slice(-10).padStart(10, '0').toUpperCase();

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');

  let personId = '';
  let gadgetId = '';

  try {
    console.log('\n--- setup');
    const person = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Probe ${RUN}`,
      type: 'student',
      id_number: `CP-${RUN}`,
      department_section: `CARRY-PROBE-${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual('probe person created', person.status, CREATED);
    personId = idOf(person.json);

    console.log('\n--- a gadget can hold its own RFID tag');
    const gadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: personId,
      gadget_type: 'laptop',
      brand_model: 'Probe Laptop',
      serial_number: `CPG${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual('gadget created with an rfid_uid', gadget.status, CREATED);
    gadgetId = idOf(gadget.json);
    expectEqual(
      'the tag is stored on the gadget',
      (gadget.json.data as { rfid_uid?: string })?.rfid_uid,
      hex(2)
    );

    console.log('\n--- the UID namespace is three-way, not two-way');
    // A UID already held by a PERSON must be refused at gadget registration.
    const clashPerson = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: personId,
      gadget_type: 'tablet',
      brand_model: 'Probe Tablet',
      serial_number: `CPG2${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual("a person's UID is refused for a gadget", clashPerson.status, CONFLICT);

    // ...and the reverse: a UID held by a GADGET refused for a person.
    const clashGadget = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Probe Clash ${RUN}`,
      type: 'student',
      id_number: `CPC-${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual("a gadget's UID is refused for a person", clashGadget.status, CONFLICT);

    // ...and for a vehicle.
    const clashVehicle = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: personId,
      plate_number: `CPV${RUN}`,
      vehicle_type: 'motorcycle',
      rfid_uid: hex(2),
    });
    expectEqual("a gadget's UID is refused for a vehicle", clashVehicle.status, CONFLICT);

    console.log('\n--- re-sending a gadget its OWN uid is not a clash');
    const noop = await request(superadmin, 'PATCH', `/gadgets/${gadgetId}`, {
      rfid_uid: hex(2),
      brand_model: 'Probe Laptop Renamed',
    });
    expectEqual('a gadget may re-send its own uid', noop.status, OK);
  } finally {
    console.log('\n--- cleanup');
    if (personId) {
      const del = await request(superadmin, 'DELETE', `/persons/${personId}`);
      expectEqual('probe person cleaned up', del.status, OK);
    }
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add the script to `serverside/package.json`, directly after the `verify:person-status` line:

```json
    "verify:gadget-carry": "ts-node src/config/verifyGadgetCarry.ts",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:gadget-carry`
Expected: FAIL. `rfid_uid` is stripped by `createGadgetSchema` (zod drops unknown keys), so "the tag is stored on the gadget" gets `undefined`, and all three clash checks return `201`/`200` instead of `409`.

- [ ] **Step 3: Add the field to the model**

In `serverside/src/modules/gadgets/gadgets.model.ts`, add to `IGadget` after `serial_number`:

```ts
  /**
   * The gadget's own RFID sticker.
   *
   * This REVERSES the "Deliberately absent" note this file used to carry. A
   * gadget is no longer identified only through its owner's card: it taps in
   * its own right at the Gadget Lane, so that the system records which devices
   * came in and whether they left. See
   * docs/superpowers/specs/2026-08-28-gadget-rfid-carry-tracking-design.md.
   *
   * Sparse for the same reason Person.rfid_uid is: a gadget registered before
   * a sticker was assigned holds `null`, and a unique index without `sparse`
   * would let exactly one such gadget exist.
   */
  rfid_uid?: string;
```

And to the schema definition, after `serial_number`:

```ts
    rfid_uid: { type: String, unique: true, sparse: true },
```

Then REPLACE the trailing comment block that begins `// Deliberately absent: \`rfid_uid\` and \`valid_until\`.` with:

```ts
// `valid_until` remains deliberately absent. A gadget registration confers no
// access, so an expiry would deny nothing and grant nothing; `status` is the
// whole of revocation.
//
// `rfid_uid` USED to be absent for a parallel reason, and is not any more — see
// the field's own comment above. A gadget now shares the UID namespace with
// persons and vehicles, which is why every issue point calls assertUidFree()
// rather than checking two registries by hand.
```

- [ ] **Step 4: Write the shared UID guard**

Create `serverside/src/utils/assertUidFree.ts`:

```ts
import { ApiError } from './ApiError';
import { PersonModel } from '../modules/persons/persons.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { GadgetModel } from '../modules/gadgets/gadgets.model';

type Kind = 'person' | 'vehicle' | 'gadget';

/**
 * An RFID UID belongs to exactly one person, vehicle, or gadget.
 *
 * This exists as ONE function rather than as hand-written pairs at each issue
 * point. It used to be pairwise — persons checked vehicles, vehicles checked
 * persons — and the moment gadgets joined the namespace that shape became five
 * separate places to forget a check. A forgotten check does not fail loudly: it
 * writes a UID that resolves to the wrong entity, or to nothing, and the card
 * is then permanently unscannable at the barrier. That is the CAV 8832 defect,
 * and it is invisible until someone stands at a gate holding a card that does
 * not work.
 *
 * `self` is the record being edited, excluded from its own check so a PATCH
 * that re-sends a row's current UID does not reject itself — the same exclusion
 * assertWithinLimit takes `excludeId` for. Omit it on create.
 *
 * Deliberately queries the MODELS rather than the repositories: personRepo and
 * vehicleRepo filter soft-deleted rows out, and a deleted person's UID is still
 * occupied as far as the unique index is concerned. Handing that UID to a
 * gadget would produce a duplicate-key error at write time instead of this
 * explanatory 409.
 */
export async function assertUidFree(
  uid: string,
  self?: { kind: Kind; id: string }
): Promise<void> {
  const skip = (kind: Kind, id: unknown) =>
    self?.kind === kind && String(id) === String(self.id);

  const person = await PersonModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (person && !skip('person', person._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
  }

  const vehicle = await VehicleModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (vehicle && !skip('vehicle', vehicle._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
  }

  const gadget = await GadgetModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (gadget && !skip('gadget', gadget._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a gadget');
  }
}
```

- [ ] **Step 5: Accept the field in the gadget schemas**

In `serverside/src/modules/gadgets/gadgets.schema.ts`, add to `createGadgetSchema` after `photo_url`:

```ts
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters')
    .optional(),
```

Append the reassign schema at the end of the file:

```ts
/**
 * Replacing a gadget's sticker is its own action, matching reassignRfidSchema
 * in persons.schema.ts: the swap has to block the retired tag, which a plain
 * field edit would skip.
 */
export const reassignGadgetRfidSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters'),
});
```

- [ ] **Step 6: Add the repository lookup**

In `serverside/src/modules/gadgets/gadgets.repository.ts`, add after `findBySerial`:

```ts
  /**
   * Resolves a gadget from its sticker. Used by scan.service's third
   * resolution branch and by assertUidFree's gadget check.
   */
  findByRfid: (rfid_uid: string) => GadgetModel.findOne({ rfid_uid }).lean(),
```

- [ ] **Step 7: Call the guard from all six issue points**

In each site below, add the `assertUidFree` call and DELETE the hand-written pairwise checks it replaces. Import with
`import { assertUidFree } from '../../utils/assertUidFree';`.

`gadgets.service.ts` — in `create`, after `assertOwnerRegistrable(owner, 'gadget')`:

```ts
    // A gadget now shares the UID namespace with persons and vehicles, so this
    // is a three-way check, not a new one-way check. Runs before takeSerial so
    // a rejected registration does not burn a serial number.
    if (data.rfid_uid) {
      await assertUidFree(data.rfid_uid);
      if (await blockedCardRepo.isBlocked(data.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    }
```

`gadgets.service.ts` — in `update`, immediately after `const current = await gadgetRepo.findById(id);` and its null guard:

```ts
    if (data.rfid_uid && data.rfid_uid !== current.rfid_uid) {
      await assertUidFree(data.rfid_uid, { kind: 'gadget', id });
      if (await blockedCardRepo.isBlocked(data.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    }
```

`persons.service.ts` — in `create`, REPLACE the `findByRfid` + `vehicleRepo.findByRfid` pair inside `if (personData.rfid_uid) {` with:

```ts
      await assertUidFree(personData.rfid_uid);
      if (await blockedCardRepo.isBlocked(personData.rfid_uid)) throw new ApiError('CARD_BLOCKED');
```

`persons.service.ts` — in `reassignRfid`, REPLACE the `clash` and `vehicleWithRfid` lookups with:

```ts
    await assertUidFree(rfid_uid, { kind: 'person', id });
```

(Keep the `blockedCardRepo.isBlocked` check above it and the retired-card blocking below it exactly as they are.)

`vehicles.service.ts` — in `create`, REPLACE `existingRfid` and `personWithRfid` with:

```ts
    await assertUidFree(String(data.rfid_uid));
```

`vehicles.service.ts` — in `update`, inside `if (data.rfid_uid) { ... if (data.rfid_uid !== currentForRfid.rfid_uid) {`, REPLACE the `existingRfid` and `personWithRfid` lookups with:

```ts
        await assertUidFree(data.rfid_uid, { kind: 'vehicle', id });
```

`vehicleApplications.service.ts` — in `create`, REPLACE `existingRfid` and `personWithRfid` with:

```ts
    await assertUidFree(input.rfid_uid);
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx tsc --noEmit` — expect exit 0.
Run: `npm run verify:gadget-carry`
Expected: PASS, all checks.

- [ ] **Step 9: Run the existing suites for regressions**

The UID checks were rewritten under four other features, so run all of them:

```bash
npm run verify:vehicles
npm run verify:gadgets
npm run verify:registration
npm run verify:person-status
npm run lint
```

Expected: all pass. If `verify:vehicles` fails on a duplicate-RFID message string, that is this task's change — `assertUidFree` produces the same three messages the old checks did, so a failure here means a message was altered. Fix the message, not the test.

- [ ] **Step 10: Commit**

```bash
git add serverside/src/utils/assertUidFree.ts serverside/src/config/verifyGadgetCarry.ts \
        serverside/src/modules/gadgets serverside/src/modules/persons/persons.service.ts \
        serverside/src/modules/vehicles/vehicles.service.ts \
        serverside/src/modules/vehicleApplications/vehicleApplications.service.ts \
        serverside/package.json
git commit -m "$(cat <<'EOF'
feat: give gadgets their own RFID tag

Gadgets join the UID namespace they were deliberately kept out of, so
they can tap at the gate in their own right. Six hand-written pairwise
uniqueness checks collapse into one assertUidFree() helper, because a
third entity turned five of those sites into places to forget a check.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Gadget as a third occupancy entity

**Files:**
- Modify: `serverside/src/modules/occupancy/occupancy.model.ts:5,17`
- Modify: `serverside/src/modules/occupancy/occupancy.repository.ts:6,11-18,117-128,133-162`
- Modify: `serverside/src/modules/scan/scan.model.ts:6,20`
- Modify: `serverside/src/modules/dashboard/dashboard.service.ts` (consumer of `countInside`)
- Test: `serverside/src/config/verifyGadgetCarry.ts`

**Interfaces:**
- Consumes: `IGadget.rfid_uid` (Task 1).
- Produces:
  - `EntityType = 'person' | 'vehicle' | 'gadget'` exported from `occupancy.repository.ts`.
  - `occupancyRepo.countInside(boundary): Promise<{ persons: number; vehicles: number; gadgets: number }>`.
  - `listInside` rows where a gadget row carries `name = brand_model` and `id_number = serial_number`.

- [ ] **Step 1: Write the failing test**

Add to `verifyGadgetCarry.ts`, inside the `try` block after the "re-sending a gadget its OWN uid" section:

```ts
    console.log('\n--- the roster and the dashboard count agree about gadgets');
    // The invariant occupancy.repository.ts:110 warns about: countInside and
    // listInside are two views of one answer. Widening the enum without
    // changing both makes a gadget row visible in one and invisible in the
    // other, and an admin cannot tell which of the two lied.
    const roster = await request(superadmin, 'GET', '/occupancy?limit=200');
    expectEqual('roster responded', roster.status, OK);
    const rosterRows = (roster.json.data ?? []) as { entity_type?: string }[];
    const rosterGadgets = rosterRows.filter((r) => r.entity_type === 'gadget').length;

    // GET /dashboard/ — there is no /dashboard/overview. The service flattens
    // countInside into persons_inside / vehicles_inside, so the gadget count
    // joins them as a sibling rather than nesting.
    const counts = await request(superadmin, 'GET', '/dashboard');
    expectEqual('dashboard responded', counts.status, OK);
    const dash = counts.json.data as { gadgets_inside?: number };
    expectEqual('the dashboard reports a gadget count at all', typeof dash?.gadgets_inside, 'number');
    expectEqual('roster and dashboard agree on gadgets inside', rosterGadgets, dash?.gadgets_inside);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:gadget-carry`
Expected: FAIL on "the dashboard reports a gadget count at all" — `typeof undefined` is `'undefined'`, not `'number'`.

- [ ] **Step 3: Widen the two enums**

`serverside/src/modules/occupancy/occupancy.model.ts` — change the interface field and the schema enum:

```ts
  entity_type: 'person' | 'vehicle' | 'gadget';
```
```ts
  entity_type: { type: String, enum: ['person', 'vehicle', 'gadget'], required: true },
```

`serverside/src/modules/scan/scan.model.ts` — the same two changes:

```ts
  entity_type: 'person' | 'vehicle' | 'gadget';
```
```ts
  entity_type: { type: String, enum: ['person', 'vehicle', 'gadget'], required: true },
```

`serverside/src/modules/occupancy/occupancy.repository.ts:6`:

```ts
export type EntityType = 'person' | 'vehicle' | 'gadget';
```

- [ ] **Step 4: Change `countInside` and `listInside` together**

In `occupancy.repository.ts`, REPLACE `countInside` with:

```ts
  /**
   * How many entities are inside right now, split by type.
   *
   * Deliberately shares `listInside`'s filter — same `state` and the same
   * `since >= boundary` staleness rule. The dashboard's live count and the
   * Presence roster are two views of one answer, and an admin who sees "14
   * inside" on the Overview and then counts 13 rows on the Presence tab has
   * no way to tell which one lied. If the roster's filter ever changes, this
   * one changes with it.
   *
   * `gadgets` was added with the third entity type and is NOT optional: the
   * old if/else-if silently dropped unknown types, so widening the enum
   * without touching this function would have broken the invariant above in
   * exactly the way it warns about — quietly, and only visible by counting
   * rows on two screens.
   */
  async countInside(
    boundary: Date
  ): Promise<{ persons: number; vehicles: number; gadgets: number }> {
    const rows = await OccupancyModel.aggregate<{ _id: EntityType; count: number }>([
      { $match: { state: 'inside', since: { $gte: boundary } } },
      { $group: { _id: '$entity_type', count: { $sum: 1 } } },
    ]);
    const counts = { persons: 0, vehicles: 0, gadgets: 0 };
    for (const row of rows) {
      if (row._id === 'person') counts.persons = row.count;
      else if (row._id === 'vehicle') counts.vehicles = row.count;
      else if (row._id === 'gadget') counts.gadgets = row.count;
    }
    return counts;
  },
```

In the same file, REPLACE the `$lookup`/`$project` stages of `listInside` with:

```ts
        { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
        { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
        { $lookup: { from: 'gadgets', localField: 'entity_id', foreignField: '_id', as: 'gadget' } },
        { $lookup: { from: 'gates', localField: 'last_gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 1,
            entity_type: 1,
            since: 1,
            // Order matters and mirrors entity_type's own order: a document is
            // only ever one of the three, so the first non-null wins and the
            // other two lookups are empty arrays.
            name: {
              $ifNull: [
                { $arrayElemAt: ['$person.full_name', 0] },
                {
                  $ifNull: [
                    { $arrayElemAt: ['$vehicle.plate_number', 0] },
                    { $arrayElemAt: ['$gadget.brand_model', 0] },
                  ],
                },
              ],
            },
            // A gadget has no id_number, so its SERIAL takes that slot — it is
            // the identifier a guard reads off the device itself.
            id_number: {
              $ifNull: [
                { $arrayElemAt: ['$person.id_number', 0] },
                { $arrayElemAt: ['$gadget.serial_number', 0] },
              ],
            },
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
```

- [ ] **Step 5: Update the `countInside` consumers — both of them**

`dashboard.service.ts` destructures the result and flattens it, at **two** sites:
`:218-219` and `:254-255`, each reading

```ts
      persons_inside: inside.persons,
      vehicles_inside: inside.vehicles,
```

Add the sibling at both:

```ts
      gadgets_inside: inside.gadgets,
```

Both sites, not one — they serve different endpoints (`GET /dashboard` and the live
payload), and updating only one produces exactly the split-brain count that this
task's other half exists to prevent. Confirm with
`grep -rn "vehicles_inside" serverside/src` that you found every site.

Note the name echo: this `gadgets_inside` is a **count** on the dashboard payload,
while Task 3 adds a `gadgets_inside` **array** to the tap payload. Different
endpoints, different objects. The name matches its siblings here, which is what
matters; do not rename either one.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsc --noEmit` — expect exit 0. TypeScript will point at any remaining site that destructures `countInside`'s result.
Run: `npm run verify:gadget-carry`
Expected: PASS.

- [ ] **Step 7: Check for regressions**

```bash
npm run verify:passback
npm run verify:gates
npm run lint
```

Expected: pass. `verify:passback` exercises the unique index this task's enum change sits on top of; a failure there means the enum widening broke entry/exit state, which must be fixed before continuing.

- [ ] **Step 8: Commit**

```bash
git add serverside/src/modules/occupancy serverside/src/modules/scan/scan.model.ts \
        serverside/src/modules/dashboard serverside/src/config/verifyGadgetCarry.ts
git commit -m "$(cat <<'EOF'
feat: make a gadget a third occupancy entity

Widens Occupancy and ScanLog entity_type to include 'gadget', so a
carried device gets its own inside/outside row and reuses the existing
passback index and nightly staleness boundary.

countInside and listInside change together on purpose: the former
dropped unknown types silently while the latter matched them, so
widening one alone would have broken the documented invariant that the
dashboard count and the Presence roster are two views of one answer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Gadget tap resolution and `gadgets_inside`

**Files:**
- Modify: `serverside/src/modules/scan/scan.service.ts:23-42` (TapResult), `:66` (entity_type), `:175` (resolution), `:231` (wrong_gate_type), `:372-411` (granted-person block)
- Modify: `serverside/src/modules/gadgets/gadgets.repository.ts` (projection)
- Test: `serverside/src/config/verifyGadgetCarry.ts`

**Interfaces:**
- Consumes: `gadgetRepo.findByRfid` (Task 1), `EntityType` (Task 2).
- Produces: `TapResult.person.gadgets_inside?: { id: string; gadget_type: string; brand_model: string; serial_number: string }[]` — populated only on a **granted person exit** tap. `TapResult.person.gadgets[].photo_url` and `.id` added. `TapResult.person.person_id?: string` — set on every person tap; Tasks 6 and 7 cannot open a prompt without it.

- [ ] **Step 1: Write the failing test**

Add to `verifyGadgetCarry.ts` inside the `try` block. Taps go through the JWT path (`tapSchema`), which names the gate explicitly:

```ts
    console.log('\n--- a gadget tag taps in its own right');
    const gates = await request(superadmin, 'GET', '/gates');
    const gateRows = (gates.json.data ?? []) as { _id: string; name: string }[];
    const gadgetLane = gateRows.find((g) => g.name === 'Gadget Lane');
    const sideGate = gateRows.find((g) => g.name === 'Side Gate');
    expectEqual('Gadget Lane gate exists (run npm run seed)', Boolean(gadgetLane), true);
    expectEqual('Side Gate exists', Boolean(sideGate), true);

    // Person in first, then the device — the Gadget Lane flow.
    const personIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: gadgetLane!._id, direction: 'entry',
    });
    expectEqual('person admitted at the gadget lane', (personIn.json.data as { access_result?: string })?.access_result, 'granted');

    const deviceIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: gadgetLane!._id, direction: 'entry',
    });
    expectEqual('gadget tag admitted', (deviceIn.json.data as { access_result?: string })?.access_result, 'granted');

    console.log('\n--- the exit tap reports what is still inside');
    const personOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: sideGate!._id, direction: 'exit',
    });
    const outData = personOut.json.data as {
      access_result?: string;
      person?: { gadgets_inside?: { serial_number: string }[] };
    };
    expectEqual('person released', outData?.access_result, 'granted');
    expectEqual('exactly one device is still inside', outData?.person?.gadgets_inside?.length, 1);
    expectEqual(
      'and it is the one that tapped in',
      outData?.person?.gadgets_inside?.[0]?.serial_number,
      `CPG${RUN}`
    );

    console.log('\n--- tapping the device out clears it');
    const deviceOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual('gadget tag released', (deviceOut.json.data as { access_result?: string })?.access_result, 'granted');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:gadget-carry`
Expected: FAIL at "gadget tag admitted" — the UID resolves to no person and no vehicle, so the tap is `denied` with `unregistered_uid`.

- [ ] **Step 3: Widen the tap's entity type and result shape**

In `scan.service.ts`, change line 66:

```ts
    let entity_type: 'person' | 'vehicle' | 'gadget' = 'person';
```

In the `TapResult` interface, REPLACE the `gadgets` field and add the new one:

```ts
    /** The cardholder's registered devices, for the exit ownership check. Shown
     *  to the guard; never consulted by any access decision. */
    gadgets?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      photo_url?: string;
    }[];
    /** The subset of those devices whose occupancy row is still `inside` — what
     *  the exit terminal must see tapped out. Populated ONLY on a granted
     *  person EXIT tap: on entry there is nothing to return yet, and on a
     *  denial this is withheld for the same reason `gadgets` is. */
    gadgets_inside?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
    }[];
```

- [ ] **Step 4: Widen the repository projection**

In `gadgets.repository.ts`, change `findActiveByOwner`'s projection. The comment above it warns that both consumers share this one projection — adding a field is the safe direction; the limit check ignores it.

```ts
      .select('gadget_type brand_model serial_number rfid_uid photo_url')
```

- [ ] **Step 5: Add the third resolution branch**

In `scan.service.ts`, find the `else` that begins `const vehicle = await vehicleRepo.findByRfid(input.rfid_uid);`. At the END of that `if (vehicle) { ... }` block add an `else` branch:

```ts
        } else {
          // Third and LAST resolution branch. Order is load-bearing: persons
          // and vehicles are the access-bearing entities and must never be
          // shadowed by a gadget lookup.
          //
          // This is the case scan.service used to say would never exist. A
          // gadget now taps in its own right so the system can record which
          // devices came in and whether they left — but it still decides
          // nothing about a human's passage. A gadget tap moves ONLY its own
          // occupancy row: the barrier is already open or shut on the strength
          // of the person's own card, tapped moments earlier.
          const gadget = await gadgetRepo.findByRfid(input.rfid_uid);
          if (gadget) {
            entity_type = 'gadget';
            entity_id = gadget._id;
            if (gadget.status === 'active') {
              access_result = 'granted';
              reason = null;
            } else {
              access_result = 'denied';
              reason = 'inactive_id';
              // lapsedAtOwnGate stays false: the egress override exists to
              // stop a person being trapped inside, and a laptop cannot be
              // trapped. A deactivated device simply does not tap out, and
              // its row is cleared by the nightly boundary.
            }
            const owner = await personRepo.findById(String(gadget.owner_person_id));
            personView = {
              full_name: owner?.full_name ?? 'Unknown owner',
              type: 'gadget',
              owner_type: owner?.type,
              department_section: owner?.department_section ?? null,
              gadgets: [
                {
                  id: String(gadget._id),
                  gadget_type: gadget.gadget_type,
                  brand_model: gadget.brand_model,
                  serial_number: gadget.serial_number,
                  photo_url: gadget.photo_url,
                },
              ],
            };
          }
        }
```

- [ ] **Step 6: Set `person_id` on the person branch**

The terminal needs the person's id to open a device prompt against them.
`gateTerminal.ts:57` already declares `person_id?: string` on the client type, but
**the server has never set it** — this closes an existing gap rather than adding a
field. In `scan.service.ts`, in the `else` branch that handles a person at a
non-vehicle gate (where `entity_type = 'person'` and `entity_id = person._id`), add
to the `personView` assignment made just above the `if (gate.type === 'vehicle')`
split:

```ts
        personView = {
          full_name: person.full_name,
          type: person.type,
          department_section: person.department_section ?? null,
          photo_url: person.photo_url,
          // The terminal opens its device prompt against this id. Set on the
          // shared person view rather than in one branch, so a person tap
          // carries it at every gate type.
          person_id: String(person._id),
        };
```

Add `person_id?: string;` to `TapResult['person']` alongside the other fields.

- [ ] **Step 7: Exclude gadgets from the gate-type guard**

In `scan.service.ts`, REPLACE the `wrong_gate_type` block and its comment with:

```ts
    // A gate has a fixed type, so a person card must not open the parking
    // barrier and a vehicle tag must not register attendance at a walking gate.
    //
    // Gadgets sit OUTSIDE this rule rather than inside it, and this is the one
    // place the third entity type needed a carve-out rather than a widening. A
    // gate's type is only ever 'person' or 'vehicle' — there is no gadget gate
    // and there should not be one, because a device has no route of its own: it
    // accompanies whoever is carrying it, through whichever gate they use.
    // Without this exclusion every gadget tap would be denied wrong_gate_type,
    // since 'gadget' matches neither gate type by construction.
    if (
      access_result === 'granted' &&
      entity_type !== 'gadget' &&
      entity_type !== gate.type
    ) {
      access_result = 'denied';
      reason = 'wrong_gate_type';
      personView = undefined;
    }
```

- [ ] **Step 8: Attach `gadgets_inside` on a granted person exit**

In `scan.service.ts`, inside the existing `if (access_result === 'granted' && !lapsedEgress && entity_type === 'person' && entity_id && personView)` block, REPLACE the `personView.gadgets = devices.map(...)` assignment with:

```ts
      const devices = await gadgetRepo.findActiveByOwner(entity_id);
      personView.gadgets = devices.map((g) => ({
        id: String(g._id),
        gadget_type: g.gadget_type,
        brand_model: g.brand_model,
        serial_number: g.serial_number,
        photo_url: g.photo_url,
      }));

      // On EXIT only, narrow that list to the devices whose occupancy row is
      // still `inside` — the ones the terminal must see tapped out. Entry
      // returns nothing here: the devices have not been tapped in yet, so an
      // "expected" list at entry would be a list of things nobody promised.
      //
      // Reuses the same `boundary` rule occupancy itself applies, so a device
      // stranded inside from before the nightly reset is not demanded back
      // today. Without that, one forgotten tap-out would haunt every
      // subsequent exit for that person until an admin cleared the row.
      if (input.direction === 'exit' && devices.length > 0) {
        const insideRows = await occupancyRepo.listInsideGadgetIds(
          devices.map((g) => g._id),
          lastResetBoundary(scan_time)
        );
        const insideSet = new Set(insideRows.map(String));
        personView.gadgets_inside = devices
          .filter((g) => insideSet.has(String(g._id)))
          .map((g) => ({
            id: String(g._id),
            gadget_type: g.gadget_type,
            brand_model: g.brand_model,
            serial_number: g.serial_number,
          }));
      }
```

- [ ] **Step 9: Add the occupancy lookup that supports it**

In `occupancy.repository.ts`, add after `listInside`:

```ts
  /**
   * Which of these gadgets are currently inside.
   *
   * Applies the same staleness rule as `enter`, `release` and `listInside` —
   * see countInside's note on why every view of "inside" must share one
   * filter. Takes ids rather than an owner so the caller, which has already
   * loaded the person's active devices, does not pay for a second lookup.
   */
  async listInsideGadgetIds(
    gadgetIds: Types.ObjectId[],
    boundary: Date
  ): Promise<Types.ObjectId[]> {
    if (gadgetIds.length === 0) return [];
    const rows = await OccupancyModel.find({
      entity_type: 'gadget',
      entity_id: { $in: gadgetIds },
      state: 'inside',
      since: { $gte: boundary },
    })
      .select('entity_id')
      .lean();
    return rows.map((r) => r.entity_id);
  },
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx tsc --noEmit` — expect exit 0.
Run: `npm run verify:gadget-carry`
Expected: PASS.

- [ ] **Step 11: Check for regressions**

```bash
npm run verify:passback
npm run verify:gadgets
npm run verify:roles
npm run verify:vehicles
npm run lint
```

Expected: all pass. `verify:roles` and `verify:passback` both drive the tap path this task rewrote; treat any failure there as caused by this task.

- [ ] **Step 12: Commit**

```bash
git add serverside/src/modules/scan serverside/src/modules/gadgets/gadgets.repository.ts \
        serverside/src/modules/occupancy/occupancy.repository.ts \
        serverside/src/config/verifyGadgetCarry.ts
git commit -m "$(cat <<'EOF'
feat: resolve gadget tags at the gate

Adds the third resolution branch to scan.service.tap, after person and
vehicle so neither is ever shadowed. A gadget tap moves only its own
occupancy row and decides nothing about a human's passage.

Gadgets are carved out of wrong_gate_type rather than folded into it: a
gate is only ever person or vehicle, so 'gadget' matches neither by
construction and every device tap would otherwise be denied.

A granted person EXIT tap now returns gadgets_inside, the devices the
terminal must see tapped out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The incomplete-exit close event

**Files:**
- Modify: `serverside/src/modules/scan/scan.schema.ts`
- Modify: `serverside/src/modules/scan/scan.routes.ts:32`
- Modify: `serverside/src/modules/scan/scan.controller.ts`
- Modify: `serverside/src/modules/scan/scan.service.ts`
- Test: `serverside/src/config/verifyGadgetCarry.ts`

**Interfaces:**
- Consumes: Task 3's `gadgets_inside`.
- Produces: `POST /api/scan/gadget-session` accepting `{ person_id, missing_gadget_ids[] }` (gate callers) or additionally `{ gate_id }` (JWT callers), and `scanService.closeGadgetSession(input): Promise<{ logged: boolean }>`.

- [ ] **Step 1: Write the failing test**

Add to `verifyGadgetCarry.ts`, after the "tapping the device out clears it" section:

```ts
    console.log('\n--- an incomplete exit is logged as its own row, not folded into the exit');
    // Re-enter both so there is something to leave behind.
    await request(superadmin, 'POST', '/scan/tap', { rfid_uid: hex(1), gate_id: gadgetLane!._id, direction: 'entry' });
    await request(superadmin, 'POST', '/scan/tap', { rfid_uid: hex(2), gate_id: gadgetLane!._id, direction: 'entry' });
    const exitAgain = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual(
      'the person left with the device still inside',
      (exitAgain.json.data as { person?: { gadgets_inside?: unknown[] } })?.person?.gadgets_inside?.length,
      1
    );

    const close = await request(superadmin, 'POST', '/scan/gadget-session', {
      gate_id: sideGate!._id,
      person_id: personId,
      missing_gadget_ids: [gadgetId],
    });
    expectEqual('close event accepted', close.status, OK);

    const logs = await request(superadmin, 'GET', `/scan/logs?limit=20`);
    const logRows = (logs.json.data ?? []) as { reason?: string; access_result?: string }[];
    const notReturned = logRows.filter((l) => l.reason === 'gadget_not_returned');
    expectEqual('a gadget_not_returned row was written', notReturned.length >= 1, true);
    expectEqual('and it is GRANTED, never a denial', notReturned[0]?.access_result, 'granted');

    // Clean the device back out so the run leaves no row inside.
    await request(superadmin, 'POST', '/scan/tap', { rfid_uid: hex(2), gate_id: sideGate!._id, direction: 'exit' });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:gadget-carry`
Expected: FAIL at "close event accepted" with `404` — the route does not exist.

- [ ] **Step 3: Add the schemas**

Append to `serverside/src/modules/scan/scan.schema.ts`:

```ts
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid id');

/**
 * Closing an exit prompt that ended with devices unticked.
 *
 * This is a separate call, not a field on the tap, because the person's exit
 * is logged the moment they tap — before anyone knows whether the devices will
 * be presented. Scan logs are append-only, so the outcome cannot be written
 * back onto that row; it becomes a second row. See the spec's "Closing an
 * incomplete exit prompt".
 */
export const gadgetSessionSchema = z.object({
  gate_id: objectId,
  person_id: objectId,
  missing_gadget_ids: z.array(objectId).min(1),
});

/** Device callers get the gate from their key, exactly like tapDeviceSchema. */
export const gadgetSessionDeviceSchema = z
  .object({
    person_id: objectId,
    missing_gadget_ids: z.array(objectId).min(1),
  })
  .transform((v) => ({ person_id: v.person_id, missing_gadget_ids: v.missing_gadget_ids }));
```

- [ ] **Step 4: Add the service method**

In `scan.service.ts`, add to `scanService` after `tap`:

```ts
  /**
   * Records that a person left with devices still inside.
   *
   * Writes a SECOND scan-log row rather than amending the exit row, which was
   * already written when they tapped. Two rows for one exit is correct here:
   * the first records that the person left, the second records what they left
   * without. occupancyService.clear writes its own append-only row for the
   * same reason — the state it describes is overwritten by the next tap.
   *
   * Deliberately touches NO occupancy state. The devices genuinely are still
   * inside; their rows must stay `inside` so tomorrow's roster shows them and
   * the nightly boundary is what eventually clears them.
   *
   * access_result is 'granted', not 'denied'. Nothing was refused — the person
   * is already outside. A denial here would be the first path in the system
   * from a laptop to a refused tap, which scan.service.ts:390 forbids.
   */
  async closeGadgetSession(input: {
    gate_id: string;
    person_id: string;
    missing_gadget_ids: string[];
  }): Promise<{ logged: boolean; missing: number }> {
    const gate = await gateRepo.findById(input.gate_id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');
    if (!Types.ObjectId.isValid(input.person_id)) {
      throw new ApiError('VALIDATION_ERROR', 'person_id is not a valid id');
    }
    const person = await personRepo.findById(input.person_id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await scanRepo.createLog({
      // The person's own card UID, so the row sits alongside their exit in any
      // per-card view. Falls back to the empty string only for a cardless
      // person, who cannot have tapped an exit in the first place.
      rfid_uid: person.rfid_uid ?? '',
      entity_type: 'person',
      entity_id: person._id,
      gate_id: gate._id,
      direction: 'exit',
      access_result: 'granted',
      reason: 'gadget_not_returned',
      scan_time: new Date(),
    });

    liveHub.notifyScan();
    return { logged: true, missing: input.missing_gadget_ids.length };
  },
```

- [ ] **Step 5: Add the controller and route**

In `scan.controller.ts`, add:

```ts
  gadgetSession: asyncHandler(async (req: Request, res: Response) => {
    // Gate callers have their gate on the key; JWT callers name it in the body.
    const gate_id = req.gate ? String(req.gate.gateId) : String(req.body.gate_id);
    sendSuccess(
      res,
      await scanService.closeGadgetSession({
        gate_id,
        person_id: req.body.person_id,
        missing_gadget_ids: req.body.missing_gadget_ids,
      })
    );
  }),
```

In `scan.routes.ts`, import the two schemas and add, directly after the `/tap` route:

```ts
function gadgetSessionValidate(req: Request, res: Response, next: NextFunction): void {
  const schema = req.gate ? gadgetSessionDeviceSchema : gadgetSessionSchema;
  validate(schema)(req, res, next);
}

// Shares tapAuth and scanLimiter with /tap: it comes from the same terminals,
// at the same rate, on the same credentials.
scanRoutes.post(
  '/gadget-session',
  scanLimiter,
  tapAuth,
  gadgetSessionValidate,
  scanController.gadgetSession
);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsc --noEmit` — expect exit 0.
Run: `npm run verify:gadget-carry`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add serverside/src/modules/scan serverside/src/config/verifyGadgetCarry.ts
git commit -m "$(cat <<'EOF'
feat: log an exit that left devices behind

The person's exit is logged when they tap, before anyone knows whether
the devices will be presented, and scan logs are append-only — so
gadget_not_returned becomes a second row rather than an amendment to the
first. Granted, never denied: nothing was refused, the person is already
outside.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Assigning a tag to a gadget

**Files:**
- Modify: `serverside/src/modules/gadgets/gadgets.service.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.controller.ts`
- Modify: `serverside/src/modules/gadgets/gadgets.routes.ts`
- Modify: `userpage/components/gadgets/GadgetForm.tsx`
- Test: `serverside/src/config/verifyGadgetCarry.ts`

**Interfaces:**
- Consumes: `assertUidFree` (Task 1), `reassignGadgetRfidSchema` (Task 1).
- Produces: `PATCH /api/gadgets/:id/rfid` → `gadgetService.reassignRfid(id, rfid_uid, actor)`.

- [ ] **Step 1: Write the failing test**

Add to `verifyGadgetCarry.ts`:

```ts
    console.log('\n--- replacing a gadget sticker blocks the retired one');
    const swap = await request(superadmin, 'PATCH', `/gadgets/${gadgetId}/rfid`, {
      rfid_uid: hex(7),
    });
    expectEqual('sticker replaced', swap.status, OK);

    // The retired tag must now be refused everywhere, or it goes back into the
    // pool and is granted again once reissued.
    const reuse = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: personId,
      gadget_type: 'tablet',
      brand_model: 'Probe Tablet',
      serial_number: `CPG3${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual('the retired tag cannot be re-registered', reuse.status, CONFLICT);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify:gadget-carry`
Expected: FAIL at "sticker replaced" with `404` — the route does not exist.

- [ ] **Step 3: Add the service method**

In `gadgets.service.ts`, add after `setStatus`:

```ts
  /**
   * Replaces a gadget's sticker and retires the old one.
   *
   * Mirrors personService.reassignRfid, including its deliberate fail-open: the
   * swap is written FIRST and the old tag blocked second. Blocking first would
   * kill the old sticker even if the swap then failed, leaving the device with
   * no working tag at all. If the block throws afterwards the old UID is off
   * this gadget AND off the blocklist — back in the pool and re-registrable —
   * so it is logged at error level rather than swallowed.
   */
  async reassignRfid(id: string, rfid_uid: string, actor: Actor) {
    assertCanWrite(actor, 'gadget');
    const existing = await gadgetRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Gadget not found');
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    await assertUidFree(rfid_uid, { kind: 'gadget', id });

    const updated = await gadgetRepo.updateById(id, { rfid_uid });
    if (!updated) throw new ApiError('NOT_FOUND', 'Gadget not found');

    if (existing.rfid_uid && existing.rfid_uid !== rfid_uid) {
      try {
        await blockedCardRepo.block({
          rfid_uid: existing.rfid_uid,
          source: 'card_replaced',
          blocked_by: actor.id,
        });
      } catch (err) {
        console.error(
          `[gadgets] FAILED to block retired tag ${existing.rfid_uid} after reassignRfid ` +
            `for gadget ${id} — this UID is now unassigned AND unblocked, and is ` +
            're-registrable until manually blocked.',
          err
        );
      }
    }
    return updated;
  },
```

Check `blockedCardRepo.block`'s signature before writing this — `persons.service.ts` passes `previous_person_id`, which has no gadget equivalent. If the field is required, add `previous_person_id: existing.owner_person_id` (the device's owner is the closest true answer); if optional, omit it.

- [ ] **Step 4: Add the controller and route**

`gadgets.controller.ts`:

```ts
  reassignRfid: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetService.reassignRfid(req.params.id, req.body.rfid_uid, actorOf(req)));
  }),
```

`gadgets.routes.ts`, after the `/:id/status` line:

```ts
gadgetRoutes.patch(
  '/:id/rfid',
  validate(reassignGadgetRfidSchema),
  gadgetController.reassignRfid
);
```

- [ ] **Step 5: Add the field to the registration form**

In `userpage/components/gadgets/GadgetForm.tsx`, add an `rfid_uid` input alongside `serial_number`. Read the file first and match its existing field markup exactly — label element, class names, and state wiring. The field is **optional** (a gadget can be registered before its sticker arrives) and must validate against `/^[0-9A-Fa-f]{6,32}$/` before submit, with the message `RFID must be 6-32 hex characters`. Include it in the POST body only when non-empty, mirroring how the form already omits other optional fields.

- [ ] **Step 6: Run the tests to verify they pass**

Run in `serverside`: `npx tsc --noEmit` then `npm run verify:gadget-carry` — expect exit 0 and PASS.
Run in `userpage`: `npx tsc --noEmit` and `npx eslint components/gadgets/GadgetForm.tsx` — expect exit 0.

- [ ] **Step 7: Commit**

```bash
git add serverside/src/modules/gadgets serverside/src/config/verifyGadgetCarry.ts \
        userpage/components/gadgets/GadgetForm.tsx
git commit -m "$(cat <<'EOF'
feat: assign and replace a gadget's RFID sticker

Adds PATCH /gadgets/:id/rfid mirroring persons.reassignRfid, including
its fail-open ordering: the swap lands first so a failed block can never
strand a device with no working tag, and a failed block is logged loudly
because a UID that is neither assigned nor blocked is re-registrable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Gadget lane entry prompt

**Files:**
- Modify: `userpage/lib/gateTerminal.ts` (TapDecision types)
- Modify: `userpage/components/gate/GateTerminal.tsx`

**Interfaces:**
- Consumes: Task 3's tap payload (`gadgets[].id`, `gadgets[].photo_url`).
- Produces: a `devicePrompt` state shape reused by Task 7:
  `{ mode: 'entry' | 'exit'; personId: string; expected: DeviceRow[]; seen: DeviceRow[] } | null`
  where `DeviceRow = { id: string; gadget_type: string; brand_model: string; serial_number: string; photo_url?: string }`.

- [ ] **Step 1: Update the payload types**

In `userpage/lib/gateTerminal.ts`, inside `TapDecision["person"]`, REPLACE the `gadgets` field and add the new one:

```ts
    gadgets?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      photo_url?: string;
    }[];
    /** Devices still inside, returned only on a granted person EXIT tap. */
    gadgets_inside?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
    }[];
```

- [ ] **Step 2: Add the prompt state and timer**

In `GateTerminal.tsx`, add near the other `useState` declarations:

```tsx
type DeviceRow = {
  id: string;
  gadget_type: string;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
};

/**
 * The two-step prompt.
 *
 * Presentation only — there is no server session. Each gadget tap is an
 * ordinary POST /scan/tap that has already moved that device's occupancy row
 * by the time it appears here. So a terminal reload mid-prompt loses the
 * checklist but never loses the record: everything tapped so far stands.
 */
const [devicePrompt, setDevicePrompt] = useState<{
  mode: "entry" | "exit";
  personId: string;
  expected: DeviceRow[];
  seen: DeviceRow[];
} | null>(null);
```

- [ ] **Step 3: Open the prompt after a granted person tap on the gadget lane**

Where a tap result is handled, after `setOutcome(...)`, add:

```tsx
// The gadget lane opens the prompt on a granted PERSON tap. A gadget tap
// arriving while the prompt is open is handled below and must not reopen it.
if (
  meta.gadgetFocus &&
  decision.access_result === "granted" &&
  decision.person?.type !== "gadget" &&
  decision.person?.person_id
) {
  setDevicePrompt({
    mode: "entry",
    personId: decision.person.person_id,
    expected: [],
    seen: [],
  });
}
```

`person_id` is supplied by Task 3 Step 6 on every person tap. If it is missing at runtime, Task 3 was not completed — stop and report rather than patching the server from this task.

- [ ] **Step 4: Accumulate gadget taps while the prompt is open**

In the same handler, before the block above:

```tsx
// A device tap while the prompt is open ticks a line instead of replacing the
// whole screen. Deduped by id so a double-read of the same sticker — common
// when someone holds it against the reader — does not list it twice.
if (devicePrompt && decision.person?.type === "gadget" && decision.access_result === "granted") {
  const g = decision.person.gadgets?.[0];
  if (g) {
    setDevicePrompt((p) =>
      p && !p.seen.some((s) => s.id === g.id) ? { ...p, seen: [...p.seen, g] } : p,
    );
  }
  return;
}
```

- [ ] **Step 5: Add the 30-second idle timeout**

```tsx
// Closes an unattended prompt so the next person does not tap into someone
// else's session. Resets on every device tap, not on a fixed deadline: a guard
// checking three laptops must not be cut off mid-queue.
useEffect(() => {
  if (!devicePrompt) return;
  const t = setTimeout(() => setDevicePrompt(null), 30_000);
  return () => clearTimeout(t);
}, [devicePrompt]);
```

- [ ] **Step 6: Render the entry prompt**

Inside the `meta.gadgetFocus` result-card branch, when `devicePrompt?.mode === "entry"`, render the accumulated `seen` list — each row with `GadgetImage`, type · brand, and the serial in large mono — plus a **Done** button calling `setDevicePrompt(null)`. When `seen` is empty show `Tap each device now, or press Done`.

Add `GadgetImage`, mirroring `VehicleImage` at `GateTerminal.tsx:59`:

```tsx
/** A registered device's photo. Same neutral glyph fallback as VehicleImage —
 *  most gadgets have no photo, so the placeholder is the common case. */
function GadgetImage({ path, gateKey }: { path?: string; gateKey: string }) {
  const placeholder = <span className="font-display text-4xl font-700 opacity-60">—</span>;
  if (!path) return placeholder;
  return (
    <AuthedImage
      path={path}
      alt="Registered device"
      className="h-full w-full object-cover"
      headers={{ "X-Gate-Key": gateKey }}
      fallback={placeholder}
    />
  );
}
```

- [ ] **Step 7: Verify manually**

Run: `npx tsc --noEmit` and `npx eslint components/gate/GateTerminal.tsx lib/gateTerminal.ts` — expect exit 0.

Then, with both servers running: provision `http://localhost:5173/gate/person-entry-gadget` to the **Gadget Lane** gate, tap a person card, confirm the prompt opens, tap a gadget sticker, confirm it appears with its serial, tap the same sticker again and confirm it does **not** duplicate, then press Done and confirm the screen returns to idle.

- [ ] **Step 8: Commit**

```bash
git add userpage/lib/gateTerminal.ts userpage/components/gate/GateTerminal.tsx
git commit -m "$(cat <<'EOF'
feat: device prompt on the gadget lane entry terminal

After a granted person tap the terminal stays open and accumulates
device taps until the guard presses Done or 30 idle seconds pass. The
prompt is presentation only — each device tap is an ordinary tap that
has already moved its occupancy row, so a reload loses the checklist but
never the record.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Exit checklist on the ordinary person exit

**Files:**
- Modify: `userpage/components/gate/GateTerminal.tsx`

**Interfaces:**
- Consumes: Task 6's `devicePrompt` state, Task 3's `gadgets_inside`, Task 4's `POST /scan/gadget-session`.
- Produces: nothing downstream.

- [ ] **Step 1: Open the checklist on a granted person exit**

`/gate/person-exit` has `gadgetFocus: false`, so this branch is keyed on the payload, not the route — which is the point: anyone who used the gadget lane is caught at the ordinary exit, with no way to walk around the check.

```tsx
// Keyed on gadgets_inside, NOT on the route. The server sends this only on a
// granted person EXIT tap and only when devices are actually still inside, so
// every other tap on this terminal behaves exactly as it did before.
if (
  meta.direction === "exit" &&
  decision.access_result === "granted" &&
  decision.person?.person_id &&
  (decision.person.gadgets_inside?.length ?? 0) > 0
) {
  setDevicePrompt({
    mode: "exit",
    personId: decision.person.person_id,
    expected: decision.person.gadgets_inside!,
    seen: [],
  });
}
```

- [ ] **Step 2: Auto-close when every expected device is ticked**

```tsx
// Closes itself once the last expected device is read, so the guard does not
// have to press anything in the normal case.
useEffect(() => {
  if (devicePrompt?.mode !== "exit") return;
  if (devicePrompt.expected.length === 0) return;
  const allSeen = devicePrompt.expected.every((e) =>
    devicePrompt.seen.some((s) => s.id === e.id),
  );
  if (allSeen) setDevicePrompt(null);
}, [devicePrompt]);
```

- [ ] **Step 3: Render the checklist and the incomplete-close path**

Render each `expected` row with a tick when its id is in `seen`, and a **Done** button. `Done` (and the 30-second timeout from Task 6) must, when devices are still unticked, POST the close event and then show the warning panel:

```tsx
async function closeExitPrompt() {
  const p = devicePrompt;
  if (!p || p.mode !== "exit") return;
  const missing = p.expected.filter((e) => !p.seen.some((s) => s.id === e.id));
  setDevicePrompt(null);
  if (missing.length === 0) return;
  setDeviceWarning(missing);
  // Fire-and-log. The person is already outside — a failed audit write must
  // never hold the terminal, and the guard has the warning on screen either
  // way. Matches how liveHub.notifyScan is treated at the end of a tap.
  try {
    await fetch(`${API_BASE}/scan/gadget-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gate-Key": config.key },
      body: JSON.stringify({
        person_id: p.personId,
        missing_gadget_ids: missing.map((m) => m.id),
      }),
    });
  } catch (err) {
    console.error("[gate] gadget session close failed", err);
  }
}
```

Add `const [deviceWarning, setDeviceWarning] = useState<DeviceRow[] | null>(null);` and render it as a **gold** panel with navy text — consistent with the existing no-device panel and with the rule that this never refuses passage. It names the missing devices and clears on the next tap. Wire the Task 6 timeout so an exit-mode prompt calls `closeExitPrompt()` rather than a bare `setDevicePrompt(null)`.

- [ ] **Step 4: Verify manually**

Run: `npx tsc --noEmit` and `npx eslint components/gate/GateTerminal.tsx` — expect exit 0.

Then, end to end: take a device in through the gadget lane, then at `/gate/person-exit` tap the person card and confirm the checklist lists that device; tap the device and confirm the screen closes green. Repeat, but press Done without tapping the device — confirm the gold warning names it, and that `GET /api/scan/logs` shows a `gadget_not_returned` row with `access_result: granted`. Finally tap a person with no devices inside and confirm the exit screen is completely unchanged from before this work.

- [ ] **Step 5: Commit**

```bash
git add userpage/components/gate/GateTerminal.tsx
git commit -m "$(cat <<'EOF'
feat: device checklist on the person exit terminal

Keyed on gadgets_inside rather than on the route, so anyone who entered
through the gadget lane is caught at the ordinary exit with no way to
walk around the check, while every other tap behaves exactly as before.

Closing with devices unticked warns in gold and posts the audit row. It
never refuses the exit: the person was already released on their own tap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Full-path verification and documentation

**Files:**
- Modify: `serverside/src/config/verifyGadgetCarry.ts`
- Modify: `userpage/docs/superpowers/specs/2026-08-05-gadget-registry-design.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Add the remaining spec-mandated checks**

Append to `verifyGadgetCarry.ts`, before the `finally`:

```ts
    console.log('\n--- a gadget belonging to someone else does not release');
    const stranger = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Stranger ${RUN}`, type: 'student',
      id_number: `CS-${RUN}`, rfid_uid: hex(8),
    });
    const strangerId = idOf(stranger.json);
    const strangerGadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: strangerId, gadget_type: 'laptop',
      brand_model: 'Stranger Laptop', serial_number: `CSG${RUN}`, rfid_uid: hex(9),
    });
    expectEqual('stranger gadget created', strangerGadget.status, CREATED);
    // It was never tapped in, so an exit tap must report exit_without_entry
    // rather than silently releasing a row that does not exist.
    const strangerOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(9), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual(
      'a device that never entered reports exit_without_entry',
      (strangerOut.json.data as { reason?: string })?.reason,
      'exit_without_entry'
    );
    await request(superadmin, 'DELETE', `/persons/${strangerId}`);

    console.log('\n--- a blocked gadget tag is refused');
    const blockedProbe = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: gadgetLane!._id, direction: 'entry',
    });
    // hex(2) was retired by the sticker swap in Task 5 and is on the blocklist.
    expectEqual(
      'the retired tag is refused at the gate',
      (blockedProbe.json.data as { reason?: string })?.reason,
      'card_blocked'
    );

    console.log('\n--- a gadget tap is logged AS a gadget');
    // Asserts the branch that could actually regress: that the UID resolved down
    // the third branch rather than being mistaken for a person or falling through
    // to unregistered_uid.
    //
    // Deliberately NOT "no attendance row exists for the gadget": attendance is
    // keyed by person_id, so a gadget id can never appear in it and that
    // assertion would be structurally impossible to fail. The property is
    // guaranteed by construction (attendancePersonId is null on a gadget tap)
    // and is recorded in the spec rather than tested here.
    const gadgetLogs = await request(superadmin, 'GET', '/scan/logs?limit=50');
    const gadgetLogRows = (gadgetLogs.json.data ?? []) as { entity_type?: string }[];
    expectEqual(
      'at least one scan log row was written with entity_type gadget',
      gadgetLogRows.some((l) => l.entity_type === 'gadget'),
      true
    );
```

- [ ] **Step 2: Run the full suite**

```bash
npm run verify:gadget-carry
npm run verify:gadgets
npm run verify:vehicles
npm run verify:passback
npm run verify:roles
npm run verify:registration
npm run verify:person-status
npm run verify:signatures
npm run verify:gates
npm run lint
npx tsc --noEmit
```

Expected: every script passes and both gates exit 0. Any failure here is a regression from Tasks 1–7 and must be fixed before the final commit — do not weaken a check to make it pass.

- [ ] **Step 3: Correct the superseded design doc**

`2026-08-05-gadget-registry-design.md` states that gadgets never enter the RFID namespace and never become a scan entity. Both are now false. Add a note directly under its title:

```markdown
> **Superseded in part, 2026-08-28.** The "no `rfid_uid`, never a scan entity"
> decision described below was deliberately reversed by
> `2026-08-28-gadget-rfid-carry-tracking-design.md`: gadgets now carry their own
> sticker and hold their own occupancy row. The rule this document's decision
> was protecting — that the gadget registry never refuses passage — is
> unchanged and still holds.
```

Leave the rest of that document intact. It is the record of why the original decision was made, and that reasoning is what the new spec argues against.

- [ ] **Step 4: Commit**

```bash
git add serverside/src/config/verifyGadgetCarry.ts \
        userpage/docs/superpowers/specs/2026-08-05-gadget-registry-design.md
git commit -m "$(cat <<'EOF'
test: full-path verification for gadget carry tracking

Covers the cases the spec calls out and the ones easiest to get wrong: a
device that never entered, a blocked tag at the gate, and the absence of
an attendance row for a gadget tap.

Marks the 2026-08-05 gadget registry design as partly superseded rather
than editing it, so the reasoning the reversal argues against survives.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Plan self-review

**Spec coverage.** Every spec section maps to a task: data model → 1, 2; three-way uniqueness → 1; scan resolution → 3; `wrong_gate_type` carve-out → 3; attendance carve-out → verified in 8 (no code change needed, which the spec states); roster and counts → 2; gate terminal → 6, 7; tag registration → 5; close event and reason codes → 4; testing → 1–8; migration → no task needed (existing gadgets keep no tag; nothing to run).

**Known gap, deliberately left.** The spec lists `gadget_unknown_tag` and `gadget_not_owned` as reason codes. An unknown tag already produces `unregistered_uid` from the existing resolution fallthrough, and a gadget owned by someone else produces `exit_without_entry` when it was never tapped in — both are truthful and already surface in anomalies. Adding two codes that restate them would grow the reason vocabulary without telling a guard anything new. **Task 8 verifies the existing codes fire; the two new ones are not implemented.** If a reviewer wants them distinct, that is a follow-up, not a silent addition here.

**Type consistency.** `DeviceRow` (Tasks 6, 7) matches `TapDecision.person.gadgets[]` (Task 6 Step 1) and the server's `TapResult` (Task 3 Step 3): `id`, `gadget_type`, `brand_model`, `serial_number`, optional `photo_url`. `gadgets_inside` omits `photo_url` on both sides. `assertUidFree`'s signature is identical in Task 1's definition and all six call sites. `countInside`'s return type gains `gadgets` in Task 2 and is read as `inside.gadgets` in its test.
