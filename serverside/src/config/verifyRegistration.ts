/**
 * Asserts registration-created logins from
 * docs/superpowers/specs/2026-08-07-registration-login-and-profile-devices-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:registration
 *
 * Restores everything it changes: every person it creates is soft-deleted in a
 * `finally`, and every LOGIN created along with a person is hard-deleted
 * (DELETE /users/:id) in the same `finally`, so re-running the harness is
 * safe. Soft-deleting the person alone is not enough — persons.service's
 * softDelete deactivates the linked login but never sets the User's
 * deleted_at, so it would stay visible in GET /users forever and permanently
 * exclude itself from bulk reactivation checks (see verifyRoles).
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
  console.log('All registration checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;
const CONFLICT = 409;
const VALIDATION = 422;

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
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Unique per run so repeated runs never collide on id_number. */
const STAMP = Date.now().toString().slice(-8);
const STUDENT_ID = `T${STAMP}`;
const STAFF_ID = `S${STAMP}`;
const PASSWORD = 'RegTest@123';
const NEW_PASSWORD = 'RegTest@456';

async function main(): Promise<void> {
  const admin = await login('testadmin', 'Admin@123');
  const registrar = await login('testregistrar', 'Registrar@123');
  const created: string[] = [];
  // Usernames of every login this run creates (currently just STUDENT_ID via
  // the first registration), so the finally block can hard-delete them and
  // leave no dead row behind. See the docblock above for why a soft-delete of
  // the person alone is not sufficient.
  const createdLogins: string[] = [];

  try {
    // --- a registrar registering a student with a password gets a login ---
    const reg = await request(registrar, 'POST', '/persons', {
      full_name: 'Reg Test Student',
      type: 'student',
      id_number: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('register student with password -> 201', reg.status, CREATED);
    const person = reg.json.data as { _id?: string; login_created?: boolean } | undefined;
    expectEqual('response reports login_created', person?.login_created, true);
    if (person?._id) created.push(person._id);
    if (person?.login_created) createdLogins.push(STUDENT_ID);

    // --- that login actually works, and carries the forced-change flag ---
    const auth = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('new student can sign in', auth.status, OK);
    const authed = auth.json.data as
      | { user?: { role?: string; mustChangePassword?: boolean } }
      | undefined;
    expectEqual('new login has the student role', authed?.user?.role, 'student');
    expectEqual('new login must change password', authed?.user?.mustChangePassword, true);

    // --- a password shorter than the minimum is rejected outright ---
    const short = await request(registrar, 'POST', '/persons', {
      full_name: 'Too Short',
      type: 'student',
      id_number: `${STUDENT_ID}X`,
      password: 'short',
    });
    expectEqual('password under 8 chars -> 422', short.status, VALIDATION);

    // --- a duplicate id_number is refused by the existing check ---
    const dupId = await request(registrar, 'POST', '/persons', {
      full_name: 'Duplicate Id',
      type: 'student',
      id_number: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('duplicate id_number -> 409', dupId.status, CONFLICT);

    // --- and a username taken by a login with NO matching person is refused
    // too. This is the case the new pre-check exists for: 'testhr' is a seeded
    // office login with no Person row, so the id_number check above cannot see
    // it. Without the username pre-check this would create the person and then
    // fail on the user insert, exercising the rollback path instead of failing
    // clean.
    const dupUser = await request(admin, 'POST', '/persons', {
      full_name: 'Username Collision',
      type: 'student',
      id_number: 'testhr',
      password: PASSWORD,
    });
    expectEqual('username taken by an office login -> 409', dupUser.status, CONFLICT);
    expectEqual('and reports DUPLICATE_USERNAME', dupUser.json.code, 'DUPLICATE_USERNAME');

    // --- that refusal left no person behind either ---
    const collisionHunt = await request(admin, 'GET', '/persons?search=testhr');
    const collisionRows = (collisionHunt.json.data ?? []) as unknown[];
    expectEqual('username collision left no person behind', collisionRows.length, 0);

    // --- domain rule still holds: a registrar cannot create a staff login ---
    const crossDomain = await request(registrar, 'POST', '/persons', {
      full_name: 'Reg Test Staff',
      type: 'staff',
      id_number: STAFF_ID,
      password: PASSWORD,
    });
    expectEqual('registrar registering staff -> 403', crossDomain.status, FORBIDDEN);

    // --- and the refused staff person was never created ---
    const orphanHunt = await request(admin, 'GET', `/persons?search=${STAFF_ID}`);
    const rows = (orphanHunt.json.data ?? []) as unknown[];
    expectEqual('refused registration left no person behind', rows.length, 0);

    // --- omitting the password still creates a person-only record ---
    const noPass = await request(admin, 'POST', '/persons', {
      full_name: 'No Login Person',
      type: 'student',
      id_number: `${STUDENT_ID}N`,
    });
    expectEqual('person without password -> 201', noPass.status, CREATED);
    const bare = noPass.json.data as { _id?: string; login_created?: boolean } | undefined;
    expectEqual('no login reported', bare?.login_created, false);
    if (bare?._id) created.push(bare._id);

    // --- change password: wrong current password is refused ---
    const studentToken = await login(STUDENT_ID, PASSWORD);
    const wrongCurrent = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: 'NotMyPassword@1',
      newPassword: NEW_PASSWORD,
    });
    expectEqual('change with wrong current password -> 401', wrongCurrent.status, 401);

    // --- reusing the current password defeats the forced change ---
    const sameAgain = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expectEqual('reusing the current password -> 422', sameAgain.status, VALIDATION);

    // --- the happy path ---
    const changed = await request(studentToken, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectEqual('change password -> 200', changed.status, OK);

    // --- the old password no longer works ---
    const oldPass = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: PASSWORD,
    });
    expectEqual('old password rejected after change', oldPass.status, 401);

    // --- the new one does, and the forced-change flag is cleared ---
    const newPass = await request(null, 'POST', '/auth/login', {
      username: STUDENT_ID,
      password: NEW_PASSWORD,
    });
    expectEqual('new password accepted', newPass.status, OK);
    const after = newPass.json.data as
      | { user?: { mustChangePassword?: boolean } }
      | undefined;
    expectEqual('must_change_password cleared', after?.user?.mustChangePassword, false);

    // --- an anonymous caller cannot reach the endpoint at all ---
    const anon = await request(null, 'POST', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expectEqual('unauthenticated change -> 401', anon.status, 401);
  } finally {
    // Hard-delete the login(s) FIRST, while the person row (and its search
    // fields) still exist to find them by. persons.service's softDelete
    // (triggered by DELETE /persons/:id below) deactivates the login but
    // never sets the User's deleted_at, so without this the row would stay
    // visible in GET /users forever and permanently excluded from bulk
    // reactivation — exactly the leak that broke verify:roles.
    for (const username of createdLogins) {
      const found = await request(admin, 'GET', `/users?search=${encodeURIComponent(username)}`);
      const rows = (found.json.data ?? []) as { id?: string; _id?: string; username?: string }[];
      const row = rows.find((r) => r.username === username);
      const userId = row?.id ?? row?._id;
      if (userId) {
        await request(admin, 'DELETE', `/users/${userId}`).catch(() => undefined);
      }
    }
    for (const id of created) {
      await request(admin, 'DELETE', `/persons/${id}`).catch(() => undefined);
    }
  }

  summary();
}

main().catch((err) => {
  console.error('[verify:registration] harness error', err);
  process.exit(1);
});
