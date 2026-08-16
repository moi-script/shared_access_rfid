import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from './db';
import { UserModel } from '../modules/users/users.model';
import { PersonModel, IPerson } from '../modules/persons/persons.model';
import { GateModel } from '../modules/gates/gates.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { GadgetModel } from '../modules/gadgets/gadgets.model';
import { AttendanceModel } from '../modules/attendance/attendance.model';
import { ScanLogModel } from '../modules/scan/scan.model';
import { PersonPhotoModel } from '../modules/persons/personPhotos.model';
import { GateKeyModel } from '../modules/gates/gateKeys.model';
import { ROLES } from '../constants/roles';
import { nextSchoolYearEnd } from '../utils/schoolYear';
import { VehicleType } from '../constants/vehicleTypes';

/**
 * Hardcoded test accounts + demo activity for the testing phase.
 * Run with: npm run seed:test
 * Idempotent — safe to run multiple times.
 */

const HARDCODED_ADMIN = {
  username: 'testadmin',
  password: 'Admin@123',
};

const HARDCODED_REGISTRAR = {
  username: 'testregistrar',
  password: 'Registrar@123',
};

// Login username = id_number, so the client "Student number" field matches the users table.
const HARDCODED_PEOPLE: {
  password: string;
  full_name: string;
  type: 'student' | 'staff';
  id_number: string;
  department_section: string;
  contact_email: string;
  rfid_uid: string;
}[] = [
  {
    password: 'Student@123',
    full_name: 'Juan Dela Cruz',
    type: 'student',
    id_number: '2025-0001',
    department_section: 'BSIT - 4A',
    contact_email: 'juan.delacruz@student.ncst.edu.ph',
    rfid_uid: 'A1B2C3D4',
  },
  {
    password: 'Student@123',
    full_name: 'Maria Santos',
    type: 'student',
    id_number: '2025-0002',
    department_section: 'BSCS - 3B',
    contact_email: 'maria.santos@student.ncst.edu.ph',
    rfid_uid: 'B2C3D4E5',
  },
  {
    password: 'Student@123',
    full_name: 'Pedro Reyes',
    type: 'student',
    id_number: '2025-0003',
    department_section: 'BSIT - 2C',
    contact_email: 'pedro.reyes@student.ncst.edu.ph',
    rfid_uid: 'C3D4E5F6',
  },
  {
    password: 'Staff@123',
    full_name: 'Ana Villanueva',
    type: 'staff',
    id_number: 'EMP-1001',
    department_section: 'Registrar Office',
    contact_email: 'ana.villanueva@ncst.edu.ph',
    rfid_uid: 'D4E5F6A7',
  },
];

const GATES = [
  { name: 'Main Entrance', type: 'person' as const, direction: 'entry' as const, location: 'Front Building Gate A' },
  { name: 'Side Gate', type: 'person' as const, direction: 'exit' as const, location: 'South Wing Gate B' },
  { name: 'Parking Entrance', type: 'vehicle' as const, direction: 'entry' as const, location: 'Parking Lot Entry' },
  { name: 'Parking Exit', type: 'vehicle' as const, direction: 'exit' as const, location: 'Parking Lot Exit' },
];

// Old-style usernames from the first seed run — remove so logins are clean.
const LEGACY_STUDENT_USERNAMES = ['student1', 'student2', 'student3'];

/** A 1x1 JPEG. Placeholder pixels, not a face — enough for the terminal to render. */
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function at(base: Date, h: number, m: number): Date {
  const x = new Date(base);
  x.setHours(h, m, 0, 0);
  return x;
}

/** The last `n` calendar days, most recent first (index 0 = today), at local midnight. */
function lastDays(n: number): Date[] {
  const days: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    days.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return days;
}

async function ensurePerson(
  p: (typeof HARDCODED_PEOPLE)[number]
): Promise<IPerson> {
  let person = await PersonModel.findOne({ rfid_uid: p.rfid_uid });
  if (person) {
    console.log(`[test-seed] person '${p.full_name}' already exists — skipping profile`);
  } else {
    person = await PersonModel.create({
      full_name: p.full_name,
      type: p.type,
      id_number: p.id_number,
      department_section: p.department_section,
      contact_email: p.contact_email,
      rfid_uid: p.rfid_uid,
      status: 'active',
    });
    console.log(`[test-seed] created ${p.type} '${p.full_name}' (rfid: ${p.rfid_uid})`);
  }

  const existingUser = await UserModel.findOne({ username: p.id_number });
  if (existingUser) {
    console.log(`[test-seed] user '${p.id_number}' already exists — skipping login`);
  } else {
    const password_hash = await bcrypt.hash(p.password, 12);
    await UserModel.create({
      username: p.id_number,
      password_hash,
      role: p.type === 'student' ? ROLES.STUDENT : ROLES.STAFF,
      person_id: person._id,
      must_change_password: false,
      is_active: true,
    });
    console.log(`[test-seed] created ${p.type} login '${p.id_number}' (password: ${p.password})`);
  }
  return person;
}

async function seedDemoActivity(persons: IPerson[]): Promise<void> {
  // Gates (idempotent by name)
  const gateMap: Record<string, Types.ObjectId> = {};
  for (const g of GATES) {
    await GateModel.updateOne({ name: g.name }, { $set: g }, { upsert: true });
    const gate = await GateModel.findOne({ name: g.name });
    if (!gate) throw new Error(`[test-seed] gate '${g.name}' missing after upsert`);
    gateMap[g.name] = gate._id;
  }

  // Vehicles for a couple of people (idempotent by plate_number, which is
  // unique — not by owner, since an owner may now hold several vehicles).
  const vehicleOwners: {
    id_number: string;
    plate: string;
    rfid: string;
    type: VehicleType;
    make: string;
    model: string;
  }[] = [
    { id_number: '2025-0001', plate: 'NCST-1234', rfid: 'E5F6A7B8', type: 'motorcycle', make: 'Honda', model: 'Click 125i' },
    { id_number: 'EMP-1001', plate: 'NCST-5678', rfid: 'F6A7B8C9', type: 'pickup', make: 'Toyota', model: 'Vios' },
  ];
  const vehicleDocs: { rfid: string; ownerId: Types.ObjectId }[] = [];
  for (const v of vehicleOwners) {
    const owner = persons.find((p) => p.id_number === v.id_number);
    if (!owner) continue;
    let vehicle = await VehicleModel.findOne({ plate_number: v.plate });
    if (!vehicle) {
      vehicle = await VehicleModel.create({
        owner_person_id: owner._id,
        plate_number: v.plate,
        rfid_uid: v.rfid,
        vehicle_type: v.type,
        make: v.make,
        vehicle_model: v.model,
        valid_until: nextSchoolYearEnd(),
        status: 'active',
      });
      console.log(`[test-seed] created vehicle '${v.plate}' for ${owner.full_name}`);
    }
    vehicleDocs.push({ rfid: v.rfid, ownerId: vehicle._id });
  }

  // One registered laptop, idempotent by serial_number (unique) the way
  // vehicles are idempotent by plate_number.
  //
  // ONE row, not two: the allowance is one active laptop per person, so a
  // second seeded row would have to belong to a second owner and would only
  // re-assert what verifyGadgets' limit check already covers. The serial is
  // stored uppercase because that is what normalizeSerial produces — seeding a
  // lowercase one would put a row in the database that the API itself could
  // never have written.
  const laptopOwner = persons.find((p) => p.id_number === '2025-0001');
  if (laptopOwner) {
    const serial = '5CD1234ABC';
    const existingGadget = await GadgetModel.findOne({ serial_number: serial });
    if (!existingGadget) {
      await GadgetModel.create({
        owner_person_id: laptopOwner._id,
        gadget_type: 'laptop',
        brand_model: 'Dell Latitude 5420',
        serial_number: serial,
        status: 'active',
      });
      console.log(`[test-seed] created laptop '${serial}' for ${laptopOwner.full_name}`);
    }
  }

  // Attendance + scan history. Re-run with SEED_RESET=1 to wipe and regenerate.
  if (process.env.SEED_RESET === '1') {
    await ScanLogModel.deleteMany({});
    await AttendanceModel.deleteMany({});
    console.log('[test-seed] SEED_RESET=1 → cleared existing scans + attendance');
  }
  const scanCount = await ScanLogModel.countDocuments({});
  if (scanCount > 0) {
    console.log('[test-seed] scan logs already present — skipping demo activity');
    return;
  }

  const days = lastDays(8);
  const mainGate = gateMap['Main Entrance'];
  const sideGate = gateMap['Side Gate'];

  const attendanceDocs: Record<string, unknown>[] = [];
  const scanDocs: Record<string, unknown>[] = [];

  persons.forEach((person, pIdx) => {
    days.forEach((day, dIdx) => {
      const roll = (pIdx + dIdx) % 7;
      if (roll === 3) return; // absent day → no scan / attendance
      const late = roll === 5;
      const isToday = dIdx === 0;

      const timeIn = isToday
        ? new Date(Date.now() - (2 + pIdx) * 60 * 1000) // arrived a few minutes ago
        : at(day, late ? 8 : 7, late ? 20 : 40);
      const timeOut = isToday ? null : at(day, 16, 30 + (dIdx % 25));

      attendanceDocs.push({
        person_id: person._id,
        date: ymd(day),
        time_in: timeIn,
        time_out: timeOut,
        status: late ? 'late' : 'present',
      });

      scanDocs.push({
        rfid_uid: person.rfid_uid,
        entity_type: 'person',
        entity_id: person._id,
        gate_id: mainGate,
        direction: 'entry',
        access_result: 'granted',
        reason: null,
        scan_time: timeIn,
      });
      if (timeOut) {
        scanDocs.push({
          rfid_uid: person.rfid_uid,
          entity_type: 'person',
          entity_id: person._id,
          gate_id: sideGate,
          direction: 'exit',
          access_result: 'granted',
          reason: null,
          scan_time: timeOut,
        });
      }
    });
  });

  // Parking (vehicle) scans at the parking gates, resolved to owner names.
  const parkingIn = gateMap['Parking Entrance'];
  const parkingOut = gateMap['Parking Exit'];
  vehicleDocs.forEach((v, vIdx) => {
    days.slice(0, 5).forEach((day, dIdx) => {
      const isToday = dIdx === 0;
      const inTime = isToday
        ? new Date(Date.now() - (5 + vIdx) * 60 * 1000)
        : at(day, 7, 35 + vIdx * 3);
      const outTime = isToday ? null : at(day, 17, 5 + vIdx * 4);
      scanDocs.push({
        rfid_uid: v.rfid,
        entity_type: 'vehicle',
        entity_id: v.ownerId,
        gate_id: parkingIn,
        direction: 'entry',
        access_result: 'granted',
        reason: null,
        scan_time: inTime,
      });
      if (outTime) {
        scanDocs.push({
          rfid_uid: v.rfid,
          entity_type: 'vehicle',
          entity_id: v.ownerId,
          gate_id: parkingOut,
          direction: 'exit',
          access_result: 'granted',
          reason: null,
          scan_time: outTime,
        });
      }
    });
  });

  // A couple of denied taps today (unregistered cards) for the admin feed.
  const now = Date.now();
  scanDocs.push(
    {
      rfid_uid: 'RFID-UNKNOWN-1',
      entity_type: 'person',
      entity_id: null,
      gate_id: mainGate,
      direction: 'entry',
      access_result: 'denied',
      reason: 'unregistered_uid',
      scan_time: new Date(now - 18 * 60 * 1000),
    },
    {
      rfid_uid: 'RFID-UNKNOWN-2',
      entity_type: 'person',
      entity_id: null,
      gate_id: sideGate,
      direction: 'entry',
      access_result: 'denied',
      reason: 'unregistered_uid',
      scan_time: new Date(now - 42 * 60 * 1000),
    }
  );

  await AttendanceModel.insertMany(attendanceDocs, { ordered: false }).catch(() => undefined);
  await ScanLogModel.insertMany(scanDocs);
  console.log(
    `[test-seed] created ${attendanceDocs.length} attendance rows and ${scanDocs.length} scan logs`
  );
}

async function seedPhotosAndKeys(persons: IPerson[], adminId: Types.ObjectId): Promise<void> {
  // Photos for two people, so the gate terminal has faces to show.
  for (const idNumber of ['2025-0001', 'EMP-1001']) {
    const person = persons.find((p) => p.id_number === idNumber);
    if (!person) continue;
    const existing = await PersonPhotoModel.findOne({ person_id: person._id });
    if (existing) {
      console.log(`[test-seed] photo for '${idNumber}' already exists — skipping`);
      continue;
    }
    await PersonPhotoModel.create({
      person_id: person._id,
      data: PLACEHOLDER_JPEG,
      mime: 'image/jpeg',
      byte_size: PLACEHOLDER_JPEG.length,
    });
    await PersonModel.updateOne(
      { _id: person._id },
      { $set: { photo_url: `/persons/${person._id}/photo` } }
    );
    console.log(`[test-seed] created placeholder photo for '${idNumber}'`);
  }

  // One device key per gate, so a terminal can be provisioned without the UI.
  const gates = await GateModel.find();
  for (const gate of gates) {
    const active = await GateKeyModel.findOne({ gate_id: gate._id, is_active: true });
    if (active) {
      console.log(`[test-seed] gate '${gate.name}' already has an active key — skipping`);
      continue;
    }
    const prefix = randomBytes(4).toString('hex');
    const secret = randomBytes(16).toString('hex');
    const key = `gk_live_${prefix}${secret}`;
    await GateKeyModel.create({
      gate_id: gate._id,
      key_hash: await bcrypt.hash(key, 12),
      key_prefix: prefix,
      created_by: adminId,
    });
    // Printed once, and never in production — the plaintext is unrecoverable.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[test-seed] gate '${gate.name}' (${gate.type}/${gate.direction}) key: ${key}`);
    }
  }
}

async function seedTest(): Promise<void> {
  await connectDB();

  // ---- Admin ----
  const existingAdmin = await UserModel.findOne({ username: HARDCODED_ADMIN.username });
  if (existingAdmin) {
    console.log(`[test-seed] superadmin '${HARDCODED_ADMIN.username}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(HARDCODED_ADMIN.password, 12);
    await UserModel.create({
      username: HARDCODED_ADMIN.username,
      password_hash,
      role: ROLES.SUPERADMIN,
      person_id: null,
      must_change_password: false,
      is_active: true,
    });
    console.log(
      `[test-seed] created superadmin '${HARDCODED_ADMIN.username}' (password: ${HARDCODED_ADMIN.password})`
    );
  }

  // ---- Registrar ----
  const existingRegistrar = await UserModel.findOne({ username: HARDCODED_REGISTRAR.username });
  if (existingRegistrar) {
    console.log(`[test-seed] registrar '${HARDCODED_REGISTRAR.username}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(HARDCODED_REGISTRAR.password, 12);
    await UserModel.create({
      username: HARDCODED_REGISTRAR.username,
      password_hash,
      role: ROLES.REGISTRAR,
      person_id: null,
      must_change_password: false,
      is_active: true,
    });
    console.log(
      `[test-seed] created registrar '${HARDCODED_REGISTRAR.username}' (password: ${HARDCODED_REGISTRAR.password})`
    );
  }

  // ---- Rank-2 office accounts, with no person_id: these are office logins, not
  // people. Each writes only its own domain; all of them read the whole
  // directory. See docs/superpowers/specs/2026-07-30-rbac-v2-design.md.
  const HARDCODED_HR = { username: 'testhr', password: 'Hr@12345' };
  const HARDCODED_OSS = { username: 'testoss', password: 'Oss@12345' };

  for (const [account, role] of [
    [HARDCODED_HR, ROLES.HR],
    [HARDCODED_OSS, ROLES.OSS],
  ] as const) {
    const existing = await UserModel.findOne({ username: account.username });
    if (existing) {
      console.log(`[test-seed] ${account.username} already exists — skipping`);
    } else {
      await UserModel.create({
        username: account.username,
        password_hash: await bcrypt.hash(account.password, 12),
        role,
        person_id: null,
        must_change_password: false,
        is_active: true,
      });
      console.log(`[test-seed] created ${account.username} (${role})`);
    }
  }

  // A staff person in HR's domain, so the harness has a cross-domain target the
  // registrar must be denied on. Without a staff Person, "registrar cannot write
  // staff" would pass against an empty collection for the wrong reason.
  const existingBea = await PersonModel.findOne({ id_number: 'EMP-1002' });
  if (!existingBea) {
    await PersonModel.create({
      full_name: 'Bea Ramos',
      type: 'staff',
      id_number: 'EMP-1002',
      department_section: 'Registrar Office',
      rfid_uid: 'C9D0E1F2',
      status: 'active',
    });
    console.log('[test-seed] created staff person EMP-1002');
  } else {
    console.log('[test-seed] staff person EMP-1002 already exists — skipping');
  }

  // ---- Clean up legacy student logins from the earlier seed ----
  const removed = await UserModel.deleteMany({ username: { $in: LEGACY_STUDENT_USERNAMES } });
  if (removed.deletedCount) {
    console.log(`[test-seed] removed ${removed.deletedCount} legacy student login(s)`);
  }

  // ---- People (students + staff), login username = id_number ----
  const persons: IPerson[] = [];
  for (const p of HARDCODED_PEOPLE) {
    persons.push(await ensurePerson(p));
  }

  // ---- Demo activity so the dashboards aren't empty ----
  await seedDemoActivity(persons);

  const adminDoc = await UserModel.findOne({ username: HARDCODED_ADMIN.username });
  if (!adminDoc) throw new Error('[test-seed] superadmin missing after seeding');
  await seedPhotosAndKeys(persons, adminDoc._id);

  await disconnectDB();
  console.log('[test-seed] done');
}

seedTest().catch(async (err) => {
  console.error('[test-seed] failed', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
