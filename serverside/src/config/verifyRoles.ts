/**
 * Asserts the permission matrix in
 * docs/superpowers/specs/2026-07-26-role-system-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:roles
 */

import { Types } from 'mongoose';
import {
  ROLES,
  ALL_ROLES,
  STAFF_SIDE,
  WRITE_DOMAINS,
  rankOf,
  rolesBelow,
  bulkEligibleRoles,
  personDomain,
  type Role,
} from '../constants/roles';
import { assertCanActOn, assertCanCreateRole, assertCanWrite, type Actor } from '../utils/authority';
import { shouldBypassRateLimit } from '../middlewares/rateLimiter';
import { nextSchoolYearEnd } from '../utils/schoolYear';
import { installVerifyBypass } from './verifyBypass';
import { connectDB, disconnectDB } from './db';
import { PersonModel } from '../modules/persons/persons.model';
import { UserModel } from '../modules/users/users.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { VehicleApplicationModel } from '../modules/vehicleApplications/vehicleApplications.model';
import { ScanLogModel } from '../modules/scan/scan.model';
import { ApplicationSignatureModel } from '../modules/vehicleApplications/applicationSignatures.model';
import { BlockedCardModel } from '../modules/blockedCards/blockedCards.model';
import { grantSuperadmin } from './grantSuperadmin';
import { userService } from '../modules/users/users.service';

// Installs the X-Verify-Bypass header on every fetch() this process makes,
// once, before any request goes out — see verifyBypass.ts. The server's rate
// limiters only honour it when NODE_ENV isn't production AND
// VERIFY_BYPASS_TOKEN is set to the same value server-side (see
// shouldBypassRateLimit() in middlewares/rateLimiter.ts) — so leaving
// VERIFY_BYPASS_TOKEN unset means this run is subject to the real limits,
// exactly like before this opt-out existed.
installVerifyBypass();

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const failures: string[] = [];
let checks = 0;

async function login(
  username: string,
  password: string
): Promise<{ token: string; role: string | undefined }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data?: { accessToken?: string; user?: { role?: string } } };
  const token = body.data?.accessToken;
  if (!token) {
    throw new Error(`login failed for '${username}' (HTTP ${res.status})`);
  }
  return { token, role: body.data?.user?.role };
}

async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some responses have no body; the status is what matters.
  }
  return { status: res.status, json };
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  deactivated_at: string | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}

/**
 * GET /users caps `limit` at 100 server-side (see utils/pagination.ts), and
 * there is no server-side search by username. A single-page fetch used to
 * assume a seeded fixture (e.g. the prod-seeded 'admin' account) would land
 * on page 1 — sorted newest-first, that assumption breaks the moment enough
 * OTHER accounts sort ahead of it, and the lookup then reports "not found"
 * for a row that is sitting one page further down. Walk every page instead
 * of trusting page 1, so growth in the collection can never produce a wrong
 * answer here — only a slower one.
 */
async function fetchAllUsers(token: string, query = ''): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  let page = 1;
  for (;;) {
    const qs = query ? `${query}&page=${page}&limit=100` : `page=${page}&limit=100`;
    const res = await request(token, 'GET', `/users?${qs}`);
    const pageRows = (res.json.data ?? []) as UserRow[];
    rows.push(...pageRows);
    const meta = (res.json.meta ?? {}) as { pagination?: { pages?: number } };
    const pages = meta.pagination?.pages ?? 1;
    if (pageRows.length === 0 || page >= pages) break;
    page++;
  }
  return rows;
}

/**
 * A 401 is always a failure even when a denial was expected — it means the
 * token is broken, not that authorization worked.
 */
async function check(
  name: string,
  token: string,
  method: string,
  path: string,
  expected: number,
  body?: unknown
): Promise<void> {
  checks++;
  const { status } = await request(token, method, path, body);
  if (status === 401 && expected !== 401) {
    failures.push(`${name}: got 401 (bad token) — expected ${expected}`);
    console.log(`  FAIL ${name} — 401, expected ${expected}`);
    return;
  }
  // A 429 is neither a pass nor a denial — it means the run hit a rate limit
  // and this check never reached the authorization code. Running all four
  // verify:* scripts back to back trips globalLimiter (RATE_LIMIT_MAX per
  // RATE_LIMIT_WINDOW_MS, applied to every API route, NOT the login limiter),
  // and a run that silently reports a wrong status here looks like a code
  // defect. Say what actually happened.
  if (status === 429 && expected !== 429) {
    failures.push(`${name}: got 429 (rate limited — see README) — expected ${expected}`);
    console.log(`  FAIL ${name} — 429 rate limited, expected ${expected}`);
    return;
  }
  if (status !== expected) {
    failures.push(`${name}: got ${status}, expected ${expected}`);
    console.log(`  FAIL ${name} — ${status}, expected ${expected}`);
    return;
  }
  console.log(`  ok   ${name} — ${status}`);
}

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
  console.log('All role checks passed.');
}

const OK = 200;
const FORBIDDEN = 403;
const CREATED = 201;
const CONFLICT = 409;

async function runChecks(): Promise<void> {
  console.log('\n== rate-limit bypass guard fails closed ==');

  // shouldBypassRateLimit() is exported as a pure function specifically so
  // the production case can be proven here, without a test framework and
  // without ever standing up a production server. The first assertion is
  // the one that matters most: production must never bypass, even with the
  // exact right token.
  expectEqual(
    'production never bypasses, even with a correct token',
    shouldBypassRateLimit(true, 'tok', 'tok'),
    false
  );
  expectEqual(
    'no configured token means no bypass',
    shouldBypassRateLimit(false, undefined, 'tok'),
    false
  );
  expectEqual(
    'an empty configured token must not match an empty header',
    shouldBypassRateLimit(false, '', ''),
    false
  );
  expectEqual(
    'no header presented means no bypass',
    shouldBypassRateLimit(false, 'tok', undefined),
    false
  );
  expectEqual(
    'a mismatched header means no bypass',
    shouldBypassRateLimit(false, 'tok', 'wrong'),
    false
  );
  expectEqual(
    'non-prod, configured, and matching header bypasses',
    shouldBypassRateLimit(false, 'tok', 'tok'),
    true
  );

  console.log('\n== school-year expiry helper ==');

  // These checks compare local-time construction against UTC construction, and
  // at a zero offset those are the SAME INSTANT — so on a UTC+0 host (the
  // default for most CI runners and Docker images) this whole block passes
  // against a UTC-based implementation and proves nothing. Fail loudly rather
  // than reporting false confidence: the README already requires TZ to be set
  // to the campus timezone. Do NOT "fix" this by pinning TZ inside the
  // verify:* npm scripts — several other checks in this harness compare dates
  // the server itself bucketed, so the harness and the server must keep
  // agreeing on local time; pinning TZ for only one side would introduce a
  // mismatch worse than the blind spot it would paper over. A loud failure
  // here is the correct signal: set TZ for the whole environment.
  expectEqual(
    'harness is not running at UTC+0 (timezone checks would be inert)',
    new Date().getTimezoneOffset() !== 0,
    true
  );

  // Default is 03-31. A date before it in the same year resolves to this year.
  const beforeCutoff = nextSchoolYearEnd(new Date(2026, 6, 27)); // 2026-07-27 local
  expectEqual('expiry lands on the configured month', beforeCutoff.getMonth(), 2); // March
  expectEqual('expiry lands on the configured day', beforeCutoff.getDate(), 31);
  expectEqual('a July date rolls to next year', beforeCutoff.getFullYear(), 2027);

  // A date after the cutoff rolls forward a further year.
  const afterCutoff = nextSchoolYearEnd(new Date(2027, 4, 2)); // 2027-05-02 local
  expectEqual('a May date rolls to the following year', afterCutoff.getFullYear(), 2028);

  // Exactly ON the cutoff day is still valid that day — end-of-day, not midnight.
  const onCutoff = nextSchoolYearEnd(new Date(2027, 2, 31, 9, 0, 0));
  expectEqual('the cutoff day itself does not roll over', onCutoff.getFullYear(), 2027);
  expectEqual('expiry is end-of-day, not midnight', onCutoff.getHours(), 23);
  expectEqual('expiry minutes are end-of-day', onCutoff.getMinutes(), 59);

  // Local, never UTC: constructed from local components, so the local date
  // components round-trip regardless of the host timezone.
  const local = nextSchoolYearEnd(new Date(2026, 6, 27));
  expectEqual('expiry is built from local components', local.getDate(), 31);

  console.log('\n== rank and domain tables ==');

  expectEqual('six roles exist', ALL_ROLES.length, 6);
  expectEqual('superadmin outranks admins', rankOf(ROLES.SUPERADMIN) > rankOf(ROLES.HR), true);
  expectEqual('hr and oss are peers', rankOf(ROLES.HR) === rankOf(ROLES.OSS), true);
  expectEqual('registrar and hr are peers', rankOf(ROLES.REGISTRAR) === rankOf(ROLES.HR), true);
  expectEqual('admins outrank students', rankOf(ROLES.OSS) > rankOf(ROLES.STUDENT), true);
  expectEqual('staff and student are peers', rankOf(ROLES.STAFF) === rankOf(ROLES.STUDENT), true);

  // rolesBelow is what replaces BULK_PROTECTED, so its exact contents matter.
  const belowSuper = rolesBelow(ROLES.SUPERADMIN);
  expectEqual('superadmin outranks five roles', belowSuper.length, 5);
  expectEqual('superadmin does not outrank itself', belowSuper.includes(ROLES.SUPERADMIN), false);
  expectEqual('superadmin outranks hr', belowSuper.includes(ROLES.HR), true);

  const belowHr = rolesBelow(ROLES.HR);
  expectEqual('hr outranks exactly two roles', belowHr.length, 2);
  expectEqual('hr does not outrank registrar', belowHr.includes(ROLES.REGISTRAR), false);
  expectEqual('hr does not outrank oss', belowHr.includes(ROLES.OSS), false);
  expectEqual('hr outranks student', belowHr.includes(ROLES.STUDENT), true);
  expectEqual('student outranks nobody', rolesBelow(ROLES.STUDENT).length, 0);

  // bulkEligibleRoles is NOT rolesBelow: it also floors out every rank-2
  // account, regardless of actor. A superadmin's bulk action must never be
  // able to sweep registrar/hr/oss just because they outrank them.
  const bulkFromSuper = bulkEligibleRoles(ROLES.SUPERADMIN);
  expectEqual('superadmin bulk-eligible roles: exactly two', bulkFromSuper.length, 2);
  expectEqual('superadmin bulk-eligible includes staff', bulkFromSuper.includes(ROLES.STAFF), true);
  expectEqual('superadmin bulk-eligible includes student', bulkFromSuper.includes(ROLES.STUDENT), true);
  expectEqual(
    'superadmin bulk-eligible excludes registrar, hr, oss, and self',
    bulkFromSuper.includes(ROLES.REGISTRAR) ||
      bulkFromSuper.includes(ROLES.HR) ||
      bulkFromSuper.includes(ROLES.OSS) ||
      bulkFromSuper.includes(ROLES.SUPERADMIN),
    false
  );

  const bulkFromHr = bulkEligibleRoles(ROLES.HR);
  expectEqual('hr bulk-eligible roles: exactly two (floor changes nothing at rank 2)', bulkFromHr.length, 2);
  expectEqual('hr bulk-eligible includes staff', bulkFromHr.includes(ROLES.STAFF), true);
  expectEqual('hr bulk-eligible includes student', bulkFromHr.includes(ROLES.STUDENT), true);

  expectEqual('student bulk-eligible roles: none', bulkEligibleRoles(ROLES.STUDENT).length, 0);

  // Exhaustiveness: a role missing from either table is a runtime hole, not a
  // type error, because Record<Role, T> is satisfied by a cast anywhere upstream.
  for (const r of ALL_ROLES) {
    expectEqual(`${r} has a rank`, typeof rankOf(r), 'number');
    expectEqual(`${r} has a write-domain entry`, Array.isArray(WRITE_DOMAINS[r]), true);
  }

  expectEqual('registrar writes only students', WRITE_DOMAINS[ROLES.REGISTRAR].join(','), 'person:student');
  expectEqual('hr writes staff and employee', WRITE_DOMAINS[ROLES.HR].join(','), 'person:staff,person:employee');
  expectEqual('oss writes vehicles and gadgets', WRITE_DOMAINS[ROLES.OSS].join(','), 'vehicle,gadget');
  expectEqual('oss writes no person type', WRITE_DOMAINS[ROLES.OSS].some((d) => d.startsWith('person:')), false);
  expectEqual('staff writes nothing', WRITE_DOMAINS[ROLES.STAFF].length, 0);
  expectEqual('student writes nothing', WRITE_DOMAINS[ROLES.STUDENT].length, 0);
  expectEqual('personDomain maps staff', personDomain('staff'), 'person:staff');
  expectEqual('staff-side has four roles', STAFF_SIDE.length, 4);
  expectEqual('oss is staff-side', STAFF_SIDE.includes(ROLES.OSS as Role), true);
  expectEqual('student is not staff-side', STAFF_SIDE.includes(ROLES.STUDENT as Role), false);

  console.log('\n== authority guards ==');

  /** True when fn throws; used so a guard that silently permits fails the check. */
  function denies(fn: () => void): boolean {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  }

  const superActor: Actor = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: ROLES.SUPERADMIN };
  const hrActor: Actor = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', role: ROLES.HR };

  // assertCanActOn — rank
  expectEqual('superadmin may act on hr', denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.HR })), false);
  expectEqual('superadmin may not act on a peer superadmin', denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.SUPERADMIN })), true);
  expectEqual('hr may act on a student', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.STUDENT })), false);
  expectEqual('hr may not act on a peer registrar', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.REGISTRAR })), true);
  expectEqual('hr may not act on a superadmin', denies(() => assertCanActOn(hrActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.SUPERADMIN })), true);
  expectEqual('nobody may act on themselves', denies(() => assertCanActOn(superActor, { _id: superActor.id, role: ROLES.STUDENT })), true);

  // The self-check compares String(target._id) against actor.id because in
  // production the target's _id is an ObjectId and the actor's id is a string.
  // A raw === would compare object to string, always be false, and silently
  // let anyone act on their own account. String fixtures cannot catch that
  // regression, so exercise it with a real ObjectId.
  const selfOid = new Types.ObjectId();
  expectEqual(
    'self-targeting is denied when _id is a real ObjectId',
    denies(() => assertCanActOn({ id: selfOid.toString(), role: ROLES.SUPERADMIN }, { _id: selfOid, role: ROLES.STUDENT })),
    true
  );
  expectEqual(
    'a DIFFERENT ObjectId is not treated as self',
    denies(() => assertCanActOn({ id: new Types.ObjectId().toString(), role: ROLES.SUPERADMIN }, { _id: selfOid, role: ROLES.STUDENT })),
    false
  );

  // assertCanCreateRole — the hole a target-based check cannot see
  expectEqual('superadmin may create hr', denies(() => assertCanCreateRole(superActor, ROLES.HR)), false);
  expectEqual('superadmin may NOT create a superadmin', denies(() => assertCanCreateRole(superActor, ROLES.SUPERADMIN)), true);
  expectEqual('hr may create a student', denies(() => assertCanCreateRole(hrActor, ROLES.STUDENT)), false);
  expectEqual('hr may NOT create a peer hr', denies(() => assertCanCreateRole(hrActor, ROLES.HR)), true);
  expectEqual('hr may NOT create a registrar', denies(() => assertCanCreateRole(hrActor, ROLES.REGISTRAR)), true);

  // assertCanWrite — domain
  expectEqual('hr may write staff persons', denies(() => assertCanWrite(hrActor, 'person:staff')), false);
  expectEqual('hr may NOT write student persons', denies(() => assertCanWrite(hrActor, 'person:student')), true);
  expectEqual('hr may NOT write vehicles', denies(() => assertCanWrite(hrActor, 'vehicle')), true);
  expectEqual('oss may write vehicles', denies(() => assertCanWrite({ id: 'dddddddddddddddddddddddd', role: ROLES.OSS }, 'vehicle')), false);
  expectEqual('oss may NOT write persons', denies(() => assertCanWrite({ id: 'dddddddddddddddddddddddd', role: ROLES.OSS }, 'person:student')), true);
  expectEqual('oss may write gadgets', denies(() => assertCanWrite({ id: 'dddddddddddddddddddddddd', role: ROLES.OSS }, 'gadget')), false);
  expectEqual('hr may NOT write gadgets', denies(() => assertCanWrite(hrActor, 'gadget')), true);
  expectEqual('registrar may NOT write gadgets', denies(() => assertCanWrite({ id: 'eeeeeeeeeeeeeeeeeeeeeeee', role: ROLES.REGISTRAR }, 'gadget')), true);
  expectEqual('superadmin may write every domain', denies(() => { assertCanWrite(superActor, 'person:student'); assertCanWrite(superActor, 'vehicle'); assertCanWrite(superActor, 'gadget'); }), false);

  // Fail-closed on an unrecognized role. `actor.role` is a JWT claim, never
  // enum-validated on the way in, so a bogus value must deny on every guard
  // rather than pass because `RANK[role]`/`WRITE_DOMAINS[role]` came back
  // `undefined`. The cast is deliberate: this value can never come from
  // TypeScript's own type system, only from a forged or corrupted token.
  const bogusActor: Actor = { id: 'eeeeeeeeeeeeeeeeeeeeeeee', role: 'ghost' as Role };
  expectEqual(
    'assertCanActOn denies an unrecognized actor role',
    denies(() => assertCanActOn(bogusActor, { _id: 'cccccccccccccccccccccccc', role: ROLES.STUDENT })),
    true
  );
  expectEqual(
    'assertCanActOn denies an unrecognized target role',
    denies(() => assertCanActOn(superActor, { _id: 'cccccccccccccccccccccccc', role: 'ghost' as Role })),
    true
  );
  expectEqual(
    'assertCanCreateRole denies an unrecognized actor role',
    denies(() => assertCanCreateRole(bogusActor, ROLES.STUDENT)),
    true
  );
  expectEqual(
    'assertCanWrite denies an unrecognized actor role',
    denies(() => assertCanWrite(bogusActor, 'person:student')),
    true
  );

  const superadminLogin = await login('testadmin', 'Admin@123');
  const registrarLogin = await login('testregistrar', 'Registrar@123');
  const studentLogin = await login('2025-0001', 'Student@123');
  const staffLogin = await login('EMP-1001', 'Staff@123');

  const superadmin = superadminLogin.token;
  const registrar = registrarLogin.token;
  const student = studentLogin.token;
  const staff = staffLogin.token;

  const hrLogin = await login('testhr', 'Hr@12345');
  const ossLogin = await login('testoss', 'Oss@12345');
  const hr = hrLogin.token;
  const oss = ossLogin.token;

  console.log('\n== seeded accounts carry the expected roles ==');
  expectEqual('testadmin is superadmin', superadminLogin.role, 'superadmin');
  expectEqual('testregistrar is registrar', registrarLogin.role, 'registrar');
  expectEqual('2025-0001 is student', studentLogin.role, 'student');
  expectEqual('EMP-1001 is staff', staffLogin.role, 'staff');
  expectEqual('testhr has role hr', hrLogin.role, 'hr');
  expectEqual('testoss has role oss', ossLogin.role, 'oss');

  console.log('\n== persons: superadmin and registrar may read ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
  ] as const) {
    await check(`${name} GET /persons`, token, 'GET', '/persons', OK);
    await check(`${name} GET /persons/sections`, token, 'GET', '/persons/sections', OK);
  }
  for (const [name, token] of [
    ['student', student],
    ['staff', staff],
  ] as const) {
    await check(`${name} GET /persons denied`, token, 'GET', '/persons', FORBIDDEN);
  }

  console.log('\n== superadmin-only areas ==');
  // Vehicles used to live in this loop, but reads are now shared across the
  // staff-side console (see "vehicle write domain" below) — only /logs,
  // /reports/attendance, and /scan/logs are still superadmin-only.
  for (const path of ['/logs', '/reports/attendance', '/scan/logs']) {
    await check(`superadmin GET ${path}`, superadmin, 'GET', path, OK);
    await check(`registrar GET ${path} denied`, registrar, 'GET', path, FORBIDDEN);
    await check(`hr GET ${path} denied`, hr, 'GET', path, FORBIDDEN);
    await check(`oss GET ${path} denied`, oss, 'GET', path, FORBIDDEN);
    await check(`student GET ${path} denied`, student, 'GET', path, FORBIDDEN);
  }

  console.log('\n== open to every authenticated role ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['registrar', registrar],
    ['hr', hr],
    ['oss', oss],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /dashboard`, token, 'GET', '/dashboard', OK);
    await check(`${name} GET /gates`, token, 'GET', '/gates', OK);
  }

  console.log('\n== registrar/hr dashboards are registration-only (no scan/gate/vehicle leak) ==');
  for (const [name, token] of [
    ['registrar', registrar],
    ['hr', hr],
  ] as const) {
    const roleDashboard = await request(token, 'GET', '/dashboard');
    expectEqual(`${name} dashboard responds 200`, roleDashboard.status, OK);
    const roleDashboardData = (roleDashboard.json.data ?? {}) as Record<string, unknown>;
    expectEqual(
      `${name} dashboard carries registration data`,
      typeof roleDashboardData.total_persons === 'number',
      true
    );
    expectEqual(
      `${name} dashboard has no recent_scans key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'recent_scans'),
      false
    );
    expectEqual(
      `${name} dashboard has no parking_activity key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'parking_activity'),
      false
    );
    expectEqual(
      `${name} dashboard has no gates key`,
      Object.prototype.hasOwnProperty.call(roleDashboardData, 'gates'),
      false
    );
  }

  console.log('\n== oss dashboard carries vehicle data but no person scan/gate data ==');
  {
    const ossDashboard = await request(oss, 'GET', '/dashboard');
    expectEqual('oss dashboard responds 200', ossDashboard.status, OK);
    const ossData = (ossDashboard.json.data ?? {}) as Record<string, unknown>;
    expectEqual(
      'oss dashboard carries registration data',
      typeof ossData.total_persons === 'number',
      true
    );
    // The Parking tab reads parking_activity unconditionally; a missing key
    // crashes the tab rather than rendering it empty.
    expectEqual(
      'oss dashboard carries parking_activity as an array',
      Array.isArray(ossData.parking_activity),
      true
    );
    expectEqual(
      'oss dashboard carries total_vehicles',
      typeof ossData.total_vehicles === 'number',
      true
    );
    expectEqual(
      'oss dashboard has no recent_scans key',
      Object.prototype.hasOwnProperty.call(ossData, 'recent_scans'),
      false
    );
    expectEqual(
      'oss dashboard has no gates key',
      Object.prototype.hasOwnProperty.call(ossData, 'gates'),
      false
    );
  }

  console.log('\n== attendance: superadmin, staff, and student may read; registrar may not ==');
  for (const [name, token] of [
    ['superadmin', superadmin],
    ['staff', staff],
    ['student', student],
  ] as const) {
    await check(`${name} GET /attendance`, token, 'GET', '/attendance', OK);
  }
  await check('registrar GET /attendance denied', registrar, 'GET', '/attendance', FORBIDDEN);

  console.log('\n== users list ==');
  await check('superadmin GET /users', superadmin, 'GET', '/users', OK);
  await check('registrar GET /users', registrar, 'GET', '/users', OK);
  await check('student GET /users denied', student, 'GET', '/users', FORBIDDEN);

  console.log('\n== user creation is role-aware ==');
  const stamp = Date.now();

  // Registrar may create a student login. This account is never touched
  // again, so cleanupProbes() removes it by prefix at the end of the run —
  // if you change `verify-stu-` below, update PROBE_USER_USERNAME_PREFIXES.
  await check(
    'registrar creates student login',
    registrar,
    'POST',
    '/users',
    CREATED,
    { username: `verify-stu-${stamp}`, password: 'Verify@12345', role: 'student' } // prefix: PROBE_USER_USERNAME_PREFIXES
  );

  // Registrar may not create privileged accounts.
  await check(
    'registrar cannot create registrar',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-reg-${stamp}`, password: 'Verify@12345', role: 'registrar' }
  );
  await check(
    'registrar cannot create superadmin',
    registrar,
    'POST',
    '/users',
    FORBIDDEN,
    { username: `verify-sa-${stamp}`, password: 'Verify@12345', role: 'superadmin' }
  );

  // Superadmin may create a registrar. Also never touched again — same
  // cleanup-by-prefix note as the student login above.
  await check(
    'superadmin creates registrar',
    superadmin,
    'POST',
    '/users',
    CREATED,
    { username: `verify-reg2-${stamp}`, password: 'Verify@12345', role: 'registrar' } // prefix: PROBE_USER_USERNAME_PREFIXES
  );

  // The stored role must be what was requested.
  const createdList = await request(superadmin, 'GET', '/users?limit=100');
  const createdItems = (createdList.json.data ?? []) as { username: string; role: string }[];
  const madeStudent = createdItems.find((u) => u.username === `verify-stu-${stamp}`);
  expectEqual('created student has role student', madeStudent?.role, 'student');

  console.log('\n== users list carries person data and filters ==');
  // Fixture lookups: walk every page (fetchAllUsers) rather than trusting
  // page 1 — see the comment on fetchAllUsers for why a single-page fetch is
  // not safe here.
  const listRows = await fetchAllUsers(superadmin);

  const juan = listRows.find((u) => u.username === '2025-0001');
  expectEqual('list joins person name', juan?.person?.full_name, 'Juan Dela Cruz');
  expectEqual('list exposes person type', juan?.person?.type, 'student');

  const testadminRow = listRows.find((u) => u.username === 'testadmin');
  expectEqual('superadmin row has no person', testadminRow?.person, null);

  const filtered = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const filteredRows = (filtered.json.data ?? []) as { username: string; person: { type: string } | null }[];
  expectEqual(
    'type=student returns only students, and is not empty',
    filteredRows.length > 0 &&
      filteredRows.every((u) => u.person?.type === 'student') &&
      filteredRows.some((u) => u.username === '2025-0001'),
    true
  );

  const bySection = await request(
    superadmin,
    'GET',
    `/users?department_section=${encodeURIComponent('BSIT - 4A')}&limit=100`
  );
  const sectionRows = (bySection.json.data ?? []) as { username: string }[];
  expectEqual(
    'department filter narrows to that section',
    sectionRows.some((u) => u.username === '2025-0001') &&
      !sectionRows.some((u) => u.username === '2025-0002'),
    true
  );

  console.log('\n== single-user activate / deactivate ==');

  // Find Juan's user id and person id via the joined list. Walk every page —
  // these are seeded fixtures, not this run's own fresh rows, so they are
  // exactly the kind of lookup that can silently land past page 1.
  const statusRows = await fetchAllUsers(superadmin);
  const juanRow = statusRows.find((u) => u.username === '2025-0001');
  if (!juanRow?.person) {
    throw new Error(
      `seed missing: searched all ${statusRows.length} accounts for username '2025-0001' with a linked person — run npm run seed:test`
    );
  }
  const juanUserId = juanRow.id;
  const selfRow = statusRows.find((u) => u.username === 'testadmin');
  if (!selfRow) {
    throw new Error(`seed missing: searched all ${statusRows.length} accounts for username 'testadmin'`);
  }
  const empStaffRow = statusRows.find((u) => u.username === 'EMP-1001');
  if (!empStaffRow) {
    throw new Error(`seed missing: searched all ${statusRows.length} accounts for username 'EMP-1001'`);
  }

  // The route now admits every staff-side role (STAFF_SIDE_GUARD), so a bare
  // "only superadmin" denial no longer holds. Registrar outranks staff
  // (rank 2 > 1) but does not write person:staff, so domain still denies it —
  // exercised here on a single-target PATCH; the peer/domain matrix on
  // students is covered in the "rank enforcement on accounts" section below.
  await check(
    'registrar cannot deactivate a staff account (domain)',
    registrar,
    'PATCH',
    `/users/${empStaffRow.id}/status`,
    FORBIDDEN,
    { active: false }
  );
  await check(
    'student cannot deactivate',
    student,
    'PATCH',
    `/users/${juanUserId}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Superadmin cannot deactivate themselves.
  await check(
    'superadmin cannot deactivate self',
    superadmin,
    'PATCH',
    `/users/${selfRow.id}/status`,
    FORBIDDEN,
    { active: false }
  );

  // Deactivating flips both the login and the gate status.
  await check(
    'superadmin deactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: false }
  );

  const afterOff = await request(superadmin, 'GET', '/users?limit=100');
  const offRow = ((afterOff.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login disabled', (offRow as unknown as { is_active: boolean })?.is_active, false);
  expectEqual('person marked inactive', offRow?.person?.status, 'inactive');

  // A deactivated account cannot log in.
  const deniedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '2025-0001', password: 'Student@123' }),
  });
  expectEqual('deactivated user cannot log in', deniedLogin.status, 401);

  // The gate denies the card with the existing reason string.
  const gatesRes = await request(superadmin, 'GET', '/gates');
  const gateList = (gatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const mainGate = gateList.find((g) => g.name === 'Main Entrance');
  const gateId = (mainGate?._id ?? mainGate?.id) as string;
  const tap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: 'A1B2C3D4',
    gate_id: gateId,
    direction: 'entry',
  });
  const tapData = (tap.json.data ?? {}) as { access_result?: string; reason?: string };
  expectEqual('gate denies inactive card', tapData.access_result, 'denied');
  expectEqual('denial reason is inactive_id', tapData.reason, 'inactive_id');

  // Reactivating restores both and clears the audit stamp.
  await check(
    'superadmin reactivates student',
    superadmin,
    'PATCH',
    `/users/${juanUserId}/status`,
    OK,
    { active: true }
  );
  const afterOn = await request(superadmin, 'GET', '/users?limit=100');
  const onRow = ((afterOn.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('login re-enabled', (onRow as unknown as { is_active: boolean })?.is_active, true);
  expectEqual('person re-activated', onRow?.person?.status, 'active');
  expectEqual(
    'audit stamp cleared',
    (onRow as unknown as { deactivated_at: string | null })?.deactivated_at,
    null
  );

  // assertCanActOn (Task 2) denies peers and superiors on EVERY path,
  // superadmin-on-superadmin included — a deliberate reversal of the old
  // role-system spec's ruling that a superadmin may individually deactivate
  // another superadmin. Now that setStatus routes through
  // assertCanActOnPersonBackedAccount (which calls assertCanActOn first),
  // this must be a 403, not the 200 an earlier draft of this harness
  // expected. Use the prod-seeded 'admin' account as the target (not
  // 'testadmin', which is the account we are authenticated as — that would
  // conflate this with the self-action check above).
  // This is exactly the lookup that broke in practice: enough accumulated
  // probe accounts (sorted newest-first) pushed the prod-seeded 'admin'
  // account past a single 100-row page, and a page-1-only fetch reported it
  // as missing even though it existed. Walk every page instead.
  const adminRows = await fetchAllUsers(superadmin);
  const otherSuperadminRow = adminRows.find((u) => u.username === 'admin');
  if (!otherSuperadminRow) {
    throw new Error(
      `seed missing: searched all ${adminRows.length} accounts for the prod-seeded superadmin username 'admin'`
    );
  }
  const otherSuperadminId = otherSuperadminRow.id;

  await check(
    'superadmin cannot deactivate a peer superadmin individually (peer protection extends to superadmins)',
    superadmin,
    'PATCH',
    `/users/${otherSuperadminId}/status`,
    FORBIDDEN,
    { active: false }
  );
  const afterOtherAttempt = await request(superadmin, 'GET', '/users?limit=100');
  const otherAttemptRow = ((afterOtherAttempt.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === 'admin'
  );
  expectEqual(
    'other superadmin login unaffected by the denied attempt',
    (otherAttemptRow as unknown as { is_active: boolean })?.is_active,
    true
  );

  console.log('\n== bulk activate / deactivate ==');

  // STAFF_SIDE_GUARD now admits registrar to the bulk routes at all — the
  // former "only superadmin" denial no longer holds at the route level.
  // The domain rule still governs what a bulk action actually touches:
  // registrar's write domain is person:student only, so a staff-type filter
  // resolves to zero targets (all excluded), not a 403. This exercises the
  // domain half of resolveBulkTargets without mutating any seeded account —
  // matched: 0 means nothing was written, so there is nothing to restore.
  const registrarStaffPreview = await request(
    registrar,
    'GET',
    '/users/bulk-status/preview?type=staff'
  );
  const registrarStaffPreviewData = (registrarStaffPreview.json.data ?? {}) as {
    matched?: number;
    excluded?: number;
  };
  expectEqual(
    'registrar bulk preview on staff filter responds 200 (route allows staff-side roles)',
    registrarStaffPreview.status,
    OK
  );
  expectEqual(
    'registrar bulk preview on staff filter matches nothing (domain excludes it)',
    registrarStaffPreviewData.matched,
    0
  );
  expectEqual(
    'registrar bulk preview on staff filter excludes at least one (domain)',
    (registrarStaffPreviewData.excluded ?? 0) > 0,
    true
  );

  const registrarStaffApply = await request(registrar, 'POST', '/users/bulk-status', {
    active: false,
    filter: { type: 'staff' },
  });
  const registrarStaffApplyData = (registrarStaffApply.json.data ?? {}) as {
    matched?: number;
    modified?: number;
  };
  expectEqual('registrar bulk apply on staff filter responds 200', registrarStaffApply.status, OK);
  expectEqual('registrar bulk apply on staff filter matches nothing', registrarStaffApplyData.matched, 0);
  expectEqual(
    'registrar bulk apply on staff filter modifies nothing',
    registrarStaffApplyData.modified,
    0
  );

  // Preview count must match what the mutation reports.
  const preview = await request(
    superadmin,
    'GET',
    '/users/bulk-status/preview?type=student'
  );
  const previewData = (preview.json.data ?? {}) as { matched: number; excluded: number };
  expectEqual('preview matches the three seeded students', previewData.matched, 3);

  const bulkOff = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: { type: 'student' },
  });
  const bulkData = (bulkOff.json.data ?? {}) as {
    matched: number;
    modified: number;
    excluded: number;
  };
  // A plain expectEqual(bulkData.matched, previewData.matched) would pass
  // when the endpoint 404s and both sides are undefined — that is exactly
  // what happened in the Step 2 pre-implementation run. Require a real
  // number on both sides so a missing/broken endpoint cannot masquerade as
  // agreement.
  expectEqual(
    'bulk matched equals preview',
    typeof bulkData.matched === 'number' && bulkData.matched === previewData.matched,
    true
  );
  expectEqual('bulk modified all three', bulkData.modified, 3);

  // Every student is now off, in both places.
  const afterBulk = await request(superadmin, 'GET', '/users?type=student&limit=100');
  const bulkRows = (afterBulk.json.data ?? []) as {
    is_active: boolean;
    person: { status: string } | null;
  }[];
  expectEqual(
    'all students deactivated',
    bulkRows.length === 3 && bulkRows.every((u) => u.is_active === false),
    true
  );
  expectEqual(
    'all student cards inactive',
    bulkRows.length === 3 && bulkRows.every((u) => u.person?.status === 'inactive'),
    true
  );

  // Every rank-2-or-above account survives an unfiltered bulk deactivate,
  // regardless of who runs it — not just peers of the actor. rolesBelow()
  // alone would let a superadmin's bulk action sweep registrar (and, once
  // seeded, hr/oss) accounts just because they outrank them: that is a
  // blast-radius safety property, not a peer-protection one, and the two
  // must not be conflated. bulkEligibleRoles() floors bulk targets at rank 1
  // (staff/student) for every actor, so registrar survives here for the same
  // reason it always did — this is a derived rank floor now, not a
  // hand-maintained name list, so it cannot go stale when a role is added.
  // An admin account can still be deactivated, just never via a filter:
  // PATCH /users/:id/status names a specific target instead.
  const bulkAll = await request(superadmin, 'POST', '/users/bulk-status', {
    active: false,
    filter: {},
  });
  const bulkAllData = (bulkAll.json.data ?? {}) as { excluded: number };
  const afterAll = await request(superadmin, 'GET', '/users?limit=100');
  const allRows = (afterAll.json.data ?? []) as {
    username: string;
    role: string;
    is_active: boolean;
  }[];
  expectEqual(
    'superadmin still active after deactivate-all',
    allRows.find((u) => u.username === 'testadmin')?.is_active,
    true
  );
  expectEqual(
    'registrar still active after deactivate-all (rank floor, not name list)',
    allRows.find((u) => u.username === 'testregistrar')?.is_active,
    true
  );
  expectEqual('exclusions were counted', bulkAllData.excluded >= 2, true);

  // Restore everyone so the script is re-runnable.
  await check('bulk reactivate all', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });
  const restored = await request(superadmin, 'GET', '/users?limit=100');

  // Guard against silent truncation: if the account count ever exceeds the
  // page limit, a check over `restored.json.data` alone would only see part
  // of the list and could pass while accounts outside the page stay
  // deactivated. Fail loudly instead of truncating quietly.
  const restoredMeta = (restored.json.meta ?? {}) as { pagination?: { total: number } };
  expectEqual(
    'restore check covers every account (no silent truncation)',
    typeof restoredMeta.pagination?.total === 'number' && restoredMeta.pagination.total <= 100,
    true
  );

  const restoredRows = (restored.json.data ?? []) as {
    is_active: boolean;
    person: { status: string } | null;
  }[];
  expectEqual(
    'everyone restored: logins re-enabled',
    restoredRows.length > 0 && restoredRows.every((u) => u.is_active),
    true
  );

  // The reactivate path's Person write (the gate side) must also be
  // verified — asserting only is_active would miss a regression that leaves
  // linked cards inactive even after the login is re-enabled, and that
  // corruption would only surface later, at Task 14.
  const restoredWithPerson = restoredRows.filter((u) => u.person !== null);
  expectEqual(
    'everyone restored: linked cards re-activated',
    restoredWithPerson.length > 0 &&
      restoredWithPerson.every((u) => u.person?.status === 'active'),
    true
  );

  console.log('\n== bulk activate must not reopen a gate closed independently ==');

  // A superadmin kills a lost card via PATCH /persons/:id/status while
  // leaving the login active. Juan's User row is already active, so a later
  // "Activate all" must not touch his Person row — only users whose row
  // actually flips from inactive -> active should have their person
  // re-activated.
  const juanPersonId = juanRow.person.id;
  await check(
    'superadmin deactivates card only (login stays active)',
    superadmin,
    'PATCH',
    `/persons/${juanPersonId}/status`,
    OK,
    { status: 'inactive' }
  );

  const beforeActivateAll = await request(superadmin, 'GET', '/users?limit=100');
  const beforeActivateAllRow = ((beforeActivateAll.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual(
    'login still active after card-only deactivation',
    (beforeActivateAllRow as unknown as { is_active: boolean } | undefined)?.is_active,
    true
  );
  expectEqual(
    'card is inactive before bulk activate',
    beforeActivateAllRow?.person?.status,
    'inactive'
  );

  await check('bulk activate all (card-only scenario)', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });

  const afterActivateAllCard = await request(superadmin, 'GET', '/users?limit=100');
  const afterActivateAllCardRow = ((afterActivateAllCard.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual(
    'bulk activate does not reopen an independently-closed gate',
    afterActivateAllCardRow?.person?.status,
    'inactive'
  );

  // Restore state so the harness stays re-runnable.
  await check(
    'superadmin restores the card',
    superadmin,
    'PATCH',
    `/persons/${juanPersonId}/status`,
    OK,
    { status: 'active' }
  );
  const restoredCard = await request(superadmin, 'GET', '/users?limit=100');
  const restoredCardRow = ((restoredCard.json.data ?? []) as typeof statusRows).find(
    (u) => u.username === '2025-0001'
  );
  expectEqual('card restored to active', restoredCardRow?.person?.status, 'active');

  console.log('\n== deletion: real deletion, not just deactivation ==');

  // A throwaway person + user, never a seeded account — deletion is one-way
  // and would permanently corrupt a seeded fixture used by later runs.
  // DELETE /users/:id below only soft-deletes the User and marks the Person
  // 'inactive' — neither document actually goes away, so cleanupProbes()
  // removes both by prefix at the end of the run. If you change `verify-del-`
  // on either line below, update BOTH PROBE_PERSON_ID_PREFIXES and
  // PROBE_USER_USERNAME_PREFIXES.
  const delStamp = Date.now();
  const throwawayRfid = 'DEAD' + (delStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const throwawayIdNumber = `verify-del-${delStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES

  const personRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Verify Deletion Throwaway',
    type: 'student',
    id_number: throwawayIdNumber,
    department_section: 'BSIT - 4A',
    rfid_uid: throwawayRfid,
  });
  expectEqual('throwaway person created', personRes.status, 201);
  const throwawayPersonId = (personRes.json.data as { _id?: string; id?: string } | undefined)
    ?._id ?? (personRes.json.data as { _id?: string; id?: string } | undefined)?.id;
  if (!throwawayPersonId) throw new Error('throwaway person creation did not return an id');

  const delUsername = `verify-del-${delStamp}`; // prefix: PROBE_USER_USERNAME_PREFIXES
  const delUserRes = await request(superadmin, 'POST', '/users', {
    username: delUsername,
    password: 'Verify@12345',
    role: 'student',
    person_id: throwawayPersonId,
  });
  expectEqual('throwaway user created', delUserRes.status, 201);
  const throwawayUserId = (delUserRes.json.data as { id?: string } | undefined)?.id;
  if (!throwawayUserId) throw new Error('throwaway user creation did not return an id');

  // Relies on the just-created throwaway user landing on this first page: the
  // list sorts by createdAt descending, so the newest row is always here
  // regardless of how many accounts exist overall.
  const beforeDeleteList = await request(superadmin, 'GET', '/users?limit=100');
  const beforeDeleteRows = (beforeDeleteList.json.data ?? []) as { username: string }[];
  expectEqual(
    'throwaway user visible before deletion',
    beforeDeleteRows.some((u) => u.username === delUsername),
    true
  );

  const previewBeforeDelete = await request(superadmin, 'GET', '/users/bulk-status/preview');
  const beforeCount = (previewBeforeDelete.json.data as { matched?: number } | undefined)?.matched;
  if (typeof beforeCount !== 'number') throw new Error('bulk preview did not return a matched count');

  await check(
    'superadmin deletes throwaway user',
    superadmin,
    'DELETE',
    `/users/${throwawayUserId}`,
    OK
  );

  const afterDeleteList = await request(superadmin, 'GET', '/users?limit=100');
  const afterDeleteRows = (afterDeleteList.json.data ?? []) as { username: string }[];
  expectEqual(
    'deleted user absent from list',
    afterDeleteRows.some((u) => u.username === delUsername),
    false
  );

  const personAfterDelete = await request(superadmin, 'GET', `/persons/${throwawayPersonId}`);
  expectEqual(
    'deleted user person marked inactive (gate closed)',
    (personAfterDelete.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  const previewAfterDelete = await request(superadmin, 'GET', '/users/bulk-status/preview');
  expectEqual(
    'bulk preview count drops by one after deletion',
    (previewAfterDelete.json.data as { matched?: number } | undefined)?.matched,
    beforeCount - 1
  );

  // The core of this task: Activate All must not resurrect a deleted user or
  // reopen their gate access.
  await check('activate all after deletion', superadmin, 'POST', '/users/bulk-status', OK, {
    active: true,
    filter: {},
  });
  const afterActivateAllList = await request(superadmin, 'GET', '/users?limit=100');
  const afterActivateAllRows = (afterActivateAllList.json.data ?? []) as { username: string }[];
  expectEqual(
    'Activate All does not resurrect the deleted user',
    afterActivateAllRows.some((u) => u.username === delUsername),
    false
  );
  const personAfterActivateAll = await request(
    superadmin,
    'GET',
    `/persons/${throwawayPersonId}`
  );
  expectEqual(
    'Activate All does not reopen the deleted user gate access',
    (personAfterActivateAll.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  await check(
    'single-user activate on deleted user is 404',
    superadmin,
    'PATCH',
    `/users/${throwawayUserId}/status`,
    404,
    { active: true }
  );

  const deletedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: delUsername, password: 'Verify@12345' }),
  });
  expectEqual('deleted user cannot log in', deletedLogin.status, 401);

  await check(
    'registrar cannot delete users',
    registrar,
    'DELETE',
    `/users/${throwawayUserId}`,
    FORBIDDEN
  );

  console.log('\n== rank enforcement on accounts ==');

  // Peer creation — the hole assertCanCreateRole closes.
  await check('hr cannot create a peer hr', hr, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-hr', password: 'Verify@12345', role: 'hr',
  });
  await check('hr cannot create a registrar', hr, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-reg', password: 'Verify@12345', role: 'registrar',
  });
  await check('superadmin cannot create a superadmin', superadmin, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-peer-super', password: 'Verify@12345', role: 'superadmin',
  });

  console.log('\n== break-glass promotion ==');

  // The API must never mint a superadmin, whoever asks.
  await check('api refuses to create a superadmin', superadmin, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-api-super', password: 'Verify@12345', role: 'superadmin',
  });

  // Promotion is idempotent and refuses unknown usernames. Run against the
  // account that is ALREADY superadmin so the harness leaves no new privileged
  // account behind — promoting testadmin is a no-op by construction.
  const promoted = await grantSuperadmin('testadmin');
  expectEqual('promoting an existing superadmin is a no-op', promoted.promoted, false);
  expectEqual('promotion reports the username', promoted.username, 'testadmin');

  let rejectedUnknown = false;
  try {
    await grantSuperadmin('rbac-no-such-user');
  } catch {
    rejectedUnknown = true;
  }
  expectEqual('promotion refuses an unknown username', rejectedUnknown, true);

  // Widened reads.
  await check('hr GET /users', hr, 'GET', '/users', OK);
  await check('oss GET /users', oss, 'GET', '/users', OK);

  // Rank on status changes. Resolve the registrar's own user id first. This
  // array is scanned repeatedly below for several seeded usernames/roles
  // (including a bare `.find(...)!` for 'superadmin' with no presence check),
  // so it is fetched via fetchAllUsers rather than a single page.
  const rankUserRows = await fetchAllUsers(superadmin);
  expectEqual('user list is non-empty', rankUserRows.length > 0, true);
  const registrarRow = rankUserRows.find((u) => u.role === 'registrar');
  // Must be a PERSON-BACKED student, not one of the person-less accounts this
  // very script creates earlier (e.g. `verify-stu-<stamp>`, created without a
  // person_id) — those sort first (newest first) and would let the domain
  // check pass trivially (no Person to write, so rank alone governs, per the
  // dangling-person_id rule). '2025-0001' is the seeded student with a real
  // linked Person, so the domain rule is actually exercised below.
  const studentRow = rankUserRows.find((u) => u.username === '2025-0001');
  expectEqual('a registrar account exists to target', Boolean(registrarRow), true);
  expectEqual('a person-backed student account exists to target', Boolean(studentRow), true);

  // NOTE: userStatusSchema declares `{ active: boolean }` — NOT `is_active`.
  // Sending the wrong key yields a 422 that looks like an authorization pass.
  await check(
    'hr cannot deactivate a peer registrar',
    hr, 'PATCH', `/users/${registrarRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'superadmin cannot deactivate a peer superadmin',
    superadmin, 'PATCH', `/users/${rankUserRows.find((u) => u.role === 'superadmin')!.id}/status`,
    FORBIDDEN, { active: false }
  );
  // DOMAIN WINS over rank on this toggle. HR outranks a student account, but
  // the toggle also writes that student's Person, which HR may not write. All
  // four of these are needed: any one alone passes against a rank-only build.
  const staffRow = rankUserRows.find((u) => u.username === 'EMP-1001');
  expectEqual('a staff account exists to target', Boolean(staffRow), true);

  await check(
    'hr may NOT deactivate a student account (domain)',
    hr, 'PATCH', `/users/${studentRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'registrar may NOT deactivate a staff account (domain)',
    registrar, 'PATCH', `/users/${staffRow!.id}/status`, FORBIDDEN, { active: false }
  );
  await check(
    'hr may deactivate a staff account',
    hr, 'PATCH', `/users/${staffRow!.id}/status`, OK, { active: false }
  );
  await check(
    'hr may reactivate that staff account',
    hr, 'PATCH', `/users/${staffRow!.id}/status`, OK, { active: true }
  );
  await check(
    'registrar may deactivate a student account',
    registrar, 'PATCH', `/users/${studentRow!.id}/status`, OK, { active: false }
  );
  await check(
    'registrar may reactivate that student account',
    registrar, 'PATCH', `/users/${studentRow!.id}/status`, OK, { active: true }
  );

  // resetPassword writes no Person, so it is rank-only — a deliberate
  // asymmetry, recorded in the spec. HR may reset a student's password.
  await check(
    'hr cannot reset passwords at all (superadmin-only route)',
    hr, 'PATCH', `/users/${studentRow!.id}/password`, FORBIDDEN, { password: 'Verify@12345' }
  );

  // Self-targeting, for each staff-side role.
  for (const [name, token] of [
    ['superadmin', superadmin], ['registrar', registrar], ['hr', hr], ['oss', oss],
  ] as const) {
    const me = rankUserRows.find((u) => u.username === (
      name === 'superadmin' ? 'testadmin'
      : name === 'registrar' ? 'testregistrar'
      : name === 'hr' ? 'testhr' : 'testoss'
    ));
    expectEqual(`${name} account is listed`, Boolean(me), true);
    await check(`${name} cannot deactivate itself`, token, 'PATCH', `/users/${me!.id}/status`, FORBIDDEN, { active: false });
  }

  // OSS has no person domain, so it cannot create a login attached to a
  // person. GET /persons is readable by all four staff-side roles (see the
  // "person write domains" block below), so which token resolves the person
  // id here doesn't matter for this check — superadmin is used because the
  // thing under test is POST /users, not read access to /persons.
  const personsForAttach = await request(superadmin, 'GET', '/persons?limit=1');
  const firstPerson = ((personsForAttach.json.data as { _id?: string; id?: string }[]) ?? [])[0];
  expectEqual('a person exists to attach', Boolean(firstPerson), true);
  await check('oss cannot create a login for a person', oss, 'POST', '/users', FORBIDDEN, {
    username: 'rbac-oss-login', password: 'Verify@12345', role: 'student',
    person_id: String(firstPerson!._id ?? firstPerson!.id),
  });

  // Bulk: a filter that WOULD match a peer must leave that peer untouched, and
  // preview must agree with apply. Asserting only the response count would pass
  // against an implementation that excluded nothing.
  //
  // An UNFILTERED scan, not a `search` term, is what exercises this: every
  // seeded Person's full_name/id_number/rfid_uid is substring-clean (no
  // shared token across student and staff records), so any non-empty
  // `type`/`department_section`/`search` filter resolves through
  // buildFilter's person_id $in [...] and structurally can never surface a
  // person-less peer account (superadmin/registrar/hr/oss all have
  // person_id: null). `filter: {}` skips that person_id narrowing entirely,
  // so peers and out-of-domain persons alike are real bulk candidates and
  // the exclusion loop actually has something to exclude.
  const rankPreview = await request(hr, 'GET', '/users/bulk-status/preview');
  const rankPreviewBody = rankPreview.json.data as { matched?: number; excluded?: number };
  expectEqual('preview returns a matched count', typeof rankPreviewBody?.matched, 'number');
  expectEqual('preview excludes at least the peers and self', (rankPreviewBody?.excluded ?? 0) > 0, true);

  // bulkStatusSchema declares `{ active: boolean, filter: bulkFilterSchema }`,
  // and bulkFilterSchema accepts only `type`, `department_section`, `search`,
  // each a plain string.
  const rankApplied = await request(hr, 'POST', '/users/bulk-status', { active: false, filter: {} });
  const rankAppliedBody = rankApplied.json.data as { matched?: number; excluded?: number };
  expectEqual('bulk apply matched equals preview matched', rankAppliedBody?.matched, rankPreviewBody?.matched);
  expectEqual('bulk apply excluded equals preview excluded', rankAppliedBody?.excluded, rankPreviewBody?.excluded);

  // Re-read BOTH a peer and a student. Asserting only the response counts would
  // pass against an implementation that excluded nothing, and checking only the
  // peer would pass against a role-only predicate that still swept every
  // student on campus — the worst hole in this subsystem.
  const rankAfterBulk = await request(superadmin, 'GET', '/users?limit=100');
  const rankAfterRows = (rankAfterBulk.json.data as { id: string; is_active: boolean }[]) ?? [];
  expectEqual('post-bulk user list is non-empty', rankAfterRows.length > 0, true);
  expectEqual(
    'peer registrar survives hr bulk deactivate',
    rankAfterRows.find((u) => u.id === registrarRow!.id)?.is_active,
    true
  );
  expectEqual(
    'out-of-domain student survives hr bulk deactivate',
    rankAfterRows.find((u) => u.id === studentRow!.id)?.is_active,
    true
  );

  // Restore anything the bulk actually deactivated. Use superadmin (every
  // domain) with the same unfiltered scan so the restore isn't itself
  // limited by hr's write domain.
  await request(superadmin, 'POST', '/users/bulk-status', { active: true, filter: {} });

  console.log('\n== person write domains ==');

  // Reads are shared — this is what lets OSS attach an owner to a vehicle.
  await check('hr GET /persons', hr, 'GET', '/persons', OK);
  await check('oss GET /persons', oss, 'GET', '/persons', OK);

  // There is NO DELETE /persons/:id route, so these rows are removed by
  // cleanupProbes() at the end of the run instead, matched by the
  // `verify-rbac-` prefix (never used by a seeded fixture). Same
  // timestamp-suffixed id_number/RFID convention as the throwaway block
  // above. If you change the `verify-rbac-` prefix on either line below,
  // update PROBE_PERSON_ID_PREFIXES too.
  const rbacStamp = Date.now();
  const probeStudentId = `verify-rbac-s-${rbacStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const probeStaffId = `verify-rbac-t-${rbacStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const probeStudentRfid = 'BEEF' + (rbacStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const probeStaffRfid = 'CAFE' + (rbacStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  // Writes are scoped.
  const madeStudentPerson = await request(registrar, 'POST', '/persons', {
    full_name: 'RBAC Probe Student', type: 'student',
    id_number: probeStudentId, department_section: 'BSIT 4-A', rfid_uid: probeStudentRfid,
  });
  expectEqual('registrar may create a student', madeStudentPerson.status, 201);

  await check('registrar may NOT create a staff person', registrar, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe Staff', type: 'staff',
    id_number: probeStaffId, department_section: 'Registrar Office', rfid_uid: probeStaffRfid,
  });

  const madeStaff = await request(hr, 'POST', '/persons', {
    full_name: 'RBAC Probe Staff', type: 'staff',
    id_number: probeStaffId, department_section: 'Registrar Office', rfid_uid: probeStaffRfid,
  });
  expectEqual('hr may create a staff person', madeStaff.status, 201);

  await check('hr may NOT create a student', hr, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe Student 2', type: 'student',
    id_number: `${probeStudentId}-b`, department_section: 'BSIT 4-A',
  });
  await check('oss may NOT create any person', oss, 'POST', '/persons', FORBIDDEN, {
    full_name: 'RBAC Probe OSS', type: 'student',
    id_number: `${probeStudentId}-c`, department_section: 'BSIT 4-A',
  });

  // Type-change escalation, both directions.
  const idOf = (r: { json: Record<string, unknown> }) => {
    const d = r.json.data as { _id?: string; id?: string } | undefined;
    return String(d?._id ?? d?.id ?? '');
  };
  const probeStudent = { _id: idOf(madeStudentPerson) };
  const probeStaff = { _id: idOf(madeStaff) };
  expectEqual('probe student has an id', probeStudent._id.length > 0, true);
  expectEqual('probe staff has an id', probeStaff._id.length > 0, true);

  await check(
    'registrar cannot push a student out of its domain',
    registrar, 'PATCH', `/persons/${probeStudent!._id}`, FORBIDDEN, { type: 'staff' }
  );
  await check(
    'registrar cannot claim a staff record by retyping it',
    registrar, 'PATCH', `/persons/${probeStaff!._id}`, FORBIDDEN, { type: 'student' }
  );
  await check(
    'registrar may still edit a student in-domain',
    registrar, 'PATCH', `/persons/${probeStudent!._id}`, OK, { department_section: 'BSIT 4-B' }
  );

  // id_number is also the linked User's login username, so it is read-only
  // on PATCH /persons/:id — the frontend just disables the input, but that
  // is a usability layer, not the enforcement boundary. A status-only check
  // would pass even if the field were silently stripped (200 either way),
  // so assert the STORED value afterwards instead.
  await check(
    'PATCH accepts a body containing id_number (field is silently dropped, not rejected)',
    registrar, 'PATCH', `/persons/${probeStudent!._id}`, OK, { id_number: `${probeStudentId}-CHANGED` }
  );
  const afterIdNumberAttempt = await request(superadmin, 'GET', `/persons/${probeStudent!._id}`);
  expectEqual(
    'id_number is unchanged after a PATCH that tried to set it',
    (afterIdNumberAttempt.json.data as { id_number?: string } | undefined)?.id_number,
    probeStudentId
  );

  // Status is a write, so it is domain-scoped too.
  await check(
    'hr may deactivate a staff person',
    hr, 'PATCH', `/persons/${probeStaff!._id}/status`, OK, { status: 'inactive' }
  );
  await check(
    'hr may NOT deactivate a student person',
    hr, 'PATCH', `/persons/${probeStudent!._id}/status`, FORBIDDEN, { status: 'inactive' }
  );

  console.log('\n== reactivation defers to rank when a linked User exists (regression counterexample) ==');

  // The old special case only refused reactivation when the linked User was
  // soft-deleted (deleted_at set). That misses a real hole: HR and OSS logins
  // can be person-backed too — userService.create permits exactly that, and
  // only the SEEDED office accounts (testhr/testoss) happen to be
  // person-less. So a merely-deactivated (is_active: false, NOT deleted)
  // person-backed HR account was reachable through PATCH /persons/:id/status
  // by any OTHER HR account, even though that same actor would be denied on
  // the equivalent PATCH /users/:id/status by assertCanActOn's peer rule.
  // Build exactly that account and prove the gap is closed: a peer gets 403,
  // a superadmin still succeeds.
  const reactStamp = Date.now();
  const reactPersonIdNumber = `verify-rbac-hr2-${reactStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES ('verify-rbac-')
  const reactRfid = 'FEED' + (reactStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  const reactPersonRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Reactivation Probe',
    type: 'staff',
    id_number: reactPersonIdNumber,
    department_section: 'HR Office',
    rfid_uid: reactRfid,
  });
  expectEqual('person-backed probe person created', reactPersonRes.status, 201);
  const reactPersonId = idOf(reactPersonRes);
  expectEqual('probe person has an id', reactPersonId.length > 0, true);

  const reactUsername = `rbac-hr2-${reactStamp}`; // prefix: PROBE_USER_USERNAME_PREFIXES ('rbac-')
  const reactUserRes = await request(superadmin, 'POST', '/users', {
    username: reactUsername,
    password: 'Verify@12345',
    role: 'hr',
    person_id: reactPersonId,
  });
  expectEqual('superadmin creates a person-backed hr account (rank-2)', reactUserRes.status, 201);
  const reactUserId = (reactUserRes.json.data as { id?: string } | undefined)?.id;
  expectEqual('probe hr account has an id', typeof reactUserId, 'string');

  // Superadmin deactivates it through the normal route — this is what
  // deactivating a colleague's login actually looks like, and it closes the
  // gate as a side effect.
  await check(
    'superadmin deactivates the person-backed hr account',
    superadmin, 'PATCH', `/users/${reactUserId}/status`, OK, { active: false }
  );
  const reactAfterOff = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'linked person went inactive with the login',
    (reactAfterOff.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  // The counterexample itself: a DIFFERENT, peer-rank hr account (the seeded
  // testhr) must be denied here. Before this fix, assertCanWrite(hr,
  // 'person:staff') passed and the deleted_at-only check never fired, so this
  // reopened the gate — something that same actor could not do through
  // PATCH /users/:id/status.
  await check(
    'a peer hr account cannot reactivate it via PATCH /persons/:id/status',
    hr, 'PATCH', `/persons/${reactPersonId}/status`, FORBIDDEN, { status: 'active' }
  );
  const reactAfterPeerAttempt = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'the denied peer attempt left the card inactive',
    (reactAfterPeerAttempt.json.data as { status?: string } | undefined)?.status,
    'inactive'
  );

  // Superadmin's short-circuit still works — this is a legitimate
  // reactivation, identical in outcome to PATCH /users/:id/status {active:true}.
  await check(
    'superadmin can still reactivate it',
    superadmin, 'PATCH', `/persons/${reactPersonId}/status`, OK, { status: 'active' }
  );
  const reactAfterSuperadmin = await request(superadmin, 'GET', `/persons/${reactPersonId}`);
  expectEqual(
    'card reactivated by superadmin',
    (reactAfterSuperadmin.json.data as { status?: string } | undefined)?.status,
    'active'
  );

  console.log('\n== vehicle write domain ==');

  await check('hr GET /vehicles', hr, 'GET', '/vehicles', OK);
  await check('oss GET /vehicles', oss, 'GET', '/vehicles', OK);
  await check('student GET /vehicles denied', student, 'GET', '/vehicles', FORBIDDEN);

  // There is NO DELETE /vehicles/:id route, so a probe vehicle is never
  // removed by the endpoint under test — create a fresh throwaway owner per
  // run, same convention as the person probes above. cleanupProbes() below
  // removes both this owner (id_number prefix already covered by
  // PROBE_PERSON_ID_PREFIXES) and the vehicle itself
  // (PROBE_VEHICLE_PLATE_PREFIX) at the end of the run — if you change the
  // `verify-rbac-v-` or `RBAC-` prefix below, update the matching constant
  // near cleanupProbes() too, or this starts leaking again.
  const vStamp = Date.now();
  const vSuffix = (vStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ownerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Vehicle Owner', type: 'student',
    id_number: `verify-rbac-v-${vStamp}`, department_section: 'BSIT 4-A', // prefix: PROBE_PERSON_ID_PREFIXES
    rfid_uid: 'FACE' + vSuffix,
  });
  expectEqual('throwaway vehicle owner created', ownerRes.status, 201);
  const ownerData = ownerRes.json.data as { _id?: string; id?: string } | undefined;
  const ownerId = String(ownerData?._id ?? ownerData?.id ?? '');
  expectEqual('throwaway owner has an id', ownerId.length > 0, true);

  const vehicleBody = {
    owner_person_id: ownerId,
    plate_number: `RBAC-${vSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIX — keep these in sync
    rfid_uid: 'D0E1' + vSuffix,
    vehicle_type: 'motorcycle',
    make: 'Honda',
    vehicle_model: 'Adv',
  };

  await check('registrar may NOT create a vehicle', registrar, 'POST', '/vehicles', FORBIDDEN, vehicleBody);
  await check('hr may NOT create a vehicle', hr, 'POST', '/vehicles', FORBIDDEN, vehicleBody);

  const created = await request(oss, 'POST', '/vehicles', vehicleBody);
  expectEqual('oss may create a vehicle', created.status, 201);
  const vData = created.json.data as { _id?: string; id?: string } | undefined;
  const vehicleId = String(vData?._id ?? vData?.id ?? '');
  expectEqual('created vehicle has an id', vehicleId.length > 0, true);

  await check(
    'oss may deactivate its own vehicle',
    oss, 'PATCH', `/vehicles/${vehicleId}/status`, OK, { status: 'inactive' }
  );
  await check(
    'hr may NOT change vehicle status',
    hr, 'PATCH', `/vehicles/${vehicleId}/status`, FORBIDDEN, { status: 'active' }
  );

  console.log('\n== a person may hold several vehicles ==');

  const multiStamp = Date.now();
  const multiSuffix = (multiStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const multiOwnerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'RBAC Multi Owner',
    type: 'student',
    id_number: `verify-rbac-multi-${multiStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'ACE0' + multiSuffix,
  });
  expectEqual('multi-vehicle owner created', multiOwnerRes.status, CREATED);
  const multiOwner = multiOwnerRes.json.data as { _id?: string; id?: string } | undefined;
  const multiOwnerId = String(multiOwner?._id ?? multiOwner?.id ?? '');
  expectEqual('multi-vehicle owner has an id', multiOwnerId.length > 0, true);

  const firstVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M1-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE1' + multiSuffix,
    vehicle_type: 'motorcycle',
    make: 'Honda',
  });
  expectEqual('first vehicle for this owner', firstVehicle.status, CREATED);
  const firstVehicleData = firstVehicle.json.data as { _id?: string; id?: string } | undefined;
  const firstVehicleId = String(firstVehicleData?._id ?? firstVehicleData?.id ?? '');
  expectEqual('first vehicle has an id', firstVehicleId.length > 0, true);

  // A person may hold several ACTIVE vehicles now, bounded per type by
  // VEHICLE_LIMITS (constants/vehicleTypes.ts). The first vehicle above is a
  // motorcycle (limit 1) and this one is a pickup (limit 3), so no
  // deactivation is needed — the allowances are independent, which is exactly
  // what this asserts.
  const secondVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M2-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE2' + multiSuffix,
    vehicle_type: 'pickup',
    make: 'Toyota',
  });
  expectEqual(
    'a second ACTIVE vehicle of a different type is allowed',
    secondVehicle.status,
    CREATED
  );

  // A second MOTORCYCLE, however, is over that type's limit of 1 — while the
  // pickup allowance above is untouched. This is the check that would catch
  // a limit lookup keyed on the wrong type, or one counting all types
  // together.
  const secondMotorcycle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M3-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE4' + multiSuffix,
    vehicle_type: 'motorcycle',
    make: 'Yamaha',
  });
  expectEqual('a second motorcycle exceeds that type limit', secondMotorcycle.status, CONFLICT);

  // Deactivating frees the slot: the limit counts ACTIVE and unexpired rows
  // only, never every row the person has ever held.
  const deactivateFirstVehicle = await request(oss, 'PATCH', `/vehicles/${firstVehicleId}/status`, {
    status: 'inactive',
  });
  expectEqual('first vehicle deactivated', deactivateFirstVehicle.status, OK);

  const replacementMotorcycle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M4-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'BEE5' + multiSuffix,
    vehicle_type: 'motorcycle',
    make: 'Suzuki',
  });
  expectEqual(
    'deactivating frees the slot for another motorcycle',
    replacementMotorcycle.status,
    CREATED
  );

  // valid_until is defaulted, not left empty.
  const secondBody = secondVehicle.json.data as { valid_until?: string } | undefined;
  expectEqual('vehicle carries a valid_until', typeof secondBody?.valid_until, 'string');

  // Uniqueness that must SURVIVE: plate and rfid.
  const dupPlate = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M1-${multiSuffix}`,
    rfid_uid: 'BEE3' + multiSuffix,
    vehicle_type: 'pickup',
    make: 'Nissan',
  });
  expectEqual('duplicate plate is still rejected', dupPlate.status, CONFLICT);

  // I3: vehicles.schema.ts used to accept any-length hex, weaker than
  // tapSchema's 6-32 char constraint (scan.schema.ts). A too-short UID
  // accepted here would register a vehicle whose pass can never tap in —
  // tapSchema would 422 it at the gate, silently, with nothing to explain
  // why the pass "doesn't work".
  const shortUidVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: multiOwnerId,
    plate_number: `RBAC-M3-${multiSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES (rejected — never persisted)
    rfid_uid: 'A3F',
    vehicle_type: 'pickup',
    make: 'Kia',
  });
  expectEqual('a too-short rfid_uid is rejected at vehicle registration', shortUidVehicle.status, 422);

  console.log('\n== I4: a deleted person\'s vehicle cannot be re-admitted ==');

  // Fresh throwaway owner, then delete them, then prove their vehicle can
  // neither be created for them after the fact nor reactivated once it
  // exists — vehicles.service used to resolve owner_person_id nowhere at
  // all, so PATCH /vehicles/:id/status {status:'active'} on a deleted
  // person's vehicle would set it active with valid_until still ahead, and
  // scan.service.tap grants a vehicle from its own status/expiry alone, then
  // looks up the (now-null) owner — the barrier opens for an "Unknown owner".
  const i4Stamp = Date.now();
  const i4Suffix = (i4Stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const i4OwnerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'I4 Vehicle Owner Probe',
    type: 'student',
    id_number: `verify-rbac-i4-${i4Stamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'FEED' + i4Suffix,
  });
  expectEqual('I4 probe owner created', i4OwnerRes.status, CREATED);
  const i4OwnerData = i4OwnerRes.json.data as { _id?: string; id?: string } | undefined;
  const i4OwnerId = String(i4OwnerData?._id ?? i4OwnerData?.id ?? '');
  expectEqual('I4 probe owner has an id', i4OwnerId.length > 0, true);

  const i4VehicleRes = await request(oss, 'POST', '/vehicles', {
    owner_person_id: i4OwnerId,
    plate_number: `RBAC-I4-${i4Suffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'FED0' + i4Suffix,
    vehicle_type: 'pickup',
    make: 'Toyota',
  });
  expectEqual('I4 probe vehicle created while owner is active', i4VehicleRes.status, CREATED);
  const i4VehicleData = i4VehicleRes.json.data as { _id?: string; id?: string } | undefined;
  const i4VehicleId = String(i4VehicleData?._id ?? i4VehicleData?.id ?? '');
  expectEqual('I4 probe vehicle has an id', i4VehicleId.length > 0, true);

  // Deleting the owner cascades to 'inactive' on their vehicle (already
  // covered by the cascade section below) — deactivate it explicitly first
  // via the owner delete cascade so the reactivation attempt below is
  // testing the real post-delete state.
  await check('superadmin deletes the I4 probe owner', superadmin, 'DELETE', `/persons/${i4OwnerId}`, OK);

  const i4Reactivate = await request(superadmin, 'PATCH', `/vehicles/${i4VehicleId}/status`, {
    status: 'active',
  });
  expectEqual(
    'reactivating a deleted owner\'s vehicle is refused, not granted',
    i4Reactivate.status,
    404
  );

  const i4VehicleAfter = await request(superadmin, 'GET', '/vehicles?limit=100');
  const i4VehicleRow = ((i4VehicleAfter.json.data ?? []) as { _id: string; status: string }[])
    .find((v) => v._id === i4VehicleId);
  expectEqual('the refused reactivation left the vehicle inactive', i4VehicleRow?.status, 'inactive');

  // Creating a NEW vehicle for a deleted owner must be refused too, not just
  // reactivating an existing one.
  const i4NewVehicle = await request(oss, 'POST', '/vehicles', {
    owner_person_id: i4OwnerId,
    plate_number: `RBAC-I4B-${i4Suffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES (rejected — never persisted)
    rfid_uid: 'FED1' + i4Suffix,
    vehicle_type: 'pickup',
    make: 'Honda',
  });
  expectEqual('creating a vehicle for a deleted owner is refused', i4NewVehicle.status, 404);

  console.log('\n== I4b (fix wave 2): owner reassignment cannot re-admit a deleted person\'s car ==');

  // updateVehicleSchema is createVehicleSchema.partial(), so owner_person_id
  // is patchable on its own with no status field at all. Before this fix,
  // vehicles.service only ran the owner check when data.status === 'active'
  // — an ALREADY-active vehicle's owner could be reassigned to a deleted
  // person and the guard never fired: status stayed 'active', valid_until
  // stayed ahead, and scan.service.tap would have granted it and shown
  // "Unknown owner" at the terminal. A second fresh owner + a second fresh
  // active vehicle proves this on the reassignment path specifically, not
  // the already-covered activation path.
  const i4bOwnerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'I4b Reassignment Target Owner',
    type: 'student',
    id_number: `verify-rbac-i4b-${i4Stamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'FEE1' + i4Suffix,
  });
  expectEqual('I4b probe second owner created', i4bOwnerRes.status, CREATED);
  const i4bOwnerData = i4bOwnerRes.json.data as { _id?: string; id?: string } | undefined;
  const i4bOwnerId = String(i4bOwnerData?._id ?? i4bOwnerData?.id ?? '');
  expectEqual('I4b probe second owner has an id', i4bOwnerId.length > 0, true);

  const i4bVehicleRes = await request(oss, 'POST', '/vehicles', {
    owner_person_id: i4bOwnerId,
    plate_number: `RBAC-I4C-${i4Suffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: 'FEE2' + i4Suffix,
    vehicle_type: 'pickup',
    make: 'Mazda',
  });
  expectEqual('I4b probe vehicle created, active, owned by the second owner', i4bVehicleRes.status, CREATED);
  const i4bVehicleData = i4bVehicleRes.json.data as { _id?: string; id?: string; status?: string } | undefined;
  const i4bVehicleId = String(i4bVehicleData?._id ?? i4bVehicleData?.id ?? '');
  expectEqual('I4b probe vehicle has an id', i4bVehicleId.length > 0, true);
  expectEqual('I4b probe vehicle starts active', i4bVehicleData?.status, 'active');

  // Reassign the ALREADY-active vehicle's owner to i4OwnerId — the owner
  // deleted earlier in the I4 block above — with no `status` field in the
  // patch at all. This is precisely the unguarded path.
  const i4bReassign = await request(superadmin, 'PATCH', `/vehicles/${i4bVehicleId}`, {
    owner_person_id: i4OwnerId,
  });
  expectEqual(
    'reassigning an active vehicle\'s owner to a deleted person is refused',
    i4bReassign.status,
    404
  );

  // Refused means refused: neither the owner nor the active status may have
  // moved. Checking status alone would miss a bug where the write partially
  // applied (owner reassigned, status merely left alone by chance).
  const i4bAfter = await request(superadmin, 'GET', '/vehicles?limit=100');
  // GET /vehicles populates owner_person_id (see vehicles.repository.ts), so
  // it comes back as an object here, not a bare id string — unwrap _id.
  const i4bRow = (
    (i4bAfter.json.data ?? []) as { _id: string; status: string; owner_person_id?: { _id?: string } | string }[]
  ).find((v) => v._id === i4bVehicleId);
  expectEqual('the refused reassignment left the vehicle active', i4bRow?.status, 'active');
  const i4bRowOwnerId =
    typeof i4bRow?.owner_person_id === 'object'
      ? String(i4bRow.owner_person_id?._id ?? '')
      : i4bRow?.owner_person_id;
  expectEqual(
    'the refused reassignment left the original owner in place',
    i4bRowOwnerId,
    i4bOwnerId
  );

  // The other half of the ruling: deactivating a vehicle whose owner is
  // already gone must still work — this guard must not regress that. Use the
  // I4 vehicle from above, which the earlier owner-delete cascade already
  // left 'inactive' with a deleted owner; flip it active directly in Mongo
  // (bypassing the API) to reproduce the exact state a pre-existing/legacy
  // row could be in, then confirm PATCH status: 'inactive' (no owner_person_id
  // in the patch) still succeeds even though personRepo.findById(i4OwnerId)
  // resolves to null.
  await VehicleModel.updateOne({ _id: i4VehicleId }, { $set: { status: 'active' } });
  const i4Deactivate = await request(superadmin, 'PATCH', `/vehicles/${i4VehicleId}`, {
    status: 'inactive',
  });
  expectEqual(
    'deactivating a vehicle whose owner is deleted still works',
    i4Deactivate.status,
    OK
  );
  const i4DeactivateRow = await VehicleModel.findById(i4VehicleId).lean();
  expectEqual(
    'the deactivation actually persisted',
    (i4DeactivateRow as unknown as { status?: string } | null)?.status,
    'inactive'
  );

  console.log('\n== C1: a vehicle with no valid_until fails closed (and still logs) ==');

  // A legacy Vehicle row from before this branch's valid_until field existed
  // (or one restored from an older backup, or edited directly in Mongo) has
  // no valid_until even though the schema now says `required: true` — that
  // is enforced only on write. scanService used to call .getTime() on it
  // unconditionally, which threw a raw TypeError BEFORE scanRepo.createLog
  // ran: the tap crashed unlogged, the barrier stayed shut, and nothing in
  // Records explained why. This proves the fix: fail closed with
  // vehicle_expired, AND still write the scan log — the log is the part that
  // distinguishes this fix from the crash.
  const c1Stamp = Date.now();
  const c1Suffix = (c1Stamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const c1OwnerRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'C1 Legacy Vehicle Owner',
    type: 'student',
    id_number: `verify-rbac-c1-${c1Stamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'CAFE' + c1Suffix,
  });
  expectEqual('C1 probe owner created', c1OwnerRes.status, CREATED);
  const c1OwnerData = c1OwnerRes.json.data as { _id?: string; id?: string } | undefined;
  const c1OwnerId = String(c1OwnerData?._id ?? c1OwnerData?.id ?? '');
  expectEqual('C1 probe owner has an id', c1OwnerId.length > 0, true);

  const c1VehicleRfid = 'C1FE' + c1Suffix;
  const c1VehicleRes = await request(oss, 'POST', '/vehicles', {
    owner_person_id: c1OwnerId,
    plate_number: `RBAC-C1-${c1Suffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: c1VehicleRfid,
    vehicle_type: 'pickup',
    make: 'Toyota',
  });
  expectEqual('C1 probe vehicle created', c1VehicleRes.status, CREATED);
  const c1VehicleData = c1VehicleRes.json.data as { _id?: string; id?: string } | undefined;
  const c1VehicleId = String(c1VehicleData?._id ?? c1VehicleData?.id ?? '');
  expectEqual('C1 probe vehicle has an id', c1VehicleId.length > 0, true);

  // Strip valid_until directly against Mongo, bypassing the API entirely.
  // updateOne (unlike a document .save()) does not run schema validators by
  // default — that mismatch (enforced on write via the API, not enforced by
  // Mongo itself) is exactly how a legacy or restored row ends up missing
  // the field in the first place, so this reproduces that real condition
  // rather than a synthetic one.
  await VehicleModel.updateOne({ _id: c1VehicleId }, { $unset: { valid_until: 1 } });
  const strippedVehicle = await VehicleModel.findById(c1VehicleId).lean();
  expectEqual(
    'C1 probe vehicle has no valid_until after the direct strip',
    strippedVehicle?.valid_until,
    undefined
  );

  const c1Gates = await request(superadmin, 'GET', '/gates');
  const c1GateList = (c1Gates.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const c1ParkingGate = c1GateList.find((g) => g.name === 'Parking Entrance');
  const c1GateId = (c1ParkingGate?._id ?? c1ParkingGate?.id) as string;
  expectEqual('a vehicle-entry gate exists for the C1 probe tap', Boolean(c1GateId), true);

  const c1Tap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: c1VehicleRfid,
    gate_id: c1GateId,
    direction: 'entry',
  });
  // The crash this guards against was a raw 500 (unhandled TypeError), not a
  // clean denial — the status check matters as much as the body.
  expectEqual('a vehicle with no valid_until does not 500', c1Tap.status, 200);
  const c1TapData = c1Tap.json.data as { access_result?: string; reason?: string } | undefined;
  expectEqual('a vehicle with no valid_until is denied', c1TapData?.access_result, 'denied');
  expectEqual('the denial reason is vehicle_expired', c1TapData?.reason, 'vehicle_expired');

  // The part that distinguishes this fix from a bare crash: the tap must be
  // LOGGED, not just denied. Read straight from Mongo rather than over
  // HTTP — GET /scan/logs has no rfid_uid filter — and require a fresh row
  // so this cannot pass against some unrelated pre-existing log.
  const c1LogRow = await ScanLogModel.findOne({ rfid_uid: c1VehicleRfid })
    .sort({ scan_time: -1 })
    .lean();
  expectEqual('a scan log row was written for the crash-prone tap', Boolean(c1LogRow), true);
  expectEqual('the logged access_result is denied', c1LogRow?.access_result, 'denied');
  expectEqual('the logged reason is vehicle_expired', c1LogRow?.reason, 'vehicle_expired');
  expectEqual(
    'the logged row is fresh (from this run, not a coincidence)',
    c1LogRow?.scan_time ? Date.now() - new Date(c1LogRow.scan_time).getTime() < 60_000 : false,
    true
  );

  console.log('\n== vehicle applications ==');

  const appStamp = Date.now();
  const appSuffix = (appStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  const applicantRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Gabrielle G. Villareal',
    type: 'student',
    id_number: `verify-rbac-app-${appStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: 'DAD0' + appSuffix,
  });
  expectEqual('applicant person created', applicantRes.status, CREATED);
  const applicant = applicantRes.json.data as { _id?: string; id?: string } | undefined;
  const applicantId = String(applicant?._id ?? applicant?.id ?? '');
  expectEqual('applicant has an id', applicantId.length > 0, true);

  const fullApplication = {
    category: 'new',
    applicant_type: 'student',
    vehicle_type: 'motorcycle',
    owner_person_id: applicantId,
    id_number: `verify-rbac-app-${appStamp}`,
    last_name: 'Villareal',
    first_name: 'Gabrielle',
    middle_name: 'Garcia',
    year_level: '4th',
    school_year: '26-27',
    mobile_no: '09452610104',
    permanent_address: 'Dreamville 6 Imus, Cavite',
    driver_name: 'Gabrielle G. Villareal',
    lto_cr_date: '2021-09-30',
    lto_or_date: '2026-01-05',
    plate_no: `RBAC-A1-${appSuffix}`, // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    make: 'Honda',
    model: 'Adv',
    year: '2021',
    color: 'Brown',
    registered_owner_name: 'Gabrielle G. Villareal',
    signed_name: 'Gabrielle G. Villareal',
    signed_date: '2026-06-30',
    rfid_uid: 'FAB0' + appSuffix,
  };

  // Authorization: OSS writes, the rest do not.
  await check('registrar cannot submit an application', registrar, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);
  await check('hr cannot submit an application', hr, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);
  await check('student cannot submit an application', student, 'POST', '/vehicle-applications', FORBIDDEN, fullApplication);

  const appCreated = await request(oss, 'POST', '/vehicle-applications', fullApplication);
  expectEqual('oss submits an application', appCreated.status, CREATED);
  const createdBody = appCreated.json.data as
    | { application?: { _id?: string; vehicle_id?: string }; vehicle?: { _id?: string; status?: string; valid_until?: string } }
    | undefined;
  const applicationId = String(createdBody?.application?._id ?? '');
  expectEqual('application has an id', applicationId.length > 0, true);
  expectEqual('a vehicle was created and is active', createdBody?.vehicle?.status, 'active');
  expectEqual('the vehicle carries an expiry', typeof createdBody?.vehicle?.valid_until, 'string');
  expectEqual('the application links to its vehicle', typeof createdBody?.application?.vehicle_id, 'string');

  // Shared reads.
  await check('hr may read applications', hr, 'GET', '/vehicle-applications', OK);
  await check('registrar may read one application', registrar, 'GET', `/vehicle-applications/${applicationId}`, OK);
  await check('student may not read applications', student, 'GET', '/vehicle-applications', FORBIDDEN);

  // Immutability is structural — these routes must not exist.
  const patchAttempt = await request(oss, 'PATCH', `/vehicle-applications/${applicationId}`, { make: 'Yamaha' });
  expectEqual('applications cannot be edited', [404, 405].includes(patchAttempt.status), true);
  const deleteAttempt = await request(oss, 'DELETE', `/vehicle-applications/${applicationId}`);
  expectEqual('applications cannot be deleted', [404, 405].includes(deleteAttempt.status), true);

  // The first application's vehicle is still active and is also a pickup, so
  // the minimal application below would be this owner's SECOND active pickup
  // — within the limit of 3, but deactivating first keeps this check isolated
  // to what it actually tests (schema defaults on a mostly-blank form) rather
  // than depending on how much pickup allowance happens to be left.
  const firstApplicationVehicleId = String(createdBody?.vehicle?._id ?? '');
  expectEqual('first application vehicle has an id', firstApplicationVehicleId.length > 0, true);
  const deactivateFirstApplicationVehicle = await request(
    superadmin,
    'PATCH',
    `/vehicles/${firstApplicationVehicleId}/status`,
    { status: 'inactive' }
  );
  expectEqual(
    'first application vehicle deactivated to make room for the minimal application',
    deactivateFirstApplicationVehicle.status,
    OK
  );

  // The client's real form left most fields blank. This must succeed.
  const minimal = await request(oss, 'POST', '/vehicle-applications', {
    category: 'new',
    applicant_type: 'student',
    vehicle_type: 'pickup',
    owner_person_id: applicantId,
    id_number: `verify-rbac-app-${appStamp}`,
    last_name: 'Villareal',
    first_name: 'Gabrielle',
    school_year: '26-27',
    plate_no: `RBAC-A2-${appSuffix}`,
    make: 'Toyota',
    registered_owner_name: 'Gabrielle G. Villareal',
    signed_name: 'Gabrielle G. Villareal',
    signed_date: '2026-06-30',
    rfid_uid: 'FAB1' + appSuffix,
  });
  expectEqual('a minimal application is accepted', minimal.status, CREATED);

  // I3: same weak-regex hole as vehicles.schema.ts, now reachable through the
  // registration door too — a too-short UID accepted here would file the
  // paperwork and issue a sticker for a pass that tapSchema then 422s at the
  // gate, silently.
  const shortUidApp = await request(oss, 'POST', '/vehicle-applications', {
    ...fullApplication,
    plate_no: `RBAC-A3-${appSuffix}`, // rejected — never persisted
    rfid_uid: 'A3F',
  });
  expectEqual('a too-short rfid_uid is rejected at application registration', shortUidApp.status, 422);

  // I2: duplicate plate and duplicate rfid must both be rejected before the
  // application is ever written — not just before the vehicle is written.
  // The old order (application, THEN vehicle, THEN the vehicle insert's own
  // unique-index check) let the common typo case (a clerk mistypes a plate
  // or RFID that's already registered) leave a permanent orphan application
  // with vehicle_id: null, since applications can never be edited or
  // deleted. Count before/after proves no new application row was written,
  // not just that the response was a 409 — a 409 with a leaked write behind
  // it would be the exact defect this fix closes.
  const plateFilterQs = `plate_no=${encodeURIComponent(`RBAC-A1-${appSuffix}`)}&limit=100`;
  const beforePlateDup = await request(superadmin, 'GET', `/vehicle-applications?${plateFilterQs}`);
  const beforePlateDupTotal = (
    (beforePlateDup.json.meta ?? {}) as { pagination?: { total?: number } }
  ).pagination?.total;
  expectEqual('application count readable before duplicate-plate attempt', typeof beforePlateDupTotal, 'number');

  const dupApp = await request(oss, 'POST', '/vehicle-applications', {
    ...fullApplication,
    plate_no: `RBAC-A1-${appSuffix}`,
    rfid_uid: 'FAB2' + appSuffix,
  });
  expectEqual('duplicate plate rejected', dupApp.status, 409);

  const afterPlateDup = await request(superadmin, 'GET', `/vehicle-applications?${plateFilterQs}`);
  const afterPlateDupTotal = (
    (afterPlateDup.json.meta ?? {}) as { pagination?: { total?: number } }
  ).pagination?.total;
  expectEqual(
    'duplicate-plate submission created no new application (count unchanged)',
    afterPlateDupTotal,
    beforePlateDupTotal
  );

  const ownerFilterQs = `owner_person_id=${applicantId}&limit=100`;
  const beforeRfidDup = await request(superadmin, 'GET', `/vehicle-applications?${ownerFilterQs}`);
  const beforeRfidDupTotal = (
    (beforeRfidDup.json.meta ?? {}) as { pagination?: { total?: number } }
  ).pagination?.total;
  expectEqual('application count readable before duplicate-rfid attempt', typeof beforeRfidDupTotal, 'number');

  const dupRfidApp = await request(oss, 'POST', '/vehicle-applications', {
    ...fullApplication,
    plate_no: `RBAC-A4-${appSuffix}`,
    rfid_uid: fullApplication.rfid_uid, // duplicate of the first application's UID
  });
  expectEqual('duplicate rfid_uid rejected', dupRfidApp.status, 409);

  const afterRfidDup = await request(superadmin, 'GET', `/vehicle-applications?${ownerFilterQs}`);
  const afterRfidDupTotal = (
    (afterRfidDup.json.meta ?? {}) as { pagination?: { total?: number } }
  ).pagination?.total;
  expectEqual(
    'duplicate-rfid submission created no new application (count unchanged)',
    afterRfidDupTotal,
    beforeRfidDupTotal
  );

  // I2 (unlinked filter): every application created above is linked to a
  // vehicle (create() only returns 201 once both writes succeed), so
  // linked=false must find none of THIS run's rows even though several exist
  // for this owner — proving the filter actually discriminates rather than
  // just returning everything.
  const unlinkedForOwner = await request(
    superadmin,
    'GET',
    `/vehicle-applications?owner_person_id=${applicantId}&linked=false&limit=100`
  );
  expectEqual('unlinked filter responds 200', unlinkedForOwner.status, OK);
  const unlinkedRows = (unlinkedForOwner.json.data ?? []) as { vehicle_id?: string | null }[];
  expectEqual(
    'linked=false finds none of this run\'s (fully-linked) applications',
    unlinkedRows.length,
    0
  );
  const linkedForOwner = await request(
    superadmin,
    'GET',
    `/vehicle-applications?owner_person_id=${applicantId}&linked=true&limit=100`
  );
  const linkedRows = (linkedForOwner.json.data ?? []) as { vehicle_id?: string | null }[];
  expectEqual('linked=true finds this run\'s applications', linkedRows.length > 0, true);
  expectEqual(
    'every linked=true row actually carries a vehicle_id',
    linkedRows.every((r) => !!r.vehicle_id),
    true
  );

  console.log('\n== application signatures are frozen per application ==');

  // A 1x1 transparent PNG, as raw bytes — the smallest valid signature.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );

  async function uploadAppSignature(token: string, appId: string): Promise<number> {
    const form = new FormData();
    form.append('signature', new Blob([pngBytes], { type: 'image/png' }), 'sig.png');
    const res = await fetch(`${BASE}/vehicle-applications/${appId}/signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return res.status;
  }

  expectEqual('oss uploads an application signature', await uploadAppSignature(oss, applicationId), CREATED);
  expectEqual('registrar may not upload one', await uploadAppSignature(registrar, applicationId), FORBIDDEN);

  await check('hr may read the application signature', hr, 'GET', `/vehicle-applications/${applicationId}/signature`, OK);
  await check('student may not read it', student, 'GET', `/vehicle-applications/${applicationId}/signature`, FORBIDDEN);

  // The frozen property: changing the OWNER's personSignature must not change
  // what this application shows. Both are PNGs, so compare byte length after
  // uploading a deliberately different-sized image to the person.
  const before = await fetch(`${BASE}/vehicle-applications/${applicationId}/signature`, {
    headers: { Authorization: `Bearer ${oss}` },
  });
  const beforeBytes = (await before.arrayBuffer()).byteLength;
  expectEqual('application signature has bytes', beforeBytes > 0, true);

  const personForm = new FormData();
  const biggerPng = Buffer.concat([pngBytes, Buffer.alloc(64)]);
  personForm.append('signature', new Blob([biggerPng], { type: 'image/png' }), 'sig.png');
  await fetch(`${BASE}/persons/${applicantId}/signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${superadmin}` },
    body: personForm,
  });

  const after = await fetch(`${BASE}/vehicle-applications/${applicationId}/signature`, {
    headers: { Authorization: `Bearer ${oss}` },
  });
  const afterBytes = (await after.arrayBuffer()).byteLength;
  expectEqual('the application signature is unchanged by a person re-sign', afterBytes, beforeBytes);

  // The frozen document additionally refuses a second signature outright,
  // rather than silently overwriting the first: CONFLICT, and the stored
  // bytes must be provably unchanged afterward.
  const secondUpload = await uploadAppSignature(oss, applicationId);
  expectEqual('a second signature upload is rejected', secondUpload, CONFLICT);
  const afterSecondAttempt = await fetch(`${BASE}/vehicle-applications/${applicationId}/signature`, {
    headers: { Authorization: `Bearer ${oss}` },
  });
  const afterSecondAttemptBytes = (await afterSecondAttempt.arrayBuffer()).byteLength;
  expectEqual('stored signature bytes unchanged after a rejected second upload', afterSecondAttemptBytes, afterBytes);

  console.log('\n== records (scan log) ==');

  await check('superadmin GET /logs', superadmin, 'GET', '/logs', OK);
  await check('registrar GET /logs denied', registrar, 'GET', '/logs', FORBIDDEN);
  await check('hr GET /logs denied', hr, 'GET', '/logs', FORBIDDEN);
  await check('oss GET /logs denied', oss, 'GET', '/logs', FORBIDDEN);
  await check('student GET /logs denied', student, 'GET', '/logs', FORBIDDEN);

  const logs = await request(superadmin, 'GET', '/logs?limit=50');
  const logRows = (logs.json.data as Record<string, unknown>[]) ?? [];
  // Length floor: every assertion below is vacuously true on an empty array.
  expectEqual('log rows exist to inspect', logRows.length > 0, true);

  const personRow = logRows.find((r) => r.entity_type === 'person' && r.subject !== null);
  expectEqual('a person scan row exists', Boolean(personRow), true);
  const subject = personRow!.subject as { full_name?: string } | null;
  expectEqual('subject is resolved, not an ObjectId', typeof subject?.full_name, 'string');
  expectEqual('resolved name is non-empty', (subject?.full_name ?? '').length > 0, true);

  expectEqual('rows expose a gate field', 'gate' in personRow!, true);
  const logsMeta = logs.json.meta as { pagination?: { total?: number }; truncated?: boolean } | undefined;
  expectEqual('meta exposes a total', typeof logsMeta?.pagination?.total, 'number');
  expectEqual('meta exposes a truncated flag', typeof logsMeta?.truncated, 'boolean');

  // I5: from=to=<today> must include a tap made today. This assertion is
  // able to fail: `new Date("YYYY-MM-DD")` parses as UTC midnight, so in any
  // timezone ahead of UTC the query's $lte boundary lands hours before the
  // tap's local timestamp and today's own rows silently vanish from the
  // response — the exact defect being guarded against.
  const dateCheckGates = await request(superadmin, 'GET', '/gates');
  const dateCheckGateList = (dateCheckGates.json.data ?? []) as {
    _id?: string;
    id?: string;
    name: string;
  }[];
  const dateCheckGate = dateCheckGateList.find((g) => g.name === 'Main Entrance');
  const dateCheckGateId = (dateCheckGate?._id ?? dateCheckGate?.id) as string;
  expectEqual('a gate exists for the date-filter probe tap', Boolean(dateCheckGateId), true);

  const dateCheckTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: 'A1B2C3D4',
    gate_id: dateCheckGateId,
    direction: 'exit',
  });
  expectEqual('date-filter probe tap responds 200', dateCheckTap.status, OK);
  const dateCheckTapData = dateCheckTap.json.data as { scan_time?: string } | undefined;
  expectEqual('date-filter probe tap is logged', typeof dateCheckTapData?.scan_time, 'string');

  const todayLocal = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  const todayLogs = await request(
    superadmin,
    'GET',
    `/logs?from=${todayLocal}&to=${todayLocal}&limit=200`
  );
  expectEqual('from=to=today responds 200', todayLogs.status, OK);
  const todayRows = (todayLogs.json.data ?? []) as { scan_time: string }[];
  expectEqual(
    'from=to=today returns rows made today (local-day range, not UTC-cut)',
    todayRows.length > 0,
    true
  );

  // access_result filter must actually filter.
  const deniedOnly = await request(superadmin, 'GET', '/logs?access_result=denied&limit=50');
  const deniedRows = (deniedOnly.json.data as { access_result: string }[]) ?? [];
  expectEqual('denied filter returns rows', deniedRows.length > 0, true);
  expectEqual('denied filter returns only denials', deniedRows.every((r) => r.access_result === 'denied'), true);

  // A malformed gate_id must be a clean 422, not a 500 with a leaked BSON
  // message — the same defect the anomaly report shipped with.
  await check('malformed gate_id is 422', superadmin, 'GET', '/logs?gate_id=not-an-id', 422);

  console.log('\n== soft-deleted people are invisible ==');

  const delStamp2 = Date.now();
  const ghostId = `verify-rbac-ghost-${delStamp2}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const ghostRfid = 'FEED' + (delStamp2 % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ghostRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Ghost Probe',
    type: 'student',
    id_number: ghostId,
    department_section: 'BSIT 4-A',
    rfid_uid: ghostRfid,
  });
  expectEqual('ghost probe created', ghostRes.status, CREATED);
  const ghostData = ghostRes.json.data as { _id?: string; id?: string } | undefined;
  const ghostOid = String(ghostData?._id ?? ghostData?.id ?? '');
  expectEqual('ghost has an id', ghostOid.length > 0, true);

  // Visible before deletion — establishes the check is not vacuous.
  const beforeList = await request(superadmin, 'GET', `/persons?search=${ghostId}`);
  expectEqual('ghost is listed before deletion',
    ((beforeList.json.data ?? []) as unknown[]).length, 1);

  await PersonModel.updateOne({ _id: ghostOid }, { $set: { deleted_at: new Date() } });

  const afterList = await request(superadmin, 'GET', `/persons?search=${ghostId}`);
  expectEqual('a deleted person is gone from the directory',
    ((afterList.json.data ?? []) as unknown[]).length, 0);

  const afterGet = await request(superadmin, 'GET', `/persons/${ghostOid}`);
  expectEqual('a deleted person is a 404 by id', afterGet.status, 404);

  const csv = await request(superadmin, 'GET', '/persons/export');
  expectEqual('a deleted person is absent from the CSV export',
    String(csv.json ?? '').includes(ghostId), false);

  const ghostGatesRes = await request(superadmin, 'GET', '/gates');
  const ghostGateList = (ghostGatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const personGate = ghostGateList.find((g) => g.name === 'Main Entrance');
  const personGateId = (personGate?._id ?? personGate?.id) as string;
  expectEqual('a person gate exists for the ghost tap', Boolean(personGateId), true);

  // The card must be refused as if it were never registered. This is what catches
  // the repository-filter mistake: if findByRfid still resolves a deleted person,
  // the gate grants while the directory says they are gone.
  const ghostTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: ghostRfid,
    gate_id: personGateId,
    direction: 'entry',
  });
  const ghostBody = ghostTap.json.data as { access_result?: string; reason?: string; person?: unknown };
  expectEqual('a deleted person is denied at the gate', ghostBody?.access_result, 'denied');
  expectEqual('the reason is unregistered_uid', ghostBody?.reason, 'unregistered_uid');
  expectEqual('a deleted person leaks no identity', ghostBody?.person, undefined);

  console.log('\n== blocked cards ==');

  const blkStamp = Date.now();
  const blkSuffix = (blkStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const oldUid = 'BEEF' + blkSuffix;
  const newUid = 'CAFE' + blkSuffix;

  const holderRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Card Holder Probe',
    type: 'student',
    id_number: `verify-rbac-card-${blkStamp}`, // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: oldUid,
  });
  expectEqual('card holder created', holderRes.status, CREATED);
  const holder = holderRes.json.data as { _id?: string; id?: string } | undefined;
  const holderId = String(holder?._id ?? holder?.id ?? '');

  // Replace the card. The old UID must die.
  const replaced = await request(superadmin, 'PATCH', `/persons/${holderId}/rfid`, { rfid_uid: newUid });
  expectEqual('card replaced', replaced.status, OK);

  // 1. The old card is refused at the gate, as BLOCKED, with no identity.
  const blockedTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: oldUid, gate_id: personGateId, direction: 'entry',
  });
  const blockedBody = blockedTap.json.data as { access_result?: string; reason?: string; person?: unknown };
  expectEqual('a replaced card is denied', blockedBody?.access_result, 'denied');
  expectEqual('the reason is card_blocked', blockedBody?.reason, 'card_blocked');
  expectEqual('a blocked card leaks no identity', blockedBody?.person, undefined);

  // 2. The new card works. Release the occupancy it creates.
  const newTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: newUid, gate_id: personGateId, direction: 'entry',
  });
  expectEqual('the new card is granted', (newTap.json.data as { access_result?: string })?.access_result, 'granted');
  await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: newUid, gate_id: personGateId, direction: 'exit',
  });

  // 3. The block holds at the point of issue, on every path.
  await check('a blocked UID cannot be registered to a person', superadmin, 'POST', '/persons', 409, {
    full_name: 'Blocked Reuse Probe', type: 'student',
    id_number: `verify-rbac-card-b-${blkStamp}`, rfid_uid: oldUid,
  });
  await check('a blocked UID cannot be reassigned', superadmin, 'PATCH', `/persons/${holderId}/rfid`, 409, {
    rfid_uid: oldUid,
  });
  await check('a blocked UID cannot be given to a vehicle', oss, 'POST', '/vehicles', 409, {
    owner_person_id: holderId, plate_number: `BLK-${blkSuffix}`,
    rfid_uid: oldUid, vehicle_type: 'pickup', make: 'Toyota',
  });

  // 4. A blocked tap must not move occupancy — it is a denial like any other.
  const rosterAfterBlocked = await request(superadmin, 'GET', '/occupancy?limit=100');
  expectEqual('occupancy roster read succeeded', rosterAfterBlocked.status, OK);
  const insideNames = ((rosterAfterBlocked.json.data ?? []) as { name?: string }[]);
  expectEqual('a blocked tap put nobody inside',
    insideNames.some((r) => r.name === 'Card Holder Probe'), false);

  console.log('\n== delete cascades, restore does not re-admit ==');

  // Build a person with a login AND a vehicle, so the cascade has all three targets.
  const vicStamp = Date.now();
  const vicSuffix = (vicStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const victimUid = 'DEAD' + vicSuffix;
  const victimUsername = `verify-del-${vicStamp}`;        // prefix: PROBE_USER_USERNAME_PREFIXES

  const vicRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Cascade Victim Probe',
    type: 'student',
    id_number: `verify-rbac-vic-${vicStamp}`,             // prefix: PROBE_PERSON_ID_PREFIXES
    department_section: 'BSIT 4-A',
    rfid_uid: victimUid,
  });
  expectEqual('cascade victim created', vicRes.status, CREATED);
  const vicData = vicRes.json.data as { _id?: string; id?: string } | undefined;
  const victimId = String(vicData?._id ?? vicData?.id ?? '');
  expectEqual('cascade victim has an id', victimId.length > 0, true);

  const vicLogin = await request(superadmin, 'POST', '/users', {
    username: victimUsername, password: 'Verify@12345', role: 'student', person_id: victimId,
  });
  expectEqual('cascade victim login created', vicLogin.status, CREATED);

  const victimVehicleUid = 'FACE' + vicSuffix;
  const vicVeh = await request(oss, 'POST', '/vehicles', {
    owner_person_id: victimId,
    plate_number: `RBAC-VIC-${vicSuffix}`,                // prefix: PROBE_VEHICLE_PLATE_PREFIXES
    rfid_uid: victimVehicleUid,
    vehicle_type: 'pickup',
    make: 'Toyota',
  });
  expectEqual('cascade victim vehicle created', vicVeh.status, CREATED);
  const vicVehData = vicVeh.json.data as { _id?: string; id?: string } | undefined;
  const victimVehicleId = String(vicVehData?._id ?? vicVehData?.id ?? '');
  expectEqual('cascade victim vehicle has an id', victimVehicleId.length > 0, true);

  await check('registrar cannot delete a person', registrar, 'DELETE', `/persons/${victimId}`, FORBIDDEN);
  await check('hr cannot delete a person', hr, 'DELETE', `/persons/${victimId}`, FORBIDDEN);
  await check('superadmin deletes the person', superadmin, 'DELETE', `/persons/${victimId}`, OK);

  // The cascade reached all three.
  const gone = await request(superadmin, 'GET', `/persons/${victimId}`);
  expectEqual('the person is gone', gone.status, 404);

  const vehAfter = await request(superadmin, 'GET', `/vehicles?limit=100`);
  const theirVehicle = ((vehAfter.json.data ?? []) as { _id: string; status: string }[])
    .find((v) => v._id === victimVehicleId);
  expectEqual('their vehicle still exists', Boolean(theirVehicle), true);
  expectEqual('their vehicle is deactivated', theirVehicle?.status, 'inactive');

  const loginAfter = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: victimUsername, password: 'Verify@12345' }),
  });
  expectEqual('their login no longer authenticates', loginAfter.status, 401);

  // Their card is blocked, not merely unregistered. Same superadmin-token tap
  // convention every other tap in this file uses. personGateId was already
  // resolved above, in the soft-deleted-people block.
  const victimTap = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: victimUid, gate_id: personGateId, direction: 'entry',
  });
  expectEqual('their card is blocked', (victimTap.json.data as { reason?: string })?.reason, 'card_blocked');

  // Their VEHICLE's tag is refused too — proving the cascade reached it.
  // Resolve a vehicle gate the same way: GET /gates, find 'Parking Entrance'.
  const cascadeGatesRes = await request(superadmin, 'GET', '/gates');
  const cascadeGateList = (cascadeGatesRes.json.data ?? []) as { _id?: string; id?: string; name: string }[];
  const cascadeParkingGate = cascadeGateList.find((g) => g.name === 'Parking Entrance');
  const vehicleGateId = (cascadeParkingGate?._id ?? cascadeParkingGate?.id) as string;
  expectEqual('a vehicle gate exists for the cascade tap', Boolean(vehicleGateId), true);

  const vehTapAfter = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: victimVehicleUid, gate_id: vehicleGateId, direction: 'entry',
  });
  expectEqual('their vehicle is refused at the barrier',
    (vehTapAfter.json.data as { access_result?: string })?.access_result, 'denied');

  // I5: personRepo.findById is deleted-filtered, so it returns null for BOTH
  // a dangling person_id AND a soft-deleted person — those used to be
  // treated as the same case (assertCanActOnPersonBackedAccount returning
  // early on either), which skipped the domain guard for exactly the
  // accounts the cascade above just deactivated. Registrar outranks a
  // student account and HR outranks nobody's domain here either, so both
  // must still be refused; only a superadmin may act on a person-backed
  // login whose person was soft-deleted. Run this on the still-deleted
  // victim, BEFORE restore below clears deleted_at.
  const vicLoginData = vicLogin.json.data as { id?: string; _id?: string } | undefined;
  const vicLoginId = String(vicLoginData?.id ?? vicLoginData?._id ?? '');
  expectEqual('cascade victim login has an id', vicLoginId.length > 0, true);

  await check(
    'HR cannot reactivate a deleted student\'s login',
    hr, 'PATCH', `/users/${vicLoginId}/status`, FORBIDDEN, { active: true }
  );
  await check(
    'registrar cannot reactivate a deleted student\'s login either',
    registrar, 'PATCH', `/users/${vicLoginId}/status`, FORBIDDEN, { active: true }
  );
  const vicLoginStillOut = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: victimUsername, password: 'Verify@12345' }),
  });
  expectEqual('the refused reactivation attempts left the login unusable',
    vicLoginStillOut.status, 401);

  console.log('\n== I2b (fix wave 2): the BULK path cannot resurrect a deleted person\'s login ==');

  // The single-account path (just above) was already fixed. buildFilter's
  // person lookup and resolveBulkTargets' own person lookup both used to
  // resolve people with no deleted_at predicate at all, so a *bulk* activate
  // could still reach this exact still-deleted victim — a hole the
  // single-account fix does nothing to close. Two lookups, two assertions.

  // (a) buildFilter: a personFilter query (search/type/department_section)
  // naming this deleted victim specifically must resolve to zero users, not
  // find them and hand them to resolveBulkTargets. `search` is unique to this
  // probe's id_number, so this cannot accidentally match a real person.
  const bulkSearchMatch = await request(superadmin, 'POST', '/users/bulk-status', {
    active: true,
    filter: { search: `verify-rbac-vic-${vicStamp}` },
  });
  const bulkSearchMatchData = (bulkSearchMatch.json.data ?? {}) as { matched?: number; modified?: number };
  expectEqual('bulk activate by search naming the deleted victim responds 200', bulkSearchMatch.status, OK);
  expectEqual(
    'a search filter naming a deleted person matches zero candidates (buildFilter excludes them)',
    bulkSearchMatchData.matched,
    0
  );

  // (b) resolveBulkTargets: an EMPTY filter (`filter: {}`) skips buildFilter's
  // person query entirely (see buildFilter's early return) and candidates
  // come from the User collection alone — resolveBulkTargets' own person
  // lookup is the only remaining gate for that path, which is exactly the
  // "even filter: {} reaches them" case. Called directly (not over HTTP) so
  // this assertion has zero blast radius: it inspects the target *list*
  // resolveBulkTargets would produce for a real registrar, rather than
  // actually running the mutation against every student account.
  const registrarUserDoc = await UserModel.findOne({ username: 'testregistrar' }).lean();
  const registrarActorId = String((registrarUserDoc as unknown as { _id?: unknown } | null)?._id ?? '');
  expectEqual('registrar user id resolved for the direct resolveBulkTargets check', registrarActorId.length > 0, true);

  const directTargets = await userService.resolveBulkTargets({}, { id: registrarActorId, role: 'registrar' });
  expectEqual(
    'resolveBulkTargets with an empty filter excludes a soft-deleted person\'s login',
    directTargets.targets.includes(vicLoginId),
    false
  );

  // Assert the STORED value, not just response counts — a count-only check
  // (e.g. "modified: 0") would pass even against the broken build if the
  // write happened to be a no-op for some unrelated reason. Read straight
  // from Mongo.
  const vicLoginRowAfterBulk = await UserModel.findById(vicLoginId).lean();
  expectEqual(
    'the deleted victim\'s login is still is_active: false after both bulk attempts',
    (vicLoginRowAfterBulk as unknown as { is_active?: boolean } | null)?.is_active,
    false
  );

  // Restore returns the record, not access.
  await check('registrar cannot restore', registrar, 'POST', `/persons/${victimId}/restore`, FORBIDDEN);
  await check('superadmin restores', superadmin, 'POST', `/persons/${victimId}/restore`, OK);
  const victimRestored = await request(superadmin, 'GET', `/persons/${victimId}`);
  expectEqual('the person is back', victimRestored.status, OK);
  expectEqual('restored inactive, not active',
    (victimRestored.json.data as { status?: string })?.status, 'inactive');
  expectEqual('restored with no card',
    (victimRestored.json.data as { rfid_uid?: string })?.rfid_uid ?? null, null);

  const vehStill = await request(superadmin, 'GET', '/vehicles?limit=100');
  expectEqual('restore did NOT reactivate their vehicle',
    ((vehStill.json.data ?? []) as { _id: string; status: string }[])
      .find((v) => v._id === victimVehicleId)?.status, 'inactive');

  // Their old card is still blocked after restore — restore is not an undo
  // for the card, only for the record.
  const victimTapAfterRestore = await request(superadmin, 'POST', '/scan/tap', {
    rfid_uid: victimUid, gate_id: personGateId, direction: 'entry',
  });
  expectEqual('their card is still blocked after restore',
    (victimTapAfterRestore.json.data as { reason?: string })?.reason, 'card_blocked');

  console.log('\n== GET /persons/deleted: the only way to find someone to restore ==');

  // A fresh throwaway, never a seeded fixture — deletion is one-way at the
  // database level even though restore exists, and this proves the recovery
  // path stays reachable after the deleting page reloads (no session-only
  // client state involved, since this harness never held one).
  const dlistStamp = Date.now();
  const dlistIdNumber = `verify-rbac-dlist-${dlistStamp}`; // prefix: PROBE_PERSON_ID_PREFIXES
  const dlistRfid = 'FACE' + (dlistStamp % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  const dlistRes = await request(superadmin, 'POST', '/persons', {
    full_name: 'Deleted List Probe',
    type: 'student',
    id_number: dlistIdNumber,
    department_section: 'BSIT 4-A',
    rfid_uid: dlistRfid,
  });
  expectEqual('deleted-list probe created', dlistRes.status, CREATED);
  const dlistPersonId = idOf(dlistRes);
  expectEqual('deleted-list probe has an id', dlistPersonId.length > 0, true);

  // Authorization first, on the not-yet-deleted probe — proves the route is
  // superadmin-only regardless of what it returns.
  await check('registrar cannot list deleted persons', registrar, 'GET', '/persons/deleted', FORBIDDEN);
  await check('hr cannot list deleted persons', hr, 'GET', '/persons/deleted', FORBIDDEN);
  await check('superadmin can list deleted persons', superadmin, 'GET', '/persons/deleted', OK);

  await check('superadmin deletes the deleted-list probe', superadmin, 'DELETE', `/persons/${dlistPersonId}`, OK);

  // Both halves, asserted separately: a build that returned everyone from
  // /persons/deleted (no deleted_at filter at all) would still pass "probe
  // present" alone, and a build that still excluded deleted rows entirely
  // would pass "absent from /persons" alone. Only both together prove the
  // new read actually targets deleted_at: { $ne: null }.
  const deletedListRes = await request(superadmin, 'GET', `/persons/deleted?search=${dlistIdNumber}`);
  expectEqual('GET /persons/deleted responds 200', deletedListRes.status, OK);
  const deletedListRows = (deletedListRes.json.data ?? []) as { _id?: string; id?: string }[];
  expectEqual(
    'the deleted probe appears in GET /persons/deleted',
    deletedListRows.some((p) => String(p._id ?? p.id) === dlistPersonId),
    true
  );

  const activeListRes = await request(superadmin, 'GET', `/persons?search=${dlistIdNumber}`);
  const activeListRows = (activeListRes.json.data ?? []) as unknown[];
  expectEqual('the deleted probe is absent from GET /persons', activeListRows.length, 0);

  // Restore it, both to prove the endpoint's whole reason for existing
  // (finding someone to restore) and to leave the run in the same
  // re-runnable state every other section here does.
  await check('superadmin restores the deleted-list probe', superadmin, 'POST', `/persons/${dlistPersonId}/restore`, OK);
  const deletedListAfterRestore = await request(superadmin, 'GET', `/persons/deleted?search=${dlistIdNumber}`);
  const deletedListAfterRestoreRows = (deletedListAfterRestore.json.data ?? []) as { _id?: string; id?: string }[];
  expectEqual(
    'the restored probe is gone from GET /persons/deleted',
    deletedListAfterRestoreRows.some((p) => String(p._id ?? p.id) === dlistPersonId),
    false
  );
}

/**
 * Prefixes this harness uses for the probe Person/User/Vehicle records it
 * creates. `DELETE /persons/:id` exists now (Task 3) but only soft-deletes —
 * the row survives with deleted_at set, exactly like `DELETE /users/:id` —
 * and there is still no `DELETE /vehicles/:id` at all (see the module
 * comments above the "person write domains" and "vehicle write domain"
 * sections), so cleanup still has to go straight at the database to actually
 * remove rows — the same pattern rebuildOccupancy.ts uses for config-script
 * DB access. Every prefix here was found by grepping this file for the
 * literal strings passed as `id_number`/`username`/`plate_number`, not
 * guessed:
 *   - Person.id_number: 'verify-rbac-' (student/staff/vehicle-owner probes,
 *     including the cascade-delete/restore victim), 'verify-del-' (the
 *     deletion-test throwaway, left 'inactive' rather than removed by
 *     DELETE /users/:id).
 *   - User.username: 'verify-stu-' and 'verify-reg2-' (created and never
 *     touched again), 'verify-del-' (soft-deleted by DELETE /users/:id,
 *     which sets deleted_at but does not remove the document).
 *   - Vehicle.plate_number: 'RBAC-' (seeded plates use 'NCST-', see
 *     testSeed.ts — 'RBAC-' never collides with a fixture). Each run's
 *     vehicle probe's owner Person is removed by PROBE_PERSON_ID_PREFIXES
 *     above, so leaving the vehicle behind would orphan it — a strictly
 *     worse defect than the original leak, since GET /vehicles has the same
 *     100-row page cap as /persons and /users.
 *   - VehicleApplication.plate_no: same 'RBAC-' prefix, reused rather than a
 *     separate array — an application's plate_no and the vehicle it creates
 *     always share the same probe plate, and there is deliberately no
 *     `PATCH`/`DELETE /vehicle-applications/:id` route either (immutability
 *     is the point of that collection), so this is the only way to remove
 *     probe applications too. A future probe prefix that only ever touches
 *     applications (not vehicles) would need its own array — none exists yet.
 * Matching by prefix — not by this run's own stamp — means a run also mops
 * up any litter left by earlier, pre-fix runs, and it is structurally unable
 * to touch a seeded fixture: no seeded username, id_number, or plate_number
 * starts with any of these prefixes.
 *
 * If a future edit adds a new probe-creating call site, grep for
 * "prefix: PROBE_" comments at each existing creation site — every one names
 * the constant it must be added to. There is no automated check tying a new
 * prefix to these arrays (no test framework exists to host one); see the
 * report for a proposal on what a cheap automated guard could look like.
 */
const PROBE_PERSON_ID_PREFIXES = ['verify-rbac-', 'verify-del-'];
const PROBE_USER_USERNAME_PREFIXES = [
  'verify-stu-',
  'verify-reg2-',
  'verify-del-',
  // Expected-403 probes below (registrar/hr/oss trying to mint a peer or a
  // superadmin) never create a row on the pass path, which is exactly why
  // this list previously omitted them — but the run that matters most is
  // the one where the guard under test REGRESSES: the POST that should have
  // been denied instead succeeds, and now the account it names is real and
  // stays real, live, at `superadmin` in `rbac-peer-super`'s case. Cleanup
  // must cover the failure path, not just the path where everything already
  // worked.
  'verify-reg-', // registrar POSTs a would-be registrar/superadmin login
  'verify-sa-',  // registrar POSTs a would-be superadmin login
  'rbac-', // rbac-peer-hr, rbac-peer-reg, rbac-peer-super, rbac-api-super, rbac-oss-login, rbac-no-such-user
];
const PROBE_VEHICLE_PLATE_PREFIXES = ['RBAC-'];
// BlockedCard.rfid_uid: 'BEEF' (the outgoing UID retired by the blocked-cards
// block's PATCH /persons/:id/rfid — see the '== blocked cards ==' section
// above), 'DEAD' (the cascade victim's person UID, blocked by softDelete —
// see the '== delete cascades, restore does not re-admit ==' section below),
// 'FACE' (the '== GET /persons/deleted ==' probe's own rfid_uid, blocked by
// softDelete when that probe is removed through DELETE /persons/:id — NOT
// the vehicle-owner or cascade-victim's vehicle tag, also 'FACE'-prefixed
// elsewhere in this file, which softDelete never blocks because it only
// blocks the deleted PERSON's own rfid_uid, and those two are removed via a
// direct DB delete in cleanupProbes(), not the endpoint under test), 'FEED'
// (the I4 vehicle-reactivation probe's own person rfid_uid, blocked the same
// way as the 'FACE' dlist probe when DELETE /persons/:id removes it — NOT
// its vehicle's 'FED0'/'FED1'-prefixed tags, which softDelete never touches).
// The replacement UID ('CAFE'-prefixed) is never blocked during this
// harness, so it needs no prefix of its own here.
const PROBE_BLOCKED_CARD_PREFIXES = ['BEEF', 'DEAD', 'FACE', 'FEED'];

/**
 * Removes every Person/User/Vehicle/VehicleApplication row this harness has
 * ever created (this run's and any earlier run's), so the collections stop
 * growing. Must run even when `runChecks()` throws or logs failures — see the
 * try/finally around its call in `main()` — but must never itself change the
 * process exit code; `summary()` is what decides pass/fail, and it runs after
 * this, untouched.
 *
 * Applications are deleted before Vehicles, and Vehicles before Persons: a
 * probe Application's vehicle_id points at a probe Vehicle, which in turn
 * points at a probe Person via owner_person_id, and while Mongo enforces no
 * real foreign key here, deleting the referencing row first keeps the
 * intermediate DB state consistent (never an Application pointing at an
 * already-deleted Vehicle, nor a Vehicle pointing at an already-deleted
 * Person) in case this function is ever interrupted between the deletes.
 */
async function cleanupProbes(): Promise<void> {
  console.log('\n== cleanup: removing probe records this harness created ==');
  // Connection lifecycle is owned by main() (connectDB()/disconnectDB() wrap
  // both runChecks() and this call) rather than opened and closed here,
  // because runChecks() now needs a live connection too — grantSuperadmin()
  // reads/writes UserModel directly, not over HTTP like the rest of the
  // harness. Connecting only once per run also means this function's own
  // deleteMany calls below share that same connection instead of racing a
  // second connect/disconnect pair around it.
  const vehicleRegex = new RegExp(`^(${PROBE_VEHICLE_PLATE_PREFIXES.join('|')})`);
  const personRegex = new RegExp(`^(${PROBE_PERSON_ID_PREFIXES.join('|')})`);
  const userRegex = new RegExp(`^(${PROBE_USER_USERNAME_PREFIXES.join('|')})`);
  const blockedCardRegex = new RegExp(`^(${PROBE_BLOCKED_CARD_PREFIXES.join('|')})`);

  // BlockedCard rows reference a probe Person via previous_person_id, so they
  // must go before the Person delete below — mirroring the
  // Application-before-Vehicle-before-Person ordering already used here. An
  // accumulation defect from getting this order wrong has broken these
  // harnesses twice before.
  const blockedCardResult = await BlockedCardModel.deleteMany({
    rfid_uid: { $regex: blockedCardRegex },
  });

  // ApplicationSignature has no probe prefix of its own — it hangs off
  // application_id, so the probe applications must be looked up first and
  // their signatures deleted before the applications themselves go, mirroring
  // the ordering below that deletes Vehicles before Persons: never delete a
  // row before the thing that references it.
  const probeApplications = await VehicleApplicationModel.find({
    plate_no: { $regex: vehicleRegex },
  })
    .select('_id')
    .lean();
  const signatureResult = await ApplicationSignatureModel.deleteMany({
    application_id: { $in: probeApplications.map((a) => a._id) },
  });

  // VehicleApplication has no unique/DELETE-able probe id of its own — it
  // reuses the same 'RBAC-' plate prefix as the Vehicle it creates (see the
  // PROBE_VEHICLE_PLATE_PREFIXES comment above), and must go first: a probe
  // application whose Vehicle was already deleted would otherwise be an
  // application pointing at a vanished vehicle_id.
  const applicationResult = await VehicleApplicationModel.deleteMany({
    plate_no: { $regex: vehicleRegex },
  });
  const vehicleResult = await VehicleModel.deleteMany({ plate_number: { $regex: vehicleRegex } });
  const personResult = await PersonModel.deleteMany({ id_number: { $regex: personRegex } });
  const userResult = await UserModel.deleteMany({ username: { $regex: userRegex } });

  console.log(
    `  removed ${signatureResult.deletedCount} probe application signature(s) (application_id matching probe applications)`
  );
  console.log(
    `  removed ${applicationResult.deletedCount} probe vehicle application(s) (plate_no matching ${PROBE_VEHICLE_PLATE_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${vehicleResult.deletedCount} probe vehicle(s) (plate_number matching ${PROBE_VEHICLE_PLATE_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${blockedCardResult.deletedCount} probe blocked card(s) (rfid_uid matching ${PROBE_BLOCKED_CARD_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${personResult.deletedCount} probe person(s) (id_number matching ${PROBE_PERSON_ID_PREFIXES.join(', ')})`
  );
  console.log(
    `  removed ${userResult.deletedCount} probe user(s) (username matching ${PROBE_USER_USERNAME_PREFIXES.join(', ')})`
  );
}

/**
 * Cleanup must run whether runChecks() throws, logs soft failures, or passes
 * cleanly — a red run must never leak probe records. The try/finally is what
 * guarantees that: `finally` runs on every exit path out of the `try`,
 * including a thrown error, before that error propagates.
 *
 * Exit-code correctness is the other half of the contract. `summary()` is
 * the ONLY thing allowed to decide the process exit code (via its
 * `process.exit(1)` on failure), and it must run strictly after cleanup so
 * a red run's non-zero exit is never skipped:
 *   - runChecks() throws  -> finally cleans up -> the throw re-propagates
 *     past summary() (never called) -> caught below -> process.exit(1).
 *   - runChecks() returns with soft failures logged -> finally cleans up ->
 *     summary() runs and calls process.exit(1) itself.
 *   - runChecks() returns clean -> finally cleans up -> summary() prints the
 *     pass message and returns -> normal exit 0.
 * Nothing in cleanupProbes() calls process.exit or swallows an error, so it
 * cannot mask a failure in either direction.
 */
async function main(): Promise<void> {
  // Connect once, up front: runChecks() now calls grantSuperadmin() directly
  // (not over HTTP), which reads/writes UserModel and needs a live mongoose
  // connection before that call runs, not just during cleanupProbes() at the
  // end. Disconnect happens in the outer finally so it still runs on every
  // exit path, same guarantee as before.
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
  console.error('\nverifyRoles crashed:', err);
  process.exit(1);
});
