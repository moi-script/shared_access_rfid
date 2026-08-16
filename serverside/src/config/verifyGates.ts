/**
 * Asserts the photo pipeline and gate terminal behavior in
 * docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gates
 */
import { detectImageType } from '../utils/imageType';
// HISTORICAL NOTE, no longer load-bearing: this import used to need to come
// BEFORE installVerifyBypass(), because db.ts pulls in config/env.ts, whose
// top-level dotenv.config() call populates process.env.VERIFY_BYPASS_TOKEN
// from .env, and verifyBypass.ts used to read that var from process.env at
// ITS OWN module-evaluation time (a one-shot top-level const, not a lazy
// read) — so importing it out of this order would silently leave the token
// unset and run this file under the real rate limits regardless of .env.
// installVerifyBypass() now reads process.env.VERIFY_BYPASS_TOKEN lazily,
// inside the function, at call time — so the token is picked up correctly
// however these imports are ordered. The order below is kept as-is (and this
// note kept, rather than deleted) because it records the real defect this
// file once had; a future "organize imports" pass can no longer reintroduce
// it.
import { connectDB, disconnectDB } from './db';
import { installVerifyBypass } from './verifyBypass';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { PersonModel } from '../modules/persons/persons.model';

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
  console.log('All gate and photo checks passed.');
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);
const TEXT = Buffer.from('this is not an image at all, not even close');

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

// Must match scanService.dateKey(), which buckets attendance by the SERVER'S
// LOCAL calendar date. toISOString() would give the UTC date, which differs
// from the local date for part of every day in any non-UTC timezone and makes
// this assertion fail by the clock rather than by behavior.
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

/**
 * Looks up a seeded Person by exact `id_number`, using the `?search=` param
 * (personService.list matches it against full_name and id_number) instead of
 * fetching a page and scanning it. GET /persons caps `limit` at 100
 * server-side (see utils/pagination.ts) with no way to raise it, so a
 * page-1-only fetch silently reports "not found" for a real row sitting past
 * page 1 once the collection grows — that is exactly what broke this script
 * against an un-cleaned-up verify:roles run ("seeded person 2025-0001 not
 * found" when the person existed, just off-page). `search` is a substring
 * match, not exact, so results still need an exact-match filter afterward.
 */
async function findPersonByIdNumber(
  token: string,
  idNumber: string
): Promise<{ _id: string; id_number: string }> {
  const res = await request(token, 'GET', `/persons?search=${encodeURIComponent(idNumber)}&limit=100`);
  const candidates = (res.json.data ?? []) as { _id: string; id_number: string }[];
  const match = candidates.find((p) => p.id_number === idNumber);
  if (!match) {
    throw new Error(
      `seeded person not found: searched /persons?search=${idNumber} for an exact id_number match ` +
        `(${candidates.length} candidate(s) returned) — run npm run seed:test`
    );
  }
  return match;
}

/** Posts a multipart photo. `headers` supplies the credential (Bearer or X-Gate-Key). */
async function uploadPhoto(
  headers: Record<string, string>,
  personId: string,
  bytes: Buffer,
  filename: string,
  declaredMime: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append('photo', new Blob([bytes as unknown as BlobPart], { type: declaredMime }), filename);
  const res = await fetch(`${BASE}/persons/${personId}/photo`, {
    method: 'POST',
    headers,
    body: form,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  return { status: res.status, json };
}

/** A real 1x1 JPEG, so uploads exercise the same path a browser would. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

async function runChecks(): Promise<void> {
  console.log('\n== magic-byte detection ==');
  expectEqual('jpeg detected', detectImageType(JPEG), 'image/jpeg');
  expectEqual('png detected', detectImageType(PNG), 'image/png');
  expectEqual('webp detected', detectImageType(WEBP), 'image/webp');
  expectEqual('text rejected', detectImageType(TEXT), null);
  expectEqual('empty buffer rejected', detectImageType(Buffer.alloc(0)), null);
  expectEqual('truncated jpeg rejected', detectImageType(Buffer.from([0xff, 0xd8])), null);
  // The real boundary: exactly matches the 3-byte JPEG magic but is too short
  // for a marker byte, which is what the `buf.length >= 4` guard exists for.
  // The 2-byte case above never reaches that guard's branch at all.
  expectEqual(
    'jpeg magic with no marker byte rejected',
    detectImageType(Buffer.from([0xff, 0xd8, 0xff])),
    null
  );

  const superadmin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const student = await login('2025-0001', 'Student@123');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Juan Dela Cruz — seeded by seed:test.
  const juan = await findPersonByIdNumber(superadmin, '2025-0001');
  const personId = juan._id;

  console.log('\n== photo upload validation ==');

  const notAnImage = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.from('definitely not an image, but I claim to be a jpeg'),
    'evil.jpg',
    'image/jpeg'
  );
  expectEqual('non-image with jpeg mime rejected', notAnImage.status, 422);

  const tooBig = await uploadPhoto(
    auth(registrar),
    personId,
    Buffer.concat([TINY_JPEG, Buffer.alloc(1_100_000, 0x20)]),
    'huge.jpg',
    'image/jpeg'
  );
  expectEqual('over-1MB upload rejected', tooBig.status, 413);

  console.log('\n== photo upload, serve, replace ==');

  const first = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'a.jpg', 'image/jpeg');
  expectEqual('registrar can upload', first.status, 201);
  expectEqual(
    'photo_url points at the internal route',
    (first.json.data as { photo_url?: string } | undefined)?.photo_url,
    `/persons/${personId}/photo`
  );

  const second = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'b.jpg', 'image/jpeg');
  expectEqual('re-upload replaces rather than erroring', second.status, 201);

  // The delete at the end of this block proves the re-upload replaced rather
  // than duplicated: if two documents existed, deleteOne would leave one behind
  // and the final 404 assertion would fail.
  const asStudent = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(student),
  });
  expectEqual('any authenticated user may fetch a photo', asStudent.status, 200);
  expectEqual(
    'photo served as image/jpeg',
    asStudent.headers.get('content-type'),
    'image/jpeg'
  );
  expectEqual(
    'photo served with nosniff',
    asStudent.headers.get('x-content-type-options'),
    'nosniff'
  );

  const noCred = await fetch(`${BASE}/persons/${personId}/photo`);
  expectEqual('photo requires a credential', noCred.status, 401);

  console.log('\n== photo ownership ==');

  const maria = await findPersonByIdNumber(superadmin, '2025-0002');
  // Presence floor: without this, every assertion below would compare
  // undefined to undefined and pass vacuously. findPersonByIdNumber already
  // throws (with a clear "what was searched for" message) rather than
  // returning undefined, so this is now a belt-and-braces check.
  expectEqual('second seeded person found', !!maria, true);
  const otherId = maria?._id ?? '';

  // Maria has no photo from any earlier step, so give her one. Without this,
  // "student refused another person's photo" below would return 404 simply
  // because there is nothing to fetch, regardless of any ownership check —
  // that is exactly what made the original version of this assertion vacuous.
  const mariaUpload = await uploadPhoto(auth(registrar), otherId, TINY_JPEG, 'maria.jpg', 'image/jpeg');
  expectEqual('registrar can upload a photo for the second person', mariaUpload.status, 201);

  // 2025-0001 is Juan; the student token belongs to Juan.
  const ownPhoto = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(student),
  });
  expectEqual('student may fetch their own photo', ownPhoto.status, 200);

  // Proves the photo exists right now, so the student's refusal just below
  // can only be attributable to the ownership rule, not to a missing photo.
  const registrarOthers = await fetch(`${BASE}/persons/${otherId}/photo`, {
    headers: auth(registrar),
  });
  expectEqual("registrar may fetch the second person's photo", registrarOthers.status, 200);

  const othersPhoto = await fetch(`${BASE}/persons/${otherId}/photo`, {
    headers: auth(student),
  });
  // 404 not 403: a 403 would confirm the photo exists and let an
  // unauthorized caller enumerate which ids have photos.
  expectEqual('student refused another person\'s photo', othersPhoto.status, 404);

  const registrarAny = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(registrar),
  });
  expectEqual('registrar may fetch any photo', registrarAny.status, 200);

  const superadminAny = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: auth(superadmin),
  });
  expectEqual('superadmin may fetch any photo', superadminAny.status, 200);

  console.log('\n== profile carries photo_url ==');
  const overview = await request(superadmin, 'GET', `/persons/${personId}/overview`);
  const overviewPerson = (overview.json.data as { person?: { photo_url?: string | null } } | undefined)
    ?.person;
  // Presence floor before comparing, so a missing person object cannot make
  // the field assertion pass vacuously.
  expectEqual('overview returns a person', !!overviewPerson, true);
  expectEqual(
    'overview carries the internal photo_url',
    overviewPerson?.photo_url,
    `/persons/${personId}/photo`
  );

  // Clean up what this run added. Maria (the second seeded person) never had
  // a seed photo, so deleting hers restores her to the pre-run state. Juan
  // (2025-0001) is different: testSeed.ts (Task 11) now gives him a seeded
  // placeholder photo, so deleting it here — while exercising the DELETE
  // path — leaves the primary demo person without a face at the gate
  // terminal until someone reseeds. That is restored at the very end of
  // this function, after the later gate-fetch check re-uploads for him too.
  const cleaned = await request(superadmin, 'DELETE', `/persons/${personId}/photo`);
  expectEqual('photo deleted', cleaned.status, 200);
  const afterDelete = await fetch(`${BASE}/persons/${personId}/photo`, { headers: auth(student) });
  expectEqual('deleted photo returns 404', afterDelete.status, 404);

  const cleanedMaria = await request(superadmin, 'DELETE', `/persons/${otherId}/photo`);
  expectEqual("second person's photo deleted", cleanedMaria.status, 200);
  const afterDeleteMaria = await fetch(`${BASE}/persons/${otherId}/photo`, { headers: auth(registrar) });
  expectEqual("second person's deleted photo returns 404", afterDeleteMaria.status, 404);

  console.log('\n== gate direction ==');
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gates = (gatesRes.json.data ?? []) as {
    _id: string;
    name: string;
    type: string;
    direction?: string;
  }[];
  expectEqual('all four gates are seeded', gates.length, 4);

  const expectedGates: Record<string, { type: string; direction: string }> = {
    'Main Entrance': { type: 'person', direction: 'entry' },
    'Side Gate': { type: 'person', direction: 'exit' },
    'Parking Entrance': { type: 'vehicle', direction: 'entry' },
    'Parking Exit': { type: 'vehicle', direction: 'exit' },
  };
  for (const [name, want] of Object.entries(expectedGates)) {
    const gate = gates.find((g) => g.name === name);
    // Comparing undefined to undefined would pass vacuously; assert presence first.
    expectEqual(`gate '${name}' exists`, !!gate, true);
    expectEqual(`gate '${name}' type`, gate?.type, want.type);
    expectEqual(`gate '${name}' direction`, gate?.direction, want.direction);
  }

  console.log('\n== device key minting ==');
  const mainGate = gates.find((g) => g.name === 'Main Entrance');
  const parkingIn = gates.find((g) => g.name === 'Parking Entrance');
  const parkingOut = gates.find((g) => g.name === 'Parking Exit');
  if (!mainGate || !parkingIn || !parkingOut) {
    throw new Error('expected gates missing — run npm run seed:test');
  }

  const registrarMint = await request(registrar, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('registrar cannot mint a key', registrarMint.status, 403);

  const firstMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  expectEqual('superadmin can mint a key', firstMint.status, 201);
  const firstKey = (firstMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('minted key has the documented shape', /^gk_live_[0-9a-f]{40}$/.test(firstKey ?? ''), true);

  const parkingMint = await request(superadmin, 'POST', `/gates/${parkingIn._id}/key`);
  const parkingKey = (parkingMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking key minted', typeof parkingKey, 'string');

  const parkingOutMint = await request(superadmin, 'POST', `/gates/${parkingOut._id}/key`);
  const parkingOutKey = (parkingOutMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('parking exit key minted', typeof parkingOutKey, 'string');

  // Minting again must revoke the first key.
  const secondMint = await request(superadmin, 'POST', `/gates/${mainGate._id}/key`);
  const secondKey = (secondMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('second mint succeeded', secondMint.status, 201);
  expectEqual('second key differs from the first', firstKey !== secondKey, true);

  console.log('\n== tapping with a device key ==');
  const gateKey = (h: string) => ({
    'X-Gate-Key': h,
    'Content-Type': 'application/json',
  });

  async function tap(
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${BASE}/scan/tap`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // no body
    }
    return { status: res.status, json };
  }

  if (!secondKey || !parkingKey) throw new Error('key minting did not return a key');

  // Juan Dela Cruz's card, seeded active.
  const granted = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual('valid key taps successfully', granted.status, 200);
  expectEqual(
    'person card granted at a person gate',
    (granted.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // The device is not trusted to name its own gate.
  const spoofed = await tap(gateKey(secondKey), {
    rfid_uid: 'A1B2C3D4',
    gate_id: parkingIn._id,
    direction: 'exit',
  });
  expectEqual('body-supplied gate is ignored, not honoured', spoofed.status, 200);

  // scanService.listLogs aggregates and sorts scan_time: -1, so [0] is the
  // newest row. The freshness guard keeps this from passing on some
  // unrelated old row if that sort ever changes. The row's gate is now a
  // resolved { id, name } object (task 8), not a bare gate_id.
  const logs = await request(superadmin, 'GET', '/scan/logs?limit=1');
  const latest = (logs.json.data ?? []) as {
    gate?: { id?: string; name?: string } | null;
    direction?: string;
    scan_time?: string;
  }[];
  expectEqual('a log row was written', latest.length >= 1, true);
  expectEqual('newest log row is from this run', !!latest[0]?.scan_time, true);
  expectEqual(
    'newest log row is fresh',
    latest[0]?.scan_time ? Date.now() - new Date(latest[0].scan_time).getTime() < 60_000 : false,
    true
  );
  expectEqual('log records the key\'s gate, not the body\'s', latest[0]?.gate?.id, mainGate._id);
  expectEqual('log records the gate\'s direction', latest[0]?.direction, 'entry');

  // A vehicle TAG at a PERSON gate must not register attendance. (Previously
  // this checked a person card at a vehicle gate, but single-card access
  // deliberately repurposes that path — an owner's person card at a vehicle
  // gate now resolves their vehicle instead of failing wrong_gate_type. The
  // wrong_gate_type guard itself is untouched by that feature, so this
  // direction — a vehicle tag presented at a person gate — still exercises
  // it, and the identity-leak assertion moves here with it.
  const wrongGate = await tap(gateKey(secondKey), { rfid_uid: 'E5F6A7B8' });
  expectEqual(
    'vehicle tag denied at a person gate',
    (wrongGate.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'denial reason is wrong_gate_type',
    (wrongGate.json.data as { reason?: string } | undefined)?.reason,
    'wrong_gate_type'
  );
  // wrong_gate_type must not leak who the cardholder is to a gate they are
  // not authorised for — checked by key absence, not by value, so this
  // cannot pass vacuously just because the field happens to be undefined.
  expectEqual(
    'wrong_gate_type denial carries no identity',
    'person' in (wrongGate.json.data as object),
    false
  );

  console.log('\n== vehicle taps and identity ==');

  // Juan's motorcycle, seeded active, at the vehicle-entry gate it belongs at.
  const vehicleGranted = await tap(gateKey(parkingKey), { rfid_uid: 'E5F6A7B8' });
  expectEqual(
    'granted vehicle tap grants',
    (vehicleGranted.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );
  const vehiclePerson = (vehicleGranted.json.data as { person?: { full_name?: string; plate_number?: string } } | undefined)
    ?.person;
  // Presence floor: without this, the field assertions below would compare
  // undefined to undefined and pass even if the identity was never returned.
  expectEqual('granted vehicle tap carries identity', !!vehiclePerson, true);
  expectEqual('granted vehicle tap carries the plate number', vehiclePerson?.plate_number, 'NCST-1234');
  expectEqual("granted vehicle tap carries the owner's name", vehiclePerson?.full_name, 'Juan Dela Cruz');

  // A deactivated person must read differently from an unregistered stranger.
  const deactivate = await request(superadmin, 'PATCH', `/persons/${personId}/status`, {
    status: 'inactive',
  });
  expectEqual('person deactivated for the inactive-ID check', deactivate.status, 200);
  const inactivePersonTap = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'inactive person denied',
    (inactivePersonTap.json.data as { access_result?: string } | undefined)?.access_result,
    'denied'
  );
  expectEqual(
    'inactive person denial reason',
    (inactivePersonTap.json.data as { reason?: string } | undefined)?.reason,
    'inactive_id'
  );
  const inactivePersonView = (inactivePersonTap.json.data as { person?: { full_name?: string } } | undefined)
    ?.person;
  expectEqual('inactive person denial carries identity', !!inactivePersonView, true);
  expectEqual('inactive person denial carries the name', inactivePersonView?.full_name, 'Juan Dela Cruz');
  // Restore before the attendance/exit-gate checks below, which expect Juan active.
  const reactivate = await request(superadmin, 'PATCH', `/persons/${personId}/status`, {
    status: 'active',
  });
  expectEqual('person reactivated after the inactive-ID check', reactivate.status, 200);

  // Same distinction for a deactivated vehicle (Ana's car).
  const vehiclesRes = await request(superadmin, 'GET', '/vehicles?limit=100');
  const vehicles = (vehiclesRes.json.data ?? []) as { _id: string; rfid_uid: string }[];
  const anaCar = vehicles.find((v) => v.rfid_uid === 'F6A7B8C9');
  expectEqual('second seeded vehicle found', !!anaCar, true);
  const anaCarId = anaCar?._id ?? '';

  const deactivateVehicle = await request(superadmin, 'PATCH', `/vehicles/${anaCarId}/status`, {
    status: 'inactive',
  });
  expectEqual('vehicle deactivated for the inactive-ID check', deactivateVehicle.status, 200);
  const inactiveVehicleTap = await tap(gateKey(parkingKey), { rfid_uid: 'F6A7B8C9' });
  expectEqual(
    'inactive vehicle denial reason',
    (inactiveVehicleTap.json.data as { reason?: string } | undefined)?.reason,
    'inactive_id'
  );
  const inactiveVehicleView = (inactiveVehicleTap.json.data as { person?: { full_name?: string; plate_number?: string } } | undefined)
    ?.person;
  expectEqual('inactive vehicle denial carries identity', !!inactiveVehicleView, true);
  expectEqual('inactive vehicle denial carries the plate number', inactiveVehicleView?.plate_number, 'NCST-5678');
  const reactivateVehicle = await request(superadmin, 'PATCH', `/vehicles/${anaCarId}/status`, {
    status: 'active',
  });
  expectEqual('vehicle reactivated after the inactive-ID check', reactivateVehicle.status, 200);

  // The earlier grant left Juan's motorcycle occupancy-'inside'. Release it
  // here so the harness ends with the vehicle 'outside' and is safe to run
  // again in the same reset window — otherwise the next run's "granted
  // vehicle tap grants" check would be denied already_inside.
  if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
  const vehicleExitTap = await tap(gateKey(parkingOutKey), { rfid_uid: 'E5F6A7B8' });
  expectEqual(
    'vehicle exit releases occupancy',
    (vehicleExitTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  console.log('\n== an expired pass is denied ==');

  // The seeded vehicle used elsewhere in this harness (Juan's motorcycle,
  // plate NCST-1234).
  const expiredUid = 'E5F6A7B8';

  // Find it over HTTP, and read its current expiry so the restore is exact
  // rather than assumed.
  const vehicleListForExpiry = await request(superadmin, 'GET', '/vehicles?limit=100');
  const vehiclesForExpiry = (vehicleListForExpiry.json.data ?? []) as {
    _id: string;
    rfid_uid: string;
    valid_until: string;
  }[];
  expectEqual('vehicle list is non-empty', vehiclesForExpiry.length > 0, true);
  const expiredTarget = vehiclesForExpiry.find((v) => v.rfid_uid === expiredUid);
  expectEqual(`seeded vehicle ${expiredUid} is present`, Boolean(expiredTarget), true);
  const originalValidUntil = expiredTarget!.valid_until;

  // The backdate/restore pair below must never leave the seeded fixture
  // (NCST-1234) permanently expired: a throw between them — an assertion
  // helper misbehaving, a network hiccup — would otherwise strand it
  // backdated forever, breaking every later run in a way that looks like a
  // product bug rather than a harness bug. try/finally guarantees the
  // restore PATCH runs on every exit path out of the try, thrown error
  // included.
  try {
    const backdated = new Date(Date.now() - 86_400_000).toISOString();
    const patched = await request(superadmin, 'PATCH', `/vehicles/${expiredTarget!._id}`, {
      valid_until: backdated,
    });
    expectEqual('expiry was backdated', patched.status, 200);

    const expiredTap = await tap(gateKey(parkingKey), { rfid_uid: expiredUid });
    expectEqual(
      'an expired pass is denied',
      (expiredTap.json.data as { access_result?: string } | undefined)?.access_result,
      'denied'
    );
    expectEqual(
      'the denial reason is vehicle_expired',
      (expiredTap.json.data as { reason?: string } | undefined)?.reason,
      'vehicle_expired'
    );

    // A denied tap must never move occupancy. Read the roster and confirm this
    // vehicle is not on it. The occupancy projection does not expose entity_id
    // (see occupancy.repository.ts listInside) — for a vehicle it projects the
    // plate_number as `name`, so match on that instead.
    const roster = await request(superadmin, 'GET', '/occupancy?limit=100');
    // Floor: `.some()` on an empty array is `false` no matter what actually
    // happened, so a broken GET /occupancy that silently returns nothing
    // would pass the negative check below vacuously. Assert the request
    // itself succeeded before trusting an empty result to mean anything.
    expectEqual('occupancy roster request succeeded', roster.status, 200);
    const inside = (roster.json.data ?? []) as { entity_type?: string; name?: string }[];
    expectEqual(
      'an expired tap did not put the vehicle inside',
      inside.some((r) => r.entity_type === 'vehicle' && r.name === 'NCST-1234'),
      false
    );
  } finally {
    const restoredPatch = await request(superadmin, 'PATCH', `/vehicles/${expiredTarget!._id}`, {
      valid_until: originalValidUntil,
    });
    expectEqual('expiry restored', restoredPatch.status, 200);
  }

  // Prove the pass works again — which also proves the earlier denial came
  // from expiry rather than from some unrelated state.
  const restoredTap = await tap(gateKey(parkingKey), { rfid_uid: expiredUid });
  expectEqual(
    'the pass works again once restored',
    (restoredTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  // The positive half of the occupancy-roster check. Without this, "an
  // expired tap did not put the vehicle inside" above could pass even if
  // GET /occupancy is completely broken and always returns an empty list —
  // this proves the roster can actually see a vehicle that IS inside, so the
  // negative check above means something.
  const rosterAfterRestore = await request(superadmin, 'GET', '/occupancy?limit=100');
  expectEqual('occupancy roster request succeeded after restore', rosterAfterRestore.status, 200);
  const insideAfterRestore = (rosterAfterRestore.json.data ?? []) as {
    entity_type?: string;
    name?: string;
  }[];
  expectEqual(
    'the restored grant DOES put the vehicle inside (roster floor)',
    insideAfterRestore.some((r) => r.entity_type === 'vehicle' && r.name === 'NCST-1234'),
    true
  );

  // The restored tap left the vehicle occupancy-'inside'. Release it here so
  // the next run starts clean, or the next run's earlier "granted vehicle tap
  // grants" check would fail with a stale already_inside.
  if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
  const expiryCleanupExit = await tap(gateKey(parkingOutKey), { rfid_uid: expiredUid });
  expectEqual(
    'post-restore vehicle exit releases occupancy',
    (expiryCleanupExit.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  console.log('\n== registration guards: per-type limits + cross-collection UID ==');

  // A person may hold multiple vehicle ROWS but only one ACTIVE at a time:
  // under single-card the owner is the key, so a second active pass has no
  // unambiguous resolution at the barrier. Uses its own throwaway owner —
  // never a seeded fixture — and is soft-deleted in the finally, which also
  // cascades the first vehicle to 'inactive' (see personService.softDelete).
  {
    const stamp = Date.now();
    const suffix = (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const ownerRes = await request(superadmin, 'POST', '/persons', {
      full_name: 'Single-Card Guard Owner',
      type: 'student',
      id_number: `verify-gates-sc-guard-${stamp}`,
      department_section: 'BSIT 4-A',
    });
    expectEqual('per-type-limit guard throwaway owner created', ownerRes.status, 201);
    const ownerData = ownerRes.json.data as { _id?: string; id?: string } | undefined;
    const ownerId = String(ownerData?._id ?? ownerData?.id ?? '');
    expectEqual('per-type-limit guard throwaway owner has an id', ownerId.length > 0, true);

    try {
      const first = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `SC-TEST-1-${suffix}`,
        rfid_uid: 'FACE' + suffix,
        vehicle_type: 'motorcycle',
        make: 'Honda',
      });
      expectEqual('first active vehicle accepted', first.status, 201);

      // Same TYPE as the first, deliberately. The guard is per-type now
      // (VEHICLE_LIMITS in constants/vehicleTypes.ts), and motorcycle's limit
      // is 1 — a second vehicle of a DIFFERENT type would legitimately be
      // accepted and would make this assertion test nothing.
      const second = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `SC-TEST-2-${suffix}`,
        rfid_uid: 'FEED' + suffix,
        vehicle_type: 'motorcycle',
        make: 'Yamaha',
      });
      expectEqual('second active vehicle of the same type rejected', second.status, 409);
    } finally {
      // The only "delete" this API offers for a Person; it soft-deletes and
      // cascades every owned vehicle to inactive (VehicleModel.updateMany in
      // personService.softDelete). No DELETE /vehicles/:id route exists, so
      // the SC-TEST vehicle row itself is not removable over HTTP — cleaned
      // up out-of-band via mongosh as part of this task's verification.
      const del = await request(superadmin, 'DELETE', `/persons/${ownerId}`);
      expectEqual('per-type-limit guard throwaway owner cleaned up', del.status, 200);
    }
  }

  // A UID belongs to a person OR a vehicle, never both. Without this, a
  // vehicle registered on a person's card is permanently unscannable: the
  // person lookup always wins (this is how CAV 8832 / rfid_uid 0003461782
  // was created). D4E5F6A7 is Ana Villanueva's seeded ID card — this attempt
  // must be rejected before any vehicle row is ever written, so there is
  // nothing to clean up beyond the throwaway owner used to reach the check.
  {
    const stamp = Date.now();
    const suffix = (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const ownerRes = await request(superadmin, 'POST', '/persons', {
      full_name: 'Cross-UID Guard Owner',
      type: 'student',
      id_number: `verify-gates-xuid-guard-${stamp}`,
      department_section: 'BSIT 4-A',
    });
    expectEqual('cross-UID guard throwaway owner created', ownerRes.status, 201);
    const ownerData = ownerRes.json.data as { _id?: string; id?: string } | undefined;
    const ownerId = String(ownerData?._id ?? ownerData?.id ?? '');
    expectEqual('cross-UID guard throwaway owner has an id', ownerId.length > 0, true);

    try {
      const r = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `SC-TEST-3-${suffix}`,
        rfid_uid: 'D4E5F6A7',
        vehicle_type: 'pickup',
        make: 'Toyota',
      });
      expectEqual("person's UID rejected for a vehicle", r.status, 409);
    } finally {
      const del = await request(superadmin, 'DELETE', `/persons/${ownerId}`);
      expectEqual('cross-UID guard throwaway owner cleaned up', del.status, 200);
    }
  }

  // And the reverse direction: F6A7B8C9 is Ana's seeded vehicle tag. A
  // person-create attempt using it must be rejected, and — since the create
  // fails — no person row is ever written, so there is nothing to delete.
  {
    const r = await request(superadmin, 'POST', '/persons', {
      full_name: 'Reverse Cross-UID Probe',
      type: 'student',
      id_number: `verify-gates-xuid-rev-${Date.now()}`,
      department_section: 'BSIT 4-A',
      rfid_uid: 'F6A7B8C9',
    });
    expectEqual("vehicle's UID rejected for a person", r.status, 409);
  }

  // vehicleService.update's one-active guard (Finding 1's fix lives in this
  // exact method) had zero assertions anywhere in this suite. PATCHing a
  // second, currently-inactive vehicle to status 'active' for an owner who
  // is already at that type's limit must be refused with 409, same as create.
  {
    const stamp = Date.now();
    const suffix = (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const ownerRes = await request(superadmin, 'POST', '/persons', {
      full_name: 'Update-Guard Owner',
      type: 'student',
      id_number: `verify-gates-upd-guard-${stamp}`,
      department_section: 'BSIT 4-A',
    });
    expectEqual('update-guard throwaway owner created', ownerRes.status, 201);
    const ownerData = ownerRes.json.data as { _id?: string; id?: string } | undefined;
    const ownerId = String(ownerData?._id ?? ownerData?.id ?? '');
    expectEqual('update-guard throwaway owner has an id', ownerId.length > 0, true);

    try {
      const activeVehicle = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `SC-TEST-4-${suffix}`,
        rfid_uid: 'FEEE' + suffix,
        vehicle_type: 'motorcycle',
        make: 'Honda',
      });
      expectEqual('update-guard first active vehicle accepted', activeVehicle.status, 201);

      // Same TYPE as the active one above, for the same reason as the create
      // guard: motorcycle's limit is 1, so ACTIVATING this one must be
      // refused. A pickup here would activate legitimately and the assertion
      // below would be testing nothing.
      const inactiveVehicle = await request(superadmin, 'POST', '/vehicles', {
        owner_person_id: ownerId,
        plate_number: `SC-TEST-5-${suffix}`,
        rfid_uid: 'FDDD' + suffix,
        vehicle_type: 'motorcycle',
        make: 'Yamaha',
        status: 'inactive',
      });
      expectEqual('update-guard second (inactive) vehicle accepted', inactiveVehicle.status, 201);
      const inactiveId = (inactiveVehicle.json.data as { _id?: string } | undefined)?._id ?? '';
      expectEqual('update-guard second vehicle has an id', inactiveId.length > 0, true);

      const activation = await request(superadmin, 'PATCH', `/vehicles/${inactiveId}`, {
        status: 'active',
      });
      expectEqual('PATCHing a second vehicle active is rejected', activation.status, 409);
    } finally {
      const del = await request(superadmin, 'DELETE', `/persons/${ownerId}`);
      expectEqual('update-guard throwaway owner cleaned up', del.status, 200);
    }
  }

  // personService.reassignRfid's cross-collection check had no assertion:
  // reassigning a person's card to a UID that belongs to a VEHICLE must be
  // refused with 409. F6A7B8C9 is Ana's seeded vehicle tag.
  {
    const stamp = Date.now();
    const personRes = await request(superadmin, 'POST', '/persons', {
      full_name: 'Reassign-Guard Person',
      type: 'student',
      id_number: `verify-gates-reassign-guard-${stamp}`,
      department_section: 'BSIT 4-A',
      rfid_uid: 'FCCC' + (stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0'),
    });
    expectEqual('reassign-guard throwaway person created', personRes.status, 201);
    const personData = personRes.json.data as { _id?: string; id?: string } | undefined;
    const guardPersonId = String(personData?._id ?? personData?.id ?? '');
    expectEqual('reassign-guard throwaway person has an id', guardPersonId.length > 0, true);

    const reassign = await request(superadmin, 'PATCH', `/persons/${guardPersonId}/rfid`, {
      rfid_uid: 'F6A7B8C9',
    });
    expectEqual("reassigning a person's card to a vehicle's UID is rejected", reassign.status, 409);

    const del = await request(superadmin, 'DELETE', `/persons/${guardPersonId}`);
    expectEqual('reassign-guard throwaway person cleaned up', del.status, 200);
  }

  // An exit gate must close the attendance day the entry gate opened.
  const sideGate = gates.find((g) => g.name === 'Side Gate');
  if (!sideGate) throw new Error('Side Gate missing — run npm run seed:test');
  const sideMint = await request(superadmin, 'POST', `/gates/${sideGate._id}/key`);
  const sideKey = (sideMint.json.data as { key?: string } | undefined)?.key;
  expectEqual('side gate key minted', typeof sideKey, 'string');

  console.log('\n== single-card access: owner card at a vehicle gate ==');

  // Ana owns exactly ONE active vehicle (NCST-5678), so her ID card must
  // resolve that vehicle at the parking barrier.
  {
    const r = await tap(gateKey(parkingKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'owner card grants at vehicle gate',
      (r.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );
    expectEqual(
      'owner card reason is null',
      (r.json.data as { reason?: string | null } | undefined)?.reason,
      null
    );
    const p = (r.json.data as { person?: Record<string, unknown> } | undefined)?.person;
    expectEqual('owner card carries identity', !!p, true);
    expectEqual('owner card shows owner name', p?.full_name, 'Ana Villanueva');
    expectEqual('owner card shows plate', p?.plate_number, 'NCST-5678');
    expectEqual('owner card shows owner type', p?.owner_type, 'staff');
    expectEqual('owner card shows department', p?.department_section, 'Registrar Office');
    // registered[] is a person-lane field and must never appear on this lane.
    expectEqual('owner card withholds registered[]', p?.registered, undefined);
    // Release so later checks start from a clean roster.
    if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
    await tap(gateKey(parkingOutKey), { rfid_uid: 'D4E5F6A7' });

    // THE OWNER-CARD EXIT HALF. The drive-in above only pins time_in — the
    // release tap just issued also runs the companion release + upsertTimeOut
    // (scan.service.tap's vehicle-gate exit path), and that half had no
    // assertion anywhere in this suite. Query the same way the time_in check
    // elsewhere in this file does.
    const anaForExit = await findPersonByIdNumber(superadmin, 'EMP-1001');
    const todayForExit = localDateKey(new Date());
    const anaAttAfterExit = await request(
      superadmin,
      'GET',
      `/attendance?person_id=${anaForExit._id}&from=${todayForExit}&to=${todayForExit}&limit=5`
    );
    const anaExitRows = (anaAttAfterExit.json.data ?? []) as { time_out?: string | null }[];
    expectEqual('an attendance row exists for the owner after driving out', anaExitRows.length >= 1, true);
    expectEqual('owner-card drive-out at the parking exit wrote a time_out', !!anaExitRows[0]?.time_out, true);
  }

  // Maria owns no vehicle. The card is CORRECT for this gate — she simply has
  // no pass — so the reason must not be wrong_gate_type.
  {
    const r = await tap(gateKey(parkingKey), { rfid_uid: 'B2C3D4E5' });
    expectEqual(
      'no vehicle denies',
      (r.json.data as { access_result?: string } | undefined)?.access_result,
      'denied'
    );
    expectEqual(
      'no vehicle reason',
      (r.json.data as { reason?: string } | undefined)?.reason,
      'no_vehicle_registered'
    );
    // THE PRIVACY RULE, re-pinned on this denial: registered[] is a
    // person-lane field and must never leak on a denial either.
    expectEqual(
      'no_vehicle_registered denial withholds registered[]',
      (r.json.data as { person?: { registered?: unknown } } | undefined)?.person?.registered,
      undefined
    );
  }

  // An owner with TWO active vehicles: nothing in an owner-CARD tap says
  // which he is driving, so the barrier refuses to guess rather than logging
  // a plate it did not verify. (The vehicle's own sticker is the lane that
  // resolves this — see the vehicle TAG check below.)
  //
  // The second vehicle is CREATED and torn down here rather than assumed.
  // This block used to rely on the seeded owner happening to hold a leftover
  // second vehicle from earlier manual testing — ambient database litter,
  // which made the assertion pass or fail depending on what a previous run or
  // a human had left behind. Worse, that leftover was a second MOTORCYCLE,
  // which put the seeded owner permanently over the motorcycle limit of 1 and
  // made the expiry block's restore PATCH (further up) fail with 409, leaving
  // the seeded fixture stranded expired for every later run.
  //
  // It is a pickup, not a motorcycle: the owner already holds the seeded
  // motorcycle NCST-1234, and motorcycle's limit is 1.
  {
    const ambiguityStamp = Date.now();
    const ambiguitySuffix = (ambiguityStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
    const juan = await findPersonByIdNumber(superadmin, '2025-0001');
    const extra = await request(superadmin, 'POST', '/vehicles', {
      owner_person_id: juan._id,
      plate_number: `SC-TEST-AMB-${ambiguitySuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
      rfid_uid: 'FAB' + ambiguitySuffix,
      vehicle_type: 'pickup',
      make: 'Toyota',
    });
    expectEqual('second active vehicle for the seeded owner created', extra.status, 201);
    const extraId = (extra.json.data as { _id?: string } | undefined)?._id ?? '';

    try {
      const r = await tap(gateKey(parkingKey), { rfid_uid: 'A1B2C3D4' });
      expectEqual(
        'ambiguous owner denies',
        (r.json.data as { access_result?: string } | undefined)?.access_result,
        'denied'
      );
      expectEqual(
        'ambiguous owner reason',
        (r.json.data as { reason?: string } | undefined)?.reason,
        'multiple_vehicles'
      );
      // THE PRIVACY RULE, re-pinned on this denial too.
      expectEqual(
        'multiple_vehicles denial withholds registered[]',
        (r.json.data as { person?: { registered?: unknown } } | undefined)?.person?.registered,
        undefined
      );
    } finally {
      // Deactivated, not deleted: this API has no vehicle DELETE, and leaving
      // it active would re-create exactly the ambient-litter problem this
      // block was rewritten to escape — every later assertion that taps the
      // seeded owner's card would then hit multiple_vehicles.
      const cleanup = await request(superadmin, 'PATCH', `/vehicles/${extraId}/status`, {
        status: 'inactive',
      });
      expectEqual('ambiguity probe vehicle deactivated', cleanup.status, 200);
    }
  }

  // A vehicle TAG at a vehicle gate is unchanged by this feature.
  {
    const r = await tap(gateKey(parkingKey), { rfid_uid: 'F6A7B8C9' });
    expectEqual(
      'vehicle tag still grants',
      (r.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );
    expectEqual(
      'vehicle tag shows plate',
      (r.json.data as { person?: { plate_number?: string } } | undefined)?.person?.plate_number,
      'NCST-5678'
    );
    if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
    await tap(gateKey(parkingOutKey), { rfid_uid: 'F6A7B8C9' });
  }

  console.log('\n== single-card attendance: companion occupancy and attendance writes ==');

  // Drive in at the parking barrier with an ID card, then leave ON FOOT at a
  // person gate. Before single-card this exit returned exit_without_entry and
  // the day's attendance showed the person was never on campus, because as a
  // PERSON they were never marked inside. This is the defect the feature
  // exists to fix, so it is pinned.
  {
    if (!parkingKey || !parkingOutKey || !sideKey) throw new Error('key minting did not return a key');
    const drive = await tap(gateKey(parkingKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'drive-in grants',
      (drive.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );

    const walkOut = await tap(gateKey(sideKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'walk-out after drive-in grants',
      (walkOut.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );
    expectEqual(
      'walk-out is not an anomaly',
      (walkOut.json.data as { reason?: string | null } | undefined)?.reason,
      null
    );

    // The vehicle is still in the lot — only the person left.
    const stillIn = await tap(gateKey(parkingKey), { rfid_uid: 'F6A7B8C9' });
    expectEqual(
      'vehicle still inside after owner walked out',
      (stillIn.json.data as { reason?: string } | undefined)?.reason,
      'already_inside'
    );

    // Verify the attendance rollup itself wrote a time_in — the roster row
    // alone does not prove the rollup ran, since occupancy and attendance are
    // separate writes.
    const ana = await findPersonByIdNumber(superadmin, 'EMP-1001');
    const today = localDateKey(new Date());
    const anaAtt = await request(
      superadmin,
      'GET',
      `/attendance?person_id=${ana._id}&from=${today}&to=${today}&limit=5`
    );
    const anaRows = (anaAtt.json.data ?? []) as { time_in?: string | null }[];
    // upsertTimeIn only sets time_in on the FIRST tap of the day (see
    // attendance.repository.ts), unlike time_out which is refreshed on every
    // exit — so a recency assertion here would fail on a same-day re-run.
    // Existence is what proves the companion attendance write ran at all.
    expectEqual('an attendance row exists for the owner today', anaRows.length >= 1, true);
    expectEqual('owner-card drive-in wrote a time_in', !!anaRows[0]?.time_in, true);

    await tap(gateKey(parkingOutKey), { rfid_uid: 'F6A7B8C9' });
  }

  // Anti-passback still runs on the VEHICLE row, which is authoritative. A
  // second owner-card entry denies, and because the deny happens on the
  // vehicle write the companion person write must never be attempted — a
  // denied tap must not move anyone's state. The person-gate exit afterwards
  // proves it: if the companion had run, Ana would be inside and the exit
  // would report released rather than exit_without_entry.
  {
    if (!parkingKey || !parkingOutKey || !sideKey) throw new Error('key minting did not return a key');
    const first = await tap(gateKey(parkingKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'first owner-card entry grants',
      (first.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );
    await tap(gateKey(sideKey), { rfid_uid: 'D4E5F6A7' }); // person leaves on foot

    const second = await tap(gateKey(parkingKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'second owner-card entry denies',
      (second.json.data as { access_result?: string } | undefined)?.access_result,
      'denied'
    );
    expectEqual(
      'second owner-card entry reason',
      (second.json.data as { reason?: string } | undefined)?.reason,
      'already_inside'
    );

    const after = await tap(gateKey(sideKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'denied entry wrote no companion occupancy',
      (after.json.data as { reason?: string } | undefined)?.reason,
      'exit_without_entry'
    );
    await tap(gateKey(parkingOutKey), { rfid_uid: 'F6A7B8C9' });
  }

  // A vehicle TAG must NOT mark its owner present. A sticker identifies a
  // car, not the human driving it. Without this, anyone borrowing the car
  // would silently mark the owner present on campus.
  {
    if (!parkingKey || !parkingOutKey || !sideKey) throw new Error('key minting did not return a key');
    await tap(gateKey(parkingKey), { rfid_uid: 'F6A7B8C9' });
    // Ana was never marked inside as a person, so a person-gate exit is an
    // anomaly — which is exactly the signal proving no companion write ran.
    const r = await tap(gateKey(sideKey), { rfid_uid: 'D4E5F6A7' });
    expectEqual(
      'vehicle tag does not mark owner present',
      (r.json.data as { reason?: string } | undefined)?.reason,
      'exit_without_entry'
    );
    await tap(gateKey(parkingOutKey), { rfid_uid: 'F6A7B8C9' });
  }

  // A person card at a PERSON gate is unchanged by this feature.
  {
    const r = await tap(gateKey(secondKey), { rfid_uid: 'B2C3D4E5' });
    expectEqual(
      'person card still grants at person gate',
      (r.json.data as { access_result?: string } | undefined)?.access_result,
      'granted'
    );
    expectEqual(
      'person lane still returns type person',
      (r.json.data as { person?: { type?: string } } | undefined)?.person?.type,
      'student'
    );
    await tap(gateKey(sideKey ?? ''), { rfid_uid: 'B2C3D4E5' });
  }

  // An inactive person at a vehicle gate denies on IDENTITY, not on vehicle
  // count. Pedro owns no vehicle, so if the status check were ordered after
  // the vehicle lookup this would wrongly report no_vehicle_registered.
  {
    const pedro = await findPersonByIdNumber(superadmin, '2025-0003');
    await request(superadmin, 'PATCH', `/persons/${pedro._id}/status`, { status: 'inactive' });
    try {
      const r = await tap(gateKey(parkingKey), { rfid_uid: 'C3D4E5F6' });
      expectEqual(
        'inactive person at vehicle gate denies',
        (r.json.data as { access_result?: string } | undefined)?.access_result,
        'denied'
      );
      expectEqual(
        'inactive person reason',
        (r.json.data as { reason?: string } | undefined)?.reason,
        'inactive_id'
      );
      // Identity is still shown so a guard can tell "deactivated student"
      // from "unregistered stranger" — the existing rule, re-pinned here.
      expectEqual(
        'inactive person identity shown',
        (r.json.data as { person?: { full_name?: string } } | undefined)?.person?.full_name,
        'Pedro Reyes'
      );
    } finally {
      await request(superadmin, 'PATCH', `/persons/${pedro._id}/status`, { status: 'active' });
    }
  }

  const exitTap = await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual(
    'exit gate grants',
    (exitTap.json.data as { access_result?: string } | undefined)?.access_result,
    'granted'
  );

  const today = localDateKey(new Date());
  const att = await request(
    superadmin,
    'GET',
    `/attendance?person_id=${personId}&from=${today}&to=${today}&limit=5`
  );
  const rows = (att.json.data ?? []) as { time_in?: string | null; time_out?: string | null }[];
  // A length floor: .find on an empty array yields undefined, and every
  // assertion below it would then compare undefined to undefined and pass.
  expectEqual('an attendance row exists for today', rows.length >= 1, true);
  expectEqual('entry gate recorded a time_in', !!rows[0]?.time_in, true);
  expectEqual('exit gate recorded a time_out', !!rows[0]?.time_out, true);
  // Re-runnable: each run's exit tap refreshes time_out to now, so this holds
  // on the first run and every run after.
  expectEqual(
    'time_out came from this run',
    rows[0]?.time_out ? Date.now() - new Date(rows[0].time_out).getTime() < 60_000 : false,
    true
  );

  const unknownKey = await tap(gateKey('gk_live_' + 'a'.repeat(40)), { rfid_uid: 'A1B2C3D4' });
  expectEqual('unknown key rejected', unknownKey.status, 401);

  // firstKey was revoked when the second was minted.
  const revoked = await tap(gateKey(firstKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  expectEqual('revoked key rejected', revoked.status, 401);

  console.log('\n== monitor output: identity detail ==');

  // A granted person tap carries the department, and an array (never undefined).
  // Uses secondKey rather than firstKey: firstKey (Main Entrance's first-minted
  // key) was revoked by the second mint above and is only still useful here as
  // the "revoked key rejected" negative case near the end of this file.
  // secondKey is the live Main Entrance key at this point in the run.
  const juanTap = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  const juanPerson = (juanTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('granted person tap returns a person block', Boolean(juanPerson), true);
  expectEqual('granted person tap carries department_section', juanPerson?.department_section, 'BSIT - 4A');
  expectEqual('granted person tap carries a registered array', Array.isArray(juanPerson?.registered), true);

  // Juan owns the seeded vehicle NCST-1234, so his registered list must name it.
  const juanRegistered = (juanPerson?.registered ?? []) as { vehicle_type?: string; make?: string }[];
  expectEqual('registered list is non-empty for a vehicle owner', juanRegistered.length > 0, true);
  expectEqual('registered entry carries a vehicle_type', typeof juanRegistered[0]?.vehicle_type, 'string');
  expectEqual('registered entry carries a make', typeof juanRegistered[0]?.make, 'string');

  // Release the occupancy that tap created, so the run stays re-runnable.
  await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });

  // A person with no vehicle gets an EMPTY array, not undefined. Pedro (2025-0003)
  // owns none. Distinguishing "nothing registered" from "we didn't look" is the point.
  const pedroTap = await tap(gateKey(secondKey), { rfid_uid: 'C3D4E5F6' });
  const pedroPerson = (pedroTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('a person with no vehicle still gets an array', Array.isArray(pedroPerson?.registered), true);
  expectEqual('that array is empty, not undefined', (pedroPerson?.registered as unknown[])?.length, 0);
  await tap(gateKey(sideKey ?? ''), { rfid_uid: 'C3D4E5F6' });

  // A vehicle tap carries the OWNER's type and the vehicle's own detail.
  const vehTap = await tap(gateKey(parkingKey), { rfid_uid: 'E5F6A7B8' });
  const vehPerson = (vehTap.json.data as { person?: Record<string, unknown> })?.person;
  expectEqual('vehicle tap carries the owner department', typeof vehPerson?.department_section, 'string');
  expectEqual('vehicle tap carries owner_type', typeof vehPerson?.owner_type, 'string');
  expectEqual('vehicle tap owner_type is not the discriminator', vehPerson?.owner_type !== 'vehicle', true);
  const vehDetail = vehPerson?.vehicle as { vehicle_type?: string; make?: string } | undefined;
  expectEqual('vehicle tap carries vehicle detail', typeof vehDetail?.vehicle_type, 'string');
  if (!parkingOutKey) throw new Error('parking exit key minting did not return a key');
  await tap(gateKey(parkingOutKey), { rfid_uid: 'E5F6A7B8' });

  // THE PRIVACY RULE: an inactive_id denial shows WHO but not WHAT THEY OWN.
  //
  // try/finally is mandatory, for the same reason as the expiry block below: a
  // throw between deactivating and reactivating leaves a SEEDED PERSON
  // permanently inactive, and every later run then fails on a card that should
  // work — a failure that looks like a product bug and costs real time to trace.
  await request(superadmin, 'PATCH', `/persons/${personId}/status`, { status: 'inactive' });
  try {
    const deniedTap = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
    const deniedData = deniedTap.json.data as { access_result?: string; reason?: string; person?: Record<string, unknown> };
    expectEqual('an inactive card is denied', deniedData?.access_result, 'denied');
    expectEqual('the reason is inactive_id', deniedData?.reason, 'inactive_id');
    expectEqual('a denial still names the person', typeof deniedData?.person?.full_name, 'string');
    expectEqual('a denial still shows the department', typeof deniedData?.person?.department_section, 'string');
    expectEqual('a denial does NOT reveal registrations', deniedData?.person?.registered, undefined);
  } finally {
    await request(superadmin, 'PATCH', `/persons/${personId}/status`, { status: 'active' });
  }

  // wrong_gate_type still reveals nothing at all — existing behaviour, re-pinned
  // because this task adds fields that could regress it. Uses a vehicle tag at
  // a person gate, not a person card at a vehicle gate: single-card access
  // repurposes the latter path (see the "vehicle tag denied at a person gate"
  // check above), so it no longer produces wrong_gate_type at all.
  const wrongGateTap = await tap(gateKey(secondKey), { rfid_uid: 'E5F6A7B8' });
  const wrongData = wrongGateTap.json.data as { reason?: string; person?: unknown };
  expectEqual('a vehicle tag at a person gate is wrong_gate_type', wrongData?.reason, 'wrong_gate_type');
  expectEqual('wrong_gate_type reveals no identity at all', wrongData?.person, undefined);

  // An expired pass must not appear in its owner's registered list — showing it
  // would tell the guard the opposite of the truth.
  const vehList = await request(superadmin, 'GET', '/vehicles?limit=100');
  const ownedVeh = ((vehList.json.data ?? []) as { _id: string; rfid_uid: string; valid_until: string }[])
    .find((v) => v.rfid_uid === 'E5F6A7B8');
  if (!ownedVeh) throw new Error('seeded vehicle E5F6A7B8 missing — run npm run seed:test');
  const keepValidUntil = ownedVeh.valid_until;

  // Count BEFORE, and assert the count DROPS BY ONE — do not assert it becomes
  // empty. How many active vehicles the seeded owner holds depends on what
  // else is in the database, so "expect 0" would fail for reasons that have
  // nothing to do with expiry. Counting the delta is robust to whatever the
  // fixture holds, and `registered` entries carry only vehicle_type and make
  // — deliberately no plate — so a specific vehicle cannot be identified from
  // the list anyway.
  const beforeTap = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
  const beforeCount = (((beforeTap.json.data as { person?: { registered?: unknown[] } })?.person
    ?.registered) ?? []).length;
  expectEqual('owner has at least one active vehicle before expiry', beforeCount > 0, true);
  await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });

  try {
    await request(superadmin, 'PATCH', `/vehicles/${ownedVeh._id}`, {
      valid_until: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const afterExpiry = await tap(gateKey(secondKey), { rfid_uid: 'A1B2C3D4' });
    const afterPerson = (afterExpiry.json.data as { person?: { registered?: unknown[] } })?.person;
    const afterCount = (afterPerson?.registered ?? []).length;
    expectEqual('an expired vehicle drops out of registered', afterCount, beforeCount - 1);
    expectEqual('the owner still grants despite an expired vehicle',
      (afterExpiry.json.data as { access_result?: string })?.access_result, 'granted');
    await tap(gateKey(sideKey ?? ''), { rfid_uid: 'A1B2C3D4' });
  } finally {
    await request(superadmin, 'PATCH', `/vehicles/${ownedVeh._id}`, { valid_until: keepValidUntil });
  }

  console.log('\n== photo fetch by a gate terminal ==');
  await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'gate.jpg', 'image/jpeg');
  const byGate = await fetch(`${BASE}/persons/${personId}/photo`, {
    headers: { 'X-Gate-Key': secondKey },
  });
  expectEqual('gate key may fetch a photo', byGate.status, 200);
  await request(superadmin, 'DELETE', `/persons/${personId}/photo`);

  // Restore Juan's seeded placeholder photo (see the comment above the first
  // cleanup block): this run deleted it twice while exercising DELETE, and
  // without this the primary demo person is left faceless at the gate
  // terminal until someone runs seed:test again.
  const restored = await uploadPhoto(auth(registrar), personId, TINY_JPEG, 'restore.jpg', 'image/jpeg');
  expectEqual('seeded photo restored for the primary demo person after the run', restored.status, 201);
}

/**
 * Mongo is used here ONLY for teardown, never for an assertion — every check
 * above still goes through the API, matching the "verifyGates has no Mongo
 * connection for assertions" rule. verifyRoles.ts's cleanupProbes() is the
 * precedent for this exact pattern: a prefix-matched sweep, run on every
 * invocation, so it also mops up rows left by EARLIER runs, not just this
 * one.
 *
 * Without this, every verify:gates run leaked one dead Vehicle row forever:
 * DELETE /persons/:id only soft-deletes the throwaway owner and cascades
 * their vehicle(s) to 'inactive' (personService.softDelete's
 * VehicleModel.updateMany) — it does not remove the vehicle document, and
 * there is no DELETE /vehicles/:id route to do that over the API.
 *
 * Matching by prefix, not by this run's own timestamp, is what lets the
 * sweep also catch earlier runs' litter. Both prefixes are structurally
 * unable to touch a seeded fixture: seeded plates are 'NCST-' (never
 * 'SC-TEST'), and seeded id_numbers are '2025-000n' / 'EMP-100n' (never
 * 'verify-gates-'). 'verify-gates-' alone covers every throwaway person this
 * file creates (the per-type-limit guard's owner, and the cross-UID
 * guard's owner) — the third guard check (vehicle's UID rejected for a
 * person) is a rejected POST /persons and creates no row to sweep.
 */
const PROBE_VEHICLE_PLATE_PREFIX = 'SC-TEST';
const PROBE_PERSON_ID_PREFIX = 'verify-gates-';

async function cleanupProbes(): Promise<void> {
  console.log('\n== cleanup: removing probe vehicle/person rows this and earlier runs left behind ==');
  const vehicleRegex = new RegExp(`^${PROBE_VEHICLE_PLATE_PREFIX}`);
  const personRegex = new RegExp(`^${PROBE_PERSON_ID_PREFIX}`);
  // Vehicle before Person: a probe Vehicle's owner_person_id points at a
  // probe Person, so removing the referencing row first keeps intermediate
  // state consistent if this is ever interrupted mid-sweep.
  const vehicleResult = await VehicleModel.deleteMany({ plate_number: { $regex: vehicleRegex } });
  const personResult = await PersonModel.deleteMany({ id_number: { $regex: personRegex } });
  console.log(
    `  removed ${vehicleResult.deletedCount} probe vehicle(s) (plate_number matching /^${PROBE_VEHICLE_PLATE_PREFIX}/)`
  );
  console.log(
    `  removed ${personResult.deletedCount} probe person(s) (id_number matching /^${PROBE_PERSON_ID_PREFIX}/)`
  );
}

/**
 * Cleanup must run whether runChecks() throws or passes — see verifyRoles.ts
 * main() for the identical reasoning. summary() is the only thing allowed to
 * decide the process exit code, and it must run strictly after cleanup so a
 * red run's non-zero exit is never skipped by an interrupted sweep.
 */
async function main(): Promise<void> {
  await connectDB();
  try {
    try {
      await runChecks();
    } finally {
      await cleanupProbes();
    }
    summary();
  } finally {
    await disconnectDB();
  }
}

main().catch((err) => {
  console.error('[verify:gates] failed', err);
  process.exit(1);
});
