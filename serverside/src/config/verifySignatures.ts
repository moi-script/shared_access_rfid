/**
 * Asserts the signature pipeline in
 * docs/superpowers/specs/2026-07-28-digital-signature-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:signatures
 */
// This script used to need no imports at all, which would have left
// TypeScript treating it as a global script and colliding with
// verifyRoles.ts over `failures`, `checks`, and `BASE` — an `export {}` kept
// it a module. Importing installVerifyBypass below now does that job too.
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
  console.log('All signature checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

/** A real 1x1 transparent PNG, so uploads exercise the same path a browser would. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** A real 1x1 JPEG — valid image bytes, wrong format for a signature. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

async function login(
  username: string,
  password: string
): Promise<{ token: string; personId: string | null }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as {
    data?: { accessToken?: string; user?: { personId?: string | null } };
  };
  const token = body.data?.accessToken;
  if (!token) throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  return { token, personId: body.data?.user?.personId ?? null };
}

async function request(
  token: string | null,
  method: string,
  path: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no JSON body; the status is what matters.
  }
  return { status: res.status, json };
}

async function uploadSignature(
  token: string,
  personId: string,
  bytes: Buffer,
  filename: string,
  declaredMime: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append(
    'signature',
    new Blob([bytes as unknown as BlobPart], { type: declaredMime }),
    filename
  );
  const res = await fetch(`${BASE}/persons/${personId}/signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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

/** Fetches the raw signature, reporting status and Content-Type rather than JSON. */
async function fetchSignature(
  token: string,
  personId: string
): Promise<{ status: number; contentType: string | null; bytes: number }> {
  const res = await fetch(`${BASE}/persons/${personId}/signature`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return { status: res.status, contentType: res.headers.get('content-type'), bytes: buf.length };
}

function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return (json.data ?? {}) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const student = await login('2025-0001', 'Student@123');
  const otherStudent = await login('2025-0002', 'Student@123');
  const staff = await login('EMP-1001', 'Staff@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const hr = await login('testhr', 'Hr@12345');
  const oss = await login('testoss', 'Oss@12345');

  if (!student.personId || !otherStudent.personId || !staff.personId) {
    throw new Error('test seed accounts are not linked to persons — run npm run seed:test');
  }
  const studentId = student.personId;
  const otherId = otherStudent.personId;
  const staffId = staff.personId;

  // Start from a known-empty state so re-runs assert the same thing.
  await request(registrar.token, 'DELETE', `/persons/${studentId}/signature`);
  await request(registrar.token, 'DELETE', `/persons/${otherId}/signature`);
  await request(registrar.token, 'DELETE', `/persons/${staffId}/signature`);

  console.log('\n== a portal user signs their own record ==');
  expectEqual(
    'no signature yet reads 404',
    (await fetchSignature(student.token, studentId)).status,
    404
  );
  const firstUpload = await uploadSignature(
    student.token,
    studentId,
    TINY_PNG,
    'sig.png',
    'image/png'
  );
  expectEqual('student uploads own signature', firstUpload.status, 201);
  expectEqual(
    'signature_url points at the API',
    dataOf(firstUpload.json).signature_url,
    `/persons/${studentId}/signature`
  );

  const read = await fetchSignature(student.token, studentId);
  expectEqual('student reads own signature', read.status, 200);
  expectEqual('served as png', read.contentType, 'image/png');
  expectEqual('bytes round-trip intact', read.bytes, TINY_PNG.length);

  const overview = await request(student.token, 'GET', '/dashboard');
  const overviewPerson = (dataOf(overview.json).person ?? {}) as Record<string, unknown>;
  expectEqual(
    'dashboard exposes signature_url',
    overviewPerson.signature_url,
    `/persons/${studentId}/signature`
  );

  console.log('\n== staff accounts get the same self-service ==');
  expectEqual(
    'staff uploads own signature',
    (await uploadSignature(staff.token, staffId, TINY_PNG, 'sig.png', 'image/png')).status,
    201
  );

  console.log('\n== a portal user cannot reach anyone else ==');
  // 404 not 403 — a 403 would confirm the record exists.
  expectEqual(
    "student cannot read another student's signature",
    (await fetchSignature(student.token, otherId)).status,
    404
  );
  expectEqual(
    "student cannot write another student's signature",
    (await uploadSignature(student.token, otherId, TINY_PNG, 'sig.png', 'image/png')).status,
    404
  );
  expectEqual(
    "student cannot delete another student's signature",
    (await request(student.token, 'DELETE', `/persons/${otherId}/signature`)).status,
    404
  );
  expectEqual(
    'unauthenticated request is rejected',
    (await request(null, 'GET', `/persons/${studentId}/signature`)).status,
    401
  );

  console.log('\n== a registrar reaches anyone (desk capture) ==');
  expectEqual(
    'registrar signs on behalf of a student',
    (await uploadSignature(registrar.token, otherId, TINY_PNG, 'sig.png', 'image/png')).status,
    201
  );
  expectEqual(
    'registrar reads that signature',
    (await fetchSignature(registrar.token, otherId)).status,
    200
  );

  console.log('\n== write authority is scoped, not just STAFF_SIDE membership ==');
  // OSS has zero person write domains (WRITE_DOMAINS.oss is vehicle/gadget
  // only). STAFF_SIDE membership alone must not be enough to reach a write —
  // that was the regression: it let OSS overwrite or delete anyone's stored
  // signature.
  expectEqual(
    'OSS cannot upload a signature for any person',
    (await uploadSignature(oss.token, studentId, TINY_PNG, 'sig.png', 'image/png')).status,
    403
  );
  expectEqual(
    'OSS cannot delete a signature for any person',
    (await request(oss.token, 'DELETE', `/persons/${studentId}/signature`)).status,
    403
  );
  expectEqual(
    "student's signature survives OSS's denied attempts",
    (await fetchSignature(student.token, studentId)).status,
    200
  );

  // Registrar's write domain is person:student only — a staff Person is out
  // of reach even though registrar is STAFF_SIDE and may read it.
  expectEqual(
    "registrar cannot upload a staff person's signature",
    (await uploadSignature(registrar.token, staffId, TINY_PNG, 'sig.png', 'image/png')).status,
    403
  );
  expectEqual(
    "registrar cannot delete a staff person's signature",
    (await request(registrar.token, 'DELETE', `/persons/${staffId}/signature`)).status,
    403
  );

  // HR's write domain is person:staff + person:employee — a student Person is
  // out of reach.
  expectEqual(
    "HR cannot upload a student's signature",
    (await uploadSignature(hr.token, studentId, TINY_PNG, 'sig.png', 'image/png')).status,
    403
  );
  expectEqual(
    "HR cannot delete a student's signature",
    (await request(hr.token, 'DELETE', `/persons/${studentId}/signature`)).status,
    403
  );

  // HR IS in-domain for a staff person — the legitimate write still works;
  // this guard scopes writes, it does not blanket-deny them.
  const hrInDomain = await uploadSignature(hr.token, staffId, TINY_PNG, 'sig.png', 'image/png');
  expectEqual('HR uploads a staff signature (in domain)', hrInDomain.status, 201);
  expectEqual(
    'staff signature still reads back after HR overwrite',
    (await fetchSignature(staff.token, staffId)).status,
    200
  );

  console.log('\n== validation ==');
  const jpegAttempt = await uploadSignature(
    student.token,
    studentId,
    TINY_JPEG,
    'sig.png',
    'image/png'
  );
  // Declared image/png with a real .png filename — only the bytes give it away.
  expectEqual('jpeg bytes rejected despite png content-type', jpegAttempt.status, 422);
  const tooBig = await uploadSignature(
    student.token,
    studentId,
    Buffer.alloc(300_000, 0x41),
    'big.png',
    'image/png'
  );
  expectEqual('oversize upload is 413', tooBig.status, 413);
  expectEqual(
    'a rejected upload leaves the existing signature intact',
    (await fetchSignature(student.token, studentId)).status,
    200
  );

  console.log('\n== re-signing replaces ==');
  const bigger = Buffer.concat([TINY_PNG, Buffer.alloc(64, 0)]);
  const second = await uploadSignature(student.token, studentId, bigger, 'sig2.png', 'image/png');
  expectEqual('re-sign accepted', second.status, 201);
  expectEqual('stored size reflects the new drawing', dataOf(second.json).byte_size, bigger.length);
  expectEqual(
    'read returns the replacement, not a duplicate',
    (await fetchSignature(student.token, studentId)).bytes,
    bigger.length
  );

  console.log('\n== removal ==');
  const removed = await request(student.token, 'DELETE', `/persons/${studentId}/signature`);
  expectEqual('student removes own signature', removed.status, 200);
  expectEqual('signature_url cleared', dataOf(removed.json).signature_url, null);
  expectEqual(
    'signature is gone',
    (await fetchSignature(student.token, studentId)).status,
    404
  );

  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
