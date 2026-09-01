import { Types } from 'mongoose';
import { scanRepo } from './scan.repository';
import { ScanLogModel } from './scan.model';
import { attendanceRepo } from '../attendance/attendance.repository';
import { personRepo } from '../persons/persons.repository';
import { vehicleRepo } from '../vehicles/vehicles.repository';
import { gadgetRepo } from '../gadgets/gadgets.repository';
import { gateRepo } from '../gates/gates.repository';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { occupancyRepo } from '../occupancy/occupancy.repository';
import { lastResetBoundary } from '../../utils/occupancyWindow';
import { parseLocalDateRange } from '../../utils/dateRange';
import { liveHub } from '../dashboard/liveHub';
import { gateSessionStore } from './gateSession.store';
import { pendingCarryStore } from './pendingCarry.store';


/** Both must match the seeded gate names exactly — see the same requirement on
 *  GATE_ROUTES in userpage/lib/gateTerminal.ts, which this mirrors from the
 *  server side, and verifyGates, which asserts the seed still provides them. */
const GADGET_LANE_NAME = 'Gadget Lane';
const MAIN_ENTRANCE_NAME = 'Main Entrance';

interface TapInput {
  rfid_uid: string;
  gate_id: string;
  direction: 'entry' | 'exit';
}

interface TapResult {
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  person?: {
    full_name: string;
    type: string;
    owner_type?: string;
    department_section: string | null;
    photo_url?: string;
    /** The VEHICLE's photo. `photo_url` above stays the owner's face — the
     *  terminal shows both side by side on a vehicle gate. */
    vehicle_photo_url?: string;
    plate_number?: string;
    vehicle?: { vehicle_type: string; make?: string };
    registered?: { vehicle_type: string; make?: string }[];
    /** The cardholder's registered devices, for the exit ownership check. Shown
     *  to the guard; never consulted by any access decision. */
    gadgets?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      photo_url?: string;
    }[];
    /** The subset of those devices whose occupancy row is still `inside` — what
     *  the exit terminal must see tapped out. Populated ONLY on a granted
     *  person EXIT tap: on entry there is nothing to return yet, and on a
     *  denial this is withheld for the same reason `gadgets` is. */
    gadgets_inside?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      /** Carried here so the exit checklist can SHOW the device it is asking
       *  for. This used to be withheld on the theory that the lane confirms a
       *  device once it is read back rather than previewing it — but the guard
       *  is being asked to find a specific laptop among several in a bag, and
       *  a line of text is a worse description of it than its photograph. */
      photo_url?: string;
    }[];
    /** The devices this person had parked at the Gadget Lane and that THIS tap
     *  just walked inside — see the commit block below. Populated only on a
     *  granted person ENTRY tap at Main Entrance, and absent (not empty) for
     *  the ordinary case of someone carrying nothing. This is what lets the
     *  person lane show the face and the laptop side by side. */
    gadgets_carried?: {
      id: string;
      gadget_type: string;
      brand_model: string;
      serial_number: string;
      photo_url?: string;
    }[];
    person_id?: string;
  };
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isLate(when: Date): boolean {
  const [h, m] = env.LATE_CUTOFF_TIME.split(':').map((n) => parseInt(n, 10));
  const cutoff = new Date(when);
  cutoff.setHours(h, m, 0, 0);
  return when.getTime() > cutoff.getTime();
}

export const scanService = {
  async tap(input: TapInput): Promise<TapResult> {
    const gate = await gateRepo.findById(input.gate_id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const scan_time = new Date();

    let entity_type: 'person' | 'vehicle' | 'gadget' = 'person';
    let entity_id: Types.ObjectId | null = null;
    let access_result: 'granted' | 'denied' = 'denied';
    let reason: string | null = 'unregistered_uid';
    let personView: TapResult['person'];
    let companionPersonId: Types.ObjectId | null = null;
    let lapsedAtOwnGate = false;
    // Set by the Gadget Lane's entry branch: this tap was granted, but it is a
    // declaration rather than a passage, so it must not touch occupancy. The
    // owner's ID tap at Main Entrance is what commits it.
    let carryParked = false;

    if (await blockedCardRepo.isBlocked(input.rfid_uid)) {
      access_result = 'denied';
      reason = 'card_blocked';
    } else {
      const person = await personRepo.findByRfid(input.rfid_uid);
      if (person) {
        personView = {
          full_name: person.full_name,
          type: person.type,
          department_section: person.department_section ?? null,
          photo_url: person.photo_url,
          person_id: String(person._id),
        };

        if (gate.type === 'vehicle') {
          entity_type = 'person';
          entity_id = person._id;
          if (person.status !== 'active') {
            access_result = 'denied';
            reason = 'inactive_id';
            lapsedAtOwnGate = true;
          } else {
            const owned = await vehicleRepo.findActiveByOwner(person._id, scan_time);
            if (owned.length === 0) {
              access_result = 'denied';
              reason = 'no_vehicle_registered';
              lapsedAtOwnGate = true;
            } else if (owned.length > 1) {
              access_result = 'denied';
              reason = 'multiple_vehicles';
              lapsedAtOwnGate = true;
            } else {
              const v = owned[0];
              entity_type = 'vehicle';
              entity_id = v._id;
              companionPersonId = person._id;
              access_result = 'granted';
              reason = null;
              personView = {
                full_name: person.full_name,
                type: 'vehicle',
                owner_type: person.type,
                department_section: person.department_section ?? null,
                photo_url: person.photo_url,
                plate_number: v.plate_number,
                vehicle: { vehicle_type: v.vehicle_type, make: v.make },
                vehicle_photo_url: v.photo_url,
              };
            }
          }
        } 
        else {
          entity_type = 'person';
          entity_id = person._id;
          if (person.status === 'active') {
            access_result = 'granted';
            reason = null;
          } else {
            access_result = 'denied';
            reason = 'inactive_id';
            lapsedAtOwnGate = true;
          }
        }
      } else {
        const vehicle = await vehicleRepo.findByRfid(input.rfid_uid);
        if (vehicle) {
          entity_type = 'vehicle';
          entity_id = vehicle._id;
          if (vehicle.status !== 'active') {
            access_result = 'denied';
            reason = 'inactive_id';
            lapsedAtOwnGate = gate.type === 'vehicle';
          } else if (!vehicle.valid_until || vehicle.valid_until.getTime() < scan_time.getTime()) {
            access_result = 'denied';
            reason = 'vehicle_expired';
            lapsedAtOwnGate = gate.type === 'vehicle';
          } else {
            access_result = 'granted';
            reason = null;
          }
          const owner = await personRepo.findById(String(vehicle.owner_person_id));
          personView = {
            full_name: owner?.full_name ?? 'Unknown owner',
            type: 'vehicle',
            owner_type: owner?.type,
            department_section: owner?.department_section ?? null,
            photo_url: owner?.photo_url,
            plate_number: vehicle.plate_number,
            vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
            vehicle_photo_url: vehicle.photo_url,
          };
        } else {
          const gadget = await gadgetRepo.findByRfid(input.rfid_uid);
          if (gadget) {
            entity_type = 'gadget';
            entity_id = gadget._id;
            if (gate.type === 'person' && input.direction === 'entry') {
              // ENTRY: the lane runs Gadget Lane -> Main Entrance. A device
              // sticker is tapped FIRST, before its owner reaches the person
              // reader, so there is no session to check it against and none is
              // wanted — the person tap at the end is the security door, and
              // this tap is only a declaration of what is being carried.
              //
              // So this grants but deliberately commits NOTHING: `carryParked`
              // below skips the occupancy write, and the device is parked
              // under its owner until their ID tap walks it in. A device whose
              // owner never arrives expires having never been inside.
              if (gate.name !== GADGET_LANE_NAME) {
                // Main Entrance is for people. Naming the right reader beats
                // the generic wrong_gate_type, which would be read as "this
                // sticker is not valid" rather than "you are at the wrong one".
                access_result = 'denied';
                reason = 'gadget_wrong_lane';
              } else if (gadget.status !== 'active') {
                access_result = 'denied';
                reason = 'inactive_id';
              } else {
                access_result = 'granted';
                reason = 'carry_pending';
                carryParked = true;
                pendingCarryStore.park(String(gadget.owner_person_id), {
                  id: String(gadget._id),
                  rfid_uid: gadget.rfid_uid ?? input.rfid_uid,
                  gadget_type: gadget.gadget_type,
                  brand_model: gadget.brand_model,
                  serial_number: gadget.serial_number,
                  photo_url: gadget.photo_url,
                });
              }
            } else if (gate.type === 'person') {
              // EXIT keeps the session rule, and keeps it for the reason the
              // entry path has now outgrown: leaving, the terminal is working
              // through a checklist of SPECIFIC devices the person's own exit
              // tap said were still inside, so a device tapped with no such
              // checklist open belongs to nobody's transaction. See
              // gateSession.store.ts, which now serves only this direction.
              const sessionPersonId = gateSessionStore.activePerson(String(gate._id));
              if (!sessionPersonId) {
                access_result = 'denied';
                reason = 'gadget_requires_person_tap';
              } else if (sessionPersonId !== String(gadget.owner_person_id)) {
                access_result = 'denied';
                reason = 'gadget_owner_mismatch';
              } else if (gadget.status === 'active') {
                access_result = 'granted';
                reason = null;
                // Ticks this device off the checklist. When it was the last one
                // owed, the session closes here rather than lingering on its
                // clock — the next device tapped at this reader then needs a
                // fresh person tap, which is the whole rule.
                gateSessionStore.settle(String(gate._id), String(gadget._id));
              } else {
                access_result = 'denied';
                reason = 'inactive_id';
              }
            } else {
              if (gadget.status === 'active') {
                access_result = 'granted';
                reason = null;
              } else {
                access_result = 'denied';
                reason = 'inactive_id';
              }
            }
            const owner = await personRepo.findById(String(gadget.owner_person_id));
            personView = {
              full_name: owner?.full_name ?? 'Unknown owner',
              type: 'gadget',
              owner_type: owner?.type,
              department_section: owner?.department_section ?? null,
              // The owner's face, so the Gadget Lane can show WHO is carrying
              // the device beside the device itself — the sticker is tied to a
              // student, and the guard is checking that pairing. Stripped
              // again below on any denial, alongside `gadgets`, so a refused
              // tap still reveals no identity.
              photo_url: owner?.photo_url,
              gadgets: [
                {
                  id: String(gadget._id),
                  gadget_type: gadget.gadget_type,
                  brand_model: gadget.brand_model,
                  serial_number: gadget.serial_number,
                  photo_url: gadget.photo_url,
                },
              ],
            };
          }
        }
      }
    }
   if (access_result === 'granted' && entity_type === 'person' && gate.name === 'Gadget Lane') {
      access_result = 'denied';
      reason = 'person_not_allowed_at_gadget_lane';
    }

    const gadgetAtPersonGate = entity_type === 'gadget' && gate.type === 'person';
    if (access_result === 'granted' && !gadgetAtPersonGate && entity_type !== gate.type) {
      access_result = 'denied';
      reason = 'wrong_gate_type';
      personView = undefined;
    }

    let lapsedEgress = false;
    if (input.direction === 'exit' && access_result === 'denied' && lapsedAtOwnGate && entity_id) {
      access_result = 'granted';
      lapsedEgress = true;
    }

    // `!carryParked`: a Gadget Lane declaration is granted but moves nothing.
    // The device becomes `inside` only in the commit block further down, when
    // its owner's own tap is granted at Main Entrance.
    if (access_result === 'granted' && entity_id && !carryParked) {
      const gateOid = gate._id;
      const boundary = lastResetBoundary(scan_time);
      if (input.direction === 'entry') {
        const outcome = await occupancyRepo.enter(entity_type, entity_id, gateOid, boundary);
        if (outcome === 'already_inside') {
          access_result = 'denied';
          reason = 'already_inside';
        } else if (companionPersonId) {
          try {
            await occupancyRepo.enter('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person occupancy failed on entry for ${companionPersonId.toString()}; ` +
                'vehicle admitted anyway (best-effort)',
              err
            );
          }
        }
      } else {
        let outcome: 'released' | 'exit_without_entry';
        try {
          outcome = await occupancyRepo.release(entity_type, entity_id, gateOid, boundary);
        } catch (err) {
          console.error(
            `[scan] occupancy unavailable on exit for ${entity_type} ${entity_id.toString()}; ` +
              'granting access anyway (fail-open)',
            err
          );
          reason = 'occupancy_unavailable';
          outcome = 'released';
        }
        if (outcome === 'exit_without_entry' && reason === null) {
          reason = 'exit_without_entry';
        }
        if (companionPersonId) {
          try {
            await occupancyRepo.release('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person release failed on exit for ${companionPersonId.toString()}; ` +
                'granting anyway (fail-open)',
              err
            );
          }
        }
      }
    }

    const identityWithheld = access_result !== 'granted' || lapsedEgress;

    if (!identityWithheld && entity_type === 'person' && entity_id && personView) {
      const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
      personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));

      const devices = await gadgetRepo.findActiveByOwner(entity_id);
      personView.gadgets = devices.map((g) => ({
        id: String(g._id),
        gadget_type: g.gadget_type,
        brand_model: g.brand_model,
        serial_number: g.serial_number,
        photo_url: g.photo_url,
      }));

      if (input.direction === 'exit' && devices.length > 0) {
        const insideRows = await occupancyRepo.listInsideGadgetIds(
          devices.map((g) => g._id),
          lastResetBoundary(scan_time)
        );
        const insideSet = new Set(insideRows.map(String));
        personView.gadgets_inside = devices
          .filter((g) => insideSet.has(String(g._id)))
          .map((g) => ({
            id: String(g._id),
            gadget_type: g.gadget_type,
            brand_model: g.brand_model,
            serial_number: g.serial_number,
            photo_url: g.photo_url,
          }));
      }

      // ENTRY: this is where the devices this person declared at the Gadget
      // Lane actually walk inside. Reached only on a granted entry — a person
      // refused here (inactive ID, already_inside) flips access_result before
      // `identityWithheld` is computed, so nothing commits and the bucket
      // stays parked for their re-tap.
      //
      // Each device gets its own ScanLog row, so the records screen shows the
      // laptop entering as a laptop rather than the fact being buried inside
      // the owner's person row.
      if (input.direction === 'entry' && gate.name === MAIN_ENTRANCE_NAME) {
        const parked = pendingCarryStore.claim(String(entity_id));
        const boundary = lastResetBoundary(scan_time);
        for (const g of parked) {
          const gadgetOid = new Types.ObjectId(g.id);
          let admitted = false;
          try {
            admitted = (await occupancyRepo.enter('gadget', gadgetOid, gate._id, boundary)) === 'admitted';
          } catch (err) {
            // The person is already through; a device's occupancy write
            // failing must not hold the barrier or lose the audit row below.
            console.error(`[scan] carried device occupancy failed for ${g.id}`, err);
          }
          try {
            await scanRepo.createLog({
              rfid_uid: g.rfid_uid,
              entity_type: 'gadget',
              entity_id: gadgetOid,
              gate_id: gate._id,
              direction: 'entry',
              access_result: admitted ? 'granted' : 'denied',
              reason: admitted ? null : 'already_inside',
              scan_time,
            });
          } catch (err) {
            console.error(`[scan] carried device log failed for ${g.id}`, err);
          }
        }
        // Every claimed device is shown, admitted or not: the guard is being
        // told what this person declared at the lane, and a device the system
        // already had inside is exactly the discrepancy worth seeing.
        if (parked.length > 0) {
          personView.gadgets_carried = parked.map((g) => ({
            id: g.id,
            gadget_type: g.gadget_type,
            brand_model: g.brand_model,
            serial_number: g.serial_number,
            photo_url: g.photo_url,
          }));
        }
      } else if (input.direction === 'exit' && (personView.gadgets_inside?.length ?? 0) > 0) {
        // Seeded with the exact devices this exit is owed, so the session ends
        // when they have all been read instead of when the clock runs out.
        gateSessionStore.open(
          String(gate._id),
          String(entity_id),
          personView.gadgets_inside!.map((g) => g.id)
        );
      }
    }

    if (identityWithheld && entity_type === 'gadget' && personView) {
      delete personView.gadgets;
      // The owner's face is now attached to a granted device tap so the lane
      // can show who is carrying what; it has to come back off on a denial for
      // the same reason the device list does — a refused sticker must not
      // identify anybody.
      delete personView.photo_url;
    }

    await scanRepo.createLog({
      rfid_uid: input.rfid_uid,
      entity_type,
      entity_id,
      gate_id: gate._id,
      direction: input.direction,
      access_result,
      reason,
      scan_time,
    });

    const attendancePersonId = entity_type === 'person' ? entity_id : companionPersonId;
    if (access_result === 'granted' && attendancePersonId) {
      const key = dateKey(scan_time);
      if (input.direction === 'entry') {
        await attendanceRepo.upsertTimeIn(
          String(attendancePersonId),
          key,
          scan_time,
          isLate(scan_time) ? 'late' : 'present'
        );
      } else {
        await attendanceRepo.upsertTimeOut(String(attendancePersonId), key, scan_time);
      }
    }

    liveHub.notifyScan();

    return { access_result, reason, scan_time, person: personView };
  },

  async closeGadgetSession(input: {
    gate_id: string;
    person_id: string;
    missing_gadget_ids: string[];
  }): Promise<{ logged: boolean; missing: number }> {
    const gate = await gateRepo.findById(input.gate_id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');
    if (!Types.ObjectId.isValid(input.person_id)) {
      throw new ApiError('VALIDATION_ERROR', 'person_id is not a valid id');
    }
    const person = await personRepo.findById(input.person_id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    // The terminal has given up on this checklist, so the permit it was
    // running under is spent. Closed BEFORE the audit row is written: the
    // write can fail, and a session left open by a failed log is precisely the
    // standing permit this endpoint is reporting the end of.
    gateSessionStore.close(String(gate._id));

    await scanRepo.createLog({
      rfid_uid: person.rfid_uid ?? '',
      entity_type: 'person',
      entity_id: person._id,
      gate_id: gate._id,
      direction: 'exit',
      access_result: 'granted',
      reason: 'gadget_not_returned',
      scan_time: new Date(),
    });

    liveHub.notifyScan();
    return { logged: true, missing: input.missing_gadget_ids.length };
  },

  async listLogs(query: Record<string, string | undefined>) {
    const { getPagination, buildMeta } = await import('../../utils/pagination');
    const p = getPagination(query);

    const match: Record<string, unknown> = {};
    if (query.gate_id) {
      if (!Types.ObjectId.isValid(query.gate_id)) {
        throw new ApiError('VALIDATION_ERROR', 'gate_id is not a valid id');
      }
      match.gate_id = new Types.ObjectId(query.gate_id);
    }
    if (query.direction) match.direction = query.direction;
    if (query.access_result) match.access_result = query.access_result;
    if (query.from || query.to) {
      match.scan_time = parseLocalDateRange(query.from, query.to);
    }

    const pipeline = [
      { $match: match },
      { $sort: { scan_time: -1 as const } },
      { $skip: p.skip },
      { $limit: p.limit },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
      { $lookup: { from: 'gadgets', localField: 'entity_id', foreignField: '_id', as: 'gadget' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gateDoc' } },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          scan_time: 1,
          direction: 1,
          access_result: 1,
          reason: 1,
          entity_type: 1,
          rfid_uid: 1,
          gate: {
            $cond: [
              { $gt: [{ $size: '$gateDoc' }, 0] },
              {
                id: { $toString: { $first: '$gateDoc._id' } },
                name: { $first: '$gateDoc.name' },
              },
              null,
            ],
          },
          subject: {
            $cond: [
              { $gt: [{ $size: '$person' }, 0] },
              {
                full_name: { $first: '$person.full_name' },
                id_number: { $first: '$person.id_number' },
              },
              {
                $cond: [
                  { $gt: [{ $size: '$vehicle' }, 0] },
                  { plate_number: { $first: '$vehicle.plate_number' } },
                  {
                    $cond: [
                      { $gt: [{ $size: '$gadget' }, 0] },
                      {
                        full_name: { $first: '$gadget.brand_model' },
                        id_number: { $first: '$gadget.serial_number' },
                      },
                      null,
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ];

    const [items, total] = await Promise.all([
      ScanLogModel.aggregate(pipeline),
      ScanLogModel.countDocuments(match),
    ]);

    return {
      items,
      meta: { ...buildMeta(total, p.page, p.limit), truncated: total > p.limit },
    };
  },
};