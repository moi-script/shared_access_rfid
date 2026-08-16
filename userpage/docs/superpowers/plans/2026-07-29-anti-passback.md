# Anti-Passback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop one RFID card from admitting two people by tracking whether each person and vehicle is currently inside campus, and denying a second entry that has no exit in between.

**Architecture:** A new `occupancy` collection holds one document per entity with a `state` of `inside` or `outside`. The entry transition is a single conditional upsert guarded by a unique compound index, so the duplicate-key error *is* the passback detection and simultaneous taps at two gates cannot both be granted. Stale state clears lazily — a document older than the most recent nightly boundary is treated as outside and overwritten in the same operation, so no cron job is needed.

**Tech Stack:** TypeScript, Express, Mongoose 8, MongoDB. Frontend is Next.js App Router with Tailwind. No new dependencies.

**Spec:** `userpage/docs/superpowers/specs/2026-07-29-anti-passback-design.md`

## Global Constraints

- **No new npm dependencies.** Everything here uses what is already installed.
- **No test framework.** This repo verifies via hand-rolled `verify:*` harnesses in `serverside/src/config/` run against a live server. Do not add jest/vitest. Tests in this plan are additions to `serverside/src/config/verifyPassback.ts`, run with `npm run verify:passback`.
- **Harness prerequisites:** `npm run dev` running in another terminal and `npm run seed:test` already applied, exactly like `verify:gates`.
- **Two repos, one feature.** Backend is `serverside/`, frontend is `userpage/`. They are separate git repositories — commit in whichever directory the task's files live in. All paths in this plan are relative to `C:\thesis_rfid\`.
- **Denial reason strings**, used verbatim in both repos: `already_inside`, `exit_without_entry`, `manual_override`.
- **Env var:** `OCCUPANCY_RESET_TIME`, default `'23:00'`.
- **Roles:** every new endpoint is `authorize(ROLES.SUPERADMIN)`. Registrar gets none of them.
- **Fail closed.** Never catch a database error and grant access. Only `E11000` is interpreted; everything else rethrows.
- **Commit style differs per repo — check `git log --oneline -5` in the repo you are committing to.**
  - `serverside/` uses conventional prefixes: `feat(occupancy): …`, `test(passback): …`, `refactor(attendance): …`.
  - `userpage/` uses plain imperative subject lines with no prefix.
  The commit commands in each task below already use the right form for their repo.

---

## File Structure

**Backend — create:**

| File | Responsibility |
|---|---|
| `serverside/src/utils/isDuplicateKey.ts` | One predicate: is this error a MongoDB duplicate-key error |
| `serverside/src/utils/occupancyWindow.ts` | One pure function: the most recent reset boundary at or before a given time |
| `serverside/src/modules/occupancy/occupancy.model.ts` | Mongoose schema + the load-bearing unique index |
| `serverside/src/modules/occupancy/occupancy.repository.ts` | All occupancy DB queries, including the atomic transitions |
| `serverside/src/modules/occupancy/occupancy.service.ts` | Roster and override business logic |
| `serverside/src/modules/occupancy/occupancy.controller.ts` | HTTP shell |
| `serverside/src/modules/occupancy/occupancy.routes.ts` | Route table + role guards |
| `serverside/src/config/rebuildOccupancy.ts` | Rebuild state from `scan_logs` |
| `serverside/src/config/verifyPassback.ts` | The verification harness, grown across tasks |

**Backend — modify:**

| File | Change |
|---|---|
| `serverside/src/config/env.ts` | Add `OCCUPANCY_RESET_TIME` |
| `serverside/src/modules/attendance/attendance.repository.ts:16-22` | Use the extracted `isDuplicateKey` |
| `serverside/src/modules/scan/scan.model.ts:22` | `gate_id` becomes optional so override rows can have none |
| `serverside/src/modules/scan/scan.service.ts:92-107` | Occupancy transition between the gate-type check and the log write |
| `serverside/src/modules/reports/reports.service.ts:31-50` | Anomaly report + null-gate guard on gate activity |
| `serverside/src/modules/reports/reports.routes.ts` | Route for `/anomalies` |
| `serverside/src/app.ts` | Mount `occupancyRoutes` |
| `serverside/package.json` | `verify:passback`, `rebuild:occupancy` scripts |
| `serverside/README.md` | Document the env var and the two new scripts |

**Frontend — create:**

- `userpage/components/admin/PresenceView.tsx` — the roster and the Clear action

**Frontend — modify:**

- `userpage/lib/permissions.ts` — `presence` in `AdminView` and `NAV_BY_ROLE.superadmin`
- `userpage/components/admin/AdminShell.tsx` — render the view
- `userpage/components/gate/GateTerminal.tsx:22` — one reason string

---

## Task 1: Reset boundary helper, env var, and harness scaffold

The boundary calculation is the only pure logic in the feature and the only place an off-by-one can hide. It ships first, with its own tests, before anything depends on it.

**Files:**
- Create: `serverside/src/utils/occupancyWindow.ts`
- Create: `serverside/src/config/verifyPassback.ts`
- Modify: `serverside/src/config/env.ts:23`
- Modify: `serverside/package.json` (scripts)

**Interfaces:**
- Consumes: `env` from `serverside/src/config/env.ts`
- Produces: `lastResetBoundary(now: Date, resetTime?: string): Date` — returns the most recent occurrence of `resetTime` (an `'HH:MM'` string) at or before `now`. Tasks 4, 5 and 7 call it.

- [ ] **Step 1: Add the env var**

In `serverside/src/config/env.ts`, add one line to the zod schema immediately after `LATE_CUTOFF_TIME`:

```ts
  LATE_CUTOFF_TIME: z.string().default('08:00'),
  OCCUPANCY_RESET_TIME: z.string().default('23:00'),
```

- [ ] **Step 2: Write the failing test harness**

Create `serverside/src/config/verifyPassback.ts`:

```ts
/**
 * Asserts the anti-passback behaviour in
 * docs/superpowers/specs/2026-07-29-anti-passback-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:passback
 */
import { lastResetBoundary } from '../utils/occupancyWindow';

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
  console.log('All anti-passback checks passed.');
}

/** Builds a local-time Date on a fixed calendar day, so assertions read clearly. */
function at(day: number, hh: number, mm: number): Date {
  return new Date(2026, 6, day, hh, mm, 0, 0); // month 6 = July
}

async function main(): Promise<void> {
  console.log('\n== reset boundary ==');

  // Before the cutoff: the boundary is YESTERDAY's occurrence.
  expectEqual(
    'morning tap resolves to yesterday 23:00',
    lastResetBoundary(at(15, 7, 5), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // After the cutoff: the boundary is TODAY's occurrence.
  expectEqual(
    'late-night tap resolves to today 23:00',
    lastResetBoundary(at(15, 23, 30), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // Exactly at the cutoff counts as "at or before", so it is today's.
  expectEqual(
    'a tap exactly at the cutoff resolves to today',
    lastResetBoundary(at(15, 23, 0), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // One minute before the cutoff is still the previous day's boundary. This is
  // the off-by-one the helper exists to get right.
  expectEqual(
    'one minute before the cutoff resolves to yesterday',
    lastResetBoundary(at(15, 22, 59), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // Midnight is the hardest case: 00:30 with a 23:00 cutoff must look BACK to
  // the previous calendar day, not forward to tonight.
  expectEqual(
    'after midnight resolves to the previous evening',
    lastResetBoundary(at(15, 0, 30), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // A midnight cutoff must not degenerate: at 00:00 the boundary is now.
  expectEqual(
    'a 00:00 cutoff resolves to today at midnight',
    lastResetBoundary(at(15, 0, 0), '00:00').getTime(),
    at(15, 0, 0).getTime()
  );

  summary();
}

main().catch((err) => {
  console.error('[verify:passback] failed', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

In `serverside/package.json`, add to `"scripts"` after `verify:signatures`:

```json
    "verify:passback": "ts-node src/config/verifyPassback.ts",
```

- [ ] **Step 4: Run it to confirm it fails**

```bash
cd serverside && npm run verify:passback
```

Expected: FAIL — `Cannot find module '../utils/occupancyWindow'`.

- [ ] **Step 5: Write the implementation**

Create `serverside/src/utils/occupancyWindow.ts`:

```ts
import { env } from '../config/env';

/**
 * The most recent occurrence of `resetTime` at or before `now`.
 *
 * Occupancy older than this boundary is treated as stale and cleared on read,
 * so a missed exit tap never becomes a next-morning lockout. Uses the SERVER'S
 * LOCAL clock, the same as scanService.dateKey() — see the timezone limitation
 * in the design doc.
 */
export function lastResetBoundary(
  now: Date,
  resetTime: string = env.OCCUPANCY_RESET_TIME
): Date {
  const [h, m] = resetTime.split(':').map((n) => parseInt(n, 10));
  const boundary = new Date(now);
  boundary.setHours(h, m, 0, 0);
  // Today's occurrence hasn't happened yet, so the most recent one was yesterday.
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}
```

- [ ] **Step 6: Run it to confirm it passes**

```bash
cd serverside && npm run verify:passback
```

Expected: `6/6 checks passed`.

- [ ] **Step 7: Commit**

```bash
cd serverside
git add src/utils/occupancyWindow.ts src/config/verifyPassback.ts src/config/env.ts package.json
git commit -m "feat(occupancy): add the reset boundary helper"
```

---

## Task 2: Extract the duplicate-key predicate

`attendance.repository.ts:16-22` already inlines the `E11000` check. Task 3 needs the same check. Extract it once now so the error code is not written twice.

**Files:**
- Create: `serverside/src/utils/isDuplicateKey.ts`
- Modify: `serverside/src/modules/attendance/attendance.repository.ts:9-23`

**Interfaces:**
- Produces: `isDuplicateKey(err: unknown): boolean`. Task 3 calls it.

- [ ] **Step 1: Write the implementation**

Create `serverside/src/utils/isDuplicateKey.ts`:

```ts
/**
 * True when Mongo rejected a write because it collided with a unique index.
 *
 * Two callers rely on this: the attendance rollup, where a collision means the
 * day's row already exists, and the occupancy entry transition, where it means
 * the card is already inside — i.e. a passback.
 */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
```

- [ ] **Step 2: Use it in the attendance repository**

In `serverside/src/modules/attendance/attendance.repository.ts`, add the import at the top:

```ts
import { isDuplicateKey } from '../../utils/isDuplicateKey';
```

Then replace the `catch` block (lines 16-22) with:

```ts
    } catch (err: unknown) {
      // A row already exists WITH a time_in (filter didn't match) → that's fine, return it.
      if (isDuplicateKey(err)) {
        return AttendanceModel.findOne({ person_id, date });
      }
      throw err;
    }
```

- [ ] **Step 3: Verify nothing broke**

```bash
cd serverside && npm run lint && npx tsc --noEmit
```

Expected: no errors.

With `npm run dev` running and `npm run seed:test` applied:

```bash
cd serverside && npm run verify:gates
```

Expected: all checks pass. That harness asserts the attendance time-in/time-out rollup, which is the code path just refactored.

- [ ] **Step 4: Commit**

```bash
cd serverside
git add src/utils/isDuplicateKey.ts src/modules/attendance/attendance.repository.ts
git commit -m "refactor(attendance): extract the shared duplicate-key check"
```

---

## Task 3: Occupancy model and repository

The heart of the feature. The unique index and the conditional upsert are what make passback detection atomic.

**Files:**
- Create: `serverside/src/modules/occupancy/occupancy.model.ts`
- Create: `serverside/src/modules/occupancy/occupancy.repository.ts`
- Modify: `serverside/src/config/verifyPassback.ts`

**Interfaces:**
- Consumes: `isDuplicateKey` (Task 2), `lastResetBoundary` (Task 1), `PaginationParams` from `../../utils/pagination`
- Produces:
  - `OccupancyModel`, `IOccupancy`
  - `occupancyRepo.enter(entity_type: EntityType, entity_id: Types.ObjectId, gate_id: Types.ObjectId, boundary: Date): Promise<'admitted' | 'already_inside'>`
  - `occupancyRepo.release(entity_type: EntityType, entity_id: Types.ObjectId, gate_id: Types.ObjectId): Promise<'released' | 'exit_without_entry'>`
  - `occupancyRepo.clearById(id: string, clearedBy: Types.ObjectId): Promise<IOccupancy | null>`
  - `occupancyRepo.listInside(boundary: Date, p: PaginationParams): Promise<{ items: unknown[]; total: number }>`
  - `type EntityType = 'person' | 'vehicle'`

Task 4 calls `enter`/`release`; Task 5 calls `clearById`/`listInside`.

- [ ] **Step 1: Write the failing tests**

These run directly against the database rather than over HTTP, because the concurrency guarantee is a property of the Mongo index and is clearest tested at the repository. Add to `serverside/src/config/verifyPassback.ts` — first the imports at the top of the file:

```ts
import mongoose, { Types } from 'mongoose';
import { connectDB } from './db';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { occupancyRepo } from '../modules/occupancy/occupancy.repository';
```

Then insert this block inside `main()`, immediately before `summary();`:

```ts
  console.log('\n== occupancy repository ==');
  await connectDB();

  const personId = new Types.ObjectId();
  const gateId = new Types.ObjectId();
  const boundary = lastResetBoundary(new Date());
  await OccupancyModel.deleteMany({ entity_id: personId });

  expectEqual(
    'first entry is admitted',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );
  expectEqual(
    'second entry with no exit is refused',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'already_inside'
  );
  expectEqual(
    'exit releases the card',
    await occupancyRepo.release('person', personId, gateId),
    'released'
  );
  expectEqual(
    'entry after a real exit is admitted again',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );
  expectEqual(
    'a second exit with nothing to release is flagged',
    await occupancyRepo.release('person', personId, gateId),
    'released'
  );
  expectEqual(
    'exit while already outside is flagged',
    await occupancyRepo.release('person', personId, gateId),
    'exit_without_entry'
  );

  // Lazy expiry: a document stranded inside from BEFORE the boundary must be
  // treated as outside, so a missed exit tap is not a next-morning lockout.
  await occupancyRepo.enter('person', personId, gateId, boundary);
  await OccupancyModel.updateOne(
    { entity_id: personId },
    { $set: { since: new Date(boundary.getTime() - 60_000) } }
  );
  expectEqual(
    'state stranded before the boundary is treated as expired',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );

  // The whole point of the design. Eight simultaneous entries on one card must
  // produce exactly ONE grant. A read-then-write implementation passes every
  // sequential check above and fails this one.
  for (let round = 1; round <= 10; round++) {
    const racer = new Types.ObjectId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  await OccupancyModel.deleteMany({ entity_id: personId });
  await mongoose.disconnect();
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd serverside && npm run verify:passback
```

Expected: FAIL — `Cannot find module '../modules/occupancy/occupancy.model'`.

- [ ] **Step 3: Write the model**

Create `serverside/src/modules/occupancy/occupancy.model.ts`:

```ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IOccupancy extends Document {
  _id: Types.ObjectId;
  entity_type: 'person' | 'vehicle';
  entity_id: Types.ObjectId;
  state: 'inside' | 'outside';
  since: Date;
  last_gate_id: Types.ObjectId | null;
  cleared_by: Types.ObjectId | null;
  cleared_at: Date | null;
}

const occupancySchema = new Schema<IOccupancy>({
  entity_type: { type: String, enum: ['person', 'vehicle'], required: true },
  entity_id: { type: Schema.Types.ObjectId, required: true },
  state: { type: String, enum: ['inside', 'outside'], required: true },
  since: { type: Date, required: true },
  last_gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', default: null },
  cleared_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  cleared_at: { type: Date, default: null },
});

// Load-bearing, not an optimisation. This index is what serialises two
// simultaneous entry taps on the same card: the loser gets E11000, which is how
// a passback is detected. Removing it silently breaks the feature.
occupancySchema.index({ entity_type: 1, entity_id: 1 }, { unique: true });

export const OccupancyModel = model<IOccupancy>('Occupancy', occupancySchema);
```

- [ ] **Step 4: Write the repository**

Create `serverside/src/modules/occupancy/occupancy.repository.ts`:

```ts
import { Types } from 'mongoose';
import { OccupancyModel, IOccupancy } from './occupancy.model';
import { isDuplicateKey } from '../../utils/isDuplicateKey';
import { PaginationParams } from '../../utils/pagination';

export type EntityType = 'person' | 'vehicle';
export type EnterResult = 'admitted' | 'already_inside';
export type ExitResult = 'released' | 'exit_without_entry';

export const occupancyRepo = {
  /**
   * Flips the entity to `inside` only if it is currently outside, or if its
   * state predates `boundary` and is therefore stale.
   *
   * The filter and the write are ONE operation on purpose. If the document
   * exists and is genuinely fresh-inside, the filter matches nothing, the
   * upsert attempts an insert, and the unique index rejects it — that E11000
   * is the passback. Splitting this into a read then a write reintroduces the
   * race the whole feature exists to close.
   */
  async enter(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId,
    boundary: Date
  ): Promise<EnterResult> {
    try {
      await OccupancyModel.findOneAndUpdate(
        {
          entity_type,
          entity_id,
          $or: [{ state: 'outside' }, { since: { $lt: boundary } }],
        },
        {
          $set: {
            state: 'inside',
            since: new Date(),
            last_gate_id: gate_id,
            cleared_by: null,
            cleared_at: null,
          },
        },
        { upsert: true, new: true }
      );
      return 'admitted';
    } catch (err: unknown) {
      if (isDuplicateKey(err)) return 'already_inside';
      throw err;
    }
  },

  /** Exit never fails. A miss means they were not inside, which is an anomaly, not a denial. */
  async release(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId
  ): Promise<ExitResult> {
    const doc = await OccupancyModel.findOneAndUpdate(
      { entity_type, entity_id, state: 'inside' },
      { $set: { state: 'outside', since: new Date(), last_gate_id: gate_id } }
    );
    return doc ? 'released' : 'exit_without_entry';
  },

  clearById(id: string, clearedBy: Types.ObjectId): Promise<IOccupancy | null> {
    return OccupancyModel.findOneAndUpdate(
      { _id: id, state: 'inside' },
      { $set: { state: 'outside', since: new Date(), cleared_by: clearedBy, cleared_at: new Date() } },
      { new: false }
    ).lean<IOccupancy | null>();
  },

  /**
   * The presence roster. Applies the same staleness rule as `enter`, so a
   * stranded row never shows up as somebody standing on campus.
   */
  async listInside(boundary: Date, p: PaginationParams) {
    const filter = { state: 'inside', since: { $gte: boundary } };
    const [items, total] = await Promise.all([
      OccupancyModel.aggregate([
        { $match: filter },
        { $sort: { since: -1 } },
        { $skip: p.skip },
        { $limit: p.limit },
        { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
        { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
        { $lookup: { from: 'gates', localField: 'last_gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 1,
            entity_type: 1,
            since: 1,
            name: {
              $ifNull: [
                { $arrayElemAt: ['$person.full_name', 0] },
                { $arrayElemAt: ['$vehicle.plate_number', 0] },
              ],
            },
            id_number: { $arrayElemAt: ['$person.id_number', 0] },
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
      ]),
      OccupancyModel.countDocuments(filter),
    ]);
    return { items, total };
  },
};
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd serverside && npm run verify:passback
```

Expected: `22/22 checks passed` — the 6 boundary checks, 7 repository checks, and 10 concurrency rounds (allow for the exact count to differ if you added checks; every one must pass).

If a concurrency round reports more than one grant, the index did not build. Confirm with `mongosh` → `db.occupancies.getIndexes()` and look for `entity_type_1_entity_id_1` with `unique: true`.

- [ ] **Step 6: Commit**

```bash
cd serverside
git add src/modules/occupancy src/config/verifyPassback.ts
git commit -m "feat(occupancy): add state with an atomic entry transition"
```

---

## Task 4: Enforce passback at the tap

Wire the repository into the scan flow. After this task the feature works at the gate, even though there is no way to see or override state yet.

**Files:**
- Modify: `serverside/src/modules/scan/scan.model.ts:22`
- Modify: `serverside/src/modules/scan/scan.service.ts`
- Modify: `serverside/src/config/verifyPassback.ts`

**Interfaces:**
- Consumes: `occupancyRepo.enter` / `occupancyRepo.release` (Task 3), `lastResetBoundary` (Task 1)
- Produces: taps now return `reason: 'already_inside'` with `access_result: 'denied'`, and `reason: 'exit_without_entry'` with `access_result: 'granted'`. Tasks 5, 6 and 8 read these strings.

- [ ] **Step 1: Make `gate_id` optional on scan logs**

Task 5 writes override rows that have no gate. The schema currently forbids that. In `serverside/src/modules/scan/scan.model.ts`, change the interface line and the schema line:

```ts
  gate_id: Types.ObjectId | null;
```

```ts
  // Nullable because a manual override is a real scan-log event with no gate.
  gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', default: null },
```

- [ ] **Step 2: Write the failing tests**

Add these helpers to `serverside/src/config/verifyPassback.ts`, above `main()`:

```ts
const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

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
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no JSON body; the status is what matters.
  }
  return { status: res.status, json };
}

interface TapData {
  access_result: 'granted' | 'denied';
  reason: string | null;
}

/** Taps as a superadmin, which names the gate in the body (see scan.routes.ts). */
async function tap(
  token: string,
  rfid_uid: string,
  gate_id: string,
  direction: 'entry' | 'exit'
): Promise<TapData> {
  const { json } = await request(token, 'POST', '/scan/tap', { rfid_uid, gate_id, direction });
  return (json.data ?? {}) as TapData;
}

/** Resolves the seeded gates by name so the harness does not hardcode ObjectIds. */
async function gateIdsByName(token: string): Promise<Record<string, string>> {
  const { json } = await request(token, 'GET', '/gates');
  const list = (json.data ?? []) as { _id: string; name: string }[];
  return Object.fromEntries(list.map((g) => [g.name, g._id]));
}
```

Then add this block inside `main()`, immediately before `summary();`:

```ts
  console.log('\n== passback at the gate ==');
  const superadmin = await login('testadmin', 'Admin@123');
  const gates = await gateIdsByName(superadmin);
  const personEntry = gates['Main Entrance'];
  const personExit = gates['Side Gate'];
  const vehicleEntry = gates['Parking Entrance'];
  const vehicleExit = gates['Parking Exit'];

  // Juan Dela Cruz from seed:test. Start from a known state.
  const juan = await PersonModel.findOne({ id_number: '2025-0001' }).lean();
  if (!juan) throw new Error('run `npm run seed:test` first — student 2025-0001 is missing');
  await OccupancyModel.deleteMany({ entity_id: juan._id });
  const juanUid = juan.rfid_uid as string;

  const first = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('first entry granted', first.access_result, 'granted');
  expectEqual('first entry has no reason', first.reason, null);

  const second = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('repeat entry denied', second.access_result, 'denied');
  expectEqual('repeat entry names the passback', second.reason, 'already_inside');

  const out = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit granted', out.access_result, 'granted');
  expectEqual('exit has no reason', out.reason, null);

  const again = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('entry after a real exit granted', again.access_result, 'granted');

  await tap(superadmin, juanUid, personExit, 'exit');
  const orphanExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit with no entry is never blocked', orphanExit.access_result, 'granted');
  expectEqual('exit with no entry is flagged', orphanExit.reason, 'exit_without_entry');

  // A denied tap must not move anyone's state. Tapping a person card at a
  // VEHICLE gate is denied for wrong_gate_type before occupancy is consulted;
  // if it leaked through, the entry below would come back already_inside.
  const wrongGate = await tap(superadmin, juanUid, vehicleEntry, 'entry');
  expectEqual('person card at a vehicle gate denied', wrongGate.reason, 'wrong_gate_type');
  const afterWrongGate = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('a denied tap left state untouched', afterWrongGate.access_result, 'granted');
  await tap(superadmin, juanUid, personExit, 'exit');

  // Vehicles are covered too.
  const car = await VehicleModel.findOne({}).lean();
  if (car) {
    await OccupancyModel.deleteMany({ entity_id: car._id });
    const carUid = car.rfid_uid;
    expectEqual(
      'vehicle first entry granted',
      (await tap(superadmin, carUid, vehicleEntry, 'entry')).access_result,
      'granted'
    );
    expectEqual(
      'vehicle repeat entry denied',
      (await tap(superadmin, carUid, vehicleEntry, 'entry')).reason,
      'already_inside'
    );
    expectEqual(
      'vehicle exit granted',
      (await tap(superadmin, carUid, vehicleExit, 'exit')).access_result,
      'granted'
    );
    await OccupancyModel.deleteMany({ entity_id: car._id });
  }

  await OccupancyModel.deleteMany({ entity_id: juan._id });
```

Add these imports at the top of the file:

```ts
import { PersonModel } from '../modules/persons/persons.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
```

Move the `await mongoose.disconnect();` line so it is the last statement before `summary();` — the block above uses models.

- [ ] **Step 3: Run to verify it fails**

```bash
cd serverside && npm run verify:passback
```

Expected: FAIL — `repeat entry denied: got "granted", expected "denied"`. The gate currently admits a passback, which is the bug.

- [ ] **Step 4: Wire occupancy into the tap**

In `serverside/src/modules/scan/scan.service.ts`, add imports:

```ts
import { occupancyRepo } from '../occupancy/occupancy.repository';
import { lastResetBoundary } from '../../utils/occupancyWindow';
```

Then insert this block between the `wrong_gate_type` check (ends line 96) and the `await scanRepo.createLog({` call:

```ts
    // Anti-passback. Runs only on taps that are otherwise granted, so a denied
    // card can never move anyone's state — including a stranger repeatedly
    // tapping a stolen inactive card.
    if (access_result === 'granted' && entity_id) {
      const gateOid = new Types.ObjectId(input.gate_id);
      if (input.direction === 'entry') {
        const outcome = await occupancyRepo.enter(
          entity_type,
          entity_id,
          gateOid,
          lastResetBoundary(scan_time)
        );
        if (outcome === 'already_inside') {
          access_result = 'denied';
          reason = 'already_inside';
          // personView is deliberately KEPT: a guard needs to see who the
          // system thinks is inside in order to resolve it.
        }
      } else {
        const outcome = await occupancyRepo.release(entity_type, entity_id, gateOid);
        if (outcome === 'exit_without_entry') {
          // Granted anyway — egress is never blocked. The reason rides along on
          // a granted row so the anomaly report can find it.
          reason = 'exit_without_entry';
        }
      }
    }
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd serverside && npm run verify:passback
```

Expected: every check passes.

- [ ] **Step 6: Confirm attendance still works**

```bash
cd serverside && npm run verify:gates
```

Expected: all checks pass. This matters — an `exit_without_entry` tap is still `granted`, so it must still write `time_out`, and the harness asserts exactly that.

- [ ] **Step 7: Commit**

```bash
cd serverside
git add src/modules/scan src/config/verifyPassback.ts
git commit -m "feat(scan): deny a repeat entry that has no exit in between"
```

---

## Task 5: Presence roster and superadmin override

**Files:**
- Create: `serverside/src/modules/occupancy/occupancy.service.ts`
- Create: `serverside/src/modules/occupancy/occupancy.controller.ts`
- Create: `serverside/src/modules/occupancy/occupancy.routes.ts`
- Modify: `serverside/src/app.ts`
- Modify: `serverside/src/config/verifyPassback.ts`

**Interfaces:**
- Consumes: `occupancyRepo.listInside` / `occupancyRepo.clearById` (Task 3)
- Produces: `GET /api/occupancy` → `{ success, data: items[], meta.pagination }`; `POST /api/occupancy/:id/clear` → `{ success, data: { cleared: true } }`. Task 8 consumes both from the frontend.

- [ ] **Step 1: Write the failing tests**

Add to `main()` in `serverside/src/config/verifyPassback.ts`, before `summary();`:

```ts
  console.log('\n== presence roster and override ==');
  const registrar = await login('testregistrar', 'Registrar@123');

  await OccupancyModel.deleteMany({ entity_id: juan._id });
  await tap(superadmin, juanUid, personEntry, 'entry');

  const roster = await request(superadmin, 'GET', '/occupancy');
  expectEqual('superadmin may read the roster', roster.status, 200);
  const rows = (roster.json.data ?? []) as { _id: string; name: string; entity_type: string }[];
  const juanRow = rows.find((r) => r.name === juan.full_name);
  expectEqual('the person who tapped in is on the roster', !!juanRow, true);
  expectEqual('roster rows name their entity type', juanRow?.entity_type, 'person');

  expectEqual(
    'registrar may not read the roster',
    (await request(registrar, 'GET', '/occupancy')).status,
    403
  );
  expectEqual(
    'an anonymous caller may not read the roster',
    (await request(null, 'GET', '/occupancy')).status,
    401
  );

  expectEqual(
    'registrar may not clear state',
    (await request(registrar, 'POST', `/occupancy/${juanRow?._id}/clear`, {})).status,
    403
  );

  const cleared = await request(superadmin, 'POST', `/occupancy/${juanRow?._id}/clear`, {});
  expectEqual('superadmin may clear state', cleared.status, 200);

  // The override worked: the card can enter again without an exit tap.
  expectEqual(
    'a cleared card may enter again',
    (await tap(superadmin, juanUid, personEntry, 'entry')).access_result,
    'granted'
  );

  // Clearing something already outside is not an error the client should retry.
  const stale = await request(superadmin, 'POST', `/occupancy/${juanRow?._id}/clear`, {});
  expectEqual('clearing an already-cleared row is a 404', stale.status, 404);

  await OccupancyModel.deleteMany({ entity_id: juan._id });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd serverside && npm run verify:passback
```

Expected: FAIL — `superadmin may read the roster: got 404, expected 200`.

- [ ] **Step 3: Write the service**

Create `serverside/src/modules/occupancy/occupancy.service.ts`:

```ts
import { Types } from 'mongoose';
import { occupancyRepo } from './occupancy.repository';
import { ScanLogModel } from '../scan/scan.model';
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { lastResetBoundary } from '../../utils/occupancyWindow';

export const occupancyService = {
  async list(query: Record<string, unknown>) {
    const p = getPagination(query);
    const { items, total } = await occupancyRepo.listInside(lastResetBoundary(new Date()), p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  /**
   * Forces one entity outside. Writes an append-only scan_logs row, because the
   * cleared_by/cleared_at fields on the occupancy document are overwritten by
   * the person's very next tap — usually within minutes. Without the log row,
   * an override erases its own evidence, which is exactly the mechanism someone
   * would use to help a friend past the passback check.
   */
  async clear(id: string, actorUserId: string) {
    if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Occupancy record not found');

    const doc = await occupancyRepo.clearById(id, new Types.ObjectId(actorUserId));
    if (!doc) throw new ApiError('NOT_FOUND', 'No one is currently inside under that record');

    const rfid_uid = await resolveRfid(doc.entity_type, doc.entity_id);
    await ScanLogModel.create({
      rfid_uid,
      entity_type: doc.entity_type,
      entity_id: doc.entity_id,
      gate_id: null, // no gate — this did not happen at a terminal
      direction: 'exit',
      access_result: 'granted',
      reason: 'manual_override',
      scan_time: new Date(),
    });

    return { cleared: true };
  },
};

/** The audit row is far more useful with the card's UID than without it. */
async function resolveRfid(
  entity_type: 'person' | 'vehicle',
  entity_id: Types.ObjectId
): Promise<string> {
  if (entity_type === 'person') {
    const person = await PersonModel.findById(entity_id).select('rfid_uid').lean();
    return person?.rfid_uid ?? 'MANUAL';
  }
  const vehicle = await VehicleModel.findById(entity_id).select('rfid_uid').lean();
  return vehicle?.rfid_uid ?? 'MANUAL';
}
```

- [ ] **Step 4: Write the controller**

Create `serverside/src/modules/occupancy/occupancy.controller.ts`:

```ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { occupancyService } from './occupancy.service';

export const occupancyController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await occupancyService.list(req.query as Record<string, unknown>);
    sendSuccess(res, items, 200, meta);
  }),

  clear: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    sendSuccess(res, await occupancyService.clear(req.params.id, req.user.userId), 200);
  }),
};
```

- [ ] **Step 5: Write the routes**

Create `serverside/src/modules/occupancy/occupancy.routes.ts`:

```ts
import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { occupancyController } from './occupancy.controller';

export const occupancyRoutes = Router();

// Superadmin only. The registrar is denied scan-derived data everywhere else in
// this API (see dashboardService.registrarView) and occupancy is scan-derived.
occupancyRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));
occupancyRoutes.get('/', occupancyController.list);
occupancyRoutes.post('/:id/clear', occupancyController.clear);
```

- [ ] **Step 6: Mount the routes**

In `serverside/src/app.ts`, add the import alongside the others:

```ts
import { occupancyRoutes } from './modules/occupancy/occupancy.routes';
```

and mount it after the `scan` line:

```ts
  app.use(`${prefix}/occupancy`, occupancyRoutes);
```

- [ ] **Step 7: Run to verify it passes**

```bash
cd serverside && npm run verify:passback
```

Expected: every check passes.

- [ ] **Step 8: Commit**

```bash
cd serverside
git add src/modules/occupancy src/app.ts src/config/verifyPassback.ts
git commit -m "feat(occupancy): add the presence roster and superadmin override"
```

---

## Task 6: Anomaly report

**Files:**
- Modify: `serverside/src/modules/reports/reports.service.ts`
- Modify: `serverside/src/modules/reports/reports.controller.ts`
- Modify: `serverside/src/modules/reports/reports.routes.ts`
- Modify: `serverside/src/config/verifyPassback.ts`

**Interfaces:**
- Consumes: the `reason` strings written in Tasks 4 and 5
- Produces: `GET /api/reports/anomalies` → `{ success, data: { count, rows } }`

- [ ] **Step 1: Write the failing tests**

Add to `main()` in `serverside/src/config/verifyPassback.ts`, before `summary();`:

```ts
  console.log('\n== anomaly report ==');

  await OccupancyModel.deleteMany({ entity_id: juan._id });
  await tap(superadmin, juanUid, personEntry, 'entry');
  await tap(superadmin, juanUid, personEntry, 'entry'); // already_inside
  await tap(superadmin, juanUid, personExit, 'exit');
  await tap(superadmin, juanUid, personExit, 'exit'); // exit_without_entry

  const report = await request(superadmin, 'GET', '/reports/anomalies');
  expectEqual('superadmin may read the anomaly report', report.status, 200);
  const payload = (report.json.data ?? {}) as {
    count: number;
    rows: { reason: string; name?: string }[];
  };
  const reasons = payload.rows.map((r) => r.reason);
  expectEqual('passbacks appear in the report', reasons.includes('already_inside'), true);
  expectEqual('orphan exits appear in the report', reasons.includes('exit_without_entry'), true);
  expectEqual('report rows resolve the person name', !!payload.rows[0]?.name, true);

  expectEqual(
    'registrar may not read the anomaly report',
    (await request(registrar, 'GET', '/reports/anomalies')).status,
    403
  );

  // Manual overrides are audit events and must be findable in the same report.
  await tap(superadmin, juanUid, personEntry, 'entry');
  const live = await request(superadmin, 'GET', '/occupancy');
  const liveRows = (live.json.data ?? []) as { _id: string; name: string }[];
  const row = liveRows.find((r) => r.name === juan.full_name);
  await request(superadmin, 'POST', `/occupancy/${row?._id}/clear`, {});

  const afterOverride = await request(superadmin, 'GET', '/reports/anomalies');
  const afterRows = ((afterOverride.json.data ?? {}) as { rows: { reason: string }[] }).rows;
  expectEqual(
    'a manual override is auditable',
    afterRows.some((r) => r.reason === 'manual_override'),
    true
  );

  // Override rows have no gate, so they must not pollute gate activity.
  const activity = await request(superadmin, 'GET', '/reports/gate-activity');
  const buckets = ((activity.json.data ?? {}) as {
    rows: { _id: { gate_id: string | null } }[];
  }).rows;
  expectEqual(
    'gate activity excludes gateless override rows',
    buckets.every((b) => b._id.gate_id !== null),
    true
  );

  await OccupancyModel.deleteMany({ entity_id: juan._id });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd serverside && npm run verify:passback
```

Expected: FAIL — `superadmin may read the anomaly report: got 404, expected 200`.

- [ ] **Step 3: Add the service methods**

In `serverside/src/modules/reports/reports.service.ts`, the first line currently imports only `FilterQuery`. Replace it so `Types` comes in too:

```ts
import { FilterQuery, Types } from 'mongoose';
```

The `ScanLogModel` / `IScanLog` import on line 3 already exists — leave it alone.

Add this interface next to the existing ones:

```ts
interface AnomalyQuery {
  from?: string;
  to?: string;
}
```

Add this method to the `reportService` object:

```ts
  /**
   * Every scan the passback system considers abnormal: refused repeat entries,
   * exits with no matching entry, and superadmin overrides. Capped at 500 rows
   * — unlike the older reports here, this one is bounded on purpose.
   */
  async anomalies(query: AnomalyQuery) {
    const match: Record<string, unknown> = {
      reason: { $in: ['already_inside', 'exit_without_entry', 'manual_override'] },
    };
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      match.scan_time = range;
    }

    const rows = await ScanLogModel.aggregate([
      { $match: match },
      { $sort: { scan_time: -1 } },
      { $limit: 500 },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
      {
        $project: {
          _id: 0,
          scan_time: 1,
          reason: 1,
          direction: 1,
          access_result: 1,
          entity_type: 1,
          rfid_uid: 1,
          name: { $arrayElemAt: ['$person.full_name', 0] },
          gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Manual override'] },
        },
      },
    ]);
    return { count: rows.length, rows };
  },
```

- [ ] **Step 4: Keep gateless rows out of gate activity**

Still in `reports.service.ts`, inside `gateActivity`, replace the `gate_id` handling:

```ts
    if (query.gate_id) {
      match.gate_id = new Types.ObjectId(query.gate_id) as unknown as IScanLog['gate_id'];
    } else {
      // Manual-override rows have no gate. Without this they aggregate into a
      // null bucket that reads as a phantom gate.
      match.gate_id = { $ne: null } as unknown as IScanLog['gate_id'];
    }
```

- [ ] **Step 5: Add the controller method and route**

In `serverside/src/modules/reports/reports.controller.ts`, add to the object:

```ts
  anomalies: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.anomalies(req.query as Record<string, string>));
  }),
```

In `serverside/src/modules/reports/reports.routes.ts`, add:

```ts
reportRoutes.get('/anomalies', reportController.anomalies);
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd serverside && npm run verify:passback
```

Expected: every check passes.

- [ ] **Step 7: Commit**

```bash
cd serverside
git add src/modules/reports src/config/verifyPassback.ts
git commit -m "feat(reports): report passback anomalies"
```

---

## Task 7: Rebuild script

Occupancy is a second source of truth and can drift. This makes drift recoverable rather than permanent.

**Files:**
- Create: `serverside/src/config/rebuildOccupancy.ts`
- Modify: `serverside/package.json`
- Modify: `serverside/README.md`

**Interfaces:**
- Consumes: `lastResetBoundary` (Task 1), `OccupancyModel` (Task 3)

- [ ] **Step 1: Write the script**

Create `serverside/src/config/rebuildOccupancy.ts`:

```ts
/**
 * Rebuilds the occupancy collection from scan_logs.
 *
 * Occupancy is a read-optimised second source of truth; scan_logs is the
 * record of what actually happened. If the two ever disagree — after a restore,
 * a manual edit, or a bug — this reconciles occupancy back to the logs.
 *
 * Only scans since the last reset boundary matter: anything older is expired by
 * definition. Manual-override rows need no special handling; they are granted
 * exits, and replaying them as exits is exactly right.
 *
 * Run with: npm run rebuild:occupancy
 */
import mongoose from 'mongoose';
import { connectDB } from './db';
import { ScanLogModel } from '../modules/scan/scan.model';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { lastResetBoundary } from '../utils/occupancyWindow';

interface Pending {
  entity_type: 'person' | 'vehicle';
  entity_id: mongoose.Types.ObjectId;
  since: Date;
  last_gate_id: mongoose.Types.ObjectId | null;
}

async function main(): Promise<void> {
  await connectDB();
  const boundary = lastResetBoundary(new Date());
  console.log(`[rebuild] replaying granted scans since ${boundary.toISOString()}`);

  const logs = await ScanLogModel.find({
    scan_time: { $gte: boundary },
    access_result: 'granted',
    entity_id: { $ne: null },
  })
    .sort({ scan_time: 1 })
    .lean();

  // Last write wins per entity, in chronological order.
  const inside = new Map<string, Pending>();
  for (const log of logs) {
    if (!log.entity_id) continue;
    const key = `${log.entity_type}:${String(log.entity_id)}`;
    if (log.direction === 'entry') {
      inside.set(key, {
        entity_type: log.entity_type,
        entity_id: log.entity_id,
        since: log.scan_time,
        last_gate_id: log.gate_id ?? null,
      });
    } else {
      inside.delete(key);
    }
  }

  await OccupancyModel.deleteMany({});
  if (inside.size > 0) {
    // Only `inside` rows are written. A missing document already means outside,
    // so writing `outside` rows would bloat the collection to the full roster.
    await OccupancyModel.insertMany(
      [...inside.values()].map((p) => ({
        entity_type: p.entity_type,
        entity_id: p.entity_id,
        state: 'inside' as const,
        since: p.since,
        last_gate_id: p.last_gate_id,
        cleared_by: null,
        cleared_at: null,
      }))
    );
  }

  console.log(`[rebuild] ${logs.length} scans replayed, ${inside.size} entities marked inside`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[rebuild:occupancy] failed', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `serverside/package.json`, add after `seed:test`:

```json
    "rebuild:occupancy": "ts-node src/config/rebuildOccupancy.ts",
```

- [ ] **Step 3: Verify it reconciles a deliberately broken state**

With `npm run dev` running:

```bash
cd serverside && npm run verify:passback
```

Expected: passes (this establishes known-good state). Then break it on purpose and repair it:

```bash
cd serverside && npx ts-node -e "import('./src/config/db').then(async (m) => { await m.connectDB(); const { OccupancyModel } = await import('./src/modules/occupancy/occupancy.model'); await OccupancyModel.deleteMany({}); console.log('occupancy wiped'); process.exit(0); })"
npm run rebuild:occupancy
```

Expected: the rebuild reports a non-negative count and exits 0. Run `npm run verify:passback` again — expected: still passes.

- [ ] **Step 4: Document the new knobs**

In `serverside/README.md`, add to the required-environment-variables table:

```markdown
| `OCCUPANCY_RESET_TIME` | Nightly cutoff (`HH:MM`, default `23:00`) after which a card still marked inside is treated as outside. Prevents a missed exit tap from locking someone out the next morning. |
```

And to the scripts list:

```markdown
- `npm run verify:passback` — assert anti-passback behaviour (needs `dev` + `seed:test`)
- `npm run rebuild:occupancy` — reconcile occupancy state from `scan_logs`
```

- [ ] **Step 5: Commit**

```bash
cd serverside
git add src/config/rebuildOccupancy.ts package.json README.md
git commit -m "feat(occupancy): rebuild state from the scan log"
```

---

## Task 8: Frontend — presence view and terminal message

**Files:**
- Create: `userpage/components/admin/PresenceView.tsx`
- Modify: `userpage/lib/permissions.ts`
- Modify: `userpage/components/admin/AdminShell.tsx`
- Modify: `userpage/components/gate/GateTerminal.tsx:22`

**Interfaces:**
- Consumes: `GET /api/occupancy` and `POST /api/occupancy/:id/clear` (Task 5); `reason: 'already_inside'` from the tap response (Task 4)

- [ ] **Step 1: Tell the terminal what the new denial means**

In `userpage/components/gate/GateTerminal.tsx`, add one entry to `REASON_TEXT`:

```ts
  unregistered_uid: "Unregistered card",
  inactive_id: "ID inactive",
  wrong_gate_type: "Wrong gate for this card",
  already_inside: "Card already inside campus",
```

- [ ] **Step 2: Add the nav entry**

In `userpage/lib/permissions.ts`, add `"presence"` to the `AdminView` union:

```ts
export type AdminView =
  | "overview"
  | "directory"
  | "parking"
  | "presence"
  | "register"
  | "accounts";
```

and to `NAV_BY_ROLE.superadmin`, after `parking`:

```ts
    { id: "presence", label: "Presence" },
```

Leave `NAV_BY_ROLE.registrar` untouched — the API returns 403 for that role.

- [ ] **Step 3: Write the presence view**

Create `userpage/components/admin/PresenceView.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGetList, apiPost } from "@/lib/auth";
import { fmtDateTime } from "./types";

interface PresenceRow {
  _id: string;
  entity_type: "person" | "vehicle";
  name: string | null;
  id_number?: string;
  gate: string;
  since: string;
}

export default function PresenceView() {
  const [rows, setRows] = useState<PresenceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGetList<PresenceRow>("/occupancy")
      .then((res) => {
        setRows(res.items);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function clear(id: string) {
    setClearing(id);
    try {
      await apiPost(`/occupancy/${id}/clear`, {});
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(null);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-600 uppercase tracking-[0.16em] text-ink-soft">
          On campus now
        </h2>
        <button
          onClick={load}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-600 text-ink-soft transition hover:border-navy/40 hover:text-navy"
        >
          Refresh
        </button>
      </div>

      <p className="mt-1 text-[13px] text-ink-soft">
        Anyone here has tapped in without tapping out. Clearing a row lets that card enter
        again — use it when someone left without tapping.
      </p>

      {error && <p className="mt-3 text-[14px] text-red">{error}</p>}
      {loading && <p className="mt-3 text-ink-soft">Loading…</p>}

      {!loading && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-line text-[12px] uppercase tracking-wide text-ink-soft">
                <th className="py-2 font-600">Name</th>
                <th className="py-2 font-600">ID</th>
                <th className="py-2 font-600">Type</th>
                <th className="py-2 font-600">Entered at</th>
                <th className="py-2 font-600">Since</th>
                <th className="py-2 font-600"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5 font-600 text-ink">{r.name ?? "Unknown"}</td>
                  <td className="py-2.5 font-mono text-[13px] text-ink-soft">
                    {r.id_number ?? "—"}
                  </td>
                  <td className="py-2.5 capitalize text-ink-soft">{r.entity_type}</td>
                  <td className="py-2.5 text-ink-soft">{r.gate}</td>
                  <td className="py-2.5 text-ink-soft">{fmtDateTime(r.since)}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => clear(r._id)}
                      disabled={clearing === r._id}
                      className="rounded-lg border border-line px-3 py-1 text-[13px] font-600 text-ink-soft transition hover:border-red/40 hover:text-red disabled:opacity-50"
                    >
                      {clearing === r._id ? "Clearing…" : "Clear"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="mt-3 text-[15px] text-ink-soft">Nobody is currently on campus.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Render it**

In `userpage/components/admin/AdminShell.tsx`, add the import next to the other view imports:

```tsx
import PresenceView from "./PresenceView";
```

and add the render line after the `parking` line:

```tsx
        {!loading && view === "presence" && <PresenceView />}
```

Note it takes no `data` prop — it fetches `/occupancy` itself, because the roster changes with every tap and the dashboard payload is loaded once on mount.

- [ ] **Step 5: Verify in the browser**

Start both sides (`npm run dev` in `serverside/`, `npm run dev` in `userpage/`), then:

1. Sign in at `/login` as `testadmin` / `Admin@123`.
2. Open the **Presence** tab. Expected: "Nobody is currently on campus" or a roster.
3. In another tab open a gate terminal and tap a seeded student card in at the person entry gate. Refresh Presence. Expected: that student appears.
4. Tap the same card at the entry gate again. Expected: the terminal shows **"Card already inside campus"**, not the raw `already_inside`.
5. Back on Presence, click **Clear** on that row. Expected: the row disappears.
6. Tap the card at the entry gate again. Expected: granted.
7. Sign out, sign in as `testregistrar` / `Registrar@123`. Expected: no Presence tab in the nav.

- [ ] **Step 6: Check types and lint**

```bash
cd userpage && npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd userpage
git add components/admin/PresenceView.tsx components/admin/AdminShell.tsx lib/permissions.ts components/gate/GateTerminal.tsx
git commit -m "Show who is on campus and let a superadmin clear stuck state"
```

---

## Done criteria

- `npm run verify:passback` passes in full, including all ten concurrency rounds.
- `npm run verify:gates` still passes — attendance rollup is unaffected.
- `npm run verify:roles` still passes — no role boundary moved.
- A repeat entry at a real terminal shows "Card already inside campus".
- The Presence tab lists who is inside, and Clear releases a card.
- `npm run rebuild:occupancy` reconciles a wiped collection without error.

## Deliberately not in scope

Carried from the spec's Known Limitations, so a reviewer does not read these as oversights:

- **The closing-time window.** A card that enters at 22:00 can enter again at 23:30, because its state predates the 23:00 boundary. Closing it needs the cron sweep this design rejected.
- **Server-local time.** `OCCUPANCY_RESET_TIME` inherits the timezone fragility of `scanService.dateKey()`. The shared fix is a `TZ` env var applied to both, deliberately out of scope here.
- **`already_inside` shows the cardholder's name.** Intentional — a guard must know who the system thinks is inside — and the same exposure `inactive_id` already has.
- **A deactivated person stranded inside** stays on the roster until the boundary, because the `status !== 'active'` check denies them at the exit gate before occupancy is consulted. The existing check is not modified.
