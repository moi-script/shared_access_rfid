import { Types } from 'mongoose';
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { GadgetModel } from '../gadgets/gadgets.model';
import { ScanLogModel } from '../scan/scan.model';
import { GateModel } from '../gates/gates.model';
import { AttendanceModel } from '../attendance/attendance.model';
import { ROLES, Role } from '../../constants/roles';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function gateStatuses() {
  const gates = await GateModel.find().lean();
  return Promise.all(
    gates.map(async (g) => {
      const last = await ScanLogModel.findOne({ gate_id: g._id }).sort({ scan_time: -1 }).lean();
      const lastScan = last?.scan_time ?? null;
      const online = lastScan ? Date.now() - new Date(lastScan).getTime() < 5 * 60 * 1000 : false;
      return {
        name: g.name,
        type: g.type,
        location: g.location ?? null,
        last_scan: lastScan,
        status: online ? 'online' : 'offline',
      };
    })
  );
}

/** Latest vehicle scans, resolved to plate number + owner name for display. */
async function parkingActivity(limit: number) {
  return ScanLogModel.aggregate([
    { $match: { entity_type: 'vehicle' } },
    { $sort: { scan_time: -1 } },
    { $limit: limit },
    { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
    { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'people', localField: 'vehicle.owner_person_id', foreignField: '_id', as: 'owner' } },
    { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
    {
      $project: {
        _id: 0,
        scan_time: 1,
        direction: 1,
        access_result: 1,
        rfid_uid: 1,
        plate_number: { $ifNull: ['$vehicle.plate_number', null] },
        owner_name: { $arrayElemAt: ['$owner.full_name', 0] },
        gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
      },
    },
  ]);
}

/** Latest scans across campus, joined with gate + person names for display. */
async function recentScans(limit: number) {
  return ScanLogModel.aggregate([
    { $sort: { scan_time: -1 } },
    { $limit: limit },
    { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
    { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
    {
      $project: {
        _id: 0,
        scan_time: 1,
        direction: 1,
        access_result: 1,
        entity_type: 1,
        reason: 1,
        rfid_uid: 1,
        gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
        name: { $arrayElemAt: ['$person.full_name', 0] },
      },
    },
  ]);
}

export const dashboardService = {
  async get(actor: { role: Role; personId: string | null }) {
    if (actor.role === ROLES.SUPERADMIN) {
      return this.adminView();
    }
    if (actor.role === ROLES.OSS) {
      return this.ossView();
    }
    if (actor.role === ROLES.REGISTRAR || actor.role === ROLES.HR) {
      // hr gets the same registration-focused summary as registrar: no scan
      // or gate data, consistent with Subsystem A's ruling. Without an
      // explicit arm here they fell through to the unlinked/guard shape
      // below ({ gates }), which the frontend does not expect for an admin
      // role.
      return this.registrarView();
    }
    if (actor.personId) return this.userView(actor.personId);
    return { gates: await gateStatuses() }; // unlinked / guard
  },

  /**
   * Registration-focused summary for the registrar: counts and recent
   * registrations only. No scan data, no gate data, no vehicle data, no
   * plate numbers, no RFID UIDs — the registrar has no Overview or Parking
   * tab and is denied /logs, /scan/logs, /reports/*, and /vehicles/*, so
   * the dashboard must not hand that class of data back either.
   */
  async registrarView() {
    const [total_persons, by_type, recent] = await Promise.all([
      PersonModel.countDocuments({ deleted_at: null }),
      PersonModel.aggregate([
        { $match: { deleted_at: null } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      PersonModel.find({ deleted_at: null })
        .sort({ createdAt: -1 })
        .limit(8)
        .select('full_name type department_section id_number createdAt')
        .lean(),
    ]);

    const persons_by_type = { student: 0, staff: 0, employee: 0 };
    for (const row of by_type as { _id: keyof typeof persons_by_type; count: number }[]) {
      if (row._id in persons_by_type) persons_by_type[row._id] = row.count;
    }

    return {
      total_persons,
      persons_by_type,
      recent_registrations: recent.map((p) => ({
        full_name: p.full_name,
        type: p.type,
        department_section: p.department_section ?? null,
        id_number: p.id_number,
        createdAt: p.createdAt,
      })),
    };
  },

  /**
   * OSS is the vehicle office: RBAC v2 gives it a Parking tab, and
   * ParkingView reads `parking_activity` unconditionally, so the
   * registration-only shape crashed that tab. It gets the registrar summary
   * plus vehicle-domain data it already owns through `registerVehicles` —
   * and nothing more. Person scan logs (`recent_scans`) and gate status stay
   * superadmin-only; OSS has no Overview or Presence tab and is still denied
   * /logs, /scan/logs and /reports/*.
   */
  async ossView() {
    const [registration, total_vehicles, total_gadgets, parking_activity] = await Promise.all([
      this.registrarView(),
      VehicleModel.countDocuments({}),
      // OSS owns the gadget domain (WRITE_DOMAINS), so the count belongs on its
      // dashboard for the same reason total_vehicles does. Deliberately not
      // added to registrarView: the registrar has no gadget surface at all, and
      // that view is defined by what it withholds.
      GadgetModel.countDocuments({}),
      parkingActivity(8),
    ]);

    return { ...registration, total_vehicles, total_gadgets, parking_activity };
  },

  async adminView() {
    const today = startOfToday();
    const [
      total_persons,
      by_type,
      total_vehicles,
      total_gadgets,
      scan_events_today,
      granted_today,
      denied_today,
      active_today,
      gates,
      recent_scans,
      parking_activity,
    ] = await Promise.all([
      PersonModel.countDocuments({ deleted_at: null }),
      PersonModel.aggregate([
        { $match: { deleted_at: null } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      VehicleModel.countDocuments({}),
      GadgetModel.countDocuments({}),
      ScanLogModel.countDocuments({ scan_time: { $gte: today } }),
      ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'granted' }),
      ScanLogModel.countDocuments({ scan_time: { $gte: today }, access_result: 'denied' }),
      AttendanceModel.countDocuments({ date: todayKey() }),
      gateStatuses(),
      recentScans(8),
      parkingActivity(8),
    ]);

    const persons_by_type = { student: 0, staff: 0, employee: 0 };
    for (const row of by_type as { _id: keyof typeof persons_by_type; count: number }[]) {
      if (row._id in persons_by_type) persons_by_type[row._id] = row.count;
    }

    return {
      total_persons,
      persons_by_type,
      active_today,
      total_vehicles,
      total_gadgets,
      scan_events_today,
      granted_today,
      denied_today,
      gates,
      recent_scans,
      parking_activity,
    };
  },

  async userView(personId: string) {
    const oid = new Types.ObjectId(personId);
    const [person, vehicles, gadgets, today, recent, statusAgg, scans] = await Promise.all([
      // deleted_at excluded here too: a soft-deleted person's login is also
      // deactivated (see personService.softDelete), so this only matters for
      // an admin looking up /:id/overview by hand — it must 404 the same way
      // GET /persons/:id does, not resurrect a deleted person's profile.
      PersonModel.findOne({ _id: personId, deleted_at: null }).lean(),
      VehicleModel.find({ owner_person_id: personId }).sort({ createdAt: -1 }).lean(),
      // Inactive rows included on purpose. A replaced device is deactivated
      // rather than deleted so its history survives (gadgets.model.ts:18-22),
      // and "this laptop was swapped" is exactly what someone opening a profile
      // is trying to find out. The status badge distinguishes them.
      GadgetModel.find({ owner_person_id: personId }).sort({ createdAt: -1 }).lean(),
      AttendanceModel.findOne({ person_id: personId, date: todayKey() }).lean(),
      AttendanceModel.find({ person_id: personId }).sort({ date: -1 }).limit(7).lean(),
      AttendanceModel.aggregate([
        { $match: { person_id: oid } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      ScanLogModel.aggregate([
        { $match: { entity_type: 'person', entity_id: oid } },
        { $sort: { scan_time: -1 } },
        { $limit: 6 },
        { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 0,
            scan_time: 1,
            direction: 1,
            access_result: 1,
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
      ]),
    ]);

    const attendance_summary = { present: 0, late: 0, absent: 0 };
    for (const row of statusAgg as { _id: keyof typeof attendance_summary; count: number }[]) {
      if (row._id in attendance_summary) attendance_summary[row._id] = row.count;
    }

    return {
      person: person
        ? {
            full_name: person.full_name,
            type: person.type,
            id_number: person.id_number,
            department_section: person.department_section ?? null,
            contact_email: person.contact_email ?? null,
            rfid_uid: person.rfid_uid,
            status: person.status,
            photo_url: person.photo_url ?? null,
            signature_url: person.signature_url ?? null,
            createdAt: person.createdAt,
          }
        : null,
      today: today
        ? { time_in: today.time_in, time_out: today.time_out, status: today.status }
        : null,
      attendance_summary,
      recent_attendance: recent,
      vehicles: vehicles.map((vehicle) => ({
        plate_number: vehicle.plate_number,
        vehicle_type: vehicle.vehicle_type,
        vehicle_model: vehicle.vehicle_model ?? null,
        rfid_uid: vehicle.rfid_uid,
        status: vehicle.status,
      })),
      gadgets: gadgets.map((gadget) => ({
        gadget_type: gadget.gadget_type,
        brand_model: gadget.brand_model,
        serial_number: gadget.serial_number,
        status: gadget.status,
      })),
      recent_scans: scans,
    };
  },
};
