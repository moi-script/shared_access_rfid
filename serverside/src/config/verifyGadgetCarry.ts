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
