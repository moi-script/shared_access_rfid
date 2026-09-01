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

    console.log('\n--- a gadget tag taps in its own right');
    const gates = await request(superadmin, 'GET', '/gates');
    const gateRows = (gates.json.data ?? []) as { _id: string; name: string }[];
    const gadgetLane = gateRows.find((g) => g.name === 'Gadget Lane');
    const mainGate = gateRows.find((g) => g.name === 'Main Entrance');
    const sideGate = gateRows.find((g) => g.name === 'Side Gate');
    expectEqual('Gadget Lane gate exists (run npm run seed)', Boolean(gadgetLane), true);
    expectEqual('Main Entrance gate exists', Boolean(mainGate), true);
    expectEqual('Side Gate exists', Boolean(sideGate), true);

    /** The lane, in order: every device first, then the ID that commits them. */
    const carryIn = async (personUid: string, deviceUids: string[]) => {
      for (const uid of deviceUids) {
        await request(superadmin, 'POST', '/scan/tap', {
          rfid_uid: uid, gate_id: gadgetLane!._id, direction: 'entry',
        });
      }
      return request(superadmin, 'POST', '/scan/tap', {
        rfid_uid: personUid, gate_id: mainGate!._id, direction: 'entry',
      });
    };

    // The ORDER is the feature: Gadget Lane, then Main Entrance. A person's own
    // card at the device reader is a few steps early, not a valid entry.
    const personAtLane = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: gadgetLane!._id, direction: 'entry',
    });
    expectEqual(
      "a person's ID is refused at the device reader",
      (personAtLane.json.data as { reason?: string })?.reason,
      'person_not_allowed_at_gadget_lane'
    );

    // ...and the mirror image: a device sticker at the person reader names the
    // right lane rather than falling through to a generic wrong_gate_type.
    const deviceAtMain = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: mainGate!._id, direction: 'entry',
    });
    const dam = deviceAtMain.json.data as { access_result?: string; reason?: string };
    expectEqual('a device sticker at the person reader is denied', dam?.access_result, 'denied');
    expectEqual('and is told which reader to use', dam?.reason, 'gadget_wrong_lane');

    console.log('\n--- a device tap DECLARES; the person tap is what commits it');
    const deviceIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: gadgetLane!._id, direction: 'entry',
    });
    const din = deviceIn.json.data as {
      access_result?: string;
      reason?: string;
      person?: { full_name?: string; photo_url?: string };
    };
    expectEqual('gadget tag accepted at the lane', din?.access_result, 'granted');
    expectEqual('and marked as declared, not admitted', din?.reason, 'carry_pending');
    // The lane shows the owner beside the device, so the sticker must resolve
    // its owner's identity on a GRANTED tap — that pairing is the whole check
    // the guard performs there.
    expectEqual('the lane is told whose device it is', din?.person?.full_name, `Carry Probe ${RUN}`);

    // The device must NOT be inside yet. This is the property the whole
    // reordering rests on: a sticker tapped by someone who then walks away is
    // never recorded as having entered.
    const pendingProfile = await request(superadmin, 'GET', `/persons/${personId}/overview`);
    const pendingRows = ((pendingProfile.json.data as { gadgets?: { inside: boolean }[] })?.gadgets ?? []);
    expectEqual(
      'a declared device is not inside until the ID taps',
      pendingRows.filter((g) => g.inside).length,
      0
    );

    const personIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: mainGate!._id, direction: 'entry',
    });
    const pin = personIn.json.data as {
      access_result?: string;
      person?: { gadgets_carried?: { serial_number: string }[] };
    };
    expectEqual('person admitted at the person reader', pin?.access_result, 'granted');
    expectEqual('and the tap reports the device it just walked in', pin?.person?.gadgets_carried?.length, 1);
    expectEqual(
      'naming the device that was declared',
      pin?.person?.gadgets_carried?.[0]?.serial_number,
      `CPG${RUN}`
    );

    const committed = await request(superadmin, 'GET', `/persons/${personId}/overview`);
    const committedRows = ((committed.json.data as { gadgets?: { inside: boolean }[] })?.gadgets ?? []);
    expectEqual(
      'and the device is inside once the ID has tapped',
      committedRows.filter((g) => g.inside).length,
      1
    );

    console.log('\n--- the exit tap reports what is still inside');
    const personOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: sideGate!._id, direction: 'exit',
    });
    const outData = personOut.json.data as {
      access_result?: string;
      person?: { gadgets_inside?: { serial_number: string }[] };
    };
    expectEqual('person released', outData?.access_result, 'granted');
    expectEqual('exactly one device is still inside', outData?.person?.gadgets_inside?.length, 1);
    expectEqual(
      'and it is the one that tapped in',
      outData?.person?.gadgets_inside?.[0]?.serial_number,
      `CPG${RUN}`
    );

    console.log('\n--- tapping the device out clears it');
    const deviceOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual('gadget tag released', (deviceOut.json.data as { access_result?: string })?.access_result, 'granted');

    console.log('\n--- an incomplete exit is logged as its own row, not folded into the exit');
    // Re-enter both so there is something to leave behind.
    await carryIn(hex(1), [hex(2)]);
    const exitAgain = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual(
      'the person left with the device still inside',
      (exitAgain.json.data as { person?: { gadgets_inside?: unknown[] } })?.person?.gadgets_inside?.length,
      1
    );

    const close = await request(superadmin, 'POST', '/scan/gadget-session', {
      gate_id: sideGate!._id,
      person_id: personId,
      missing_gadget_ids: [gadgetId],
    });
    expectEqual('close event accepted', close.status, OK);

    const logs = await request(superadmin, 'GET', `/scan/logs?limit=20`);
    const logRows = (logs.json.data ?? []) as { reason?: string; access_result?: string }[];
    const notReturned = logRows.filter((l) => l.reason === 'gadget_not_returned');
    expectEqual('a gadget_not_returned row was written', notReturned.length >= 1, true);
    expectEqual('and it is GRANTED, never a denial', notReturned[0]?.access_result, 'granted');

    // Clean the device back out so the run leaves no row inside.
    await request(superadmin, 'POST', '/scan/tap', { rfid_uid: hex(2), gate_id: sideGate!._id, direction: 'exit' });

    // Last of the gadget-tap checks on purpose: a denied tap moves no
    // occupancy state, so it cannot disturb the entry/exit ordering the
    // checks above depend on.
    console.log('\n--- a gadget tag is refused at a VEHICLE gate');
    const parkingIn = gateRows.find((g) => g.name === 'Parking Entrance');
    expectEqual('Parking Entrance gate exists', Boolean(parkingIn), true);
    const gadgetAtParking = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: parkingIn!._id, direction: 'entry',
    });
    const gp = gadgetAtParking.json.data as { access_result?: string; reason?: string };
    expectEqual('a device tag at the parking barrier is denied', gp?.access_result, 'denied');
    expectEqual('and denied for the right reason', gp?.reason, 'wrong_gate_type');

    console.log('\n--- replacing a gadget sticker blocks the retired one');
    const swap = await request(superadmin, 'PATCH', `/gadgets/${gadgetId}/rfid`, {
      rfid_uid: hex(7),
    });
    expectEqual('sticker replaced', swap.status, OK);

    // The retired tag must now be refused everywhere, or it goes back into the
    // pool and is granted again once reissued.
    const reuse = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: personId,
      gadget_type: 'tablet',
      brand_model: 'Probe Tablet',
      serial_number: `CPG3${RUN}`,
      rfid_uid: hex(2),
    });
    expectEqual('the retired tag cannot be re-registered', reuse.status, CONFLICT);

    console.log('\n--- a gadget belonging to someone else does not release');
    const stranger = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Stranger ${RUN}`, type: 'student',
      id_number: `CS-${RUN}`, rfid_uid: hex(8),
    });
    const strangerId = idOf(stranger.json);
    const strangerGadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: strangerId, gadget_type: 'laptop',
      brand_model: 'Stranger Laptop', serial_number: `CSG${RUN}`, rfid_uid: hex(9),
    });
    expectEqual('stranger gadget created', strangerGadget.status, CREATED);
    // It was never tapped in, so an exit tap must report exit_without_entry
    // rather than silently releasing a row that does not exist.
    const strangerOut = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(9), gate_id: sideGate!._id, direction: 'exit',
    });
    expectEqual(
      'a device that never entered reports exit_without_entry',
      (strangerOut.json.data as { reason?: string })?.reason,
      'exit_without_entry'
    );
    await request(superadmin, 'DELETE', `/persons/${strangerId}`);

    console.log('\n--- a blocked gadget tag is refused');
    const blockedProbe = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(2), gate_id: gadgetLane!._id, direction: 'entry',
    });
    // hex(2) was retired by the sticker swap in Task 5 and is on the blocklist.
    expectEqual(
      'the retired tag is refused at the gate',
      (blockedProbe.json.data as { reason?: string })?.reason,
      'card_blocked'
    );

    console.log('\n--- a gadget tap is logged AS a gadget');
    // Asserts the branch that could actually regress: that the UID resolved down
    // the third branch rather than being mistaken for a person or falling through
    // to unregistered_uid.
    //
    // Deliberately NOT "no attendance row exists for the gadget": attendance is
    // keyed by person_id, so a gadget id can never appear in it and that
    // assertion would be structurally impossible to fail. The property is
    // guaranteed by construction (attendancePersonId is null on a gadget tap)
    // and is recorded in the spec rather than tested here.
    const gadgetLogs = await request(superadmin, 'GET', '/scan/logs?limit=50');
    const gadgetLogRows = (gadgetLogs.json.data ?? []) as { entity_type?: string }[];
    expectEqual(
      'at least one scan log row was written with entity_type gadget',
      gadgetLogRows.some((l) => l.entity_type === 'gadget'),
      true
    );

    console.log('\n--- the audit row is REACHABLE on the anomalies report');
    // The gadget_not_returned check above proves the row was written. This
    // proves it can be read on the one screen an auditor actually opens, which
    // is a different property and the one that was broken: the reasons the
    // anomalies query matches on are an explicit $in list, and a new reason
    // that nobody adds to it is written perfectly and seen by no one. A
    // verification gate that misses the feature's only permanent output is not
    // a gate.
    //
    // Bounded to today so the 500-row cap cannot push the row out of the
    // window; `to` is inclusive of the whole local day (dateRange.ts).
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const anomalies = await request(superadmin, 'GET', `/reports/anomalies?from=${today}&to=${today}`);
    expectEqual('anomalies report responded', anomalies.status, OK);
    const anomalyRows = ((anomalies.json.data as { rows?: unknown[] })?.rows ?? []) as {
      reason?: string;
      entity_type?: string;
      name?: string | null;
    }[];
    expectEqual(
      'the gadget_not_returned row is reachable via GET /reports/anomalies',
      anomalyRows.some((r) => r.reason === 'gadget_not_returned'),
      true
    );
    // And the gadget rows that already matched the query render a name. They
    // did not before the gadgets $lookup was added: a nameless anomaly row is
    // worse than an absent one, because it cannot be acted on. The stranger
    // device's exit_without_entry above is one such row.
    const gadgetAnomalies = anomalyRows.filter((r) => r.entity_type === 'gadget');
    expectEqual('a gadget anomaly row exists to check', gadgetAnomalies.length > 0, true);
    expectEqual(
      'and it resolves a display name rather than null',
      gadgetAnomalies.every((r) => Boolean(r.name)),
      true
    );

    console.log('\n--- a lowercase UID registered and tapped in lowercase still opens the gate');
    // The round trip both boundaries have to agree on. Registration uppercases
    // what it stores, so a UID hand-entered as `a1b2c3` is persisted `A1B2C3`;
    // if the tap path did not uppercase too, this exact tap comes back
    // `unregistered_uid` and a real card silently stops working at a real
    // barrier. `hex` already returns uppercase, so the casing is forced down
    // on BOTH sides here — that is the whole point of the check.
    const lowerUid = hex(4).toLowerCase();
    const caseProbe = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Case Probe ${RUN}`,
      type: 'student',
      id_number: `CCP-${RUN}`,
      rfid_uid: lowerUid,
    });
    expectEqual('lowercase-UID person created', caseProbe.status, CREATED);
    const caseProbeId = idOf(caseProbe.json);
    expectEqual(
      'and the UID was normalized on the way in',
      (caseProbe.json.data as { rfid_uid?: string })?.rfid_uid,
      lowerUid.toUpperCase()
    );

    const lowerTap = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: lowerUid,
      // The person reader: a person's card is refused at the Gadget Lane now,
      // so tapping this probe there would assert casing against a denial that
      // has nothing to do with casing.
      gate_id: mainGate!._id,
      direction: 'entry',
    });
    const lt = lowerTap.json.data as { access_result?: string; reason?: string };
    expectEqual('a lowercase tap of an uppercase-stored UID is GRANTED', lt?.access_result, 'granted');

    // Leave nothing inside: release the row, then remove the probe person.
    await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: lowerUid,
      gate_id: sideGate!._id,
      direction: 'exit',
    });
    if (caseProbeId) {
      const delCase = await request(superadmin, 'DELETE', `/persons/${caseProbeId}`);
      expectEqual('lowercase-UID probe cleaned up', delCase.status, OK);
    }

    console.log('\n--- two people can have devices declared at once');
    // The defect this replaces: the store that used to gate device taps held
    // ONE session per gate and let a later call overwrite it, so the moment a
    // second student tapped a device while the first was still walking to the
    // person reader, the first student's devices were lost. Buckets are keyed
    // by person now, so this interleaving — A's device, B's device, then A's
    // ID, then B's ID — has to work in exactly that order.
    const other = await request(superadmin, 'POST', '/persons', {
      full_name: `Carry Second ${RUN}`,
      type: 'student',
      id_number: `CS2-${RUN}`,
      department_section: `CARRY-PROBE-${RUN}`,
      rfid_uid: hex(5),
    });
    expectEqual('second probe person created', other.status, CREATED);
    const otherId = idOf(other.json);
    const otherGadget = await request(superadmin, 'POST', '/gadgets', {
      owner_person_id: otherId,
      gadget_type: 'tablet',
      brand_model: 'Second Tablet',
      serial_number: `CSG2${RUN}`,
      rfid_uid: hex(6),
    });
    expectEqual('second probe gadget created', otherGadget.status, CREATED);

    // A declares, then B declares before A has reached the person reader.
    await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(7), gate_id: gadgetLane!._id, direction: 'entry',
    });
    await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(6), gate_id: gadgetLane!._id, direction: 'entry',
    });

    const aIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: mainGate!._id, direction: 'entry',
    });
    const aCarried = (aIn.json.data as { person?: { gadgets_carried?: { id: string }[] } })
      ?.person?.gadgets_carried ?? [];
    expectEqual("A's tap walks in A's device", aCarried.length, 1);
    expectEqual('and it is A\'s own, not the one B declared in between', aCarried[0]?.id, gadgetId);

    const bIn = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(5), gate_id: mainGate!._id, direction: 'entry',
    });
    const bCarried = (bIn.json.data as {
      access_result?: string;
      person?: { gadgets_carried?: { serial_number: string }[] };
    })?.person?.gadgets_carried ?? [];
    expectEqual('B is admitted after A', (bIn.json.data as { access_result?: string })?.access_result, 'granted');
    expectEqual("B's device survived A's tap and walks in with B", bCarried.length, 1);
    expectEqual('and it is B\'s own device', bCarried[0]?.serial_number, `CSG2${RUN}`);

    // Put both back outside so the checks below start from a clean floor.
    // Person first, then their device: exit still runs on the per-gate session
    // that a person's own exit tap opens, so a device tapped ahead of its owner
    // there is refused and would be left stranded inside.
    for (const pair of [[hex(1), hex(7)], [hex(5), hex(6)]]) {
      for (const uid of pair) {
        await request(superadmin, 'POST', '/scan/tap', {
          rfid_uid: uid, gate_id: sideGate!._id, direction: 'exit',
        });
      }
    }
    if (otherId) {
      const delOther = await request(superadmin, 'DELETE', `/persons/${otherId}`);
      expectEqual('second probe person cleaned up', delOther.status, OK);
    }

    console.log('\n--- the profile and the gate agree on what is being carried');

    // The risk this guards is not "does the flag serialize" — it is DRIFT. The
    // profile's `inside` and the terminal's gadgets_inside are two readers of
    // one fact, and if they ever stop agreeing the console will contradict the
    // guard standing at the barrier. So both are read at the same moments and
    // compared against each other, not against a hardcoded expectation.
    const profileOf = async () => {
      const r = await request(superadmin, 'GET', `/persons/${personId}/overview`);
      const rows = (r.json.data as { gadgets?: { id: string; inside: boolean; rfid_uid: string | null }[] })
        ?.gadgets ?? [];
      return rows;
    };

    // Nothing is inside at this point — every earlier block tapped its devices
    // back out, so this establishes the floor the next tap moves off.
    const before = await profileOf();
    expectEqual(
      'profile starts with no device inside',
      before.filter((g) => g.inside).length,
      0
    );

    // hex(7), NOT hex(2): the sticker swap earlier in this script retired
    // hex(2) and put it on the blocklist, so a tap with it is denied and moves
    // no occupancy at all. Using it here made every assertion below compare
    // two empty sets and pass for the wrong reason.
    await carryIn(hex(1), [hex(7)]);

    const during = await profileOf();
    expectEqual(
      'profile reports exactly one device inside after it taps in',
      during.filter((g) => g.inside).length,
      1
    );
    expectEqual(
      'and it is the device that tapped, not merely some device',
      during.find((g) => g.inside)?.id,
      gadgetId
    );
    // An untagged device must never count as inside: it holds no occupancy row
    // because nothing ever tapped it, which is why the UI leaves it out of the
    // carry count rather than reporting it as returned.
    expectEqual(
      'an untagged device is never reported inside',
      during.filter((g) => !g.rfid_uid && g.inside).length,
      0
    );

    // The agreement check: the person's own exit tap computes gadgets_inside
    // server-side, independently of the profile query above.
    const agreeExit = await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(1), gate_id: sideGate!._id, direction: 'exit',
    });
    const gateSays = (agreeExit.json.data as { person?: { gadgets_inside?: { id: string }[] } })
      ?.person?.gadgets_inside ?? [];
    // Guarded against the empty-set trap: two sides that agree on "nothing"
    // agree for free, and that is exactly how this check passed while the tap
    // above was silently being denied. The comparison is only meaningful when
    // there is something to compare.
    expectEqual('the gate reports something inside to compare', gateSays.length > 0, true);
    expectEqual(
      'the gate and the profile name the SAME devices inside',
      gateSays.map((g) => g.id).sort().join(','),
      during.filter((g) => g.inside).map((g) => g.id).sort().join(',')
    );

    await request(superadmin, 'POST', '/scan/tap', {
      rfid_uid: hex(7), gate_id: sideGate!._id, direction: 'exit',
    });
    const after = await profileOf();
    expectEqual(
      'profile drops back to nothing inside once the device is returned',
      after.filter((g) => g.inside).length,
      0
    );
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
