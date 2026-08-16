# Single-Card Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One RFID credential grants person attendance at person gates and the owner's vehicle at vehicle gates.

**Architecture:** `scan.service.tap` keeps its structure. When a matched person taps at a gate whose `type` is `vehicle`, a new branch resolves that person's single active vehicle instead of falling through to `wrong_gate_type`. The vehicle's occupancy row stays authoritative; the owner's occupancy row and attendance rollup are written as a best-effort companion. Registration gains two guards that make the one-vehicle-per-owner assumption true.

**Tech Stack:** TypeScript, Express, Mongoose 8, Zod (serverside); Next.js 16, React 19, Tailwind 4 (userpage).

**Spec:** `/c/thesis_rfid/userpage/docs/superpowers/specs/2026-08-01-single-card-access-design.md`

## Global Constraints

- **There is no unit-test framework in this project.** Verification is black-box `ts-node` harnesses run against a live server: `npm run verify:roles`, `verify:gates`, `verify:signatures`, `verify:passback`. "Write the failing test" means adding a check to the relevant harness; "run the test" means running that harness. Do not add jest/vitest/mocha.
- **Never test destructive actions against seeded fixtures.** A prior task corrupted seeded UID `C3D4E5F6` by testing card replacement against a seeded person and broke 119 of 121 checks. New destructive cases create their own throwaway rows and clean them up.
- **Any fixture mutation wraps in `try/finally`.** Deactivating a person, backdating an expiry, deactivating a vehicle — the restore goes in `finally`, and every occupancy row created is released. A throw between mutate and restore breaks every later run in a way that looks like a product bug.
- **`firstKey` is revoked partway through `verifyGates`** by the second key mint. Use `secondKey` for new granted taps, `parkingKey` / `parkingOutKey` / `sideKey` for their respective gates.
- **`verifyGates` has no Mongo connection.** Assert occupancy and attendance state through the API, never by reading the database.
- **No `toISOString()` or any string date conversion in scan paths.** This codebase has shipped two real defects from UTC-derived dates. `valid_until` is stored end-of-day local; compare native `Date` objects against the tap's own `scan_time`.
- **No transactions available** — standalone Mongo, no replica set. Multi-write ordering is the only safety mechanism.
- **Never render a raw snake_case reason code on an operator screen.** All reasons go through `reasonText()` in `/c/thesis_rfid/userpage/lib/reasonText.ts`. This has been a must-fix twice.
- **Assertion discipline:** every assertion must be able to fail; collection assertions need a length floor (`.every()` on an empty array is `true`); any comparison must confirm both values are present rather than matching `undefined` to `undefined`.
- **eslint baseline:** 4 pre-existing errors in userpage, one each across FOUR files — `app/admin/page.tsx`, `app/dashboard/page.tsx`, `components/PersonProfile.tsx`, `components/StudentsDirectory.tsx`. Do not touch those files. 0 new errors allowed.
- **Do not run `npm run dev`** — the dev server is already running on :3000 (EADDRINUSE, orphans a process tree). It runs at production rate limits with `VERIFY_BYPASS_TOKEN` set, so all four harnesses chain in one command. Do not raise rate limits.
- **Repos:** backend `/c/thesis_rfid/serverside`, frontend `/c/thesis_rfid/userpage`. Tasks 1-3 commit to serverside; Task 4 to userpage.

## Fixture facts, verified against the live database

```
Gates:   Main Entrance    person / entry      Side Gate      person / exit
         Parking Entrance vehicle / entry     Parking Exit   vehicle / exit

A1B2C3D4  Juan Dela Cruz    student, "BSIT - 4A"    TWO active vehicles (NCST-1234, U329340MX)
B2C3D4E5  Maria Santos      student, "BSCS - 3B"    zero vehicles
C3D4E5F6  Pedro Reyes       student, "BSIT - 2C"    zero vehicles
D4E5F6A7  Ana Villanueva    staff,   "Registrar Office"   ONE active vehicle (NCST-5678)
E5F6A7B8  the vehicle NCST-1234, owner Juan
F6A7B8C9  the vehicle NCST-5678, owner Ana
```

Juan is the `multiple_vehicles` fixture and needs no mutation. Ana is the single-vehicle grant fixture. Maria and Pedro are the `no_vehicle_registered` fixtures. This mapping is why no task needs to create a vehicle just to test the happy path.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `serverside/src/modules/vehicles/vehicles.repository.ts` | widen `findActiveByOwner` projection | 1 |
| `serverside/src/modules/scan/scan.service.ts` | owner-card resolution branch; companion occupancy + attendance writes | 1, 2 |
| `serverside/src/modules/vehicles/vehicles.service.ts` | one-active-vehicle rule; cross-collection UID check | 3 |
| `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts` | same two pre-checks, so an application never orphans | 3 |
| `serverside/src/modules/persons/persons.service.ts` | reverse cross-collection UID check | 3 |
| `serverside/src/config/verifyGates.ts` | all new harness checks | 1, 2, 3 |
| `userpage/lib/reasonText.ts` | two new reason strings | 4 |

---

### Task 1: Owner-card resolution at vehicle gates

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.repository.ts:30-38`
- Modify: `serverside/src/modules/scan/scan.service.ts:~78-135` (the `else` block that resolves a person)
- Test: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `vehicleRepo.findActiveByOwner(owner_person_id: Types.ObjectId, asOf: Date)`, `personRepo.findByRfid(uid: string)`, `gate.type: 'person' | 'vehicle'`.
- Produces: a module-scoped `let companionPersonId: Types.ObjectId | null = null` inside `tap`, set **only** on a granted owner-card resolution. Task 2 consumes it. Two new reason strings, `'no_vehicle_registered'` and `'multiple_vehicles'`, consumed by Task 4.

**Prerequisite — one-off data repair.** Vehicle `CAV 8832` holds `rfid_uid = 0003461782`, identical to its owner's person card, so it is permanently shadowed by the person lookup. Clear it before anything else:

```bash
mongosh ncst_rfid --quiet --eval 'db.vehicles.updateOne({plate_number:"CAV 8832"},{$unset:{rfid_uid:""}}); print(db.vehicles.findOne({plate_number:"CAV 8832"},{plate_number:1,rfid_uid:1,_id:0}))'
```

Expected output shows `plate_number` present and `rfid_uid` absent. This is data, not code — no commit.

- [ ] **Step 1: Widen the `findActiveByOwner` projection**

The gate path needs `_id` (for occupancy) and `plate_number` (for the scan log and terminal). Widen the existing method rather than adding a second one — two lookups with drifting filters is how a vehicle gets granted by one and rejected by the other.

In `vehicles.repository.ts`, change only the `.select(...)` line:

```ts
  findActiveByOwner: (owner_person_id: Types.ObjectId, asOf: Date) =>
    VehicleModel.find({
      owner_person_id,
      status: 'active',
      valid_until: { $gte: asOf },
    })
      // Projection is shared by two consumers: the monitor's `registered[]`
      // list (vehicle_type + make) and the single-card gate path, which also
      // needs _id for the occupancy write and plate_number for the scan log.
      // `_id` is included by default. Keep this ONE method — a second lookup
      // with a drifting filter is how a vehicle gets granted by one caller
      // and rejected by another.
      .select('vehicle_type make plate_number')
      .sort({ createdAt: -1 })
      .lean(),
```

`.select()` does not narrow Mongoose's lean type, so `v._id` and `v.plate_number` already typecheck. The existing monitor caller maps only `vehicle_type` and `make` and is unaffected.

- [ ] **Step 2: Write the failing harness checks**

In `verifyGates.ts`, add a block after the existing granted-tap checks. Use `parkingKey` (Parking Entrance, `vehicle`/`entry`). Resolve people via the existing `findPersonByIdNumber` helper.

```ts
  // ---- Single-card access: owner card at a vehicle gate ----
  // Ana owns exactly ONE active vehicle (NCST-5678), so her ID card must
  // resolve that vehicle at the parking barrier.
  {
    const r = await tap(parkingKey, { rfid_uid: 'D4E5F6A7', direction: 'entry' });
    expectEqual('owner card grants at vehicle gate', r.body.access_result, 'granted');
    expectEqual('owner card reason is null', r.body.reason, null);
    expectEqual('owner card shows owner name', r.body.person?.full_name, 'Ana Villanueva');
    expectEqual('owner card shows plate', r.body.person?.plate_number, 'NCST-5678');
    expectEqual('owner card shows owner type', r.body.person?.owner_type, 'staff');
    expectEqual(
      'owner card shows department',
      r.body.person?.department_section,
      'Registrar Office'
    );
    // registered[] is a person-lane field and must never appear on this lane.
    expectEqual('owner card withholds registered[]', r.body.person?.registered, undefined);
    // Release so later checks start from a clean roster.
    await tap(parkingOutKey, { rfid_uid: 'D4E5F6A7', direction: 'exit' });
  }

  // Maria owns no vehicle. The card is CORRECT for this gate — she simply has
  // no pass — so the reason must not be wrong_gate_type.
  {
    const r = await tap(parkingKey, { rfid_uid: 'B2C3D4E5', direction: 'entry' });
    expectEqual('no vehicle denies', r.body.access_result, 'denied');
    expectEqual('no vehicle reason', r.body.reason, 'no_vehicle_registered');
  }

  // Juan owns TWO active vehicles. Nothing in the tap says which he is
  // driving, so the barrier refuses to guess rather than logging a plate it
  // did not verify.
  {
    const r = await tap(parkingKey, { rfid_uid: 'A1B2C3D4', direction: 'entry' });
    expectEqual('ambiguous owner denies', r.body.access_result, 'denied');
    expectEqual('ambiguous owner reason', r.body.reason, 'multiple_vehicles');
  }

  // A vehicle TAG at a vehicle gate is unchanged by this feature.
  {
    const r = await tap(parkingKey, { rfid_uid: 'F6A7B8C9', direction: 'entry' });
    expectEqual('vehicle tag still grants', r.body.access_result, 'granted');
    expectEqual('vehicle tag shows plate', r.body.person?.plate_number, 'NCST-5678');
    await tap(parkingOutKey, { rfid_uid: 'F6A7B8C9', direction: 'exit' });
  }

  // A person card at a PERSON gate is unchanged by this feature.
  {
    const r = await tap(secondKey, { rfid_uid: 'B2C3D4E5', direction: 'entry' });
    expectEqual('person card still grants at person gate', r.body.access_result, 'granted');
    expectEqual('person lane still returns type person', r.body.person?.type, 'student');
    await tap(sideKey, { rfid_uid: 'B2C3D4E5', direction: 'exit' });
  }
```

Add the inactive-person case separately, with the mutation restored in `finally`. Pedro is used because he owns no vehicle, which proves the person-status check runs **before** the vehicle lookup — if it ran after, this would return `no_vehicle_registered` instead:

```ts
  // An inactive person at a vehicle gate denies on IDENTITY, not on vehicle
  // count. Pedro owns no vehicle, so if the status check were ordered after
  // the vehicle lookup this would wrongly report no_vehicle_registered.
  {
    const pedro = await findPersonByIdNumber('2025-0003');
    await patchPerson(pedro._id, { status: 'inactive' });
    try {
      const r = await tap(parkingKey, { rfid_uid: 'C3D4E5F6', direction: 'entry' });
      expectEqual('inactive person at vehicle gate denies', r.body.access_result, 'denied');
      expectEqual('inactive person reason', r.body.reason, 'inactive_id');
      // Identity is still shown so a guard can tell "deactivated student"
      // from "unregistered stranger" — the existing rule, re-pinned here.
      expectEqual('inactive person identity shown', r.body.person?.full_name, 'Pedro Reyes');
    } finally {
      await patchPerson(pedro._id, { status: 'active' });
    }
  }
```

Use whatever the file's existing helper for a person PATCH is named; if none exists, inline the authenticated `fetch` the file already uses for admin calls, following the surrounding style.

- [ ] **Step 3: Run the harness to verify the new checks fail**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates
```

Expected: FAIL. The owner-card taps return `denied` / `wrong_gate_type`, not `granted` / `no_vehicle_registered` / `multiple_vehicles`. Record the failing count.

- [ ] **Step 4: Implement the owner-card branch**

In `scan.service.ts`, declare the companion alongside the other `let` bindings near the top of `tap`:

```ts
    let personView: TapResult['person'];
    // Set ONLY on a granted owner-card resolution: the person whose card
    // opened a vehicle gate. Drives the companion occupancy and attendance
    // writes. Null on every other path, including vehicle-tag taps — a
    // sticker identifies a car, a card identifies a person, and only the
    // latter is evidence that the human was present.
    let companionPersonId: Types.ObjectId | null = null;
```

Then split the existing `if (person)` block on gate type. The current body becomes the `person`-gate arm, unchanged. The new arm:

```ts
      const person = await personRepo.findByRfid(input.rfid_uid);
      if (person) {
        // Identity view shared by every person-resolved outcome below. The
        // granted owner-card path REPLACES it with the vehicle-shaped view.
        personView = {
          full_name: person.full_name,
          type: person.type,
          department_section: person.department_section ?? null,
          photo_url: person.photo_url,
        };

        if (gate.type === 'vehicle') {
          // Single-card access. The card IS correct for this gate, so the
          // denials here are about the holder's registration, never
          // wrong_gate_type. Entity stays 'person' on a denial so the scan
          // log records who was refused; only a grant becomes the vehicle.
          entity_type = 'person';
          entity_id = person._id;
          if (person.status !== 'active') {
            // Ordered BEFORE the vehicle lookup on purpose: a deactivated ID
            // is an identity problem, and reporting "no vehicle registered"
            // for it would send a guard after the wrong thing.
            access_result = 'denied';
            reason = 'inactive_id';
          } else {
            const owned = await vehicleRepo.findActiveByOwner(person._id, scan_time);
            if (owned.length === 0) {
              access_result = 'denied';
              reason = 'no_vehicle_registered';
            } else if (owned.length > 1) {
              // Registration enforces one active vehicle per owner, so this
              // is a safety net for rows that predate that rule. Refusing to
              // guess is the point: granting here would log a plate nobody
              // verified into the scan log, the occupancy roster and the
              // anomaly report.
              access_result = 'denied';
              reason = 'multiple_vehicles';
            } else {
              const v = owned[0];
              entity_type = 'vehicle';
              entity_id = v._id;
              companionPersonId = person._id;
              access_result = 'granted';
              reason = null;
              personView = {
                full_name: person.full_name,
                type: 'vehicle',
                owner_type: person.type,
                department_section: person.department_section ?? null,
                photo_url: person.photo_url,
                plate_number: v.plate_number,
                vehicle: { vehicle_type: v.vehicle_type, make: v.make },
              };
            }
          }
        } else {
          entity_type = 'person';
          entity_id = person._id;
          if (person.status === 'active') {
            access_result = 'granted';
            reason = null;
          } else {
            access_result = 'denied';
            reason = 'inactive_id';
          }
        }
      } else {
```

Leave the `else` vehicle-lookup branch exactly as it is.

Note what this does **not** change: the `wrong_gate_type` guard is untouched. It fires only when `access_result === 'granted'`, and a granted owner-card tap has already set `entity_type` to `'vehicle'`, so the guard passes. Denied owner-card taps never reach it.

- [ ] **Step 5: Run the harness to verify it passes**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates
```

Expected: PASS, with the count risen by the number of checks added. Then run the full chain and confirm no regression:

```bash
cd /c/thesis_rfid/serverside && npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
```

- [ ] **Step 6: Prove the privacy assertion is non-vacuous**

Temporarily delete the `expectEqual('owner card withholds registered[]', ...)` line's guard by changing the `registered` attachment condition in `scan.service.ts` from `entity_type === 'person'` to a bare truthy check, re-run `verify:gates`, and confirm **that specific check fails**. Restore the guard and confirm the count returns. An assertion that cannot fail is not a test.

- [ ] **Step 7: Confirm fixtures are clean**

```bash
mongosh ncst_rfid --quiet --eval 'print("inside: "+db.occupancies.countDocuments({state:"inside"})); print("pedro: "+db.people.findOne({id_number:"2025-0003"}).status)'
```

Expected: `inside: 0`, `pedro: active`.

- [ ] **Step 8: Commit**

```bash
cd /c/thesis_rfid/serverside
git add src/modules/vehicles/vehicles.repository.ts src/modules/scan/scan.service.ts src/config/verifyGates.ts
git commit -m "feat: resolve owner's vehicle from a person card at vehicle gates"
```

---

### Task 2: Companion attendance and occupancy writes

**Files:**
- Modify: `serverside/src/modules/scan/scan.service.ts` (anti-passback block ~line 150-190, attendance rollup ~line 215-230)
- Test: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `companionPersonId: Types.ObjectId | null` from Task 1, set only on a granted owner-card resolution. `occupancyRepo.enter(entity_type, entity_id, gate_id, boundary): Promise<'admitted' | 'already_inside'>`, `occupancyRepo.release(...): Promise<'released' | 'exit_without_entry'>`, `attendanceRepo.upsertTimeIn(personId: string, dateKey: string, when: Date, status: 'present' | 'late')`, `attendanceRepo.upsertTimeOut(personId: string, dateKey: string, when: Date)`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing harness checks**

Two checks, both in `verifyGates.ts`. The first is the whole point of the feature.

```ts
  // ---- Single-card attendance ----
  // Drive in at the parking barrier with an ID card, then leave ON FOOT at a
  // person gate. Before single-card this exit returned exit_without_entry and
  // the day's attendance showed the person was never on campus, because as a
  // PERSON they were never marked inside. This is the defect the feature
  // exists to fix, so it is pinned.
  {
    const drive = await tap(parkingKey, { rfid_uid: 'D4E5F6A7', direction: 'entry' });
    expectEqual('drive-in grants', drive.body.access_result, 'granted');

    const walkOut = await tap(sideKey, { rfid_uid: 'D4E5F6A7', direction: 'exit' });
    expectEqual('walk-out after drive-in grants', walkOut.body.access_result, 'granted');
    expectEqual('walk-out is not an anomaly', walkOut.body.reason, null);

    // The vehicle is still in the lot — only the person left.
    const stillIn = await tap(parkingKey, { rfid_uid: 'F6A7B8C9', direction: 'entry' });
    expectEqual('vehicle still inside after owner walked out', stillIn.body.reason, 'already_inside');

    await tap(parkingOutKey, { rfid_uid: 'F6A7B8C9', direction: 'exit' });
  }

  // Anti-passback still runs on the VEHICLE row, which is authoritative. A
  // second owner-card entry denies, and because the deny happens on the
  // vehicle write the companion person write must never be attempted — a
  // denied tap must not move anyone's state. The person-gate exit afterwards
  // proves it: if the companion had run, Ana would be inside and the exit
  // would report released rather than exit_without_entry.
  {
    const first = await tap(parkingKey, { rfid_uid: 'D4E5F6A7', direction: 'entry' });
    expectEqual('first owner-card entry grants', first.body.access_result, 'granted');
    await tap(sideKey, { rfid_uid: 'D4E5F6A7', direction: 'exit' }); // person leaves on foot

    const second = await tap(parkingKey, { rfid_uid: 'D4E5F6A7', direction: 'entry' });
    expectEqual('second owner-card entry denies', second.body.access_result, 'denied');
    expectEqual('second owner-card entry reason', second.body.reason, 'already_inside');

    const after = await tap(sideKey, { rfid_uid: 'D4E5F6A7', direction: 'exit' });
    expectEqual(
      'denied entry wrote no companion occupancy',
      after.body.reason,
      'exit_without_entry'
    );
    await tap(parkingOutKey, { rfid_uid: 'F6A7B8C9', direction: 'exit' });
  }

  // A vehicle TAG must NOT mark its owner present. A sticker identifies a
  // car, not the human driving it. Without this, anyone borrowing the car
  // would silently mark the owner present on campus.
  {
    await tap(parkingKey, { rfid_uid: 'F6A7B8C9', direction: 'entry' });
    // Ana was never marked inside as a person, so a person-gate exit is an
    // anomaly — which is exactly the signal proving no companion write ran.
    const r = await tap(sideKey, { rfid_uid: 'D4E5F6A7', direction: 'exit' });
    expectEqual('vehicle tag does not mark owner present', r.body.reason, 'exit_without_entry');
    await tap(parkingOutKey, { rfid_uid: 'F6A7B8C9', direction: 'exit' });
  }
```

- [ ] **Step 2: Run the harness to verify the new checks fail**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates
```

Expected: FAIL on `walk-out is not an anomaly` — it returns `exit_without_entry`, because nothing yet writes the person's occupancy row.

- [ ] **Step 3: Implement the companion occupancy writes**

In the anti-passback block, after the existing vehicle `enter`:

```ts
      if (input.direction === 'entry') {
        const outcome = await occupancyRepo.enter(entity_type, entity_id, gateOid, boundary);
        if (outcome === 'already_inside') {
          access_result = 'denied';
          reason = 'already_inside';
          // personView is deliberately KEPT: a guard needs to see who the
          // system thinks is inside in order to resolve it.
        } else if (companionPersonId) {
          // BEST-EFFORT, and deliberately second. The vehicle row above is
          // authoritative and is what the anti-passback check runs on. There
          // is no transaction here (standalone Mongo), so these two writes
          // cannot be atomic — and denying on a failure would be worse than
          // tolerating one, because the deny happens AFTER the vehicle row
          // already moved: it would record a car inside the lot while
          // keeping the barrier shut, and unwinding needs a compensating
          // release that can itself fail. Worst case here is a car correctly
          // in the lot whose driver's attendance is missing, which this log
          // line surfaces.
          //
          // 'already_inside' is benign, not an error: the person may have
          // walked in through a person gate earlier.
          try {
            await occupancyRepo.enter('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person occupancy failed on entry for ${companionPersonId.toString()}; ` +
                'vehicle admitted anyway (best-effort)',
              err
            );
          }
        }
      } else {
```

And in the exit branch, after the existing vehicle `release` and its `exit_without_entry` handling:

```ts
        if (outcome === 'exit_without_entry') {
          reason = 'exit_without_entry';
        }
        if (companionPersonId) {
          // Best-effort, same reasoning as entry. A person already outside is
          // SILENT rather than an anomaly: they may have walked out through a
          // person gate and returned on foot. The vehicle release above
          // carries the anomaly signal for this tap.
          try {
            await occupancyRepo.release('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person release failed on exit for ${companionPersonId.toString()}; ` +
                'granting anyway (fail-open)',
              err
            );
          }
        }
```

- [ ] **Step 4: Implement the companion attendance rollup**

Occupancy is the live roster; attendance is the daily `time_in` / `time_out` rollup. They are separate records, and the rollup is guarded by `entity_type === 'person'` — which is false on the owner-card path. Without this step the person appears on the roster but still has no `time_in`, which is the more visible half of the problem left broken.

Replace the rollup guard:

```ts
    // The person this tap is attributable to: the cardholder on a person tap,
    // or the owner whose card opened a vehicle gate. A vehicle TAG tap has
    // neither and correctly writes no attendance.
    const attendancePersonId = entity_type === 'person' ? entity_id : companionPersonId;
    if (access_result === 'granted' && attendancePersonId) {
      const key = dateKey(scan_time);
      if (input.direction === 'entry') {
        await attendanceRepo.upsertTimeIn(
          String(attendancePersonId),
          key,
          scan_time,
          isLate(scan_time) ? 'late' : 'present'
        );
      } else {
        await attendanceRepo.upsertTimeOut(String(attendancePersonId), key, scan_time);
      }
    }
```

- [ ] **Step 5: Run the harness to verify it passes**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates && npm run verify:passback
```

Expected: PASS. Then the full chain:

```bash
cd /c/thesis_rfid/serverside && npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
```

- [ ] **Step 6: Prove the sticker/card distinction can actually fail**

Temporarily set `companionPersonId` on the vehicle-tag branch too (assign `vehicle.owner_person_id` to it), re-run `verify:gates`, and confirm the `vehicle tag does not mark owner present` check fails. Revert. This assertion is the only thing standing between a borrowed car and a false attendance record.

- [ ] **Step 7: Confirm fixtures are clean**

```bash
mongosh ncst_rfid --quiet --eval 'print("inside: "+db.occupancies.countDocuments({state:"inside"}))'
```

Expected: `inside: 0`.

- [ ] **Step 8: Commit**

```bash
cd /c/thesis_rfid/serverside
git add src/modules/scan/scan.service.ts src/config/verifyGates.ts
git commit -m "feat: mark the owner present when their card opens a vehicle gate"
```

---

### Task 3: Registration guards

**Files:**
- Modify: `serverside/src/modules/vehicles/vehicles.service.ts:32-49` (`create`), `:51-75` (`update`)
- Modify: `serverside/src/modules/vehicleApplications/vehicleApplications.service.ts:116-126`
- Modify: `serverside/src/modules/persons/persons.service.ts:104-110` (`create`), `:199-206` (`reassignRfid`)
- Test: `serverside/src/config/verifyGates.ts`

**Interfaces:**
- Consumes: `vehicleRepo.findActiveByOwner` with the widened projection from Task 1 (needs `plate_number` for the error message). `personRepo.findByRfid(uid: string)`, `vehicleRepo.findByRfid(uid: string)`.
- Produces: nothing consumed by later tasks.

Both guards use existing error codes from `serverside/src/constants/errors.ts`. Do **not** add new codes: `DUPLICATE_RFID` (409) and `CONFLICT` (409) already carry the right status and meaning.

- [ ] **Step 1: Write the failing harness checks**

These are destructive, so they create their own throwaway rows and clean up. Never reuse a seeded person.

```ts
  // ---- Registration guards ----
  // A person may hold multiple vehicle ROWS but only one ACTIVE at a time:
  // under single-card the owner is the key, so a second active pass has no
  // unambiguous resolution at the barrier.
  {
    const owner = await createThrowawayPerson({ type: 'student' });
    try {
      const first = await createVehicle({ owner_person_id: owner._id, plate_number: 'SC-TEST-1' });
      expectEqual('first active vehicle accepted', first.status, 201);
      const second = await createVehicle({ owner_person_id: owner._id, plate_number: 'SC-TEST-2' });
      expectEqual('second active vehicle rejected', second.status, 409);
    } finally {
      await deleteThrowawayPerson(owner._id);
    }
  }

  // A UID belongs to a person OR a vehicle, never both. Without this, a
  // vehicle registered on a person's card is permanently unscannable: the
  // person lookup always wins.
  {
    const r = await createVehicle({ rfid_uid: 'D4E5F6A7', plate_number: 'SC-TEST-3' });
    expectEqual("person's UID rejected for a vehicle", r.status, 409);
  }

  // And the reverse direction.
  {
    const r = await createThrowawayPerson({ type: 'student', rfid_uid: 'F6A7B8C9' });
    expectEqual("vehicle's UID rejected for a person", r.status, 409);
  }
```

Use the file's existing helpers for authenticated admin calls; if `createThrowawayPerson` / `createVehicle` / `deleteThrowawayPerson` do not exist, write them in the surrounding style as thin wrappers over the authenticated `fetch` the file already uses, returning `{ status, body }`. Every throwaway row must be removed in a `finally`.

- [ ] **Step 2: Run the harness to verify the new checks fail**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates
```

Expected: FAIL — all three currently return 201, because none of these guards exist.

- [ ] **Step 3: Add both guards to `vehicleService.create`**

After the existing `existingRfid` check:

```ts
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // A UID belongs to a person OR a vehicle, never both. scan.service.tap
    // resolves person first, so a vehicle holding a person's UID is
    // permanently unscannable — it would be accepted here and then silently
    // never work at the barrier. This is how CAV 8832 was created.
    if (data.rfid_uid) {
      const personWithRfid = await personRepo.findByRfid(String(data.rfid_uid));
      if (personWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
      }
    }
```

Then, after the owner lookup and before the create, the one-active-vehicle rule:

```ts
    // One ACTIVE vehicle per owner. Under single-card the owner's card is the
    // key, so two active passes give the barrier no way to know which car is
    // being driven. A person may still hold multiple vehicle rows — only one
    // may be active. scan.service.tap keeps a multiple_vehicles denial as a
    // safety net for rows that predate this rule.
    if ((data.status ?? 'active') === 'active') {
      const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
      if (active.length > 0) {
        throw new ApiError(
          'CONFLICT',
          `${owner.full_name} already has an active vehicle (${active[0].plate_number}). Deactivate it first.`
        );
      }
    }
```

- [ ] **Step 4: Add the same rule to `vehicleService.update`**

The existing guard block already fires on `data.status === 'active' || data.owner_person_id` and resolves `ownerId` and `owner`. Extend it — activating a second pass, or moving a pass onto an owner who already has one, must both fail:

```ts
      if (!owner) {
        throw new ApiError('NOT_FOUND', 'Vehicle owner not found or deleted; cannot activate');
      }
      // Same one-active-vehicle rule as create, on both re-arming paths:
      // activating this vehicle, and reassigning it to an owner who already
      // has an active one. Excludes this vehicle so a no-op PATCH on an
      // already-active row does not reject itself.
      const willBeActive = data.status ? data.status === 'active' : current.status === 'active';
      if (willBeActive) {
        const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
        const others = active.filter((v) => String(v._id) !== String(current._id));
        if (others.length > 0) {
          throw new ApiError(
            'CONFLICT',
            `${owner.full_name} already has an active vehicle (${others[0].plate_number}). Deactivate it first.`
          );
        }
      }
```

- [ ] **Step 5: Mirror both pre-checks in `vehicleApplicationService.create`**

The application is written before the vehicle and is immutable, so a failure at the vehicle insert leaves an orphan application that can never be edited or deleted. That is exactly why the existing `DUPLICATE_RFID` / `DUPLICATE_PLATE` pre-checks are there. Both new guards need the same treatment, immediately after the existing `existingRfid` check:

```ts
    const existingRfid = await vehicleRepo.findByRfid(input.rfid_uid);
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // Pre-checked here for the same reason as DUPLICATE_RFID above: without
    // it, the application writes first and only the vehicle insert fails,
    // leaving an orphan application that is immutable by design.
    const personWithRfid = await personRepo.findByRfid(input.rfid_uid);
    if (personWithRfid) {
      throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
    }
    const activeForOwner = await vehicleRepo.findActiveByOwner(owner._id, new Date());
    if (activeForOwner.length > 0) {
      throw new ApiError(
        'CONFLICT',
        `${owner.full_name} already has an active vehicle (${activeForOwner[0].plate_number}). Deactivate it first.`
      );
    }
```

- [ ] **Step 6: Add the reverse check to `personService`**

In `create`, inside the existing `if (data.rfid_uid)` block, after the `personRepo.findByRfid` check:

```ts
      const existing = await personRepo.findByRfid(data.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
      // The reverse of the check in vehicleService.create: a UID belongs to a
      // person OR a vehicle, never both.
      const vehicleWithRfid = await vehicleRepo.findByRfid(data.rfid_uid);
      if (vehicleWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
      }
```

And the same two lines in `reassignRfid`, after its existing `clash` check:

```ts
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');
    const vehicleWithRfid = await vehicleRepo.findByRfid(rfid_uid);
    if (vehicleWithRfid) {
      throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
    }
```

Import `vehicleRepo` in `persons.service.ts` if it is not already imported. **Check for an import cycle** — if `vehicles.service.ts` imports from `persons.service.ts`, importing the *repository* (not the service) avoids it, which is what this step specifies.

`personService.update` deliberately gets no check. It has no uniqueness check of any kind today, not even person-against-person; closing that is a separate pre-existing defect and is recorded as out of scope in the spec.

- [ ] **Step 7: Run the harness to verify it passes**

```bash
cd /c/thesis_rfid/serverside && npm run verify:gates
```

Expected: PASS. Then the full chain — the one-active-vehicle rule touches paths `verify:roles` and `verify:signatures` also exercise:

```bash
cd /c/thesis_rfid/serverside && npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
```

If a pre-existing check now fails because a harness registers two vehicles for one owner, that is the new rule working. Fix the **harness** to deactivate the first, not the rule.

- [ ] **Step 8: Confirm no throwaway rows survived**

```bash
mongosh ncst_rfid --quiet --eval 'print("SC-TEST vehicles: "+db.vehicles.countDocuments({plate_number:/^SC-TEST/})); print("inside: "+db.occupancies.countDocuments({state:"inside"}))'
```

Expected: both `0`. If any survive, delete them and fix the `finally` that failed to.

- [ ] **Step 9: Build, lint, and commit**

```bash
cd /c/thesis_rfid/serverside && npm run build && npm run lint
git add src/modules/vehicles/vehicles.service.ts src/modules/vehicleApplications/vehicleApplications.service.ts src/modules/persons/persons.service.ts src/config/verifyGates.ts
git commit -m "feat: enforce one active vehicle per owner and cross-collection UID uniqueness"
```

---

### Task 4: Terminal reason strings

**Files:**
- Modify: `userpage/lib/reasonText.ts`

**Interfaces:**
- Consumes: the reason codes `'no_vehicle_registered'` and `'multiple_vehicles'` produced by Task 1.
- Produces: nothing.

This is the last mile of a rule that has been a must-fix twice: a raw snake_case code must never reach an operator screen. `REASON_TEXT` is shared by `GateTerminal` (a guard at a barrier) and `RecordsView` (an auditor), so both screens are covered by this one change.

- [ ] **Step 1: Add both entries**

In `REASON_TEXT`, after the `wrong_gate_type` line:

```ts
  wrong_gate_type: "Wrong gate for this card",
  // Single-card access: the card IS valid for this gate, so neither of these
  // is a wrong_gate_type. The wording tells a guard what to DO — check the
  // plate by eye, or send them to register — rather than naming the internal
  // condition.
  no_vehicle_registered: "No vehicle registered to this ID",
  multiple_vehicles: "Multiple vehicles — check plate manually",
```

- [ ] **Step 2: Verify the strings render**

```bash
cd /c/thesis_rfid/userpage && npx tsc --noEmit && npm run lint
```

Expected: tsc clean; eslint reports exactly the 4 pre-existing errors across `app/admin/page.tsx`, `app/dashboard/page.tsx`, `components/PersonProfile.tsx`, `components/StudentsDirectory.tsx` and **0 new**.

Then confirm end to end in the running app: open the vehicle-entry terminal, tap Maria's UID `B2C3D4E5`, and confirm the screen reads "No vehicle registered to this ID" and not `no_vehicle_registered`. Tap Juan's `A1B2C3D4` and confirm "Multiple vehicles — check plate manually". The verdict must still be the dominant element and still red.

- [ ] **Step 3: Commit**

```bash
cd /c/thesis_rfid/userpage
git add lib/reasonText.ts
git commit -m "feat: plain-English text for the single-card denial reasons"
```

---

## Manual data note

Juan Dela Cruz holds two active vehicles (`NCST-1234`, `U329340MX`). The one-active-vehicle rule binds writes, not existing rows, so he stays denied `multiple_vehicles` at the parking gate until one is deactivated through the admin UI. This is the safety net behaving correctly and is worth demonstrating rather than quietly fixing — Task 1 depends on him staying that way, so **do not deactivate either vehicle** during implementation.
