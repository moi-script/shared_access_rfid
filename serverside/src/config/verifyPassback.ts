/**
 * Asserts the anti-passback behaviour in
 * docs/superpowers/specs/2026-07-29-anti-passback-design.md.
 *
 * Requires: MongoDB reachable at `MONGODB_URI`, `npm run dev` running (the
 * HTTP-based checks below tap through the real server), and `npm run
 * seed:test` already applied.
 * Run with: npm run verify:passback
 */
import mongoose, { Types } from 'mongoose';
import { connectDB } from './db';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { occupancyRepo } from '../modules/occupancy/occupancy.repository';
import { lastResetBoundary } from '../utils/occupancyWindow';
import { PersonModel } from '../modules/persons/persons.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { UserModel } from '../modules/users/users.model';
import { ScanLogModel } from '../modules/scan/scan.model';
import { rebuildOccupancy } from './rebuildOccupancy';
import { installVerifyBypass } from './verifyBypass';

// Installs the X-Verify-Bypass header on every fetch() this process makes,
// once, before any request goes out — see verifyBypass.ts and the matching
// comment in verifyRoles.ts. Unset VERIFY_BYPASS_TOKEN means this run is
// subject to the real rate limits.
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
  console.log('All anti-passback checks passed.');
}

/** Builds a local-time Date on a fixed calendar day, so assertions read clearly. */
function at(day: number, hh: number, mm: number): Date {
  return new Date(2026, 6, day, hh, mm, 0, 0); // month 6 = July
}

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
  person?: { full_name: string; registered?: unknown };
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

  // The default-parameter path is contract for Tasks 4, 5 and 7, so exercise it.
  expectEqual(
    'omitting resetTime uses the configured default',
    lastResetBoundary(at(15, 7, 5)).getTime(),
    lastResetBoundary(at(15, 7, 5), '23:00').getTime()
  );

  console.log('\n== occupancy repository ==');
  await connectDB();
  // Mongoose builds indexes in the background after the model is first used.
  // Without waiting for it here, the concurrency round below can fire its
  // duplicate writes before the unique index exists, which makes MongoDB
  // refuse to build it against the resulting duplicate keys — silently
  // disabling passback detection for the rest of the run. Waiting on init()
  // guarantees the index is live before any test traffic hits the collection.
  await OccupancyModel.init();

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
    await occupancyRepo.release('person', personId, gateId, boundary),
    'released'
  );
  expectEqual(
    'entry after a real exit is admitted again',
    await occupancyRepo.enter('person', personId, gateId, boundary),
    'admitted'
  );
  expectEqual(
    'exit after a re-entry releases again',
    await occupancyRepo.release('person', personId, gateId, boundary),
    'released'
  );
  expectEqual(
    'exit while already outside is flagged',
    await occupancyRepo.release('person', personId, gateId, boundary),
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

  // Race against an EXISTING outside document, not a fresh insert. This path
  // resolves through the update predicate rather than the unique index, so it
  // needs its own proof.
  for (let round = 1; round <= 5; round++) {
    const racer = new Types.ObjectId();
    await occupancyRepo.enter('person', racer, gateId, boundary);
    await occupancyRepo.release('person', racer, gateId, boundary); // now state: 'outside'
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `outside-doc round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  // Race against a STALE inside document. Exactly one caller should heal it and
  // be admitted; the other seven must be refused.
  for (let round = 1; round <= 5; round++) {
    const racer = new Types.ObjectId();
    await occupancyRepo.enter('person', racer, gateId, boundary);
    await OccupancyModel.updateOne(
      { entity_id: racer },
      { $set: { since: new Date(boundary.getTime() - 60_000) } }
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () => occupancyRepo.enter('person', racer, gateId, boundary))
    );
    expectEqual(
      `stale-doc round ${round}: exactly one grant under 8 concurrent entries`,
      results.filter((r) => r === 'admitted').length,
      1
    );
    await OccupancyModel.deleteMany({ entity_id: racer });
  }

  await OccupancyModel.deleteMany({ entity_id: personId });

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
  // The subtle half of the personView asymmetry: unlike wrong_gate_type, an
  // already_inside denial must KEEP the cardholder's identity so a guard can
  // see who the system thinks is inside. A future "harmonise the denial
  // branches" refactor that cleared it here would go green without this.
  expectEqual('already_inside denial keeps identity', second.person?.full_name, 'Juan Dela Cruz');
  // The gate deliberately KEEPS identity on an already_inside denial so a guard
  // can resolve it, but must never reveal what that person has registered — a
  // denied tap is the case most likely to involve someone holding a card that
  // isn't theirs. The attachment is guarded on access_result === 'granted', so
  // this holds by control flow; pinning it means a future refactor that splits
  // that guard per-branch cannot quietly undo it. Juan owns active vehicles
  // (seed:test), so this fails for the right reason rather than passing
  // vacuously against an owner with nothing registered.
  expectEqual('already_inside denial does not reveal registrations', second.person?.registered, undefined);

  const out = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit granted', out.access_result, 'granted');
  expectEqual('exit has no reason', out.reason, null);

  const again = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('entry after a real exit granted', again.access_result, 'granted');

  await tap(superadmin, juanUid, personExit, 'exit');
  const orphanExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit with no entry is never blocked', orphanExit.access_result, 'granted');
  expectEqual('exit with no entry is flagged', orphanExit.reason, 'exit_without_entry');

  // release() must apply the same staleness rule as enter()/listInside(),
  // otherwise a card stranded 'inside' from before the nightly boundary would
  // silently report 'released' on its next exit tap, hiding a genuine
  // exit-without-entry from the anomaly report. Pin the exact scenario: enter,
  // backdate `since` to before the boundary (same technique as the stale-doc
  // concurrency block above), then tap an exit.
  const staleEntry = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('stale-exit setup: entry granted', staleEntry.access_result, 'granted');
  const staleBoundary = lastResetBoundary(new Date());
  await OccupancyModel.updateOne(
    { entity_id: juan._id },
    { $set: { since: new Date(staleBoundary.getTime() - 60_000) } }
  );
  const staleExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit against a stale inside row is never blocked', staleExit.access_result, 'granted');
  expectEqual(
    'exit against a stale inside row is flagged, not silently released',
    staleExit.reason,
    'exit_without_entry'
  );
  await OccupancyModel.deleteMany({ entity_id: juan._id });

  // And the ordinary case must still behave: a fresh entry followed by an
  // exit is a real release with no anomaly reason.
  const freshEntry = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('fresh-exit setup: entry granted', freshEntry.access_result, 'granted');
  const freshExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('exit against a fresh inside row is granted', freshExit.access_result, 'granted');
  expectEqual('exit against a fresh inside row has no reason', freshExit.reason, null);
  await OccupancyModel.deleteMany({ entity_id: juan._id });

  // A denied tap must not move anyone's state. Tapping Juan's person card at
  // a VEHICLE gate is denied before occupancy is consulted — single-card
  // access resolves his owner-card at the barrier, and since he owns TWO
  // active vehicles (the seeded multiple_vehicles fixture) the barrier
  // refuses to guess which one rather than granting; if it leaked through,
  // the entry below would come back already_inside. (Prior to single-card
  // access this denied for wrong_gate_type instead — the denial-does-not-
  // move-state guarantee under test here is unchanged, only the reason is.)
  const wrongGate = await tap(superadmin, juanUid, vehicleEntry, 'entry');
  expectEqual('person card at a vehicle gate denied', wrongGate.reason, 'multiple_vehicles');
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

  console.log('\n== egress is never blocked by a lapsed registration ==');
  // A registration can lapse (deactivated by a clerk, or valid_until passing)
  // while the vehicle is standing INSIDE the campus. Entry denials are correct
  // then — but an EXIT denial traps the row: occupancy only ever moves on a
  // granted tap, so the vehicle stays 'inside' for the rest of the occupancy
  // window and every tap after reactivation comes back already_inside, with no
  // gate-side way to resolve it. That is the exact sequence observed in
  // production on 2026-08-06 (scan_logs for owner card 0003461782).
  //
  // Uses a throwaway owner and vehicle so the deactivation cannot disturb the
  // seeded fixtures the rest of this harness taps.
  const lapseStamp = Date.now();
  const lapseSuffix = (lapseStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const lapseOwnerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Lapsed-Pass Owner',
    type: 'student',
    id_number: `verify-lapse-${lapseStamp}`,
    department_section: 'BSIT 4-A',
    rfid_uid: `BBBB${lapseSuffix}`,
  });
  expectEqual('lapse setup: throwaway owner created', lapseOwnerRes.status, 201);
  const lapseOwnerId = String(
    (lapseOwnerRes.json.data as { _id?: string } | undefined)?._id ?? ''
  );
  const lapseCardUid = `BBBB${lapseSuffix}`;
  const lapseTagUid = `BC01${lapseSuffix}`;

  const lapseVehicleRes = await request(superadmin, 'POST', '/vehicles', {
    owner_person_id: lapseOwnerId,
    plate_number: `LAPSE-${lapseSuffix}`,
    rfid_uid: lapseTagUid,
    vehicle_type: 'motorcycle',
    make: 'Toyota',
  });
  expectEqual('lapse setup: throwaway vehicle created', lapseVehicleRes.status, 201);
  const lapseVehicleId = String(
    (lapseVehicleRes.json.data as { _id?: string } | undefined)?._id ?? ''
  );

  try {
    // --- the vehicle TAG lane ---
    expectEqual(
      'lapse setup: vehicle tag entry granted',
      (await tap(superadmin, lapseTagUid, vehicleEntry, 'entry')).access_result,
      'granted'
    );

    const deactivated = await request(superadmin, 'PATCH', `/vehicles/${lapseVehicleId}`, {
      status: 'inactive',
    });
    expectEqual('lapse setup: vehicle deactivated', deactivated.status, 200);

    // Entry must still be refused — the pass is genuinely revoked.
    expectEqual(
      'a deactivated vehicle is refused entry',
      (await tap(superadmin, lapseTagUid, vehicleEntry, 'entry')).reason,
      'inactive_id'
    );

    // ...but the car is already inside, and a stuck exit gate is a physical
    // safety problem. Egress is granted and the occupancy row is released.
    const lapsedExit = await tap(superadmin, lapseTagUid, vehicleExit, 'exit');
    expectEqual('a deactivated vehicle is never trapped inside', lapsedExit.access_result, 'granted');
    expectEqual(
      'the lapsed exit still names why the pass was refused',
      lapsedExit.reason,
      'inactive_id'
    );
    const afterLapsedExit = await OccupancyModel.findOne({ entity_id: lapseVehicleId }).lean();
    expectEqual('the lapsed exit released the occupancy row', afterLapsedExit?.state, 'outside');

    // Reactivating must hand back a usable pass, not a permanent already_inside.
    const reactivated = await request(superadmin, 'PATCH', `/vehicles/${lapseVehicleId}`, {
      status: 'active',
    });
    expectEqual('lapse setup: vehicle reactivated', reactivated.status, 200);
    expectEqual(
      'entry after reactivation is granted, not already_inside',
      (await tap(superadmin, lapseTagUid, vehicleEntry, 'entry')).access_result,
      'granted'
    );

    // --- the owner-CARD lane, which denies for a different reason ---
    // The car is inside from the tap above. Deactivate again: the owner's card
    // now resolves to zero active vehicles, so this path denies with
    // no_vehicle_registered rather than inactive_id — and trapped the car just
    // the same before this fix.
    await request(superadmin, 'PATCH', `/vehicles/${lapseVehicleId}`, { status: 'inactive' });
    expectEqual(
      'an owner card with no active vehicle is refused entry',
      (await tap(superadmin, lapseCardUid, vehicleEntry, 'entry')).reason,
      'no_vehicle_registered'
    );
    const cardExit = await tap(superadmin, lapseCardUid, vehicleExit, 'exit');
    expectEqual(
      'an owner card with no active vehicle is never trapped inside',
      cardExit.access_result,
      'granted'
    );

    // The vehicle it entered on cannot be resolved from the card any more, so
    // the card releases the PERSON. The vehicle row is cleared by its own tag
    // (above) or by the superadmin override; what must not happen is a refused
    // exit.
    //
    // The reason is the LAPSE, not exit_without_entry: the person had no
    // occupancy row here, and the milder anomaly must not overwrite the fact
    // that explains why the barrier opened.
    expectEqual(
      'the card exit names why the pass was refused',
      cardExit.reason,
      'no_vehicle_registered'
    );

    // The override must not become a way through the WRONG barrier. This
    // vehicle is inactive, so a sticker tap carries `inactive_id` at any gate —
    // but at a walking gate that tap is a wrong-gate tap wearing a lapse's
    // reason code, and stays denied in both directions.
    const tagAtPersonGate = await tap(superadmin, lapseTagUid, personExit, 'exit');
    expectEqual(
      'a lapsed vehicle tag is still refused at a person gate',
      tagAtPersonGate.access_result,
      'denied'
    );

    // And entry is untouched by all of the above: the override is exit-only.
    expectEqual(
      'the override never applies to entry',
      (await tap(superadmin, lapseTagUid, vehicleEntry, 'entry')).access_result,
      'denied'
    );
  } finally {
    await OccupancyModel.deleteMany({ entity_id: new Types.ObjectId(lapseVehicleId) });
    await OccupancyModel.deleteMany({ entity_id: new Types.ObjectId(lapseOwnerId) });
    await VehicleModel.deleteMany({ plate_number: `LAPSE-${lapseSuffix}` });
    await PersonModel.deleteMany({ id_number: `verify-lapse-${lapseStamp}` });
  }

  console.log('\n== presence roster and override ==');
  const registrar = await login('testregistrar', 'Registrar@123');
  const superadminUser = await UserModel.findOne({ username: 'testadmin' }).lean();
  if (!superadminUser) throw new Error('run `npm run seed:test` first — testadmin is missing');

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

  // The override must leave a permanent, attributable audit trail — this is
  // the entire point of the feature, not incidental bookkeeping.
  const overrideLog = await ScanLogModel.findOne({
    entity_id: juan._id,
    reason: 'manual_override',
  })
    .sort({ scan_time: -1 })
    .lean();
  expectEqual('the override wrote an audit log row', !!overrideLog, true);
  expectEqual('the audit row carries the card UID', overrideLog?.rfid_uid, juanUid);
  expectEqual(
    'the audit row attributes the override to the acting superadmin',
    overrideLog?.actor_user_id?.toString(),
    superadminUser._id.toString()
  );

  // Immediately again, with nothing tapped in between: the row is genuinely
  // outside now, so there is nothing to clear and the client must not retry.
  const stale = await request(superadmin, 'POST', `/occupancy/${juanRow?._id}/clear`, {});
  expectEqual('clearing an already-cleared row is a 404', stale.status, 404);

  // The override actually released the card: it may enter again with no exit tap.
  expectEqual(
    'a cleared card may enter again',
    (await tap(superadmin, juanUid, personEntry, 'entry')).access_result,
    'granted'
  );

  // And a legitimate second visit is still clearable — the 404 above is about
  // state, not about the row being spent.
  const roster2 = await request(superadmin, 'GET', '/occupancy');
  const rows2 = (roster2.json.data ?? []) as { _id: string; name: string }[];
  const juanRow2 = rows2.find((r) => r.name === juan.full_name);
  expectEqual(
    'a re-entered card can be cleared again',
    (await request(superadmin, 'POST', `/occupancy/${juanRow2?._id}/clear`, {})).status,
    200
  );

  await OccupancyModel.deleteMany({ entity_id: juan._id });

  console.log('\n== anomaly report ==');

  const anomalyWindowStart = new Date();
  await OccupancyModel.deleteMany({ entity_id: juan._id });
  await tap(superadmin, juanUid, personEntry, 'entry');
  await tap(superadmin, juanUid, personEntry, 'entry'); // already_inside
  await tap(superadmin, juanUid, personExit, 'exit');
  await tap(superadmin, juanUid, personExit, 'exit'); // exit_without_entry

  // The $limit: 500 cap (reports.service.ts's anomalies()) can silently hide
  // anomalies from an operator who only reads `count`. `total` (a real
  // countDocuments) and `truncated` must be present and self-consistent so a
  // caller can tell "500" from "at least 500". scan_logs is real, permanent
  // scan history that accumulates across every run of this harness (and real
  // gate traffic) — whether an unfiltered report today lands above or below
  // the cap depends on that accumulated volume, not on anything this harness
  // controls, so the assertions below check the CONTRACT for whichever
  // branch actually happened rather than assuming one.
  const ANOMALY_CAP = 500; // must match the `$limit: 500` in reports.service.ts's anomalies()

  function assertAnomalyReportContract(
    label: string,
    payload: { count: number; total: number; truncated: boolean; rows: unknown[] }
  ): void {
    expectEqual(`${label}: anomaly report exposes a total count`, typeof payload.total, 'number');
    expectEqual(`${label}: anomaly report exposes a truncated flag`, typeof payload.truncated, 'boolean');
    expectEqual(`${label}: count matches rows.length`, payload.count, payload.rows.length);
    if (payload.total > ANOMALY_CAP) {
      expectEqual(`${label}: rows are capped at ${ANOMALY_CAP} when over the cap`, payload.rows.length, ANOMALY_CAP);
      expectEqual(`${label}: truncated is true when over the cap`, payload.truncated, true);
    } else {
      expectEqual(`${label}: total matches rows.length when under the cap`, payload.total, payload.rows.length);
      expectEqual(`${label}: truncated is false when under the cap`, payload.truncated, false);
    }
  }

  const report = await request(superadmin, 'GET', '/reports/anomalies');
  expectEqual('superadmin may read the anomaly report', report.status, 200);
  const payload = (report.json.data ?? {}) as {
    count: number;
    total: number;
    truncated: boolean;
    rows: { reason: string; name?: string }[];
  };
  assertAnomalyReportContract('unfiltered report', payload);

  // Prove the under-cap branch is also reachable and correct, not merely
  // assumed: narrow the query window to only the rows this run just wrote
  // (a handful of taps above). That is guaranteed to sit under the cap no
  // matter how much history has piled up in scan_logs from other runs or
  // real traffic, so this exercises the other branch of the contract on
  // every single run. `from` accepts any Date-parseable string (see
  // dateRange.ts's fallback to native parsing for non-"YYYY-MM-DD" input),
  // so an ISO timestamp gives exact-instant filtering rather than day
  // buckets.
  const narrowReport = await request(
    superadmin,
    'GET',
    `/reports/anomalies?from=${encodeURIComponent(anomalyWindowStart.toISOString())}`
  );
  expectEqual('superadmin may read the anomaly report with a narrow window', narrowReport.status, 200);
  const narrowPayload = (narrowReport.json.data ?? {}) as {
    count: number;
    total: number;
    truncated: boolean;
    rows: { reason: string; name?: string }[];
  };
  // A length floor: without it, an empty result would make "total matches
  // rows.length" trivially true (0 === 0) even if the endpoint were broken.
  expectEqual('narrow window actually contains this run\'s anomaly rows', narrowPayload.rows.length >= 2, true);
  expectEqual('narrow window is under the cap (proves the under-cap branch runs)', narrowPayload.total > ANOMALY_CAP, false);
  assertAnomalyReportContract('narrow window (under cap)', narrowPayload);

  const reasons = payload.rows.map((r) => r.reason);
  expectEqual('passbacks appear in the report', reasons.includes('already_inside'), true);
  expectEqual('orphan exits appear in the report', reasons.includes('exit_without_entry'), true);
  expectEqual('report rows resolve the person name', !!payload.rows[0]?.name, true);
  // The $in filter is the entire mechanism of this endpoint. wrong_gate_type
  // rows already exist from the "passback at the gate" section above, so this
  // is a real negative check, not a tautology — an implementation that
  // matched everything (or used $ne: null) would fail it.
  expectEqual(
    'non-anomaly reasons stay out of the report',
    reasons.includes('wrong_gate_type'),
    false
  );

  expectEqual(
    'registrar may not read the anomaly report',
    (await request(registrar, 'GET', '/reports/anomalies')).status,
    403
  );

  // A malformed gate_id must be a clean validation error, not a crash that
  // leaks a raw BSON error message.
  const badGateId = await request(superadmin, 'GET', '/reports/gate-activity?gate_id=bogus');
  expectEqual('a malformed gate_id is a clean 422, not a 500', badGateId.status, 422);

  // Manual overrides are audit events and must be findable in the same report.
  const overrideAt = new Date();
  await tap(superadmin, juanUid, personEntry, 'entry');
  const live = await request(superadmin, 'GET', '/occupancy');
  const liveRows = (live.json.data ?? []) as { _id: string; name: string }[];
  const row = liveRows.find((r) => r.name === juan.full_name);
  await request(superadmin, 'POST', `/occupancy/${row?._id}/clear`, {});

  const afterOverride = await request(superadmin, 'GET', '/reports/anomalies');
  const afterRows = ((afterOverride.json.data ?? {}) as {
    rows: { reason: string; rfid_uid: string; scan_time: string; actor?: string }[];
  }).rows;
  // Match on this run's own row (by UID and timestamp), not just "any
  // manual_override row exists anywhere in the 500-row window" — the earlier
  // roster/override section already produced one of those.
  const overrideRow = afterRows.find(
    (r) =>
      r.reason === 'manual_override' &&
      r.rfid_uid === juanUid &&
      new Date(r.scan_time).getTime() >= overrideAt.getTime()
  );
  expectEqual('this run\'s manual override is auditable', !!overrideRow, true);
  expectEqual(
    'the override row names the acting superadmin',
    overrideRow?.actor,
    'testadmin'
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

  console.log('\n== occupancy rebuild (non-empty path) ==');
  // Everything above this point only ever exercised rebuildOccupancy() with
  // zero entities inside (every test entity gets exited before the next
  // section), so insertMany and its field mapping (state/since/last_gate_id/
  // entity_type/entity_id) had no automated coverage. This block proves the
  // non-empty path end-to-end: a real HTTP entry tap, a full occupancy wipe,
  // a rebuild, and field-level assertions against the reconstructed row.
  await OccupancyModel.deleteMany({ entity_id: juan._id });
  const rebuildEntry = await tap(superadmin, juanUid, personEntry, 'entry');
  expectEqual('rebuild setup: entry granted', rebuildEntry.access_result, 'granted');

  const entryLog = await ScanLogModel.findOne({
    rfid_uid: juanUid,
    direction: 'entry',
    access_result: 'granted',
  })
    .sort({ scan_time: -1 })
    .lean();
  if (!entryLog) throw new Error('expected an entry log row for the rebuild non-empty-path check');

  // Destructive: this wipes the ENTIRE occupancy collection, not just Juan's
  // row. That's fine here — rebuildOccupancy() immediately reconstructs it
  // from scan_logs, the actual source of truth, so nothing is permanently
  // lost. Don't reuse this pattern in a context where scan_logs itself might
  // be incomplete.
  await OccupancyModel.deleteMany({});
  const rebuildResult = await rebuildOccupancy();
  expectEqual('rebuild marks at least one entity inside', rebuildResult.inside >= 1, true);

  const rebuiltRow = await OccupancyModel.findOne({ entity_id: juan._id }).lean();
  expectEqual('rebuilt row exists for the entered person', !!rebuiltRow, true);
  expectEqual('rebuilt row state is inside', rebuiltRow?.state, 'inside');
  expectEqual(
    'rebuilt row since matches the entry log scan_time',
    rebuiltRow?.since?.getTime(),
    entryLog.scan_time.getTime()
  );
  expectEqual(
    'rebuilt row last_gate_id matches the entry gate',
    rebuiltRow?.last_gate_id?.toString(),
    personEntry
  );

  // Release the state so the harness stays re-runnable.
  const rebuildExit = await tap(superadmin, juanUid, personExit, 'exit');
  expectEqual('rebuild teardown: exit granted', rebuildExit.access_result, 'granted');
  await OccupancyModel.deleteMany({ entity_id: juan._id });

  await mongoose.disconnect();
  summary();
}

main().catch((err) => {
  console.error('[verify:passback] failed', err);
  process.exit(1);
});
