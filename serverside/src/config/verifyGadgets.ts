/**
 * Asserts the gadget registry in
 * docs/superpowers/specs/2026-08-05-gadget-registry-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gadgets
 *
 * Restores everything it changes: the throwaway owner is soft-deleted in a
 * `finally`, and the seeded laptop is left exactly as found.
 */
import { installVerifyBypass } from './verifyBypass';
import { GADGET_LIMITS } from '../constants/gadgetTypes';

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
  console.log('All gadget checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const VALIDATION = 422;

/** A real 1x1 transparent PNG, so uploads exercise the same path a browser would. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

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

async function uploadPhoto(
  headers: Record<string, string>,
  path: string,
  bytes: Buffer,
  filename: string,
  declaredMime: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append('photo', new Blob([bytes as unknown as BlobPart], { type: declaredMime }), filename);
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: form });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  return { status: res.status, json };
}

function idOf(json: Record<string, unknown>): string {
  const data = json.data as { _id?: string; id?: string } | undefined;
  return String(data?._id ?? data?.id ?? '');
}

interface TapGadget {
  gadget_type?: string;
  brand_model?: string;
  serial_number?: string;
}

interface TapData {
  access_result?: string;
  reason?: string | null;
  person?: { full_name?: string; gadgets?: TapGadget[] };
}

/** Taps a UID at a gate using that gate's device key. */
async function tap(
  gateKey: string,
  rfid_uid: string,
  direction: 'entry' | 'exit'
): Promise<TapData> {
  const res = await fetch(`${BASE}/scan/tap`, {
    method: 'POST',
    headers: { 'X-Gate-Key': gateKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfid_uid, direction }),
  });
  const json = (await res.json()) as { data?: TapData };
  return json.data ?? {};
}

async function countScanLogs(token: string): Promise<number> {
  const res = await request(token, 'GET', '/scan/logs?limit=1');
  const meta = res.json.meta as { pagination?: { total?: number } } | undefined;
  return meta?.pagination?.total ?? -1;
}

async function main(): Promise<void> {
  // Same seeded accounts the other harnesses use (see verifyGates.ts:189).
  const superadmin = await login('testadmin', 'Admin@123');
  const oss = await login('testoss', 'Oss@12345');
  const registrar = await login('testregistrar', 'Registrar@123');
  const hr = await login('testhr', 'Hr@12345');

  const stamp = Date.now();
  const suffix = (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  console.log('\n== throwaway owner ==');
  const ownerUid = `CAFE${suffix}`;
  const ownerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Gadget Owner',
    type: 'student',
    id_number: `verify-gad-${stamp}`,
    department_section: 'BSIT 4-B',
    rfid_uid: ownerUid,
  });
  expectEqual('throwaway owner created', ownerRes.status, CREATED);
  const ownerId = idOf(ownerRes.json);
  expectEqual('throwaway owner has an id', ownerId.length > 0, true);

  try {
    console.log('\n== permission matrix ==');
    // A 401 anywhere here is a failure, not a denial: it would mean the route
    // is unreachable rather than refused, and every assertion below it would be
    // passing for the wrong reason.
    const ossCreate = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Lenovo ThinkPad T14',
      serial_number: `PF-${suffix}-A`,
    });
    expectEqual('oss may register a laptop', ossCreate.status, CREATED);
    const gadgetId = idOf(ossCreate.json);
    expectEqual('the created gadget has an id', gadgetId.length > 0, true);

    const registrarCreate = await request(registrar, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Acer Aspire 5',
      serial_number: `PF-${suffix}-REG`,
    });
    expectEqual('registrar may NOT register a laptop', registrarCreate.status, FORBIDDEN);

    const hrCreate = await request(hr, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Asus VivoBook',
      serial_number: `PF-${suffix}-HR`,
    });
    expectEqual('hr may NOT register a laptop', hrCreate.status, FORBIDDEN);

    const registrarRead = await request(registrar, 'GET', '/gadgets');
    expectEqual('registrar MAY read the gadget list', registrarRead.status, OK);
    const hrRead = await request(hr, 'GET', '/gadgets');
    expectEqual('hr MAY read the gadget list', hrRead.status, OK);

    console.log('\n== serial uniqueness and normalization ==');
    const dupExact = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Lenovo ThinkPad T14',
      serial_number: `PF-${suffix}-A`,
    });
    expectEqual('an identical serial is refused', dupExact.status, CONFLICT);

    // The two cases that make the unique index worth having. Without them the
    // assertion above passes on a plain index and pins nothing: a stolen laptop
    // would be re-registered to a second owner by retyping its serial in a
    // different case.
    const dupCase = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Lenovo ThinkPad T14',
      serial_number: `pf-${suffix.toLowerCase()}-a`,
    });
    expectEqual('a lowercase variant of the same serial is refused', dupCase.status, CONFLICT);

    const dupSpace = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'Lenovo ThinkPad T14',
      serial_number: `  PF-${suffix}-A  `,
    });
    expectEqual('a whitespace-padded variant is refused', dupSpace.status, CONFLICT);

    const stored = await request(oss, 'GET', `/gadgets/${gadgetId}`);
    expectEqual(
      'the stored serial is normalized to uppercase',
      (stored.json.data as { serial_number?: string } | undefined)?.serial_number,
      `PF-${suffix}-A`
    );

    console.log('\n== per-person allowance ==');
    expectEqual('the laptop limit is 1 (guards the assertions below)', GADGET_LIMITS.laptop, 1);
    const second = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'HP ProBook 450',
      serial_number: `PF-${suffix}-B`,
    });
    expectEqual('a second active laptop is refused', second.status, CONFLICT);
    expectEqual(
      'the refusal names the limit',
      String((second.json as { message?: string }).message ?? '').includes('1 active laptop'),
      true
    );

    const deactivate = await request(oss, 'PATCH', `/gadgets/${gadgetId}/status`, {
      status: 'inactive',
    });
    expectEqual('the first laptop is deactivated', deactivate.status, OK);

    const replacement = await request(oss, 'POST', '/gadgets', {
      owner_person_id: ownerId,
      gadget_type: 'laptop',
      brand_model: 'HP ProBook 450',
      serial_number: `PF-${suffix}-B`,
    });
    expectEqual('another laptop fits once the first is inactive', replacement.status, CREATED);
    const replacementId = idOf(replacement.json);

    const reactivate = await request(oss, 'PATCH', `/gadgets/${gadgetId}/status`, {
      status: 'active',
    });
    expectEqual('reactivating past the limit is refused', reactivate.status, CONFLICT);

    console.log('\n== a gadget cannot change hands ==');
    const otherOwner = await request(superadmin, 'POST', '/persons', {
      full_name: 'Gadget Thief',
      type: 'student',
      id_number: `verify-gad2-${stamp}`,
      department_section: 'BSIT 4-B',
      rfid_uid: `BEEF${suffix}`,
    });
    expectEqual('second throwaway person created', otherOwner.status, CREATED);
    const otherOwnerId = idOf(otherOwner.json);

    const transfer = await request(oss, 'PATCH', `/gadgets/${replacementId}`, {
      owner_person_id: otherOwnerId,
    });
    // Refused, not silently stripped. A 200 here would mean the caller believes
    // a transfer happened while the row never moved.
    expectEqual('a transfer attempt is refused outright', transfer.status, VALIDATION);
    const afterTransfer = await request(oss, 'GET', `/gadgets/${replacementId}`);
    expectEqual(
      'the owner is unchanged after the refused transfer',
      String((afterTransfer.json.data as { owner_person_id?: string } | undefined)?.owner_person_id ?? ''),
      ownerId
    );
    await request(superadmin, 'DELETE', `/persons/${otherOwnerId}`);

    console.log('\n== unknown owner ==');
    const orphan = await request(oss, 'POST', '/gadgets', {
      owner_person_id: '000000000000000000000000',
      gadget_type: 'laptop',
      brand_model: 'Ghost Book',
      serial_number: `PF-${suffix}-GHOST`,
    });
    expectEqual('a laptop for a non-existent owner is refused', orphan.status, NOT_FOUND);

    console.log('\n== photo pipeline ==');
    const upload = await uploadPhoto(
      { Authorization: `Bearer ${oss}` },
      `/gadgets/${replacementId}/photo`,
      TINY_PNG,
      'laptop.png',
      'image/png'
    );
    expectEqual('gadget photo uploaded', upload.status, CREATED);
    expectEqual(
      'photo_url points at the internal route',
      (upload.json.data as { photo_url?: string } | undefined)?.photo_url,
      `/gadgets/${replacementId}/photo`
    );

    const notAnImage = await uploadPhoto(
      { Authorization: `Bearer ${oss}` },
      `/gadgets/${replacementId}/photo`,
      Buffer.from('this is not an image', 'utf8'),
      'laptop.png',
      'image/png'
    );
    expectEqual('a non-image is refused on the bytes', notAnImage.status, VALIDATION);

    console.log('\n== gate display ==');
    const gatesRes = await request(superadmin, 'GET', '/gates');
    const gates = (gatesRes.json.data ?? []) as { _id: string; name: string }[];
    const mainIn = gates.find((g) => g.name === 'Main Entrance');
    const sideOut = gates.find((g) => g.name === 'Side Gate');
    const parkingIn = gates.find((g) => g.name === 'Parking Entrance');
    if (!mainIn || !sideOut || !parkingIn) {
      throw new Error('seeded gates missing — run npm run seed:test');
    }
    const keyFor = async (gateId: string): Promise<string> => {
      const mint = await request(superadmin, 'POST', `/gates/${gateId}/key`);
      return (mint.json.data as { key?: string } | undefined)?.key ?? '';
    };
    const mainKey = await keyFor(mainIn._id);
    const sideKey = await keyFor(sideOut._id);
    const parkingKey = await keyFor(parkingIn._id);
    expectEqual('gate keys minted', mainKey.length > 0 && sideKey.length > 0, true);

    // THE route-ordering check, mirroring verifyVehicles: GET /gadgets/:id/photo
    // must sit above the router-level authorize, or a terminal's X-Gate-Key is
    // rejected and the frame silently renders a placeholder forever.
    const gateFetch = await fetch(`${BASE}/gadgets/${replacementId}/photo`, {
      headers: { 'X-Gate-Key': mainKey },
    });
    expectEqual('a gate key can read a gadget photo', gateFetch.status, OK);
    expectEqual('served as an image', gateFetch.headers.get('content-type'), 'image/png');

    const scanLogsBefore = await countScanLogs(superadmin);
    expectEqual('scan log total is readable', scanLogsBefore >= 0, true);

    const entry = await tap(mainKey, ownerUid, 'entry');
    expectEqual('the owner card is granted at a person gate', entry.access_result, 'granted');
    // Length floor first: `.every()` and `[0]` on an empty array would both let
    // a missing list pass as success. Two defects in Subsystem A came from
    // exactly that.
    expectEqual('the tap carries one registered laptop', entry.person?.gadgets?.length, 1);
    const shown = entry.person?.gadgets?.[0];
    expectEqual('the laptop type is shown', shown?.gadget_type, 'laptop');
    expectEqual('the brand and model are shown', shown?.brand_model, 'HP ProBook 450');
    expectEqual('the serial is shown', shown?.serial_number, `PF-${suffix}-B`);

    // The deactivated first laptop must NOT appear: a revoked registration that
    // still displays would tell a guard the opposite of the truth.
    const serials = (entry.person?.gadgets ?? []).map((g) => g.serial_number);
    expectEqual(
      'the deactivated laptop is not shown',
      serials.includes(`PF-${suffix}-A`),
      false
    );

    const scanLogsAfterEntry = await countScanLogs(superadmin);
    expectEqual(
      'the tap wrote exactly one scan log',
      scanLogsAfterEntry - scanLogsBefore,
      1
    );

    console.log('\n== withheld on denial ==');
    // Exit first, so the card is outside again and the denial below is caused
    // by the deactivation rather than by anti-passback.
    const exit = await tap(sideKey, ownerUid, 'exit');
    expectEqual('the owner card is granted on the way out', exit.access_result, 'granted');
    expectEqual('the exit tap also carries the laptop', exit.person?.gadgets?.length, 1);

    const suspend = await request(superadmin, 'PATCH', `/persons/${ownerId}/status`, {
      status: 'inactive',
    });
    expectEqual('the owner is deactivated', suspend.status, OK);

    const denied = await tap(mainKey, ownerUid, 'entry');
    expectEqual('a deactivated card is denied', denied.access_result, 'denied');
    expectEqual('the denial reason is inactive_id', denied.reason, 'inactive_id');
    // The important one. A denied tap is the case most likely to involve
    // someone holding a card that is not theirs; handing them the cardholder's
    // laptop serials would invert the whole point of the feature.
    expectEqual('a denied tap carries NO gadget list', denied.person?.gadgets, undefined);

    const reinstate = await request(superadmin, 'PATCH', `/persons/${ownerId}/status`, {
      status: 'active',
    });
    expectEqual('the owner is reinstated', reinstate.status, OK);

    console.log('\n== vehicle gates do not prompt for a laptop ==');
    // The owner card at a vehicle gate takes the single-card path, which sets
    // entity_type = 'vehicle'. This owner has no vehicle, so it is denied — and
    // either way the gadget block must not fire.
    const atParking = await tap(parkingKey, ownerUid, 'entry');
    expectEqual('no gadget list at a vehicle gate', atParking.person?.gadgets, undefined);
    console.log('\n== registered devices appear on the owner\'s overview ==');
    const owner = await request(superadmin, 'GET', '/persons?search=2025-0001');
    const ownerRows = (owner.json.data ?? []) as { _id: string }[];
    expectEqual('seeded student found', ownerRows.length > 0, true);
    const seededOwnerId = ownerRows[0]?._id;

    const overview = await request(superadmin, 'GET', `/persons/${seededOwnerId}/overview`);
    expectEqual('overview -> 200', overview.status, OK);
    const gadgetsOnOverview = ((overview.json.data as Record<string, unknown>)?.gadgets ?? []) as {
      serial_number?: string;
      brand_model?: string;
      status?: string;
    }[];
    expectEqual('overview includes gadgets', Array.isArray(gadgetsOnOverview), true);
    expectEqual(
      'seeded laptop is listed',
      gadgetsOnOverview.some((g) => g.serial_number === '5CD1234ABC'),
      true
    );
    expectEqual(
      'listed device carries its model',
      gadgetsOnOverview.find((g) => g.serial_number === '5CD1234ABC')?.brand_model,
      'Dell Latitude 5420'
    );

    // --- the student sees their own devices on their own dashboard ---
    const studentToken = await login('2025-0001', 'Student@123');
    const dash = await request(studentToken, 'GET', '/dashboard');
    const myGadgets = ((dash.json.data as Record<string, unknown>)?.gadgets ?? []) as {
      serial_number?: string;
    }[];
    expectEqual(
      'student dashboard lists their own device',
      myGadgets.some((g) => g.serial_number === '5CD1234ABC'),
      true
    );
  } finally {
    // Soft-deletes the person and cascades every registered gadget to inactive,
    // the same way it cascades vehicles. The gadget rows themselves survive, by
    // design — they are history. Every serial this harness writes carries the
    // run's timestamp, so a surviving row can never collide with the next run.
    const del = await request(superadmin, 'DELETE', `/persons/${ownerId}`);
    expectEqual('throwaway owner cleaned up', del.status, OK);
    const after = await request(superadmin, 'GET', `/gadgets?owner_person_id=${ownerId}&limit=100`);
    const rows = (after.json.data ?? []) as { status?: string }[];
    expectEqual('the owner had gadget rows to cascade', rows.length > 0, true);
    expectEqual(
      'deleting the owner deactivated every one of their gadgets',
      rows.every((r) => r.status === 'inactive'),
      true
    );
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
