# Monitor Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a guard at a barrier which section the tapped person belongs to, and what they have registered, without leaking that on a denial.

**Architecture:** `scan.service.tap` widens the `person` block of its response with `department_section`, an `owner_type` for vehicle taps, `vehicle` detail, and a `registered[]` array populated **only on granted person taps**. The terminal renders those fields. No schema change, no migration — every new value is read from records that already exist.

**Tech Stack:** TypeScript, Express, Mongoose 8 (backend); Next.js 16 + React 19 + Tailwind 4 (frontend). Verification is black-box `ts-node` harnesses, not a unit-test framework.

**Spec:** `docs/superpowers/specs/2026-07-31-monitor-output-design.md`

## Global Constraints

- **No unit-test framework exists and none may be added.** Verification extends `serverside/src/config/verify*.ts`. `verify:gates` is the relevant harness — it taps real gates with real gate keys.
- **All four harnesses chain in one command:** `npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback`. A dev server runs on :3000 at production rate limits with `VERIFY_BYPASS_TOKEN` set. Do **not** raise the limits. Do **not** run `npm run dev` — it fails EADDRINUSE and orphans a process tree.
- **Two repos.** Backend `C:\thesis_rfid\serverside`, frontend `C:\thesis_rfid\userpage`. Both on `main`, clean and pushed. Create branch `feat/monitor-output` in each.
- **Commit style differs per repo.** `serverside` uses conventional prefixes (`feat:`, `fix:`, `test:`); `userpage` uses plain sentence subjects with **no** prefix.
- **Next.js 16 is not the Next.js you know.** `userpage/AGENTS.md` requires reading the relevant guide in `node_modules/next/dist/docs/` before writing frontend code.
- **Never derive a calendar date with `toISOString()`.** Expiry comparisons use local time against the tap's own `scan_time`; this codebase has shipped two real defects from UTC-derived dates.
- Every commit must build: `npm run build` and `npm run lint` clean (backend); `npx tsc --noEmit` clean and **no new** eslint errors (frontend — exactly 4 pre-exist, one each in `app/admin/page.tsx`, `app/dashboard/page.tsx`, `PersonProfile.tsx` and `StudentsDirectory.tsx`, which this work must not touch).
- **Every assertion must be able to fail.** Collection assertions need a length floor — `.every()` on `[]` is `true`, which has caused real defects here. Comparisons must confirm both values are present rather than matching `undefined` to `undefined`.
- Probe records must be covered by the `PROBE_*` cleanup arrays in `verifyRoles.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `serverside/src/modules/vehicles/vehicles.repository.ts` | add `findActiveByOwner` |
| `serverside/src/modules/scan/scan.service.ts` | widen `TapResult`, populate the new fields |
| `serverside/src/config/verifyGates.ts` | seven new assertions |
| `userpage/lib/gateTerminal.ts` | widen `TapDecision.person` |
| `userpage/components/gate/GateTerminal.tsx` | render department, registered items, vehicle detail |

Two tasks, split on the repo boundary. The backend ships a superset of what the terminal reads, so the frontend task cannot break the backend one, and the backend is independently verifiable by harness before any UI exists.

---

## Task 1: Widen the tap response

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.repository.ts`
- Modify: `serverside/src/modules/scan/scan.service.ts:20-25` (`TapResult`), `:56-70` (person branch), `:95-104` (vehicle branch)
- Test: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `Vehicle` with `vehicle_type`, `make`, `valid_until`, `status` (all shipped); the `owner_person_id` index added when the unique constraint was dropped.
- Produces: `TapResult.person` gaining `department_section`, `owner_type?`, `vehicle?`, `registered?`. Task 2 renders exactly these.

**`findByOwner` no longer exists** — it was deliberately removed when the one-vehicle-per-person rule was dropped, because leaving it would read as evidence of a rule that no longer applies. Add a new, differently-scoped method rather than restoring it.

- [ ] **Step 1: Write the failing checks**

Add to `verifyGates.ts`. It taps through the existing local `tap(headers, body)` closure (declared around line 373) and already holds `parkingKey`, `parkingOutKey` and the main-gate key — read the file for their exact names rather than assuming.

```ts
  console.log('\n== monitor output: identity detail ==');

  // A granted person tap carries the department, and an array (never undefined).
  const juanTap = await tap({ 'X-Gate-Key': secondKey! }, { rfid_uid: 'A1B2C3D4' });
  const juanPerson = (juanTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('granted person tap returns a person block', Boolean(juanPerson), true);
  expectEqual('granted person tap carries department_section', juanPerson?.department_section, 'BSIT - 4A');
  expectEqual('granted person tap carries a registered array', Array.isArray(juanPerson?.registered), true);

  // Juan owns the seeded vehicle NCST-1234, so his registered list must name it.
  const juanRegistered = (juanPerson?.registered ?? []) as { vehicle_type?: string; make?: string }[];
  expectEqual('registered list is non-empty for a vehicle owner', juanRegistered.length > 0, true);
  expectEqual('registered entry carries a vehicle_type', typeof juanRegistered[0]?.vehicle_type, 'string');
  expectEqual('registered entry carries a make', typeof juanRegistered[0]?.make, 'string');

  // Release the occupancy that tap created, so the run stays re-runnable.
  await tap({ 'X-Gate-Key': sideKey! }, { rfid_uid: 'A1B2C3D4' });

  // A person with no vehicle gets an EMPTY array, not undefined. Pedro (2025-0003)
  // owns none. Distinguishing "nothing registered" from "we didn't look" is the point.
  const pedroTap = await tap({ 'X-Gate-Key': secondKey! }, { rfid_uid: 'C3D4E5F6' });
  const pedroPerson = (pedroTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('a person with no vehicle still gets an array', Array.isArray(pedroPerson?.registered), true);
  expectEqual('that array is empty, not undefined', (pedroPerson?.registered as unknown[])?.length, 0);
  await tap({ 'X-Gate-Key': sideKey! }, { rfid_uid: 'C3D4E5F6' });

  // A vehicle tap carries the OWNER's type and the vehicle's own detail.
  const vehTap = await tap({ 'X-Gate-Key': parkingKey! }, { rfid_uid: 'E5F6A7B8' });
  const vehPerson = (vehTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('vehicle tap carries the owner department', typeof vehPerson?.department_section, 'string');
  expectEqual('vehicle tap carries owner_type', typeof vehPerson?.owner_type, 'string');
  expectEqual('vehicle tap owner_type is not the discriminator', vehPerson?.owner_type !== 'vehicle', true);
  const vehDetail = vehPerson?.vehicle as { vehicle_type?: string; make?: string } | undefined;
  expectEqual('vehicle tap carries vehicle detail', typeof vehDetail?.vehicle_type, 'string');
  await tap({ 'X-Gate-Key': parkingOutKey! }, { rfid_uid: 'E5F6A7B8' });

  // THE PRIVACY RULE: an inactive_id denial shows WHO but not WHAT THEY OWN.
  //
  // try/finally is mandatory, for the same reason as the expiry block below: a
  // throw between deactivating and reactivating leaves a SEEDED PERSON
  // permanently inactive, and every later run then fails on a card that should
  // work — a failure that looks like a product bug and costs real time to trace.
  await request(superadmin, 'PATCH', `/persons/${juanId}/status`, { status: 'inactive' });
  try {
    const deniedTap = await tap({ 'X-Gate-Key': secondKey! }, { rfid_uid: 'A1B2C3D4' });
    const deniedData = deniedTap.json.data as { access_result?: string; reason?: string; person?: Record<string, unknown> };
    expectEqual('an inactive card is denied', deniedData?.access_result, 'denied');
    expectEqual('the reason is inactive_id', deniedData?.reason, 'inactive_id');
    expectEqual('a denial still names the person', typeof deniedData?.person?.full_name, 'string');
    expectEqual('a denial still shows the department', typeof deniedData?.person?.department_section, 'string');
    expectEqual('a denial does NOT reveal registrations', deniedData?.person?.registered, undefined);
  } finally {
    await request(superadmin, 'PATCH', `/persons/${juanId}/status`, { status: 'active' });
  }

  // wrong_gate_type still reveals nothing at all — existing behaviour, re-pinned
  // because this task adds fields that could regress it.
  const wrongGate = await tap({ 'X-Gate-Key': parkingKey! }, { rfid_uid: 'A1B2C3D4' });
  const wrongData = wrongGate.json.data as { reason?: string; person?: unknown };
  expectEqual('a person card at a vehicle gate is wrong_gate_type', wrongData?.reason, 'wrong_gate_type');
  expectEqual('wrong_gate_type reveals no identity at all', wrongData?.person, undefined);
```

`juanId` is the seeded person's id; the file already resolves people by id number via `findPersonByIdNumber` (around line 108) — reuse it rather than hardcoding an ObjectId. `secondKey`, `parkingKey`, `parkingOutKey` and `sideKey` all already exist in that file (the last around line 641).

**Fixture facts verified against the live database**, so these assertions are grounded rather than assumed:

| UID | Who | Active vehicles |
|---|---|---|
| `A1B2C3D4` | Juan Dela Cruz, `BSIT - 4A` | **2** (`NCST-1234` + a leftover from vehicle-registration testing) |
| `C3D4E5F6` | Pedro Reyes | **0** — which is what makes the empty-array check meaningful |
| `E5F6A7B8` | the vehicle `NCST-1234`, owned by Juan | — |

Juan owning **two** vehicles is why the expiry check below counts a delta rather than expecting an empty list.

Case 7 from the spec — an expired vehicle excluded from `registered` — is added in Step 3b, after the implementation exists, because it needs a `try/finally` around a fixture mutation.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:gates`
Expected: `granted person tap carries department_section` fails with `undefined, expected "BSIT - 4A"`, and the registered-array checks fail because the field does not exist.

- [ ] **Step 3: Write the implementation**

`vehicles.repository.ts` — add:

```ts
  /**
   * Every vehicle this person may currently use: active, and not past its
   * expiry as of `asOf`.
   *
   * Deliberately NOT a revival of findByOwner, which was removed when the
   * one-vehicle-per-person rule was dropped. This one is scoped to what a gate
   * should display: showing an expired pass would tell a guard the opposite of
   * the truth. `asOf` is passed in rather than read from the clock here so the
   * caller compares against the tap's own scan_time, in local time.
   */
  findActiveByOwner: (owner_person_id: Types.ObjectId, asOf: Date) =>
    VehicleModel.find({
      owner_person_id,
      status: 'active',
      valid_until: { $gte: asOf },
    })
      .select('vehicle_type make')
      .sort({ createdAt: -1 })
      .lean(),
```

`scan.service.ts` — widen `TapResult`:

```ts
interface TapResult {
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  person?: {
    full_name: string;
    type: string;
    owner_type?: string;
    department_section: string | null;
    photo_url?: string;
    plate_number?: string;
    vehicle?: { vehicle_type: string; make?: string };
    registered?: { vehicle_type: string; make?: string }[];
  };
}
```

Person branch — add the department to the existing `personView` assignment:

```ts
      personView = {
        full_name: person.full_name,
        type: person.type,
        department_section: person.department_section ?? null,
        photo_url: person.photo_url,
      };
```

Vehicle branch — add the owner's type and the vehicle's own detail. `type` stays the literal `'vehicle'`: it is a discriminator the terminal already renders as display text when no plate is present, so repurposing it would change person-lane behaviour.

```ts
        personView = {
          full_name: owner?.full_name ?? 'Unknown owner',
          type: 'vehicle',
          owner_type: owner?.type,
          department_section: owner?.department_section ?? null,
          plate_number: vehicle.plate_number,
          vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
        };
```

Then, **after** every denial branch has run and immediately before the scan log is written, attach the registered list — grants only, person entities only:

```ts
    // Registered items are withheld on EVERY denial. A guard resolving a denial
    // needs to know who, not what that person owns, and a denied tap is the case
    // most likely to involve someone holding a card that is not theirs. This is
    // enforced here rather than by the UI declining to render it: a field the
    // server sends is a field that exists in the response, whoever is looking.
    //
    // Placed after wrong_gate_type (which clears personView entirely) so it can
    // never resurrect identity on a denial that deliberately withheld it.
    if (access_result === 'granted' && entity_type === 'person' && entity_id && personView) {
      const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
      personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));
    }
```

Placement matters twice over: after `wrong_gate_type` sets `personView = undefined`, and after the anti-passback block so an `already_inside` denial does not carry it either.

- [ ] **Step 3b: Add the expiry-exclusion check**

```ts
  // An expired pass must not appear in its owner's registered list — showing it
  // would tell the guard the opposite of the truth.
  const vehList = await request(superadmin, 'GET', '/vehicles?limit=100');
  const ownedVeh = ((vehList.json.data ?? []) as { _id: string; rfid_uid: string; valid_until: string }[])
    .find((v) => v.rfid_uid === 'E5F6A7B8');
  expectEqual('seeded vehicle E5F6A7B8 found', Boolean(ownedVeh), true);
  const keepValidUntil = ownedVeh!.valid_until;

  // Count BEFORE, and assert the count DROPS BY ONE — do not assert it becomes
  // empty. The seeded owner currently holds TWO active vehicles (NCST-1234 plus
  // a leftover from vehicle-registration testing), so "expect 0" would fail for
  // a reason that has nothing to do with expiry. Counting the delta is also
  // robust to whatever the fixture holds later, and `registered` entries carry
  // only vehicle_type and make — deliberately no plate — so a specific vehicle
  // cannot be identified from the list anyway.
  const beforeTap = await tap({ 'X-Gate-Key': secondKey! }, { rfid_uid: 'A1B2C3D4' });
  const beforeCount = (((beforeTap.json.data as { person?: { registered?: unknown[] } })?.person
    ?.registered) ?? []).length;
  expectEqual('owner has at least one active vehicle before expiry', beforeCount > 0, true);
  await tap({ 'X-Gate-Key': sideKey! }, { rfid_uid: 'A1B2C3D4' });

  try {
    await request(superadmin, 'PATCH', `/vehicles/${ownedVeh!._id}`, {
      valid_until: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const afterExpiry = await tap({ 'X-Gate-Key': secondKey! }, { rfid_uid: 'A1B2C3D4' });
    const afterPerson = (afterExpiry.json.data as { person?: { registered?: unknown[] } })?.person;
    const afterCount = (afterPerson?.registered ?? []).length;
    expectEqual('an expired vehicle drops out of registered', afterCount, beforeCount - 1);
    expectEqual('the owner still grants despite an expired vehicle',
      (afterExpiry.json.data as { access_result?: string })?.access_result, 'granted');
    await tap({ 'X-Gate-Key': sideKey! }, { rfid_uid: 'A1B2C3D4' });
  } finally {
    await request(superadmin, 'PATCH', `/vehicles/${ownedVeh!._id}`, { valid_until: keepValidUntil });
  }
```

The `try/finally` is not optional. A throw between the backdate and the restore leaves a **seeded fixture permanently expired**, which then breaks every later run in a way that looks like a product bug. That exact trap was found in review during the vehicle-registration work.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:gates   # twice — identical, and no stale already_inside
```

Then prove the privacy rule has teeth: temporarily drop the `access_result === 'granted'` condition so `registered` is attached on denials too, re-run, and confirm `a denial does NOT reveal registrations` fails. Restore and re-verify. Report exactly what you saw.

Also confirm the query is not running on denials: it sits inside the `granted` branch, so a denied tap must issue no vehicle lookup. Say how you established that.

- [ ] **Step 5: Commit**

```bash
git add src/modules/vehicles/vehicles.repository.ts src/modules/scan/scan.service.ts src/config/verifyGates.ts
git commit -m "feat(scan): show department and registered items on the gate terminal"
```

---

## Task 2: Render it

**Files:**
- Modify: `userpage/lib/gateTerminal.ts:44-58` (`TapDecision.person`)
- Modify: `userpage/components/gate/GateTerminal.tsx`

**Interfaces:**
- Consumes: the widened `person` block from Task 1.

**Read `node_modules/next/dist/docs/` before writing components** — `AGENTS.md` requires it; this is Next.js 16.

- [ ] **Step 1: Write the failing check**

Start the frontend (`npm run dev`, port 5173; the backend is already running on 3000) and open a gate terminal route. Tap a seeded card — or drive it with the reader-emulating hidden input, which accepts the UID followed by Enter.

Expected failure: the screen shows the name and `student`, but **no department and no registered items**, because the component does not read the new fields yet. Record what you actually saw.

- [ ] **Step 2: Confirm the failure is the predicted one**

If the department already renders, stop and find out what is supplying it before continuing.

- [ ] **Step 3: Write the implementation**

`lib/gateTerminal.ts` — widen the type to match the server exactly:

```ts
  person?: {
    full_name: string;
    type: string;
    owner_type?: string;
    department_section?: string | null;
    photo_url?: string;
    person_id?: string;
    plate_number?: string;
    vehicle?: { vehicle_type: string; make?: string };
    registered?: { vehicle_type: string; make?: string }[];
  };
```

`GateTerminal.tsx` — in the granted/denied result card, beneath the name:

- **Department line.** Label by the person's type, reading `owner_type ?? type` so one expression covers both lanes: `student` → "Course & Section", anything else → "Department". A null or empty value renders an em dash, never the string `undefined`.
- **Vehicle line** (vehicle taps): `vehicle_type · make · plate_number`, skipping absent parts rather than printing empty separators.
- **Registered line** (person taps, present only on grants): each entry as `vehicle_type · make`. With several, list them; with none, render nothing at all — an empty list is not worth a line at a barrier.

Constraints the terminal already lives under, which this must not break:

- It is read at a distance, fast, by someone with a queue waiting. **The access verdict stays the largest element on screen.** New lines are secondary; do not let them compete with it.
- Green means granted, red denied, amber means the system did not decide. Nothing here touches that mapping.
- Reasons render through the shared `reasonText()` map — do not introduce a raw snake_case code, which has been a must-fix twice.
- The existing "no photo on file" affordance stays.

- [ ] **Step 4: Verify in a real browser**

1. `npx tsc --noEmit` — clean. `npx eslint .` — no **new** errors; exactly 4 pre-exist in two files this task must not touch. Report the count you see.
2. Tap a student who owns a vehicle at a person gate: name, course/section, and the registered vehicle all render, verdict still dominant.
3. Tap a student who owns none: no registered line, no empty placeholder.
4. Tap a staff member: the label reads "Department", not "Course & Section".
5. Tap a vehicle at the parking gate: owner name, owner department, and vehicle type/make/plate.
6. Deactivate someone and tap: name and department show, **no** registered line.
7. Tap a person card at a vehicle gate: no identity at all.
8. No console errors.

Release any occupancy your taps create, so you leave the system as you found it.

- [ ] **Step 5: Commit**

```bash
git add lib/gateTerminal.ts components/gate/GateTerminal.tsx
git commit -m "Show course, department and registered items on the gate terminal"
```

---

## Final verification

```bash
# serverside
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:gates     # twice

# userpage
npx tsc --noEmit
npx eslint .             # only the 4 pre-existing errors
```

By hand, since no harness covers the rendering:

1. A granted student tap shows course/section and their vehicle.
2. A staff tap is labelled "Department".
3. A denied (inactive) tap shows who, but not what they own.
4. A person card at a vehicle gate shows nothing.
5. Occupancy is clean afterwards — no card left inside.
