/**
 * Asserts the per-type vehicle limits and the vehicle-photo pipeline in
 * docs/superpowers/specs/2026-08-05-vehicle-limits-and-photos-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:vehicles
 */
import { installVerifyBypass } from './verifyBypass';
import { VEHICLE_LIMITS } from '../constants/vehicleTypes';

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
  console.log('All vehicle checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;
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

/** Posts a multipart photo. `headers` supplies the credential. */
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

async function main(): Promise<void> {
  // Same seeded superadmin the other harnesses use (see verifyGates.ts:189).
  const superadmin = await login('testadmin', 'Admin@123');

  const stamp = Date.now();
  const suffix = (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  let uidCounter = 0;
  /** Each vehicle needs a distinct 6-32 hex UID; DUPLICATE_RFID would otherwise
   *  mask a limit result and make a passing run meaningless. */
  const nextUid = () => `AB${(uidCounter++).toString(16).toUpperCase().padStart(2, '0')}${suffix}`;

  console.log('\n== throwaway owner ==');
  const ownerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Vehicle-Limit Owner',
    type: 'student',
    id_number: `verify-veh-${stamp}`,
    department_section: 'BSIT 4-A',
    rfid_uid: 'AAAA' + suffix,
  });
  expectEqual('throwaway owner created', ownerRes.status, CREATED);
  const ownerId = idOf(ownerRes.json);
  expectEqual('throwaway owner has an id', ownerId.length > 0, true);

  let vehicleForPhoto = '';
  let vehicleUidForTap = '';

  try {
    console.log('\n== per-type limits ==');
    // van's limit is 3. Registering exactly that many must all succeed.
    expectEqual('van limit is 3 (guards the assertions below)', VEHICLE_LIMITS.van, 3);
    for (let i = 1; i <= VEHICLE_LIMITS.van; i++) {
      const uid = nextUid();
      const res = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `VEH-VAN${i}-${suffix}`,
        rfid_uid: uid,
        vehicle_type: 'van',
        make: 'Toyota',
      });
      expectEqual(`van ${i} of ${VEHICLE_LIMITS.van} accepted`, res.status, CREATED);
      if (i === 1) {
        vehicleForPhoto = idOf(res.json);
        vehicleUidForTap = uid;
      }
    }

    const fourthVan = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VEH-VAN4-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'van',
      make: 'Toyota',
    });
    expectEqual('a fourth van is refused', fourthVan.status, CONFLICT);
    expectEqual(
      'the refusal names the limit',
      String((fourthVan.json as { message?: string }).message ?? '').includes('3 active vans'),
      true
    );

    // A different type has its own allowance, untouched by the vans above.
    const truck = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VEH-TRK1-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'truck',
      make: 'Isuzu',
    });
    expectEqual('a truck is accepted despite three vans', truck.status, CREATED);

    const secondTruck = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VEH-TRK2-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'truck',
      make: 'Isuzu',
    });
    expectEqual('a second truck is refused (limit 1)', secondTruck.status, CONFLICT);

    console.log('\n== deactivating frees a slot ==');
    const deactivate = await request(superadmin, 'PATCH', `/vehicles/${vehicleForPhoto}/status`, {
      status: 'inactive',
    });
    expectEqual('first van deactivated', deactivate.status, OK);

    const replacementVan = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VEH-VAN5-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'van',
      make: 'Nissan',
    });
    expectEqual('another van fits once one is inactive', replacementVan.status, CREATED);

    // Reactivating the deactivated van would put the owner back at four.
    const reactivate = await request(superadmin, 'PATCH', `/vehicles/${vehicleForPhoto}/status`, {
      status: 'active',
    });
    expectEqual('reactivating past the limit is refused', reactivate.status, CONFLICT);

    console.log('\n== vehicle photos ==');
    // The replacement van is active, so it is the one a tap can resolve.
    const tapVehicleId = idOf(replacementVan.json);
    const upload = await uploadPhoto(
      { Authorization: `Bearer ${superadmin}` },
      `/vehicles/${tapVehicleId}/photo`,
      TINY_PNG,
      'vehicle.png',
      'image/png'
    );
    expectEqual('vehicle photo uploaded', upload.status, CREATED);
    expectEqual(
      'photo_url points at the internal route',
      (upload.json.data as { photo_url?: string } | undefined)?.photo_url,
      `/vehicles/${tapVehicleId}/photo`
    );

    const notAnImage = await uploadPhoto(
      { Authorization: `Bearer ${superadmin}` },
      `/vehicles/${tapVehicleId}/photo`,
      Buffer.from('this is not an image', 'utf8'),
      'vehicle.png',
      'image/png'
    );
    expectEqual('a non-image is refused on the bytes', notAnImage.status, VALIDATION);

    console.log('\n== gate reads the photo and the tap carries both ==');
    const gatesRes = await request(superadmin, 'GET', '/gates');
    const gates = (gatesRes.json.data ?? []) as { _id: string; name: string }[];
    const parkingIn = gates.find((g) => g.name === 'Parking Entrance');
    if (!parkingIn) throw new Error('Parking Entrance gate missing — run npm run seed:test');
    const mint = await request(superadmin, 'POST', `/gates/${parkingIn._id}/key`);
    const parkingKey = (mint.json.data as { key?: string } | undefined)?.key ?? '';
    expectEqual('parking key minted', parkingKey.length > 0, true);

    // THE route-ordering check. GET /vehicles/:id/photo must sit above the
    // router-level authorize, or a gate terminal's X-Gate-Key is rejected and
    // the vehicle frame silently renders a placeholder forever.
    const gateFetch = await fetch(`${BASE}/vehicles/${tapVehicleId}/photo`, {
      headers: { 'X-Gate-Key': parkingKey },
    });
    expectEqual('a gate key can read a vehicle photo', gateFetch.status, OK);
    expectEqual('served as an image', gateFetch.headers.get('content-type'), 'image/png');

    // Give the owner a face too, so the tap can be checked for both photos.
    const ownerPhoto = await uploadPhoto(
      { Authorization: `Bearer ${superadmin}` },
      `/persons/${ownerId}/photo`,
      TINY_PNG,
      'owner.png',
      'image/png'
    );
    expectEqual('owner photo uploaded', ownerPhoto.status, CREATED);

    const replacementUid = (replacementVan.json.data as { rfid_uid?: string } | undefined)?.rfid_uid;
    const tapRes = await fetch(`${BASE}/scan/tap`, {
      method: 'POST',
      headers: { 'X-Gate-Key': parkingKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rfid_uid: replacementUid, direction: 'entry' }),
    });
    const tapJson = (await tapRes.json()) as {
      data?: {
        access_result?: string;
        person?: { photo_url?: string; vehicle_photo_url?: string };
      };
    };
    expectEqual('vehicle sticker tap is granted', tapJson.data?.access_result, 'granted');
    // The bug this feature fixed: the sticker path never sent the owner's face.
    expectEqual(
      'the tap carries the OWNER photo',
      typeof tapJson.data?.person?.photo_url,
      'string'
    );
    expectEqual(
      'the tap carries the VEHICLE photo',
      tapJson.data?.person?.vehicle_photo_url,
      `/vehicles/${tapVehicleId}/photo`
    );

    // Keep vehicleUidForTap referenced so an unused-variable lint stays quiet
    // and the first van's UID is visible in the log on a failing run.
    console.log(`  (first van UID was ${vehicleUidForTap})`);

    console.log('\n== list: owner join, search, and deactivation ==');

    // A vehicle of a type with room to spare, so this block never collides
    // with the limit assertions above. pickup's limit is 3.
    const listPlate = `VLIST-${suffix}`;
    const listUid = nextUid();
    const listRes = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: listPlate,
      rfid_uid: listUid,
      vehicle_type: 'pickup',
      make: 'Toyota',
    });
    expectEqual('list fixture created', listRes.status, CREATED);
    const listId = idOf(listRes.json);

    // 1. The owner arrives joined, not as a bare id.
    const listed = await request(superadmin, 'GET', `/vehicles?search=${listPlate}`);
    expectEqual('list responds 200', listed.status, OK);
    const listRows = (listed.json.data ?? []) as Array<{
      plate_number?: string;
      owner_person_id?: { full_name?: string } | string;
    }>;
    expectEqual('search by plate returns exactly one row', listRows.length, 1);
    const joinedOwner = listRows[0]?.owner_person_id;
    expectEqual(
      'owner is populated, not a bare id',
      typeof joinedOwner === 'object' && typeof joinedOwner?.full_name === 'string',
      true
    );
    expectEqual(
      'populated owner is the right person',
      typeof joinedOwner === 'object' ? joinedOwner?.full_name : null,
      'Vehicle-Limit Owner'
    );

    // 2. Search matches the sticker UID too.
    const byUid = await request(superadmin, 'GET', `/vehicles?search=${listUid}`);
    const uidRows = (byUid.json.data ?? []) as Array<{ plate_number?: string }>;
    expectEqual('search by rfid_uid finds the vehicle', uidRows[0]?.plate_number, listPlate);

    // 3. Regex metacharacters are escaped, not executed. Unescaped, the open
    //    paren reaches the driver as an unterminated group and 500s.
    const meta = await request(superadmin, 'GET', '/vehicles?search=' + encodeURIComponent('CAV (88'));
    expectEqual('regex metacharacters do not error', meta.status, OK);

    // 4. Deactivating frees the owner's slot for that type. Fill pickup to its
    //    limit, confirm the next one is refused, deactivate one, confirm it is
    //    then accepted.
    const pickupsToAdd = VEHICLE_LIMITS.pickup - 1; // the fixture above is one
    for (let i = 0; i < pickupsToAdd; i++) {
      const r = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `VFILL${i}-${suffix}`,
        rfid_uid: nextUid(),
        vehicle_type: 'pickup',
      });
      expectEqual(`pickup filler ${i + 1} accepted`, r.status, CREATED);
    }

    const overLimit = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VOVER-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'pickup',
    });
    expectEqual('pickup past the limit is refused', overLimit.status, CONFLICT);

    const deact = await request(superadmin, 'PATCH', `/vehicles/${listId}/status`, {
      status: 'inactive',
    });
    expectEqual('deactivate responds 200', deact.status, OK);

    const afterFree = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: ownerId,
      plate_number: `VFREE-${suffix}`,
      rfid_uid: nextUid(),
      vehicle_type: 'pickup',
    });
    expectEqual('deactivating freed the slot', afterFree.status, CREATED);

    // 5. Reactivating past the limit is refused, and says so in words the UI
    //    can show verbatim.
    const react = await request(superadmin, 'PATCH', `/vehicles/${listId}/status`, {
      status: 'active',
    });
    expectEqual('reactivating past the limit is refused', react.status, CONFLICT);
    expectEqual(
      'the refusal names the limit',
      String(react.json.message ?? '').includes('the limit'),
      true
    );
  } finally {
    // Soft-deletes the person and cascades every owned vehicle to inactive.
    const del = await request(superadmin, 'DELETE', `/persons/${ownerId}`);
    expectEqual('throwaway owner cleaned up', del.status, OK);
  }

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
