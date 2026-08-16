# Single-Card Access — Design

**Date:** 2026-08-01
**Status:** Approved, ready for planning
**Scope:** One RFID credential resolves person attendance at person gates and the owner's vehicle
at vehicle gates.

## Problem

A person card tapped at a vehicle gate is denied `wrong_gate_type` with identity cleared, so the
terminal reads "Unknown card / Wrong gate for this card". This is correct under the current design —
gates have a fixed type, and a person card must not open the parking barrier — but it means a
cardholder needs a second physical credential (a windshield sticker) to use the parking lane.

The client wants one card to do both: tap at Main Entrance for attendance, tap the same card at
Parking Entrance to raise the barrier for their own vehicle.

A second, independent defect surfaced while diagnosing this. Vehicle registration checks RFID
uniqueness against other **vehicles** only:

```
vehicleApplications.service.ts:116   const existingRfid = await vehicleRepo.findByRfid(input.rfid_uid);
vehicles.service.ts:41               const existingRfid = await vehicleRepo.findByRfid(...);
```

Neither consults `personRepo.findByRfid`. A person's card can therefore be assigned to a vehicle,
producing a vehicle row that can never be scanned — the person lookup always wins. This is how
`CAV 8832` ended up holding `0003461782`, the same UID as its owner's ID card.

## Decisions

| Question | Decision |
|---|---|
| Multiple active vehicles per owner | **One active vehicle per owner**, enforced at registration. The gate additionally denies on ambiguity as a safety net for rows predating the rule. |
| Do vehicles keep their own RFID tag | **Yes.** The owner-card path is additive. A windshield sticker still works. |
| Does a parking tap record attendance | **Yes**, but only on the owner-card path. |
| Which occupancy is authoritative | The **vehicle's**. The person write is best-effort. |
| Does a vehicle *tag* record attendance | **No.** A sticker identifies a car; a card identifies a person. |

## Resolution

`scan.service.tap` keeps its current structure. The blocked-card check still runs first, and the
person lookup still precedes the vehicle lookup. What changes is the branch taken when a matched
person taps at a gate whose `type` is `vehicle`.

Today that falls through to the `wrong_gate_type` guard at `scan.service.ts:141`. Instead it takes
the owner-card path:

| State | `access_result` | `reason` |
|---|---|---|
| Person `status !== 'active'` | denied | `inactive_id` |
| Zero active, unexpired vehicles | denied | `no_vehicle_registered` *(new)* |
| Two or more active, unexpired vehicles | denied | `multiple_vehicles` *(new)* |
| Exactly one | granted | `null` |

On a grant the path sets `entity_type = 'vehicle'` and `entity_id = vehicle._id`. Because it does,
the existing `wrong_gate_type` guard passes unmodified — that guard is not touched by this work.

Two paths are entirely unchanged: a vehicle tag tapped at a vehicle gate, and a person card tapped
at a person gate.

### Why `no_vehicle_registered` is a new reason

Reusing `wrong_gate_type` would be actively misleading. Under this design the card *is* correct for
that gate; the person simply has no pass. A guard told "wrong gate" investigates the wrong thing.
`multiple_vehicles` is separate for the same reason — it tells the guard to verify the plate by eye,
which is the only action that resolves it.

Both reasons need entries in the shared `reasonText()` map. Shipping a raw snake_case code to an
operator screen has been a must-fix twice in this project.

### Which vehicles count

`vehicleRepo.findActiveByOwner(owner_person_id, asOf)` already exists — the monitor-output work
added it for the `registered[]` list. It filters `status: 'active'` and `valid_until: { $gte: asOf }`.

Its projection is `select('vehicle_type make')`, which is insufficient here: the gate path needs
`_id` (for occupancy) and `plate_number` (for the scan log and the terminal). Widen the projection
rather than adding a second near-identical method — two lookups with drifting filters is exactly how
a vehicle gets granted by one and rejected by the other.

`asOf` is the tap's own `scan_time` Date. No string conversion anywhere in this path: this codebase
has shipped two real defects from UTC-derived dates, and `valid_until` is stored as end-of-day local.

## Occupancy

Occupancy is keyed `{ entity_type, entity_id }` with a unique index. Person and vehicle rows are
already independent, so a parking tap can move a vehicle without touching its owner — and, on this
path, can move both as two separate writes.

### Entry

1. `occupancyRepo.enter('vehicle', vehicle._id, gateOid, boundary)`. This is the anti-passback gate.
   `already_inside` denies here, and **no person write is attempted**.
2. `occupancyRepo.enter('person', person._id, gateOid, boundary)` — **best-effort**. A thrown error
   is logged as an anomaly and does not deny. `already_inside` is benign, not an error: the person
   may have walked in through Main Entrance earlier.

**The ordering and the best-effort rule are load-bearing.** There is no transaction available
(standalone Mongo, no replica set), so the two writes cannot be atomic. Denying on a failed person
write would be worse than tolerating it: the deny happens *after* the vehicle row has already moved,
so it would record a car inside the lot while keeping the barrier shut, and recovering would need a
compensating release that can itself fail. Vehicle-authoritative with a best-effort companion never
produces that state — the worst case is a car correctly in the lot whose driver's attendance row is
missing, which the anomaly log surfaces.

This is a deliberate refinement of the first recommendation made during brainstorming, which
proposed denying on a failed person write. That was wrong for the reason above and is recorded here
so it is not re-derived.

### Exit

Mirrors entry, and egress is still never blocked:

1. `occupancyRepo.release('vehicle', ...)`. An `exit_without_entry` outcome is recorded as the
   reason but the tap remains **granted** — the existing life-safety rule is unchanged.
2. `occupancyRepo.release('person', ...)` — best-effort. A person already outside is **silent**, not
   an anomaly: they may have walked out through Side Gate and returned on foot. The vehicle side
   carries the anomaly signal for this tap.

### Attendance rollup, not just occupancy

Occupancy and attendance are two different records. Occupancy is the live presence roster;
attendance is the daily rollup that `attendanceRepo.upsertTimeIn` / `upsertTimeOut` writes at the end
of `tap`. That rollup is guarded by `entity_type === 'person'`.

On the owner-card path `entity_type` is `vehicle`, so the rollup would not fire — the person would
appear on the live roster but still have no `time_in` for the day. That is half the stated problem
solved and the more visible half left broken.

**The companion person id therefore drives both writes:** the occupancy row *and* the attendance
rollup. The rollup's guard becomes "the person this tap is attributable to", which is `entity_id`
on a person tap and the companion id on an owner-card tap.

This was missed in the first draft of this spec and found while planning the implementation.

### The case that motivated the change

Drive in at Parking Entrance with the ID card, park, walk to class, leave on foot through Side Gate.
Today the Side Gate exit returns `exit_without_entry` and the attendance record shows the person was
never on campus — because as a *person* they were never marked inside. Under this design step 2 of
entry marks them present, so the walk-out resolves normally.

Without the companion write this would stop being an edge case and become what happens to every
driver, every day.

## Registration

Two guards, both currently absent:

**One active vehicle per owner.** Reject any create — or any status change to `active` — that would
leave a person holding a second active, unexpired vehicle. Return a clear conflict naming the
existing plate so an admin knows what to deactivate. This is what keeps `multiple_vehicles` a safety
net rather than a routine outcome.

This narrows a constraint the vehicle-registration work deliberately dropped. That relaxation was
correct for a system where each vehicle carried its own tag; under single-card the owner *is* the
key, so a one-to-many mapping has no unambiguous resolution at the barrier. The capability is not
removed — a person may still hold multiple vehicle rows — but only one may be active at a time.

**Cross-collection UID uniqueness.** Vehicle registration also checks `personRepo.findByRfid`, and
person registration and card replacement also check `vehicleRepo.findByRfid`. A UID may belong to a
person or a vehicle, never both. The blocked-card check is unaffected and still runs first at scan
time.

## Existing data

Two manual repairs. Neither is automated — both are small, and a migration that rewrites access
credentials is a worse risk than a documented step.

- **`CAV 8832` holds `rfid_uid = 0003461782`**, identical to its owner's person card, and is
  therefore permanently shadowed. Clear the field. The vehicle becomes reachable through its owner,
  which is the intended behaviour.
- **Juan Dela Cruz holds two active vehicles** (`NCST-1234`, `U329340MX`). The new constraint binds
  writes, not existing rows, so he will be denied `multiple_vehicles` at the parking gate until one
  is deactivated. This is the safety net behaving correctly and is worth demonstrating rather than
  quietly fixing.

## Frontend

`GateTerminal` needs no structural change — an owner-card grant at a vehicle gate returns the same
`person` shape a vehicle tag returns today (owner name, `owner_type`, `department_section`,
`plate_number`, `vehicle`). Only the two new reason strings are added to `reasonText()`.

The terminal's existing constraints hold: the verdict stays the dominant element, green means
granted and red denied, and no raw reason code reaches the screen.

## Verification

Extends `serverside/src/config/verifyGates.ts`, which taps at real gates with gate keys.

1. An owner card at Parking Entrance grants, and returns the owner's name and the vehicle's plate.
2. That same tap creates **both** occupancy rows — vehicle inside and person inside — **and** writes
   the owner's attendance `time_in` for the day.
3. A person with no active vehicle denies `no_vehicle_registered`.
4. A person with two active vehicles denies `multiple_vehicles`.
5. An inactive person at a vehicle gate denies `inactive_id`, with identity still shown.
6. A vehicle **tag** at Parking Entrance still grants and moves **only** the vehicle row — the
   owner's person occupancy is untouched. This pins the sticker/card distinction.
7. Drive in at Parking Entrance, then exit on foot at Side Gate: the exit grants with **no**
   `exit_without_entry` reason. This is the defect that motivated the change.
8. A second entry tap of the same owner card at Parking Entrance denies `already_inside`, and no
   person write occurs.
9. Registration rejects a second active vehicle for the same owner.
10. Registration rejects a vehicle whose `rfid_uid` belongs to a person.

Assertion discipline: every assertion must be able to fail; collection assertions need a length
floor, because `.every()` on an empty array is `true` and that has caused real defects here; any
comparison must confirm both values are present rather than matching `undefined` to `undefined`.

Fixture discipline, both standing constraints in this project:

- **Never test destructive actions against seeded fixtures.** Cases 3, 4, 5, 9 and 10 create their
  own throwaway rows. A prior task corrupted `C3D4E5F6` by testing card replacement against a
  seeded person and broke 119 of 121 checks.
- Any case that mutates a fixture — deactivating a person, backdating an expiry, deactivating one
  of Juan's vehicles — wraps the mutation and its restore in `try/finally`, and releases every
  occupancy row it creates. A throw between mutate and restore leaves a seeded fixture broken in a
  way that looks like a product bug on every later run.

Harness notes: `firstKey` is revoked partway through `verifyGates` by the second key mint — use
`secondKey` for new granted taps. `verifyGates` has no Mongo connection; occupancy state is asserted
through the API, not by reading the database.

## Out of scope

- **The gadget registry.** `2026-07-27-gadget-registry-design.md` remains unimplemented. Gadgets are
  already exempt from the gate-type check and nothing here changes that.
- **The exit-double policy.** Repeated exits with no entry between are granted by the deliberate
  egress rule; whether to make that louder is a separate open question.
- **`personService.update`'s missing RFID check.** That method writes `rfid_uid` straight through
  with no uniqueness check of any kind — not even person-against-person. The cross-collection guard
  goes where the existing `DUPLICATE_RFID` guards already are (`create` and `reassignRfid`). Closing
  the `update` hole is a pre-existing, separate defect and widening it here would mean adding the
  person-against-person check too. Recorded so it is not mistaken for an oversight in this work.
- **Normalising `department_section`.** Still data hygiene.
- **Removing vehicle RFID tags.** Explicitly rejected: the owner-card path is additive, existing
  tags keep working, and no migration runs.
