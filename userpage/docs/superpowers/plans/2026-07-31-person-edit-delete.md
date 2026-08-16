# Person Edit, Delete and Card Blocklist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator correct, remove and re-card a registered person — and make every card that leaves a person's record permanently dead at every scanner.

**Architecture:** `Person` gains `deleted_at`, excluded inside the repository's read paths so no list or gate lookup can resurrect a deleted record. A new `blocked_cards` collection holds every retired UID; `scan.service.tap` checks it before resolving anything, and every registration path refuses a blocked UID. Deleting cascades to the login and the person's vehicles, gate-first.

**Tech Stack:** TypeScript, Express, Mongoose 8 (backend); Next.js 16 + React 19 + Tailwind 4 (frontend). Verification is black-box `ts-node` harnesses, not a unit-test framework.

**Spec:** `docs/superpowers/specs/2026-07-31-person-edit-delete-design.md`

## Global Constraints

- **This is a school ID system and the client has explicitly prioritised strictness over convenience.** There is **no unblock**, no undo, and no prompt asking why a card was retired. Do not add one, do not add a "force" flag, and do not soften a block into a warning.
- **No unit-test framework exists and none may be added.** Verification extends `serverside/src/config/verify*.ts`.
- **All four harnesses chain in one command:** `npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback`. A dev server runs on :3000 at production rate limits with `VERIFY_BYPASS_TOKEN` set. Do **not** raise the limits. Do **not** run `npm run dev` — EADDRINUSE, and it orphans a process tree.
- **Two repos.** Backend `C:\thesis_rfid\serverside`, frontend `C:\thesis_rfid\userpage`. Both on `main`, clean. Create branch `feat/person-lifecycle` in each.
- **Commit style differs per repo.** `serverside` uses conventional prefixes; `userpage` uses plain sentence subjects with **no** prefix.
- **Next.js 16 is not the Next.js you know** — read `node_modules/next/dist/docs/` before writing frontend code, per `userpage/AGENTS.md`.
- Every commit must build: `npm run build` and `npm run lint` clean (backend); `npx tsc --noEmit` clean and no new eslint errors (frontend — exactly 4 pre-exist, one each in `app/admin/page.tsx`, `app/dashboard/page.tsx`, `components/PersonProfile.tsx`, `components/StudentsDirectory.tsx`).
- **Every assertion must be able to fail.** Collection assertions need a length floor — `.every()` on `[]` is `true`. Comparisons must confirm both values are present rather than matching `undefined` to `undefined`.
- Fixture mutations restore in a `finally`; probe records are covered by the `PROBE_*` cleanup arrays.

---

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `src/modules/persons/persons.model.ts` | add `deleted_at` |
| `src/modules/persons/persons.repository.ts` | exclude deleted rows in **five** reads — `findByIdNumber` deliberately excepted |
| `src/modules/blockedCards/blockedCards.model.ts` | **create** |
| `src/modules/blockedCards/blockedCards.repository.ts` | **create** — `isBlocked`, `block`, `list` |
| `src/constants/errors.ts` | add `CARD_BLOCKED` |
| `src/modules/scan/scan.service.ts` | blocklist check first |
| `src/modules/persons/persons.service.ts` | block on card replace; `softDelete`; `restore` |
| `src/modules/persons/persons.routes.ts` | `DELETE /:id`, `POST /:id/restore` (superadmin) |
| `src/modules/vehicles/vehicles.service.ts` | refuse a blocked UID |
| `src/modules/vehicleApplications/vehicleApplications.service.ts` | refuse a blocked UID |
| `src/config/verifyRoles.ts` | all assertions — it has both a Mongo connection and a working tap |

**Frontend**

| File | Responsibility |
|---|---|
| `components/PersonEditForm.tsx` | **create** — prefilled edit, `id_number` read-only |
| `components/ReplaceCardDialog.tsx` | **create** — new UID, warns the old one dies |
| `components/StudentsDirectory.tsx` | row actions, show-deleted filter, restore |
| `lib/reasonText.ts` | `card_blocked` |
| `components/gate/GateTerminal.tsx` | `card_blocked` (only if it does not already route through `reasonText`) |

---

## Task 1: Soft-delete the person record

**Files:**
- Modify: `serverside/src/modules/persons/persons.model.ts`, `persons.repository.ts`
- Test: `serverside/src/config/verifyRoles.ts` (not `verifyGates.ts` — it has no Mongo connection)

**Interfaces:**
- Produces: `Person.deleted_at: Date | null`, and repository reads that exclude deleted rows. Task 3 sets the field; nothing else may read a deleted person.

**This is the task that can silently half-work.** `personRepo` has six read paths. Five must exclude
deleted rows; **one must not**, and getting that backwards produces a confusing error rather than a
security hole — but it is still wrong.

| Method | Used by | Exclude deleted? |
|---|---|---|
| `findPaginated` | the directory | **yes** |
| `findAll` | CSV export | **yes** |
| `distinctSections` | the section filter | **yes** |
| `findById` | profile, and several services | **yes** |
| `findByRfid` | **`scan.service.tap` — the gate** | **yes** |
| `findByIdNumber` | duplicate detection in `personService.create` | **NO — see below** |

Miss `findByRfid` and a deleted person's card still opens the barrier while the directory shows them
gone: the feature looks finished and is not. `userRepo.buildFilter` is the precedent — it pins
`deleted_at: null` in one place, with a comment explaining that is what stops "Activate All"
resurrecting deleted accounts.

### Why `findByIdNumber` is the exception

Its only caller is the duplicate check in `personService.create` (`persons.service.ts:81`), and its
job is to detect a collision against an index that **still contains deleted rows** — `id_number` is
unique and is deliberately *not* cleared on delete, because a student number should not be recycled.

Filter it and the service's own check passes for a deleted person's number, then Mongo's unique
index rejects the insert with `E11000`, which `errorHandler` turns into a generic
`409 DUPLICATE_KEY "Duplicate value"` instead of the clean `DUPLICATE_ID` the spec promises. The
operator is told "duplicate value" with no indication of which field or that the number belongs to
someone who was deleted.

`findByRfid` is safe to filter for the opposite reason: delete **does** clear `rfid_uid`, so a
deleted person holds no UID and there is nothing left to clash with. That asymmetry is the whole
reason the delete clears one field and not the other — leave a comment saying so, or the next reader
will "fix" the inconsistency.

- [ ] **Step 1: Write the failing checks**

`verifyRoles.ts` — the harness has a live Mongo connection, so it can set `deleted_at` directly without needing the endpoint that Task 3 adds:

```ts
  console.log('\n== soft-deleted people are invisible ==');

  const delStamp2 = Date.now();
  const ghostId = `verify-rbac-ghost-${delStamp2}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const ghostRfid = 'FEED' + (delStamp2 % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ghostRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Ghost Probe',
    type: 'student',
    id_number: ghostId,
    department_section: 'BSIT 4-A',
    rfid_uid: ghostRfid,
  });
  expectEqual('ghost probe created', ghostRes.status, CREATED);
  const ghostData = ghostRes.json.data as { _id?: string; id?: string } | undefined;
  const ghostOid = String(ghostData?._id ?? ghostData?.id ?? '');
  expectEqual('ghost has an id', ghostOid.length > 0, true);

  // Visible before deletion — establishes the check is not vacuous.
  const beforeList = await request(superadmin, 'GET', `/persons?search=${ghostId}`);
  expectEqual('ghost is listed before deletion',
    ((beforeList.json.data ?? []) as unknown[]).length, 1);

  await PersonModel.updateOne({ _id: ghostOid }, { $set: { deleted_at: new Date() } });

  const afterList = await request(superadmin, 'GET', `/persons?search=${ghostId}`);
  expectEqual('a deleted person is gone from the directory',
    ((afterList.json.data ?? []) as unknown[]).length, 0);

  const afterGet = await request(superadmin, 'GET', `/persons/${ghostOid}`);
  expectEqual('a deleted person is a 404 by id', afterGet.status, 404);

  const csv = await request(superadmin, 'GET', '/persons/export');
  expectEqual('a deleted person is absent from the CSV export',
    String(csv.json ?? '').includes(ghostId), false);
```

**The assertion that matters most** goes in `verifyRoles.ts` too — it already taps. The established
convention in that file is a superadmin-token tap with an explicit gate and direction (see the
existing `gate denies inactive card` block), **not** a gate key:

```ts
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gateList = (gatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const personGate = gateList.find((g) => g.name === 'Main Entrance');
  const personGateId = (personGate?._id ?? personGate?.id) as string;
  expectEqual('a person gate exists for the ghost tap', Boolean(personGateId), true);

  // The card must be refused as if it were never registered. This is what catches
  // the repository-filter mistake: if findByRfid still resolves a deleted person,
  // the gate grants while the directory says they are gone.
  const ghostTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: ghostRfid,
    gate_id: personGateId,
    direction: 'entry',
  });
  const ghostBody = ghostTap.json.data as { access_result?: string; reason?: string; person?: unknown };
  expectEqual('a deleted person is denied at the gate', ghostBody?.access_result, 'denied');
  expectEqual('the reason is unregistered_uid', ghostBody?.reason, 'unregistered_uid');
  expectEqual('a deleted person leaks no identity', ghostBody?.person, undefined);
```

Keeping this in `verifyRoles.ts` rather than `verifyGates.ts` matters: `verifyGates` has **no Mongo
connection** (its only imports are `detectImageType` and `installVerifyBypass`), so it cannot set
`deleted_at` directly, and Task 3's delete endpoint does not exist yet. Do not add a database
connection to `verifyGates` for this.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run verify:roles`
Expected: `a deleted person is gone from the directory` fails (`1, expected 0`), and the gate check grants instead of denying.

- [ ] **Step 3: Write the implementation**

`persons.model.ts`:

```ts
  deleted_at: { type: Date, default: null, index: true },
```

`persons.repository.ts` — exclude deleted rows **inside** every read, not at call sites:

```ts
/**
 * Every read here excludes soft-deleted people, in this file rather than at the
 * call sites, for the same reason userRepo.buildFilter pins deleted_at there:
 * one of these reads is findByRfid, which scan.service.tap uses to resolve a
 * tapped card. A call site that forgot the condition would let a deleted
 * person's card open a barrier while the directory showed them as gone — the
 * feature would look finished and would not be.
 */
const notDeleted = { deleted_at: null } as const;
```

Apply it to **five**: `findPaginated` and `findAll` merge it into the incoming filter;
`distinctSections` adds it to its match; `findById` becomes `findOne({ _id: id, ...notDeleted })`;
`findByRfid` adds it to its query.

**`findByIdNumber` keeps querying every row**, deleted included, with a comment stating that it
backs a uniqueness check against an index that retains deleted `id_number`s — so filtering it would
turn a clean `DUPLICATE_ID` into a raw duplicate-key error.

`findById` returning `null` for a deleted person is what makes `GET /persons/:id` a 404 — verify `personService.get` already throws `NOT_FOUND` on a null.

- [ ] **Step 4: Run to verify it passes**

```bash
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:roles   # twice, byte-identical
```

**Prove the gate check has teeth:** temporarily remove `notDeleted` from `findByRfid` only, re-run, and confirm the gate assertion fails while the directory ones still pass. That contrast is the whole point — restore and re-verify.

- [ ] **Step 5: Commit**

```bash
git add src/modules/persons src/config/verifyRoles.ts
git commit -m "feat(persons): soft-delete people and exclude them from every read"
```

---

## Task 2: The card blocklist

**Files:**
- Create: `serverside/src/modules/blockedCards/blockedCards.model.ts`, `.repository.ts`
- Modify: `serverside/src/constants/errors.ts`, `src/modules/scan/scan.service.ts`, `src/modules/persons/persons.service.ts`, `src/modules/vehicles/vehicles.service.ts`, `src/modules/vehicleApplications/vehicleApplications.service.ts`
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Produces: `blockedCardRepo.isBlocked(uid)`, `blockedCardRepo.block({ rfid_uid, source, previous_person_id, blocked_by })`, and a `card_blocked` denial. Task 3 calls `block` from the delete cascade.

**The rule is absolute:** any UID that leaves a person's record is blocked forever. No unblock endpoint, no force flag, no prompt. This is a school ID system and the client chose strictness over recoverability deliberately.

- [ ] **Step 1: Write the failing checks**

```ts
  console.log('\n== blocked cards ==');

  const blkStamp = Date.now();
  const blkSuffix = (blkStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const oldUid = 'BEEF' + blkSuffix;
  const newUid = 'CAFE' + blkSuffix;

  const holderRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Card Holder Probe',
    type: 'student',
    id_number: `verify-rbac-card-${blkStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: oldUid,
  });
  expectEqual('card holder created', holderRes.status, CREATED);
  const holder = holderRes.json.data as { _id?: string; id?: string } | undefined;
  const holderId = String(holder?._id ?? holder?.id ?? '');

  // Replace the card. The old UID must die.
  const replaced = await request(superadmin, 'PATCH', `/persons/${holderId}/rfid`, { rfid_uid: newUid });
  expectEqual('card replaced', replaced.status, OK);

  // 1. The old card is refused at the gate, as BLOCKED, with no identity.
  const blockedTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: oldUid, gate_id: personGateId, direction: 'entry',
  });
  const blockedBody = blockedTap.json.data as { access_result?: string; reason?: string; person?: unknown };
  expectEqual('a replaced card is denied', blockedBody?.access_result, 'denied');
  expectEqual('the reason is card_blocked', blockedBody?.reason, 'card_blocked');
  expectEqual('a blocked card leaks no identity', blockedBody?.person, undefined);

  // 2. The new card works. Release the occupancy it creates.
  const newTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: newUid, gate_id: personGateId, direction: 'entry',
  });
  expectEqual('the new card is granted', (newTap.json.data as { access_result?: string })?.access_result, 'granted');
  await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: newUid, gate_id: personGateId, direction: 'exit',
  });

  // 3. The block holds at the point of issue, on every path.
  await check('a blocked UID cannot be registered to a person', superadmin, 'POST', '/persons', 409, {
    full_name: 'Blocked Reuse Probe', type: 'student',
    id_number: `verify-rbac-card-b-${blkStamp}`, rfid_uid: oldUid,
  });
  await check('a blocked UID cannot be reassigned', superadmin, 'PATCH', `/persons/${holderId}/rfid`, 409, {
    rfid_uid: oldUid,
  });
  await check('a blocked UID cannot be given to a vehicle', oss, 'POST', '/vehicles', 409, {
    owner_person_id: holderId, plate_number: `BLK-${blkSuffix}`,
    rfid_uid: oldUid, vehicle_type: 'car', make: 'Toyota',
  });

  // 4. A blocked tap must not move occupancy — it is a denial like any other.
  const rosterAfterBlocked = await request(superadmin, 'GET', '/occupancy?limit=100');
  expectEqual('occupancy roster read succeeded', rosterAfterBlocked.status, OK);
  const insideNames = ((rosterAfterBlocked.json.data ?? []) as { name?: string }[]);
  expectEqual('a blocked tap put nobody inside',
    insideNames.some((r) => r.name === 'Card Holder Probe'), false);
```

`personGateId` is resolved exactly as the existing blocks do — `GET /gates`, find `Main Entrance`. There is no gate-key minting in this file and none is needed: `/scan/tap` accepts a superadmin token, which is how every existing tap in `verifyRoles.ts` works.

- [ ] **Step 2: Run to verify it fails**

Expected: `the reason is card_blocked` fails with `unregistered_uid` — the old card is already dead, but not *blocked*, so it cannot be distinguished from a card that was never registered, and the registration checks return `201` instead of `409`.

- [ ] **Step 3: Write the implementation**

Model:

```ts
export interface IBlockedCard extends Document {
  rfid_uid: string;
  source: 'card_replaced' | 'person_deleted';
  previous_person_id: Types.ObjectId | null;
  blocked_by: Types.ObjectId;
  blocked_at: Date;
}
```

`rfid_uid` unique and indexed. `source` is **derived from the action, never chosen by an operator** — there is no prompt.

**Probe cleanup:** `blocked_cards` is a new collection the harness will write to, so `cleanupProbes` must delete blocked rows whose `rfid_uid` belongs to a probe. Import `BlockedCardModel` alongside the other models already imported there, and delete blocked cards **before** the persons they reference, mirroring the existing ordering comments. Without this the collection grows every run — an accumulation defect has broken these harnesses twice.

`errors.ts`:

```ts
  CARD_BLOCKED: { status: 409, message: 'This card has been permanently blocked and cannot be reused' },
```

`scan.service.tap` — the check goes **first**, before resolving the UID to anything:

```ts
    // A blocked card is refused before we look up what it used to be. It is
    // checked first because a blocked UID must never resolve to an identity:
    // the card may be in the wrong hands, which is why it was retired.
    //
    // Like every denial, this sits before the anti-passback block, so a blocked
    // card can never move anyone's inside/outside state.
    if (await blockedCardRepo.isBlocked(input.rfid_uid)) {
      access_result = 'denied';
      reason = 'card_blocked';
      // personView is deliberately left undefined.
    } else {
      ...existing resolution...
    }
```

`persons.service.reassignRfid` — block the outgoing UID as part of the same action:

```ts
    const existing = await personRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Person not found');
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');

    const updated = await this.update(id, { rfid_uid }, actor);
    // Block AFTER the swap succeeds: blocking first would kill the old card
    // even if the reassignment then failed, stranding the person with no
    // working card at all.
    if (existing.rfid_uid && existing.rfid_uid !== rfid_uid) {
      await blockedCardRepo.block({
        rfid_uid: existing.rfid_uid,
        source: 'card_replaced',
        previous_person_id: existing._id,
        blocked_by: actor.id,
      });
    }
    return updated;
```

That ordering is deliberate and worth its comment: it is the one place in this feature where failing *open* on the old card is safer than failing closed, because the alternative leaves a real person with no way through any gate.

Add the `isBlocked` guard to `personService.create`, `vehicleService.create`, and `vehicleApplicationService.create`. A block that held only at the barrier would be no block — a blocked UID could be re-registered and would then resolve normally.

- [ ] **Step 4: Run to verify it passes**

All four harnesses chained; `verify:roles` twice byte-identical.

**Prove the block is enforced at issue, not just at the gate:** temporarily remove the `isBlocked` guard from `personService.create`, re-run, and confirm `a blocked UID cannot be registered to a person` fails while the gate check still passes. Restore. Report the contrast.

- [ ] **Step 5: Commit**

```bash
git add src/modules/blockedCards src/constants/errors.ts src/modules/scan src/modules/persons src/modules/vehicles src/modules/vehicleApplications src/config/verifyRoles.ts
git commit -m "feat(cards): block a retired UID everywhere, permanently"
```

---

## Task 3: Delete and restore

**Files:**
- Modify: `serverside/src/modules/persons/persons.service.ts`, `persons.controller.ts`, `persons.routes.ts`
- Test: `serverside/src/config/verifyRoles.ts`

**Interfaces:**
- Consumes: `deleted_at` (Task 1), `blockedCardRepo.block` (Task 2).
- Produces: `DELETE /persons/:id` and `POST /persons/:id/restore`, both superadmin-only.

- [ ] **Step 1: Write the failing checks**

```ts
  console.log('\n== delete cascades, restore does not re-admit ==');

  // Build a person with a login AND a vehicle, so the cascade has all three targets.
  const vicStamp = Date.now();
  const vicSuffix = (vicStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const victimUid = 'DEAD' + vicSuffix;
  const victimUsername = `verify-del-${vicStamp}`;        // prefix: PROBE_USER_USERNAME_PREFIXES

  const vicRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Cascade Victim Probe',
    type: 'student',
    id_number: `verify-rbac-vic-${vicStamp}`,             // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: victimUid,
  });
  expectEqual('cascade victim created', vicRes.status, CREATED);
  const vicData = vicRes.json.data as { _id?: string; id?: string } | undefined;
  const victimId = String(vicData?._id ?? vicData?.id ?? '');
  expectEqual('cascade victim has an id', victimId.length > 0, true);

  const vicLogin = await request(superadmin, 'POST', '/users', {
    username: victimUsername, password: 'Verify@12345', role: 'student', person_id: victimId,
  });
  expectEqual('cascade victim login created', vicLogin.status, CREATED);

  const victimVehicleUid = 'FACE' + vicSuffix;
  const vicVeh = await request(oss, 'POST', '/vehicles', {
    owner_person_id: victimId,
    plate_number: `RBAC-VIC-${vicSuffix}`,                // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: victimVehicleUid,
    vehicle_type: 'car',
    make: 'Toyota',
  });
  expectEqual('cascade victim vehicle created', vicVeh.status, CREATED);
  const vicVehData = vicVeh.json.data as { _id?: string; id?: string } | undefined;
  const victimVehicleId = String(vicVehData?._id ?? vicVehData?.id ?? '');
  expectEqual('cascade victim vehicle has an id', victimVehicleId.length > 0, true);

  await check('registrar cannot delete a person', registrar, 'DELETE', `/persons/${victimId}`, FORBIDDEN);
  await check('hr cannot delete a person', hr, 'DELETE', `/persons/${victimId}`, FORBIDDEN);
  await check('superadmin deletes the person', superadmin, 'DELETE', `/persons/${victimId}`, OK);

  // The cascade reached all three.
  const gone = await request(superadmin, 'GET', `/persons/${victimId}`);
  expectEqual('the person is gone', gone.status, 404);

  const vehAfter = await request(superadmin, 'GET', `/vehicles?limit=100`);
  const theirVehicle = ((vehAfter.json.data ?? []) as { _id: string; status: string }[])
    .find((v) => v._id === victimVehicleId);
  expectEqual('their vehicle still exists', Boolean(theirVehicle), true);
  expectEqual('their vehicle is deactivated', theirVehicle?.status, 'inactive');

  const loginAfter = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: victimUsername, password: 'Verify@12345' }),
  });
  expectEqual('their login no longer authenticates', loginAfter.status, 401);

  // Their card is blocked, not merely unregistered. Same superadmin-token tap
  // convention every other tap in this file uses.
  const victimTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: victimUid, gate_id: personGateId, direction: 'entry',
  });
  expectEqual('their card is blocked', (victimTap.json.data as { reason?: string })?.reason, 'card_blocked');

  // Their VEHICLE's tag is refused too — proving the cascade reached it.
  // Resolve a vehicle gate the same way: GET /gates, find 'Parking Entrance'.
  const vehTapAfter = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: victimVehicleUid, gate_id: vehicleGateId, direction: 'entry',
  });
  expectEqual('their vehicle is refused at the barrier',
    (vehTapAfter.json.data as { access_result?: string })?.access_result, 'denied');

  // Restore returns the record, not access.
  await check('registrar cannot restore', registrar, 'POST', `/persons/${victimId}/restore`, FORBIDDEN);
  await check('superadmin restores', superadmin, 'POST', `/persons/${victimId}/restore`, OK);
  const restored = await request(superadmin, 'GET', `/persons/${victimId}`);
  expectEqual('the person is back', restored.status, OK);
  expectEqual('restored inactive, not active',
    (restored.json.data as { status?: string })?.status, 'inactive');
  expectEqual('restored with no card',
    (restored.json.data as { rfid_uid?: string })?.rfid_uid ?? null, null);

  const vehStill = await request(superadmin, 'GET', '/vehicles?limit=100');
  expectEqual('restore did NOT reactivate their vehicle',
    ((vehStill.json.data ?? []) as { _id: string; status: string }[])
      .find((v) => v._id === victimVehicleId)?.status, 'inactive');
```

- [ ] **Step 2: Run to verify it fails**

Expected: the `DELETE` calls return `404` — the route does not exist. Treat only that as the signal; the `403` checks would pass for the wrong reason.

- [ ] **Step 3: Write the implementation**

```ts
  /**
   * Write order is load-bearing. There are no transactions (a standalone Mongo
   * has no replica set), so a partial failure is possible and the order decides
   * which side it lands on:
   *   1. vehicles  — crash here: their car is refused, they are still admitted
   *   2. person    — crash here: both cards refused
   *   3. login     — last, because it grants no physical access
   *
   * Every partial failure leaves access MORE restricted, never less. Same rule
   * users.service states for deactivation: the gate is the first thing closed.
   */
  async softDelete(id: string, actor: Actor) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await VehicleModel.updateMany({ owner_person_id: person._id }, { $set: { status: 'inactive' } });

    const retiredUid = person.rfid_uid;
    await personRepo.updateById(id, {
      deleted_at: new Date(),
      status: 'inactive',
      rfid_uid: undefined,   // release the sparse-unique claim
    });
    if (retiredUid) {
      await blockedCardRepo.block({
        rfid_uid: retiredUid,
        source: 'person_deleted',
        previous_person_id: person._id,
        blocked_by: actor.id,
      });
    }

    const login = await userRepo.findByPersonId(id);
    if (login) {
      await userRepo.updateById(String(login._id), {
        is_active: false,
        refreshTokenHash: null,   // an existing session must not be refreshable
        deactivated_at: new Date(),
        deactivated_by: new Types.ObjectId(actor.id),
      });
    }
    return { id, deleted: true };
  },
```

Clearing `rfid_uid` **and** blocking it are both needed: clearing alone would return the UID to the pool, which the always-block rule forbids; blocking alone would leave a deleted person holding a unique claim on a UID nothing can use.

`restore` clears `deleted_at` and sets `status: 'inactive'`. It does **not** touch vehicles, the login, or the blocked card. Restoring returns the record and its history, not access — the person needs a **new** card issued.

Routes, both superadmin-only, matching `DELETE /users/:id`:

```ts
personRoutes.delete('/:id', authorize(ROLES.SUPERADMIN), personController.remove);
personRoutes.post('/:id/restore', authorize(ROLES.SUPERADMIN), personController.restore);
```

- [ ] **Step 4: Run to verify it passes**

All four chained; `verify:roles` twice byte-identical.

**Prove the cascade order:** temporarily move the vehicle deactivation to *after* the person write, re-run, and describe what would be observable if the process died between them. Restore. (You cannot easily crash mid-cascade, so reason from the code and say so — but the reordering must not break any assertion, which itself tells you the tests do not yet pin the order. Say so honestly rather than claiming coverage you do not have.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/persons src/config/verifyRoles.ts
git commit -m "feat(persons): delete with cascade and superadmin restore"
```

---

## Task 4: Edit and replace-card UI

**Files:**
- Create: `userpage/components/PersonEditForm.tsx`, `components/ReplaceCardDialog.tsx`
- Modify: `userpage/components/StudentsDirectory.tsx`, `lib/reasonText.ts`

**Interfaces:**
- Consumes: `PATCH /persons/:id`, `PATCH /persons/:id/rfid`, and the `card_blocked` reason.

`StudentsDirectory.tsx` currently imports only read helpers (`apiGet`, `apiGetList`, `apiGetBlob`) — there are no mutations on that screen at all. Its table already has an empty trailing `<th>`; that is where the row actions go.

- [ ] **Step 1: Write the failing check**

Log in as `testregistrar` / `Registrar@123` and open the Directory. Expected failure: rows have no Edit or Replace-card action. Record what you see.

- [ ] **Step 2: Confirm the failure is the predicted one**

- [ ] **Step 3: Write the implementation**

`PersonEditForm` — prefilled from the row: full name, type (constrained by `personTypesFor(role)`, exactly as `PersonForm` already constrains it), course/department, email. **`id_number` renders read-only with a short note** — "also their login username" — so the restriction reads as deliberate.

`ReplaceCardDialog` — shows the current UID, accepts a new one (the reader types straight into the field), and states plainly, before confirming: **"The current card will be permanently blocked and can never be used again."** That is the truth and there is no undo, so it must not be buried.

Surface the server's `409` messages verbatim — `DUPLICATE_RFID` and `CARD_BLOCKED` say different things and an operator needs to know which.

`lib/reasonText.ts` gains `card_blocked: "Card blocked"`.

- [ ] **Step 4: Verify in a real browser**

1. `npx tsc --noEmit` clean; `npx eslint .` — no new errors (4 pre-exist, do not touch those files).
2. As `testregistrar`: edit a student's course, see it persist after reload.
3. `id_number` is read-only and the note explains why.
4. As `testregistrar`: editing a **staff** member is not offered, and is refused if forced.
5. Replace a card: the dialog warns the old one dies permanently; after confirming, the new UID is on the record.
6. Tapping the old card at a terminal shows **"Card blocked"**, not a raw code.
7. Attempting to reuse a blocked UID in registration shows the server's message.
8. No console errors.

- [ ] **Step 5: Commit**

```bash
git add components/PersonEditForm.tsx components/ReplaceCardDialog.tsx components/StudentsDirectory.tsx lib/reasonText.ts
git commit -m "Let an operator edit a person and replace their card"
```

---

## Task 5: Delete, restore and the deleted view

**Files:**
- Modify: `userpage/components/StudentsDirectory.tsx`, `components/PersonProfile.tsx`

- [ ] **Step 1: Write the failing check**

As `testadmin`, open the Directory. Expected: no Delete action and no way to see deleted people. Record it.

- [ ] **Step 2: Confirm the failure**

- [ ] **Step 3: Write the implementation**

**Delete** is superadmin-only in the UI (the server enforces it regardless). The confirmation must name what it takes with it, with counts **fetched, not guessed** — "This also deactivates their login and 2 vehicles, and permanently blocks their card. This cannot be undone."

**Show deleted** is a superadmin-only filter. Deleted rows are visually distinct from merely inactive ones — the two mean different things and have different recovery paths. Each carries **Restore**.

The restore confirmation must say the person comes back **without a card** and needs a new one issued. Without that, an operator restores someone, watches them be refused at the barrier, and reasonably concludes the restore failed.

- [ ] **Step 4: Verify in a real browser**

1. `npx tsc --noEmit` clean; no new eslint errors.
2. As `testregistrar`: no Delete action, and no show-deleted filter.
3. As `testadmin`: delete a probe person; the confirmation names the login and vehicle counts.
4. They vanish from the default list and appear under show-deleted, visually distinct from inactive.
5. Restore them; the confirmation says they return without a card; after restoring they are listed as inactive with no RFID.
6. No console errors.

- [ ] **Step 5: Commit**

```bash
git add components/StudentsDirectory.tsx components/PersonProfile.tsx
git commit -m "Let a superadmin delete and restore a person"
```

---

## Final verification

```bash
# serverside
npm run build && npm run lint
npm run verify:roles && npm run verify:gates && npm run verify:signatures && npm run verify:passback
npm run verify:roles     # twice

# userpage
npx tsc --noEmit && npx eslint .
```

By hand:

1. A deleted person's card is refused as **blocked**, at both a person gate and a vehicle gate.
2. A replaced card is refused as **blocked**, and the new one works.
3. A blocked UID cannot be registered to a person, a vehicle, or a vehicle application.
4. Restore returns the record, inactive and cardless.
5. A registrar can edit a student but not delete anyone.
