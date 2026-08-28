/**
 * Asserts the two halves of person deactivation:
 *
 *   1. A person whose status is not 'active' cannot have a vehicle, a vehicle
 *      application, or a gadget registered to them (assertOwnerRegistrable).
 *   2. The bulk status sweep on /persons/bulk-status is fenced by write
 *      domain, so a registrar's "Deactivate All" never reaches staff and HR's
 *      never reaches students.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:person-status
 *
 * Restores everything it changes: throwaway people are soft-deleted in a
 * `finally`, and any seeded person this harness deactivates is put back to
 * 'active' before it exits.
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
  console.log('All person-status checks passed.');
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

/**
 * Every identifier this harness writes carries the run's timestamp, so a row
 * that survives a crashed run can never collide with the next one.
 */
const RUN = Date.now().toString().slice(-9);
const hex = (n: number) => (RUN + String(n)).slice(-10).padStart(10, '0').toUpperCase();

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');

  let studentId = '';
  let staffId = '';

  try {
    console.log('\n--- setup: a throwaway student and a throwaway staff member');
    const student = await request(superadmin, 'POST', '/persons', {
      full_name: `Status Probe Student ${RUN}`,
      type: 'student',
      id_number: `SP-${RUN}`,
      department_section: `STATUS-PROBE-${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual('throwaway student created', student.status, CREATED);
    studentId = idOf(student.json);

    const staff = await request(superadmin, 'POST', '/persons', {
      full_name: `Status Probe Staff ${RUN}`,
      type: 'staff',
      id_number: `SF-${RUN}`,
      department_section: `STATUS-PROBE-${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual('throwaway staff created', staff.status, CREATED);
    staffId = idOf(staff.json);

    console.log('\n--- an ACTIVE owner can still register (the guard is not a blanket refusal)');
    const okVehicle = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: studentId,
      plate_number: `SPA${RUN}`,
      vehicle_type: 'motorcycle',
      rfid_uid: hex(3),
    });
    expectEqual('active owner may register a vehicle', okVehicle.status, CREATED);

    console.log('\n--- deactivate the student, then try every issue point');
    const off = await request(superadmin, 'PATCH', `/persons/${studentId}/status`, {
      status: 'inactive',
    });
    expectEqual('student deactivated', off.status, OK);

    const vehicle = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: studentId,
      plate_number: `SPB${RUN}`,
      vehicle_type: 'motorcycle',
      rfid_uid: hex(4),
    });
    expectEqual('inactive owner refused a vehicle', vehicle.status, CONFLICT);

    const gadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: studentId,
      gadget_type: 'laptop',
      serial_number: `SPG${RUN}`,
      brand_model: 'Probe',
    });
    expectEqual('inactive owner refused a gadget', gadget.status, CONFLICT);

    const application = await request(superadmin, 'POST', '/vehicle-applications', {
      category: 'new',
      applicant_type: 'student',
      vehicle_type: 'motorcycle',
      owner_person_id: studentId,
      id_number: `SP-${RUN}`,
      school_year: '2026-2027',
      plate_no: `SPC${RUN}`,
      registered_owner_name: `Status Probe Student ${RUN}`,
      rfid_uid: hex(5),
    });
    expectEqual('inactive owner refused a vehicle application', application.status, CONFLICT);
    // The orphan-application failure this guard was placed early to avoid: if
    // the refusal came from the vehicle write instead, the application row
    // would already exist and be unreachable forever.
    const orphans = await request(
      superadmin,
      'GET',
      `/vehicle-applications?owner_person_id=${studentId}&limit=100`
    );
    expectEqual(
      'the refused application wrote no orphan row',
      ((orphans.json.data ?? []) as unknown[]).length,
      0
    );

    console.log('\n--- a PENDING person is refused too (the test is !== active, not === inactive)');
    const pending = await request(superadmin, 'POST', '/persons', {
      full_name: `Status Probe Pending ${RUN}`,
      type: 'student',
      id_number: `SPP-${RUN}`,
      department_section: `STATUS-PROBE-${RUN}`,
    });
    expectEqual('card-less person is created as pending', pending.status, CREATED);
    const pendingId = idOf(pending.json);
    const pendingGadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: pendingId,
      gadget_type: 'laptop',
      serial_number: `SPPG${RUN}`,
      brand_model: 'Probe',
    });
    expectEqual('pending owner refused a gadget', pendingGadget.status, CONFLICT);
    await request(superadmin, 'DELETE', `/persons/${pendingId}`);

    console.log('\n--- reactivating reopens the desk');
    const on = await request(superadmin, 'PATCH', `/persons/${studentId}/status`, {
      status: 'active',
    });
    expectEqual('student reactivated', on.status, OK);
    const afterVehicle = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: studentId,
      gadget_type: 'tablet',
      serial_number: `SPG2${RUN}`,
      brand_model: 'Probe',
    });
    expectEqual('reactivated owner may register again', afterVehicle.status, CREATED);

    console.log('\n--- bulk sweep is fenced by write domain');
    // The section holds one student and one staff member. A registrar holds
    // person:student only, so the staff member must be reported as excluded and
    // must still be active afterwards. This is the check that would catch the
    // worst regression in the feature: a role-blind sweep.
    const section = encodeURIComponent(`STATUS-PROBE-${RUN}`);
    const preview = await request(
      registrar,
      'GET',
      `/persons/bulk-status/preview?section=${section}&status=inactive`
    );
    expectEqual('registrar preview succeeded', preview.status, OK);
    const pv = preview.json.data as { matched?: number; excluded?: number };
    expectEqual('registrar preview matches only the student', pv?.matched, 1);
    expectEqual('registrar preview excludes the staff member', pv?.excluded, 1);

    const sweep = await request(registrar, 'POST', '/persons/bulk-status', {
      status: 'inactive',
      filter: { section: `STATUS-PROBE-${RUN}` },
    });
    expectEqual('registrar sweep succeeded', sweep.status, OK);
    const sw = sweep.json.data as { matched?: number; modified?: number; excluded?: number };
    expectEqual('sweep modified exactly the student', sw?.modified, 1);
    expectEqual('sweep excluded exactly the staff member', sw?.excluded, 1);

    const staffAfter = await request(superadmin, 'GET', `/persons/${staffId}`);
    expectEqual(
      "registrar's sweep left the staff member active",
      (staffAfter.json.data as { status?: string })?.status,
      'active'
    );
    const studentAfter = await request(superadmin, 'GET', `/persons/${studentId}`);
    expectEqual(
      "registrar's sweep deactivated the student",
      (studentAfter.json.data as { status?: string })?.status,
      'inactive'
    );

    console.log('\n--- a repeated sweep matches the same rows but modifies none');
    const again = await request(registrar, 'POST', '/persons/bulk-status', {
      status: 'inactive',
      filter: { section: `STATUS-PROBE-${RUN}` },
    });
    const ag = again.json.data as { matched?: number; modified?: number };
    expectEqual('repeat sweep still matches the student', ag?.matched, 1);
    expectEqual('repeat sweep modifies nothing', ag?.modified, 0);

    console.log('\n--- last_activated_at records activations, and only activations');
    // Registering WITH a card creates the person 'active', so the very first
    // activation is the registration itself and the column is never blank for
    // someone created through the desk.
    const staffRow = await request(superadmin, 'GET', `/persons/${staffId}`);
    const atCreation = (staffRow.json.data as { last_activated_at?: string })?.last_activated_at;
    expectEqual('a person registered with a card has an activation date', Boolean(atCreation), true);

    // The student is currently inactive (the sweep above). Reactivate and the
    // date must move forward off its registration value.
    await request(superadmin, 'PATCH', `/persons/${studentId}/status`, { status: 'active' });
    const reactivated = await request(superadmin, 'GET', `/persons/${studentId}`);
    const firstDate = (reactivated.json.data as { last_activated_at?: string })?.last_activated_at;
    expectEqual('reactivation records a date', Boolean(firstDate), true);

    // The check that matters most: re-sending 'active' to an already-active
    // person must NOT move the date, or the column stops meaning "activated
    // on" and starts meaning "last touched" — which is what updatedAt already
    // (uselessly) says.
    await request(superadmin, 'PATCH', `/persons/${studentId}/status`, { status: 'active' });
    const noop = await request(superadmin, 'GET', `/persons/${studentId}`);
    expectEqual(
      're-activating an already-active person does not move the date',
      (noop.json.data as { last_activated_at?: string })?.last_activated_at,
      firstDate
    );

    // An unrelated edit must not move it either — the whole reason this is a
    // dedicated field rather than a read of updatedAt.
    await request(superadmin, 'PATCH', `/persons/${studentId}`, {
      department_section: `STATUS-PROBE-${RUN}`,
      full_name: `Status Probe Student ${RUN} Renamed`,
    });
    const renamed = await request(superadmin, 'GET', `/persons/${studentId}`);
    expectEqual(
      'an unrelated edit does not move the activation date',
      (renamed.json.data as { last_activated_at?: string })?.last_activated_at,
      firstDate
    );

    // And the bulk path stamps it too.
    await request(superadmin, 'PATCH', `/persons/${studentId}/status`, { status: 'inactive' });
    await request(registrar, 'POST', '/persons/bulk-status', {
      status: 'active',
      filter: { section: `STATUS-PROBE-${RUN}` },
    });
    const swept = await request(superadmin, 'GET', `/persons/${studentId}`);
    const sweptDate = (swept.json.data as { last_activated_at?: string })?.last_activated_at;
    expectEqual('the bulk sweep records an activation date', Boolean(sweptDate), true);
    expectEqual('the bulk sweep moved the date forward', sweptDate !== firstDate, true);

    console.log('\n--- the export carries status and the activation date');
    const csv = await fetch(
      `${BASE}/persons/export?section=${encodeURIComponent(`STATUS-PROBE-${RUN}`)}`,
      { headers: { Authorization: `Bearer ${superadmin}` } }
    );
    expectEqual('export responded', csv.status, OK);
    const text = await csv.text();
    const [header, ...dataLines] = text.trim().split('\n');
    expectEqual(
      'header ends with the two new columns',
      header.trim().endsWith('status,last_activated_at'),
      true
    );
    expectEqual('export returned both probe people', dataLines.length, 2);
    const studentLine = dataLines.find((l) => l.includes(`SP-${RUN}`)) ?? '';
    expectEqual('the exported row carries the status', studentLine.includes('active'), true);
    expectEqual(
      'the exported row carries an ISO activation date',
      /,\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/.test(studentLine),
      true
    );
  } finally {
    console.log('\n--- cleanup');
    for (const id of [studentId, staffId]) {
      if (!id) continue;
      const del = await request(superadmin, 'DELETE', `/persons/${id}`);
      expectEqual(`throwaway person ${id} cleaned up`, del.status, OK);
    }
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
