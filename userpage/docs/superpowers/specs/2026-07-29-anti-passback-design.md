# Anti-Passback — Design

**Date:** 2026-07-29
**Status:** Approved, ready for planning
**Scope:** Occupancy state for persons and vehicles, enforced at the tap. Touches
`scan`, `reports`, `dashboard` (nav only) and adds one module.

## Problem

Direction comes from the gate, never from the cardholder's state
(`serverside/src/modules/scan/scan.service.ts:38`). One card can therefore admit
any number of people: student A taps in at the entry gate, passes the card back
through the fence, student B taps in on the same UID. Both taps are granted,
both look identical in `scan_logs`, and attendance records one clean arrival.

Nothing in the system detects the same card entering twice with no exit in
between. This is the classic RFID passback attack and the system currently has
no answer to it.

## What this is not

This is **not** occupancy accounting for headcount accuracy. State is allowed to
drift — it is cleared nightly, and a missed exit is corrected by a sweep rather
than chased down. The design optimises for *"can this card admit a second
person"*, not for *"exactly who is on campus"*. The presence roster is a useful
by-product, not the requirement.

It is also not a change to who may leave. Egress is never blocked.

## Decisions

| Question | Decision |
|---|---|
| Repeat entry, no exit | **Denied**, `reason: 'already_inside'`, with a superadmin override to clear the state. |
| Stale state | **Auto-clears** at a nightly cutoff (`OCCUPANCY_RESET_TIME`, default `23:00`), evaluated lazily on read — no cron. |
| Coverage | **Persons and vehicles.** Both get occupancy state and passback enforcement. |
| Exit with no entry | **Always granted**, flagged `exit_without_entry`. Blocking egress is a life-safety problem. |
| State storage | Dedicated `occupancy` collection, rebuildable from `scan_logs`. |
| Concurrency | Atomic conditional upsert; the unique index is the arbiter, not application logic. |
| Failure posture | **Fail closed.** A DB error on the occupancy write returns 500 and the gate stays shut. |
| Override audit | Append-only row in `scan_logs` with `reason: 'manual_override'`. |
| Who may override | **Superadmin only.** There is no guard role in this system. |

### Why lazy expiry rather than a nightly job

A cron sweep must be running at 23:00 to work. A server restarted at 22:58, a
crashed process, or a machine that was off all night all leave state stuck.
Evaluating the boundary at read time means the very first tap of the next
morning heals the record. There is no scheduler to deploy and no job to miss.

### Why a collection rather than deriving from `scan_logs`

State could be derived by reading each entity's last granted scan. That never
drifts, but the guard override then has no home — clearing someone would mean
writing a synthetic exit row purely to change a derived value, which corrupts
gate-activity reports. A real collection gives the override somewhere honest to
write, gives the presence roster an O(1) source, and the rebuild script keeps
drift recoverable.

## Data model

### `serverside/src/modules/occupancy/occupancy.model.ts`

```ts
export interface IOccupancy extends Document {
  _id: Types.ObjectId;
  entity_type: 'person' | 'vehicle';
  entity_id: Types.ObjectId;        // ref Person | Vehicle
  state: 'inside' | 'outside';
  since: Date;                       // when the current state began
  last_gate_id: Types.ObjectId | null;
  cleared_by: Types.ObjectId | null; // superadmin who overrode, null if organic
  cleared_at: Date | null;
}

occupancySchema.index({ entity_type: 1, entity_id: 1 }, { unique: true });
```

That unique index is load-bearing. It is what makes the entry transition atomic
and what prevents duplicate rows when two taps race on a card that has no
document yet. It is not merely a lookup optimisation.

**A missing document means `outside`.** The two-state machine has no "unknown".
The collection starts empty, self-populates on first tap, and the rebuild script
only ever writes `inside` rows — so the collection stays roughly the size of the
current campus population rather than the full person roster.

### No change to `scan_logs`

The new outcomes ride the existing `reason` field:

| `reason` | `access_result` | Meaning |
|---|---|---|
| `already_inside` | `denied` | Passback detected. The card is already inside. |
| `exit_without_entry` | `granted` | Exited without a matching entry. First granted row in the system that carries a reason. |
| `manual_override` | `granted` | Superadmin cleared the state. `gate_id` is null. |
| `occupancy_unavailable` | `granted` | Exit granted even though the occupancy write failed. Egress is never blocked; the roster row may be stale until the nightly boundary. |

Because `manual_override` rows have no gate, `reportService.gateActivity` must
add a `gate_id: { $ne: null }` guard to its `$match` so overrides do not appear
as a null-gate bucket.

### `serverside/src/config/env.ts`

```ts
OCCUPANCY_RESET_TIME: z.string().default('23:00'),
```

## Tap flow

The transition slots into `scanService.tap` **after** the status and gate-type
checks and **before** `scanRepo.createLog` — the log's `reason` depends on its
outcome. Denied taps never reach it, so `unregistered_uid`, `inactive_id` and
`wrong_gate_type` cannot move anyone's state.

### Entry — one conditional upsert

```ts
enter: async (entity_type, entity_id, gate_id, boundary: Date) => {
  try {
    await OccupancyModel.findOneAndUpdate(
      {
        entity_type, entity_id,
        $or: [{ state: 'outside' }, { since: { $lt: boundary } }],
      },
      { $set: { state: 'inside', since: new Date(), last_gate_id: gate_id,
                cleared_by: null, cleared_at: null } },
      { upsert: true, new: true }
    );
    return 'admitted';
  } catch (err) {
    if (isDuplicateKey(err)) return 'already_inside';
    throw err;
  }
}
```

The filter carries the lazy expiry: a document whose `since` predates the last
boundary is treated as outside and overwritten in the same operation. If the
document exists *and* is genuinely fresh-inside, the filter matches nothing, the
upsert attempts an insert, and the unique index rejects it with `E11000`.

**That duplicate-key error is the passback detection**, and it is atomic because
MongoDB serialises it at the index rather than in application code. The same
`findOneAndUpdate` + `E11000` idiom is already used in
`attendance.repository.ts:16`, where the check is written inline. This design
extracts it once as `utils/isDuplicateKey.ts` and uses it in both places, so the
error-code test is not duplicated a second time.

### Exit — the mirror

```ts
const doc = await OccupancyModel.findOneAndUpdate(
  { entity_type, entity_id, state: 'inside' },
  { $set: { state: 'outside', since: new Date(), last_gate_id: gate_id } }
);
return doc ? 'released' : 'exit_without_entry';
```

No match means they were not inside. The tap still returns `granted`; the
anomaly rides in `reason` and the attendance time-out rollup runs unchanged.

### The boundary helper

A pure function: *the most recent occurrence of `OCCUPANCY_RESET_TIME` at or
before `now`*. At 07:05 with a 23:00 cutoff the boundary is yesterday 23:00; at
23:30 it is today 23:00. Isolated and pure so it can be tested without a server.

## API

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/occupancy` | superadmin | Presence roster — paginated, searchable, joined to names and photos |
| `POST /api/occupancy/:id/clear` | superadmin | Force one entity to `outside`; stamps `cleared_by` / `cleared_at` and writes the `manual_override` scan row |

`:id` is the **occupancy document `_id`**, not the person or vehicle id. The
roster returns it, so the client never has to compose a composite key, and a
clear can only target a row that already exists.
| `GET /api/reports/anomalies` | superadmin | `already_inside` denials and `exit_without_entry` grants over a date range |

Registrar is denied all three, consistent with `dashboardService.registrarView`
(`dashboard.service.ts:108`), which already withholds every class of scan data.

### Why superadmin and not a guard

`constants/roles.ts` defines superadmin, registrar, staff and student.
`userpage/lib/permissions.ts:24` gives `staff` no abilities. Gate terminals
authenticate with a device key, not a user account, so "the guard" is not an
identity the API can recognise. Inventing a guard role is out of scope for this
feature; the override therefore lives in the admin console under superadmin.

## Frontend

- `userpage/lib/permissions.ts` — new `presence` entry in `AdminView` and in
  `NAV_BY_ROLE.superadmin`.
- `userpage/components/admin/PresenceView.tsx` — roster of who is inside, with a
  Clear action per row. The override belongs here because you need to see the
  stuck card to clear it.
- `userpage/components/gate/GateTerminal.tsx:22` — one line:
  `already_inside: "Card already inside campus"`.

## Error handling and edge cases

**Fail closed.** Any non-duplicate-key error on the occupancy write propagates,
the tap returns 500, and the gate does not open. This matches how every other DB
failure in `tap()` already behaves. For a security feature, "the database is
unreachable, therefore admit everyone" is the wrong default.

**Racing entries on a card with no document.** Both upserts attempt an insert;
the unique index lets exactly one win and the loser gets `E11000` → denied. The
design is correct in precisely the case it exists for, with no extra code.

**A deactivated person who is currently inside.** The `status !== 'active'` check
denies them at the exit gate before occupancy is consulted, so their state stays
`inside` until the nightly boundary. Harmless — they are denied entry anyway —
but it is why an inactive person can linger on the presence roster. The existing
status check is deliberately not modified.

**RFID reassigned to a different person.** Occupancy is keyed on `entity_id`, not
`rfid_uid`, so reassignment carries no stale state. This is the reason for that
key choice.

**Vehicles parked overnight.** The nightly boundary clears them, so a car left on
campus can re-enter the next morning without an exit. This is an accuracy loss,
not a lockout, and is the accepted cost of covering vehicles under a
time-boxed reset.

### Known limitations

**The closing-time window.** Expiry is per-entity and evaluated at read, not on
a clock, so any card whose `since` predates the most recent boundary gets one
free re-entry the next time it taps — whether that tap comes at 23:30 or at
07:00 the following morning. It is not a roughly one-hour exposure; it is one
unchecked entry per stale card, sitting dormant until that card is next used.
This is indistinguishable from — and deliberately tolerated for the same
reason as — a legitimate missed exit tap, which is the point of lazy expiry.
Closing it would require the cron sweep this design deliberately avoids.

**`already_inside` reveals the cardholder's name.** Intentional — a guard must
know who the system thinks is inside in order to resolve it — but a stranger
tapping a found card learns the owner's name. This is the same exposure
`inactive_id` already has, so it is consistent rather than new.

**Server-local time.** `OCCUPANCY_RESET_TIME` computes its boundary from server
local time, the same as `dateKey()` in `scan.service.ts:23`. On a UTC host,
"23:00" is not 11 PM in Manila and the boundary lands mid-morning, clearing
occupancy while campus is full. This feature does not create that bug but it does
inherit it, and it is more visible here than in attendance. The fix is a single
`TZ` env var applied to both helpers, deliberately left out of this scope to
avoid expanding the blast radius.

## Rebuild script

`npm run rebuild:occupancy`, following the existing `verify:*` / `seed:*`
convention. Replays granted person and vehicle scans since the last boundary and
derives the final state per entity. `manual_override` rows fall out correctly for
free — they are `direction: 'exit'`, `access_result: 'granted'`, so the replay
treats them as exits, which is what they are.

## Testing

This repo has no test framework — verification is hand-rolled `verify:*`
harnesses (`config/verifyGates.ts`) run against a live `npm run dev` with
`seed:test` applied. This feature follows that convention. Introducing jest is a
legitimate change but should be its own decision, not a side effect of an
anti-passback feature.

**`npm run verify:passback`.**

### Pure-function checks, no server

The boundary helper, tested in-process the way `verifyGates.ts` already tests
`detectImageType`: now before the cutoff → yesterday's boundary; now after →
today's; now exactly at the cutoff; and a `since` straddling the boundary in both
directions. This is where the off-by-one lives.

### Sequential API checks

Against the `seed:test` students and a seeded vehicle:

1. Entry → `granted`
2. Entry again → `denied`, `already_inside`
3. Exit → `granted`
4. Entry again → `granted`
5. Exit with no prior entry → `granted`, `exit_without_entry`
6. A vehicle tag through the same cycle
7. A `wrong_gate_type` tap, then a legitimate entry — asserting the denied tap
   left state untouched

### The concurrency check

Every assertion above passes on a naive read-then-write implementation. The
atomic claim is only provable by firing simultaneous taps:

```ts
const results = await Promise.all(
  Array.from({ length: 8 }, () => tap(uid, GATE_ENTRY))
);
expectEqual('exactly one grant under 8 concurrent entries',
  results.filter(r => r.access_result === 'granted').length, 1);
```

Eight parallel entry taps on one card must yield exactly one `granted` and seven
`already_inside`. **Loop this block ten times and assert the invariant each
round** — a race that reproduces at 1-in-20 will pass a single run and fail
during a defense.

### What this does not cover

The harness needs a running server and a seeded database, so it cannot run in CI
and it mutates real data — it must clear its own occupancy rows via the override
endpoint on the way out. It exercises MongoDB's real index behaviour, which is
the point: a mocked test of the duplicate-key path would only prove the mock
returns what it was told to.
