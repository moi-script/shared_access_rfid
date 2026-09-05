/**
 * Asserts that issuing a replacement card clears the directory's red row.
 *
 * The no-card flag is not a field on the person — it is derived live from the
 * scan log (persons.service.manualEntriesFor / manualEntryPersonIds), so
 * "clearing" it is not a matter of unsetting anything. reassignRfid settles
 * the outstanding MANUAL: passages instead, and these checks are what say the
 * two halves are actually wired to each other:
 *
 *   1. Hand-typed passages make the person red and put them on the no-card
 *      filter's list.
 *   2. Replacing their card takes them off it, in the same breath.
 *   3. The badge's count follows: a passage settled by a reissue is not
 *      merely hidden, it stops being counted.
 *   4. Losing the NEW card puts them back — the flag tracks the current card,
 *      not a one-time forgiveness.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:no-card
 *
 * Cleans up after itself: the probe person is erased in a `finally`.
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
  console.log('All no-card resolution checks passed.');
}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000/api';

const OK = 200;
const CREATED = 201;

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

interface DirectoryRow {
  _id: string;
  full_name: string;
  rfid_uid: string | null;
  manual_entry_at: string | null;
  manual_entry_count: number;
}

interface TapResult {
  access_result?: string;
  reason?: string;
}

async function main(): Promise<void> {
  const superadmin = await login('testadmin', 'Admin@123');

  const idNumber = `NC${RUN}`;
  let personId = '';

  /**
   * The directory row as the clerk sees it. Searched by id_number rather than
   * fetched by id, because what is under test is the LIST projection — the
   * per-person read does not compute manual_entry_at at all, so asserting
   * against it would pass no matter what the helpers do.
   */
  async function row(filter = ''): Promise<DirectoryRow | undefined> {
    const res = await request(superadmin, 'GET', `/persons?search=${idNumber}${filter}`);
    const rows = (res.json.data ?? []) as DirectoryRow[];
    return rows.find((r) => r._id === personId);
  }

  try {
    console.log('\n--- setup: a person holding a card, and the two person gates');
    const person = await request(superadmin, 'POST', '/persons', {
      full_name: `No Card Probe ${RUN}`,
      type: 'student',
      id_number: idNumber,
      department_section: `NOCARD-PROBE-${RUN}`,
      rfid_uid: hex(1),
    });
    expectEqual('probe person created', person.status, CREATED);
    personId = idOf(person.json);

    const gates = await request(superadmin, 'GET', '/gates');
    const gateRows = (gates.json.data ?? []) as { _id: string; name: string; type: string }[];
    const entryGate = gateRows.find((g) => g.name === 'Main Entrance');
    const exitGate = gateRows.find((g) => g.name === 'Side Gate');
    if (!entryGate || !exitGate) throw new Error('seed gates missing — run npm run seed:test');

    // A hand-typed passage is only granted at a person gate: a student number
    // identifies a person, not a car (scan.service, manual_entry_wrong_gate).
    const typeIn = (gate: string, direction: 'entry' | 'exit') =>
      request(superadmin, 'POST', '/scan/tap', { id_number: idNumber, gate_id: gate, direction });

    console.log('\n--- a guard waves them through twice, by ID number');
    const first = await typeIn(entryGate._id, 'entry');
    expectEqual('manual entry granted', (first.json.data as TapResult)?.access_result, 'granted');
    expectEqual('manual entry is logged as such', (first.json.data as TapResult)?.reason, 'manual_id_entry');
    const second = await typeIn(exitGate._id, 'exit');
    expectEqual('manual exit granted', (second.json.data as TapResult)?.access_result, 'granted');

    console.log('\n--- the directory turns them red, and the follow-up filter finds them');
    const flagged = await row();
    expectEqual('row counts both passages', flagged?.manual_entry_count, 2);
    expectEqual('row carries a last-seen date', typeof flagged?.manual_entry_at, 'string');
    expectEqual('row is on the no-card list', (await row('&manual_entry=true')) !== undefined, true);

    console.log('\n--- OSS issues the replacement card');
    const replaced = await request(superadmin, 'PATCH', `/persons/${personId}/rfid`, {
      rfid_uid: hex(2),
    });
    expectEqual('card replaced', replaced.status, OK);

    const settled = await row();
    expectEqual('row now holds the new card', settled?.rfid_uid, hex(2));
    // The count, not just the date: a settled passage has to stop being
    // counted, or the badge would keep reading ×2 with no date beside it.
    expectEqual('no passages left outstanding', settled?.manual_entry_count, 0);
    expectEqual('row is no longer red', settled?.manual_entry_at, null);
    expectEqual('row is off the no-card list', (await row('&manual_entry=true')) === undefined, true);

    console.log('\n--- they lose the new card too');
    const third = await typeIn(entryGate._id, 'entry');
    expectEqual('manual entry granted again', (third.json.data as TapResult)?.access_result, 'granted');
    const reflagged = await row();
    // 1, not 3: the two the reissue settled are gone for good, so the badge
    // describes the CURRENT card's history rather than the person's.
    expectEqual('only the new passage counts', reflagged?.manual_entry_count, 1);
    expectEqual('row is red again', (await row('&manual_entry=true')) !== undefined, true);
  } finally {
    if (personId) await request(superadmin, 'DELETE', `/persons/${personId}/erase`);
    summary();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
