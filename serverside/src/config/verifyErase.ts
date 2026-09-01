/**
 * Asserts what erasing a person does, and — more importantly — what it
 * refuses to do.
 *
 * Erase is the one destructive path that now runs in production, so the
 * checks here are the guard rails:
 *
 *   1. Only a superadmin can reach it.
 *   2. The person, their vehicles, gadgets and login are gone for good.
 *   3. Their occupancy row goes with them — live state, or the inside-count
 *      is wrong forever.
 *   4. Their scan history does NOT go with them, and still reads with a name
 *      via the erasedPersons tombstone.
 *   5. The physical card is genuinely free: it re-registers to somebody else.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:erase
 *
 * Cleans up after itself: whatever it creates is erased again in a `finally`,
 * including the second person that inherits the freed card.
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
  console.log('All erase checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

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

/** Every identifier carries the run's timestamp, so a crashed run never collides with the next. */
const RUN = Date.now().toString().slice(-9);
const hex = (n: number) => (RUN + String(n)).slice(-10).padStart(10, '0').toUpperCase();

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');

  const personName = `Erase Probe ${RUN}`;
  let personId = '';
  let heirId = '';

  try {
    console.log('\n--- setup: a person holding a card, a vehicle and a gadget');
    const person = await request(superadmin, 'POST', '/persons', {
      full_name: personName,
      type: 'student',
      id_number: `EP-${RUN}`,
      department_section: `ERASE-PROBE-${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual('probe person created', person.status, CREATED);
    personId = idOf(person.json);

    // The rfid_uid sent here is required by createVehicleSchema and then
    // discarded: a vehicle pass carries the OWNER's card (ownerCardUid in
    // vehicles.service.ts), so the row stores hex(1) whatever is posted. It
    // is sent as hex(1) to match what actually gets stored. That sharing is
    // why the erase below frees two UIDs, not three.
    const vehicle = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: personId,
      plate_number: `EPV${RUN}`,
      vehicle_type: 'motorcycle',
      rfid_uid: hex(1),
    });
    expectEqual('probe vehicle created', vehicle.status, CREATED);

    const gadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: personId,
      gadget_type: 'laptop',
      brand_model: 'Erase Probe Laptop',
      serial_number: `EPG${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual('probe gadget created', gadget.status, CREATED);

    console.log('\n--- the person taps in, so there is history AND live state to test');
    const gates = await request(superadmin, 'GET', '/gates');
    const gateRows = (gates.json.data ?? []) as { _id: string; name: string }[];
    const mainGate = gateRows.find((g) => g.name === 'Main Entrance');
    expectEqual('Main Entrance gate exists (run npm run seed)', Boolean(mainGate), true);

    const tap = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1),
      gate_id: mainGate!._id,
      direction: 'entry',
    });
    expectEqual('probe person tapped in', tap.status, OK);

    const rosterBefore = await request(superadmin, 'GET', '/occupancy?limit=200');
    const insideBefore = ((rosterBefore.json.data ?? []) as { name?: string }[]).filter(
      (r) => r.name === personName
    ).length;
    expectEqual('probe person is on the inside roster before erasing', insideBefore, 1);

    console.log('\n--- a registrar cannot erase, however destructive the button looks');
    const denied = await request(registrar, 'DELETE', `/persons/${personId}/erase`);
    expectEqual('registrar is refused', denied.status, FORBIDDEN);

    const stillThere = await request(superadmin, 'GET', `/persons/${personId}`);
    expectEqual('refused erase changed nothing', stillThere.status, OK);

    console.log('\n--- superadmin erases');
    const erased = await request(superadmin, 'DELETE', `/persons/${personId}/erase`);
    expectEqual('erase succeeded', erased.status, OK);
    const result = erased.json.data as {
      erased?: boolean;
      vehiclesDeleted?: number;
      gadgetsDeleted?: number;
      cardsFreed?: string[];
    };
    expectEqual('erase reports itself done', result?.erased, true);
    expectEqual('one vehicle deleted', result?.vehiclesDeleted, 1);
    expectEqual('one gadget deleted', result?.gadgetsDeleted, 1);
    // Two, not three: the vehicle rides on the owner's card. See the setup.
    expectEqual('both distinct cards reported freed', result?.cardsFreed?.length, 2);

    console.log('\n--- what must be gone');
    const gone = await request(superadmin, 'GET', `/persons/${personId}`);
    expectEqual('the person is gone', gone.status, NOT_FOUND);

    const vehiclesLeft = await request(
      superadmin,
      'GET',
      `/vehicles?owner_person_id=${personId}&limit=1`
    );
    expectEqual(
      'no vehicle survives',
      (vehiclesLeft.json.meta as { pagination?: { total?: number } })?.pagination?.total ?? 0,
      0
    );

    const gadgetsLeft = await request(
      superadmin,
      'GET',
      `/gadgets?owner_person_id=${personId}&limit=1`
    );
    expectEqual(
      'no gadget survives',
      (gadgetsLeft.json.meta as { pagination?: { total?: number } })?.pagination?.total ?? 0,
      0
    );

    // The whole reason occupancy is deleted rather than left: nothing can ever
    // release a row whose card now belongs to someone else.
    const rosterAfter = await request(superadmin, 'GET', '/occupancy?limit=200');
    const insideAfter = ((rosterAfter.json.data ?? []) as { name?: string | null }[]).filter(
      (r) => r.name === personName
    ).length;
    expectEqual('the inside roster no longer holds them', insideAfter, 0);

    console.log('\n--- what must survive');
    const dash = await request(superadmin, 'GET', '/dashboard');
    const recent = (dash.json.data as { recent_scans?: { rfid_uid?: string; name?: string }[] })
      ?.recent_scans;
    const theirTap = (recent ?? []).find((r) => r.rfid_uid === hex(1));
    expectEqual('their tap is still in the scan history', Boolean(theirTap), true);
    expectEqual('and it still carries their name, marked erased', theirTap?.name, `${personName} (erased)`);

    console.log('\n--- the card is genuinely free, not merely unassigned');
    const heir = await request(superadmin, 'POST', '/persons', {
      full_name: `Erase Probe Heir ${RUN}`,
      type: 'student',
      id_number: `EH-${RUN}`,
      department_section: `ERASE-PROBE-${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual('the freed card re-registers to somebody else', heir.status, CREATED);
    heirId = idOf(heir.json);
  } finally {
    for (const id of [personId, heirId].filter(Boolean)) {
      await request(superadmin, 'DELETE', `/persons/${id}/erase`);
    }
    summary();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
