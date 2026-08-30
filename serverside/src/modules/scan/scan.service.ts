// import { Types } from 'mongoose';
// import { scanRepo } from './scan.repository';
// import { ScanLogModel } from './scan.model';
// import { attendanceRepo } from '../attendance/attendance.repository';
// import { personRepo } from '../persons/persons.repository';
// import { vehicleRepo } from '../vehicles/vehicles.repository';
// import { gadgetRepo } from '../gadgets/gadgets.repository';
// import { gateRepo } from '../gates/gates.repository';
// import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
// import { ApiError } from '../../utils/ApiError';
// import { env } from '../../config/env';
// import { occupancyRepo } from '../occupancy/occupancy.repository';
// import { lastResetBoundary } from '../../utils/occupancyWindow';
// import { parseLocalDateRange } from '../../utils/dateRange';
// import { liveHub } from '../dashboard/liveHub';

// interface TapInput {
//   rfid_uid: string;
//   gate_id: string;
//   direction: 'entry' | 'exit';
// }

// interface TapResult {
//   access_result: 'granted' | 'denied';
//   reason: string | null;
//   scan_time: Date;
//   person?: {
//     full_name: string;
//     type: string;
//     owner_type?: string;
//     department_section: string | null;
//     photo_url?: string;
//     /** The VEHICLE's photo. `photo_url` above stays the owner's face — the
//      *  terminal shows both side by side on a vehicle gate. */
//     vehicle_photo_url?: string;
//     plate_number?: string;
//     vehicle?: { vehicle_type: string; make?: string };
//     registered?: { vehicle_type: string; make?: string }[];
//     /** The cardholder's registered devices, for the exit ownership check. Shown
//      *  to the guard; never consulted by any access decision. */
//     gadgets?: {
//       id: string;
//       gadget_type: string;
//       brand_model: string;
//       serial_number: string;
//       photo_url?: string;
//     }[];
//     /** The subset of those devices whose occupancy row is still `inside` — what
//      *  the exit terminal must see tapped out. Populated ONLY on a granted
//      *  person EXIT tap: on entry there is nothing to return yet, and on a
//      *  denial this is withheld for the same reason `gadgets` is. */
//     gadgets_inside?: {
//       id: string;
//       gadget_type: string;
//       brand_model: string;
//       serial_number: string;
//     }[];
//     person_id?: string;
//   };
// }

// function dateKey(d: Date): string {
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`;
// }

// function isLate(when: Date): boolean {
//   const [h, m] = env.LATE_CUTOFF_TIME.split(':').map((n) => parseInt(n, 10));
//   const cutoff = new Date(when);
//   cutoff.setHours(h, m, 0, 0);
//   return when.getTime() > cutoff.getTime();
// }

// export const scanService = {
//   async tap(input: TapInput): Promise<TapResult> {
//     const gate = await gateRepo.findById(input.gate_id);
//     if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

//     const scan_time = new Date();

//     let entity_type: 'person' | 'vehicle' | 'gadget' = 'person';
//     let entity_id: Types.ObjectId | null = null;
//     let access_result: 'granted' | 'denied' = 'denied';
//     let reason: string | null = 'unregistered_uid';
//     let personView: TapResult['person'];
//     // Set ONLY on a granted owner-card resolution: the person whose card
//     // opened a vehicle gate. Drives the companion occupancy and attendance
//     // writes in Task 2. Null on every other path, including vehicle-tag taps
//     // — a sticker identifies a car, a card identifies a person, and only the
//     // latter is evidence that the human was present.
//     let companionPersonId: Types.ObjectId | null = null;
//     // True when this tap was refused because the holder's REGISTRATION has
//     // lapsed — deactivated, expired, or resolving to no single vehicle — at a
//     // gate the card otherwise belongs at. It is set only in those branches,
//     // never inferred from `reason` afterwards, because the deciding fact is one
//     // only those branches hold: that the card is at the right barrier. A
//     // vehicle tag refused with `vehicle_expired` at a WALKING gate carries the
//     // same reason code and must not be overridden into an exit there.
//     //
//     // Drives the egress override below. Never consulted on entry.
//     let lapsedAtOwnGate = false;

//     // A blocked card is refused before we look up what it used to be. It is
//     // checked first because a blocked UID must never resolve to an identity:
//     // the card may be in the wrong hands, which is why it was retired.
//     //
//     // Like every denial, this sits before the anti-passback block, so a blocked
//     // card can never move anyone's inside/outside state.
//     if (await blockedCardRepo.isBlocked(input.rfid_uid)) {
//       access_result = 'denied';
//       reason = 'card_blocked';
//       // personView is deliberately left undefined.
//     } else {
//       // Resolve entity by RFID: person first, then vehicle
//       const person = await personRepo.findByRfid(input.rfid_uid);
//       if (person) {
//         // Identity view shared by every person-resolved outcome below. The
//         // granted owner-card path REPLACES it with the vehicle-shaped view.
//         personView = {
//           full_name: person.full_name,
//           type: person.type,
//           department_section: person.department_section ?? null,
//           photo_url: person.photo_url,
//           // The terminal opens its device prompt against this id. Set on the
//           // shared person view rather than in one branch, so a person tap
//           // carries it at every gate type.
//           person_id: String(person._id),
//         };

//         if (gate.type === 'vehicle') {
//           // Single-card access. The card IS correct for this gate, so the
//           // denials here are about the holder's registration, never
//           // wrong_gate_type. Entity stays 'person' on a denial so the scan
//           // log records who was refused; only a grant becomes the vehicle.
//           entity_type = 'person';
//           entity_id = person._id;
//           if (person.status !== 'active') {
//             // Ordered BEFORE the vehicle lookup on purpose: a deactivated ID
//             // is an identity problem, and reporting "no vehicle registered"
//             // for it would send a guard after the wrong thing.
//             access_result = 'denied';
//             reason = 'inactive_id';
//             lapsedAtOwnGate = true;
//           } else {
//             const owned = await vehicleRepo.findActiveByOwner(person._id, scan_time);
//             if (owned.length === 0) {
//               access_result = 'denied';
//               reason = 'no_vehicle_registered';
//               lapsedAtOwnGate = true;
//             } else if (owned.length > 1) {
//               // Expected, not exceptional. A person may now hold several
//               // active vehicles (see constants/vehicleTypes VEHICLE_LIMITS),
//               // so their CARD cannot say which one they are driving. The
//               // vehicle's own RFID sticker can, and is the intended lane —
//               // this denial tells the guard to use it. Refusing to guess is
//               // the point: granting here would log a plate nobody verified
//               // into the scan log, the occupancy roster and the anomaly
//               // report.
//               access_result = 'denied';
//               reason = 'multiple_vehicles';
//               lapsedAtOwnGate = true;
//             } else {
//               const v = owned[0];
//               entity_type = 'vehicle';
//               entity_id = v._id;
//               companionPersonId = person._id;
//               access_result = 'granted';
//               reason = null;
//               personView = {
//                 full_name: person.full_name,
//                 type: 'vehicle',
//                 owner_type: person.type,
//                 department_section: person.department_section ?? null,
//                 photo_url: person.photo_url,
//                 plate_number: v.plate_number,
//                 vehicle: { vehicle_type: v.vehicle_type, make: v.make },
//                 vehicle_photo_url: v.photo_url,
//               };
//             }
//           }
//         } else {
//           entity_type = 'person';
//           entity_id = person._id;
//           if (person.status === 'active') {
//             access_result = 'granted';
//             reason = null;
//           } else {
//             access_result = 'denied';
//             reason = 'inactive_id';
//             lapsedAtOwnGate = true;
//           }
//         }
//       } else {
//         const vehicle = await vehicleRepo.findByRfid(input.rfid_uid);
//         if (vehicle) {
//           entity_type = 'vehicle';
//           entity_id = vehicle._id;
//           if (vehicle.status !== 'active') {
//             access_result = 'denied';
//             reason = 'inactive_id';
//             // Only at a vehicle gate. A sticker tapped at a walking gate is a
//             // wrong_gate_type tap wearing a lapse's reason code, and must stay
//             // denied in both directions.
//             lapsedAtOwnGate = gate.type === 'vehicle';
//           } else if (!vehicle.valid_until || vehicle.valid_until.getTime() < scan_time.getTime()) {
//             // Expiry is stored as end-of-day local (see nextSchoolYearEnd), so a
//             // pass valid until 2027-03-31 works for all of that day.
//             //
//             // `valid_until` is `required: true` on the schema, but that is
//             // enforced only on write — a Vehicle row created before this field
//             // existed (or restored from an older backup, or edited directly in
//             // Mongo) can still have it missing. Treat a missing expiry as
//             // already-expired rather than dereferencing `.getTime()` on
//             // `undefined`: the latter is a raw TypeError thrown before
//             // scanRepo.createLog runs below, which denies the tap AND leaves no
//             // scan log, no anomaly row, nothing an auditor could find. Failing
//             // closed here keeps the same fail-closed posture as the rest of
//             // this function while still logging the denial.
//             access_result = 'denied';
//             reason = 'vehicle_expired';
//             lapsedAtOwnGate = gate.type === 'vehicle';
//           } else {
//             access_result = 'granted';
//             reason = null;
//           }
//           const owner = await personRepo.findById(String(vehicle.owner_person_id));
//           personView = {
//             full_name: owner?.full_name ?? 'Unknown owner',
//             type: 'vehicle',
//             owner_type: owner?.type,
//             department_section: owner?.department_section ?? null,
//             // The owner's FACE. This was missing: the owner-card path above
//             // has always sent it and this one never did, so a sticker tap
//             // showed a name with no face — and the sticker is now the primary
//             // lane for anyone with more than one vehicle.
//             photo_url: owner?.photo_url,
//             plate_number: vehicle.plate_number,
//             vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
//             vehicle_photo_url: vehicle.photo_url,
//           };
//         } else {
//           // Third and LAST resolution branch. Order is load-bearing: persons
//           // and vehicles are the access-bearing entities and must never be
//           // shadowed by a gadget lookup.
//           //
//           // This is the case scan.service used to say would never exist. A
//           // gadget now taps in its own right so the system can record which
//           // devices came in and whether they left — but it still decides
//           // nothing about a human's passage. A gadget tap moves ONLY its own
//           // occupancy row: the barrier is already open or shut on the strength
//           // of the person's own card, tapped moments earlier.
//           const gadget = await gadgetRepo.findByRfid(input.rfid_uid);
//           if (gadget) {
//             entity_type = 'gadget';
//             entity_id = gadget._id;
//             if (gadget.status === 'active') {
//               access_result = 'granted';
//               reason = null;
//             } else {
//               access_result = 'denied';
//               reason = 'inactive_id';
//               // lapsedAtOwnGate stays false: the egress override exists to
//               // stop a person being trapped inside, and a laptop cannot be
//               // trapped. A deactivated device simply does not tap out, and
//               // its row is cleared by the nightly boundary.
//             }
//             const owner = await personRepo.findById(String(gadget.owner_person_id));
//             personView = {
//               full_name: owner?.full_name ?? 'Unknown owner',
//               type: 'gadget',
//               owner_type: owner?.type,
//               department_section: owner?.department_section ?? null,
//               gadgets: [
//                 {
//                   id: String(gadget._id),
//                   gadget_type: gadget.gadget_type,
//                   brand_model: gadget.brand_model,
//                   serial_number: gadget.serial_number,
//                   photo_url: gadget.photo_url,
//                 },
//               ],
//             };
//           }
//         }
//       }
//     }

//     // A gate has a fixed type, so a person card must not open the parking
//     // barrier and a vehicle tag must not register attendance at a walking gate.
//     //
//     // Gadgets needed a carve-out here rather than a widening, because a gate's
//     // type is only ever 'person' or 'vehicle': there is no gadget gate and
//     // there should not be one, so 'gadget' matches neither by construction and
//     // every device tap would otherwise be denied wrong_gate_type.
//     //
//     // The carve-out is narrow on purpose. Gadgets are exempt at PERSON gates
//     // ONLY, not universally. A device accompanies whoever carries it through a
//     // walking gate, which is why it cannot be held to a gate type of its own —
//     // but a laptop tag at the parking barrier is a genuine wrong-gate tap, and
//     // showing the guard GRANTED for it is the opposite of useful. Gadget Lane
//     // is seeded type: 'person' (seed.ts:18); no vehicle gate ever expects a
//     // device.
//     const gadgetAtPersonGate = entity_type === 'gadget' && gate.type === 'person';
//     if (access_result === 'granted' && !gadgetAtPersonGate && entity_type !== gate.type) {
//       access_result = 'denied';
//       reason = 'wrong_gate_type';
//       personView = undefined;
//     }

//     // Egress is never blocked by a lapsed registration.
//     //
//     // A pass can lapse — deactivated by a clerk, or valid_until simply passing
//     // — while the holder is standing INSIDE the campus. Refusing their ENTRY
//     // after that is the point of the feature. Refusing their EXIT is a
//     // different thing entirely, and it was trapping them: occupancy only ever
//     // moves on a granted tap, so a refused exit leaves the row `inside` for the
//     // rest of the occupancy window, and every tap after the pass is restored
//     // comes back `already_inside` with no way to resolve it at the gate. That
//     // is the defect this block closes — observed on 2026-08-06, where a car
//     // admitted at 03:07, deactivated, then reactivated could not get back in.
//     //
//     // The tap is GRANTED but keeps its reason, so nothing is hidden: the guard
//     // sees "ID inactive" on the terminal, the scan log records why the barrier
//     // opened, and reports.anomalies surfaces the row. This is the same
//     // granted-with-a-reason shape that `exit_without_entry` and
//     // `occupancy_unavailable` already use.
//     //
//     // Placed AFTER the wrong_gate_type guard so a card at the wrong barrier
//     // cannot be overridden into an exit there, and BEFORE the anti-passback
//     // block so the override actually releases the occupancy row — releasing it
//     // is the entire purpose. `lapsedAtOwnGate` is set only where the card is
//     // known to belong at this gate; see its declaration.
//     //
//     // Deliberately NOT extended to `card_blocked` or `unregistered_uid`: a
//     // blocked card is refused before identity is resolved because it may be in
//     // the wrong hands, and an unregistered UID has no occupancy row to free, so
//     // neither can be trapped by this mechanism in the first place.
//     let lapsedEgress = false;
//     if (input.direction === 'exit' && access_result === 'denied' && lapsedAtOwnGate && entity_id) {
//       access_result = 'granted';
//       lapsedEgress = true;
//       // `reason` is deliberately left as-is.
//     }

//     // Anti-passback. Runs only on taps that are otherwise granted, so a denied
//     // card can never move anyone's state — including a stranger repeatedly
//     // tapping a stolen inactive card.
//     if (access_result === 'granted' && entity_id) {
//       // gate._id is the same ObjectId as input.gate_id: gateRepo.findById above
//       // resolved it from this exact string, so reuse it instead of
//       // reconstructing a third ObjectId from the same source string.
//       const gateOid = gate._id;
//       // Shared by both branches so entry and exit agree on exactly the same
//       // reset boundary for this tap, rather than each computing it separately.
//       const boundary = lastResetBoundary(scan_time);
//       if (input.direction === 'entry') {
//         const outcome = await occupancyRepo.enter(entity_type, entity_id, gateOid, boundary);
//         if (outcome === 'already_inside') {
//           access_result = 'denied';
//           reason = 'already_inside';
//           // personView is deliberately KEPT: a guard needs to see who the
//           // system thinks is inside in order to resolve it.
//         } else if (companionPersonId) {
//           // BEST-EFFORT, and deliberately second. The vehicle row above is
//           // authoritative and is what the anti-passback check runs on. There
//           // is no transaction here (standalone Mongo), so these two writes
//           // cannot be atomic — and denying on a failure would be worse than
//           // tolerating one, because the deny happens AFTER the vehicle row
//           // already moved: it would record a car inside the lot while
//           // keeping the barrier shut, and unwinding needs a compensating
//           // release that can itself fail. Worst case here is a car correctly
//           // in the lot whose driver's attendance is missing, which this log
//           // line surfaces.
//           //
//           // 'already_inside' is benign, not an error: the person may have
//           // walked in through a person gate earlier.
//           try {
//             await occupancyRepo.enter('person', companionPersonId, gateOid, boundary);
//           } catch (err) {
//             console.error(
//               `[scan] companion person occupancy failed on entry for ${companionPersonId.toString()}; ` +
//                 'vehicle admitted anyway (best-effort)',
//               err
//             );
//           }
//         }
//       } else {
//         // Egress is never blocked, including when occupancy itself is
//         // unavailable: a stuck exit gate is a physical safety problem, while a
//         // failed release only leaves a stale roster row that the nightly
//         // boundary clears. Entry deliberately still fails closed.
//         let outcome: 'released' | 'exit_without_entry';
//         try {
//           outcome = await occupancyRepo.release(entity_type, entity_id, gateOid, boundary);
//         } catch (err) {
//           console.error(
//             `[scan] occupancy unavailable on exit for ${entity_type} ${entity_id.toString()}; ` +
//               'granting access anyway (fail-open)',
//             err
//           );
//           reason = 'occupancy_unavailable';
//           outcome = 'released';
//         }
//         if (outcome === 'exit_without_entry' && reason === null) {
//           // Only when nothing more specific was recorded. On a lapsed egress
//           // the reason is already the lapse — the fact the guard needs, and the
//           // fact that explains why the barrier opened at all. Overwriting it
//           // here would report a card that left on a revoked pass as an ordinary
//           // missed tap-in, which is the milder of the two anomalies.
//           reason = 'exit_without_entry';
//         }
//         if (companionPersonId) {
//           // Best-effort, same reasoning as entry. A person already outside is
//           // SILENT rather than an anomaly: they may have walked out through a
//           // person gate and returned on foot. The vehicle release above
//           // carries the anomaly signal for this tap.
//           try {
//             await occupancyRepo.release('person', companionPersonId, gateOid, boundary);
//           } catch (err) {
//             console.error(
//               `[scan] companion person release failed on exit for ${companionPersonId.toString()}; ` +
//                 'granting anyway (fail-open)',
//               err
//             );
//           }
//         }
//       }
//     }

//     // Registered items are withheld on EVERY denial. A guard resolving a denial
//     // needs to know who, not what that person owns, and a denied tap is the case
//     // most likely to involve someone holding a card that is not theirs. This is
//     // enforced here rather than by the UI declining to render it: a field the
//     // server sends is a field that exists in the response, whoever is looking.
//     //
//     // Placed after wrong_gate_type (which clears personView entirely) and after
//     // the anti-passback block, so it can never resurrect identity on a denial
//     // that deliberately withheld it, nor attach on an already_inside denial.
//     // `!lapsedEgress` keeps the withholding rule intact. That override turns a
//     // denial into a grant so the barrier opens, but the tap is still a refused
//     // registration, and a deactivated ID is precisely the case most likely to
//     // involve a card in the wrong hands — the reason this data is withheld on
//     // denials at all. Testing `access_result` alone would hand exactly that
//     // person the cardholder's vehicle and laptop-serial list.
//     //
//     // Hoisted into a named condition because the rule now has two arms: the
//     // person arm below, which withholds by never ATTACHING the lists, and the
//     // gadget arm just after it, which has to REMOVE one. Both must always
//     // agree on what "withheld" means, and two copies of the predicate would
//     // eventually stop agreeing.
//     const identityWithheld = access_result !== 'granted' || lapsedEgress;

//     if (!identityWithheld && entity_type === 'person' && entity_id && personView) {
//       const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
//       personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));
//       // Registered devices, for the exit ownership check: the guard compares
//       // the serial on this screen against the laptop in the person's hands.
//       //
//       // This is the ENTIRE gate-side footprint of the gadget registry, and it
//       // lives inside this block rather than anywhere else for four reasons,
//       // each of which is a property the placement guarantees rather than a rule
//       // something else has to enforce:
//       //
//       //   1. It cannot deny. access_result and reason are already final by the
//       //      time this runs, and nothing above reads `gadgets`. There is no
//       //      path from a laptop registration to a refused tap — which is the
//       //      whole design: the check answers "is this device yours", never "may
//       //      you leave". Those are different questions and the second is
//       //      already answered, independently, by the person's own card.
//       //   2. It is withheld on every denial, by the same `granted` condition
//       //      that withholds `registered` above — see that comment. A denied tap
//       //      is the case most likely to involve someone holding a card that is
//       //      not theirs, and handing that person a list of the cardholder's
//       //      laptop serials inverts the point of the feature entirely.
//       //   3. Vehicle gates are unaffected. The single-card owner path sets
//       //      entity_type = 'vehicle' before this point, so the condition does
//       //      not hold there. The parking barrier does not prompt for a laptop.
//       //   4. It stays a DISPLAY field even though a gadget is now a full
//       //      entity_type in its own right. That widening is what this list
//       //      item used to deny, and each consequence of it is handled
//       //      elsewhere, on purpose, rather than here: the wrong_gate_type
//       //      guard needed the `gadgetAtPersonGate` carve-out (there is no
//       //      gadget gate type, so a device would otherwise be refused at every
//       //      barrier); a gadget tap moves its OWN occupancy row and is
//       //      therefore subject to anti-passback like anything else that has
//       //      one; and it writes its own ScanLog rows, which is the entire
//       //      point of the feature. What remains true is attendance: a gadget
//       //      tap writes none, because `attendancePersonId` is null for it —
//       //      attendance is keyed by person and a device is not a person. This
//       //      block still adds no reason codes of its own.
//       const devices = await gadgetRepo.findActiveByOwner(entity_id);
//       personView.gadgets = devices.map((g) => ({
//         id: String(g._id),
//         gadget_type: g.gadget_type,
//         brand_model: g.brand_model,
//         serial_number: g.serial_number,
//         photo_url: g.photo_url,
//       }));

//       // On EXIT only, narrow that list to the devices whose occupancy row is
//       // still `inside` — the ones the terminal must see tapped out. Entry
//       // returns nothing here: the devices have not been tapped in yet, so an
//       // "expected" list at entry would be a list of things nobody promised.
//       //
//       // Reuses the same `boundary` rule occupancy itself applies, so a device
//       // stranded inside from before the nightly reset is not demanded back
//       // today. Without that, one forgotten tap-out would haunt every
//       // subsequent exit for that person until an admin cleared the row.
//       if (input.direction === 'exit' && devices.length > 0) {
//         const insideRows = await occupancyRepo.listInsideGadgetIds(
//           devices.map((g) => g._id),
//           lastResetBoundary(scan_time)
//         );
//         const insideSet = new Set(insideRows.map(String));
//         personView.gadgets_inside = devices
//           .filter((g) => insideSet.has(String(g._id)))
//           .map((g) => ({
//             id: String(g._id),
//             gadget_type: g.gadget_type,
//             brand_model: g.brand_model,
//             serial_number: g.serial_number,
//           }));
//       }
//     }

//     // The same rule, second arm — see identityWithheld above.
//     //
//     // A gadget tap is the one path that reaches here with `gadgets` ALREADY
//     // populated: the third resolution branch builds personView from the device
//     // and its owner before the grant/deny decision exists, so withholding here
//     // means removing the list rather than declining to add it. Without this, a
//     // retired or deactivated sticker tapped at the Gadget Lane answers its own
//     // inactive_id denial with the owner's full name, department AND the device
//     // serial — precisely the "someone holding a credential that is not theirs"
//     // case the rule above exists for, arriving through the one branch that
//     // never passed through it.
//     //
//     // personView itself SURVIVES, matching the vehicle branch's posture: a
//     // guard resolving a denial still needs the minimum to act on it, and the
//     // owner's name on a denied device tag is what tells them whose desk to
//     // walk the laptop back to. Only the device list goes.
//     if (identityWithheld && entity_type === 'gadget' && personView) {
//       delete personView.gadgets;
//     }

//     await scanRepo.createLog({
//       rfid_uid: input.rfid_uid,
//       entity_type,
//       entity_id,
//       gate_id: gate._id,
//       direction: input.direction,
//       access_result,
//       reason,
//       scan_time,
//     });

//     // The person this tap is attributable to: the cardholder on a person tap,
//     // or the owner whose card opened a vehicle gate. A vehicle TAG tap has
//     // neither and correctly writes no attendance.
//     const attendancePersonId = entity_type === 'person' ? entity_id : companionPersonId;
//     if (access_result === 'granted' && attendancePersonId) {
//       const key = dateKey(scan_time);
//       if (input.direction === 'entry') {
//         await attendanceRepo.upsertTimeIn(
//           String(attendancePersonId),
//           key,
//           scan_time,
//           isLate(scan_time) ? 'late' : 'present'
//         );
//       } else {
//         // A lapsed egress reaches here as a grant, and should: the person did
//         // leave, and the time-out is the truthful record of it. Only the exit
//         // side is reachable that way — the override never fires on entry — so a
//         // revoked ID can still never mark itself present.
//         await attendanceRepo.upsertTimeOut(String(attendancePersonId), key, scan_time);
//       }
//     }

//     // Wakes every connected Overview/Records console. Deliberately the LAST
//     // thing before the return and deliberately not awaited: it schedules a
//     // broadcast rather than performing one, so the person standing at the
//     // barrier never waits on a dashboard query. Placed here, after the log and
//     // attendance writes, so a console that reacts instantly still reads a
//     // database that already has this tap in it.
//     liveHub.notifyScan();

//     return { access_result, reason, scan_time, person: personView };
//   },

//   /**
//    * Records that a person left with devices still inside.
//    *
//    * Writes a SECOND scan-log row rather than amending the exit row, which was
//    * already written when they tapped. Two rows for one exit is correct here:
//    * the first records that the person left, the second records what they left
//    * without. occupancyService.clear writes its own append-only row for the
//    * same reason — the state it describes is overwritten by the next tap.
//    *
//    * Deliberately touches NO occupancy state. The devices genuinely are still
//    * inside; their rows must stay `inside` so tomorrow's roster shows them and
//    * the nightly boundary is what eventually clears them.
//    *
//    * access_result is 'granted', not 'denied'. Nothing was refused — the person
//    * is already outside. A denial here would be the first path in the system
//    * from a laptop to a refused tap, which scan.service.ts:466 forbids.
//    */
//   async closeGadgetSession(input: {
//     gate_id: string;
//     person_id: string;
//     missing_gadget_ids: string[];
//   }): Promise<{ logged: boolean; missing: number }> {
//     const gate = await gateRepo.findById(input.gate_id);
//     if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');
//     if (!Types.ObjectId.isValid(input.person_id)) {
//       throw new ApiError('VALIDATION_ERROR', 'person_id is not a valid id');
//     }
//     const person = await personRepo.findById(input.person_id);
//     if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

//     await scanRepo.createLog({
//       // The person's own card UID, so the row sits alongside their exit in any
//       // per-card view. Falls back to the empty string only for a cardless
//       // person, who cannot have tapped an exit in the first place.
//       rfid_uid: person.rfid_uid ?? '',
//       entity_type: 'person',
//       entity_id: person._id,
//       gate_id: gate._id,
//       direction: 'exit',
//       access_result: 'granted',
//       reason: 'gadget_not_returned',
//       scan_time: new Date(),
//     });

//     liveHub.notifyScan();
//     return { logged: true, missing: input.missing_gadget_ids.length };
//   },

//   async listLogs(query: Record<string, string | undefined>) {
//     const { getPagination, buildMeta } = await import('../../utils/pagination');
//     const p = getPagination(query);

//     const match: Record<string, unknown> = {};
//     if (query.gate_id) {
//       // Mongoose does NOT cast $match in an aggregation pipeline, so a raw
//       // string here would compare against ObjectIds and match nothing —
//       // silently returning an empty page instead of an error. Validate and
//       // convert, and reject a malformed id with 422 rather than letting a BSON
//       // error surface as a 500 with an internal message.
//       if (!Types.ObjectId.isValid(query.gate_id)) {
//         throw new ApiError('VALIDATION_ERROR', 'gate_id is not a valid id');
//       }
//       match.gate_id = new Types.ObjectId(query.gate_id);
//     }
//     if (query.direction) match.direction = query.direction;
//     if (query.access_result) match.access_result = query.access_result;
//     if (query.from || query.to) {
//       // Callers pass local-time boundaries. Never derive these with
//       // toISOString() or a bare `new Date(str)`: the server buckets
//       // attendance and the occupancy reset boundary by LOCAL Date
//       // components, and a UTC-parsed day queries the wrong bucket for part
//       // of every day outside UTC+0. parseLocalDateRange also makes `to`
//       // an EXCLUSIVE next-day boundary so the selected day is fully
//       // included, not cut off at its own midnight.
//       match.scan_time = parseLocalDateRange(query.from, query.to);
//     }

//     const pipeline = [
//       { $match: match },
//       { $sort: { scan_time: -1 as const } },
//       { $skip: p.skip },
//       { $limit: p.limit },
//       { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
//       { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
//       // The third entity_type. Without it every device tap — and the Gadget
//       // Lane roughly doubles tap volume — renders `subject: null` in the
//       // Records console, indistinguishable from an unregistered card.
//       { $lookup: { from: 'gadgets', localField: 'entity_id', foreignField: '_id', as: 'gadget' } },
//       { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gateDoc' } },
//       {
//         // Projection is a whitelist and the joined arrays are never projected
//         // themselves, so no field from a joined collection can leak.
//         $project: {
//           _id: 0,
//           id: { $toString: '$_id' },
//           scan_time: 1,
//           direction: 1,
//           access_result: 1,
//           reason: 1,
//           entity_type: 1,
//           rfid_uid: 1,
//           gate: {
//             $cond: [
//               { $gt: [{ $size: '$gateDoc' }, 0] },
//               {
//                 id: { $toString: { $first: '$gateDoc._id' } },
//                 name: { $first: '$gateDoc.name' },
//               },
//               // null on manual occupancy overrides, which write gate_id: null.
//               null,
//             ],
//           },
//           subject: {
//             $cond: [
//               { $gt: [{ $size: '$person' }, 0] },
//               {
//                 full_name: { $first: '$person.full_name' },
//                 id_number: { $first: '$person.id_number' },
//               },
//               {
//                 $cond: [
//                   { $gt: [{ $size: '$vehicle' }, 0] },
//                   { plate_number: { $first: '$vehicle.plate_number' } },
//                   {
//                     $cond: [
//                       { $gt: [{ $size: '$gadget' }, 0] },
//                       // A gadget has neither a name nor a plate: brand/model
//                       // goes where the name goes and the SERIAL where the
//                       // id/plate goes, matching what
//                       // occupancy.repository.listInside already projects for
//                       // the roster. Ordered LAST, after person and vehicle,
//                       // for the same reason tap resolution is: the
//                       // access-bearing entities must never be shadowed by a
//                       // gadget.
//                       {
//                         full_name: { $first: '$gadget.brand_model' },
//                         id_number: { $first: '$gadget.serial_number' },
//                       },
//                       // null when the UID matched nothing — an unregistered
//                       // card has no entity to resolve.
//                       null,
//                     ],
//                   },
//                 ],
//               },
//             ],
//           },
//         },
//       },
//     ];

//     const [items, total] = await Promise.all([
//       ScanLogModel.aggregate(pipeline),
//       ScanLogModel.countDocuments(match),
//     ]);

//     // truncated sits beside buildMeta()'s pagination rather than replacing
//     // it, so this endpoint's meta shape stays consistent with every other
//     // list endpoint (/api/users, /api/persons, ...). It's added because a
//     // silently truncated list is indistinguishable from a short one: without
//     // it a caller can't tell "these are all the rows" from "there's a next
//     // page".
//     return {
//       items,
//       meta: { ...buildMeta(total, p.page, p.limit), truncated: total > p.limit },
//     };
//   },
// };



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
// import { gateSessionStore } from './gateSession.store';
import { gateSessionStore } from './gateSession.store';
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
    // Set ONLY on a granted owner-card resolution: the person whose card
    // opened a vehicle gate. Drives the companion occupancy and attendance
    // writes in Task 2. Null on every other path, including vehicle-tag taps
    // — a sticker identifies a car, a card identifies a person, and only the
    // latter is evidence that the human was present.
    let companionPersonId: Types.ObjectId | null = null;
    // True when this tap was refused because the holder's REGISTRATION has
    // lapsed — deactivated, expired, or resolving to no single vehicle — at a
    // gate the card otherwise belongs at. It is set only in those branches,
    // never inferred from `reason` afterwards, because the deciding fact is one
    // only those branches hold: that the card is at the right barrier. A
    // vehicle tag refused with `vehicle_expired` at a WALKING gate carries the
    // same reason code and must not be overridden into an exit there.
    //
    // Drives the egress override below. Never consulted on entry.
    let lapsedAtOwnGate = false;

    // A blocked card is refused before we look up what it used to be. It is
    // checked first because a blocked UID must never resolve to an identity:
    // the card may be in the wrong hands, which is why it was retired.
    //
    // Like every denial, this sits before the anti-passback block, so a blocked
    // card can never move anyone's inside/outside state.
    if (await blockedCardRepo.isBlocked(input.rfid_uid)) {
      access_result = 'denied';
      reason = 'card_blocked';
      // personView is deliberately left undefined.
    } else {
      // Resolve entity by RFID: person first, then vehicle
      const person = await personRepo.findByRfid(input.rfid_uid);
      if (person) {
        // Identity view shared by every person-resolved outcome below. The
        // granted owner-card path REPLACES it with the vehicle-shaped view.
        personView = {
          full_name: person.full_name,
          type: person.type,
          department_section: person.department_section ?? null,
          photo_url: person.photo_url,
          // The terminal opens its device prompt against this id. Set on the
          // shared person view rather than in one branch, so a person tap
          // carries it at every gate type.
          person_id: String(person._id),
        };

        if (gate.type === 'vehicle') {
          // Single-card access. The card IS correct for this gate, so the
          // denials here are about the holder's registration, never
          // wrong_gate_type. Entity stays 'person' on a denial so the scan
          // log records who was refused; only a grant becomes the vehicle.
          entity_type = 'person';
          entity_id = person._id;
          if (person.status !== 'active') {
            // Ordered BEFORE the vehicle lookup on purpose: a deactivated ID
            // is an identity problem, and reporting "no vehicle registered"
            // for it would send a guard after the wrong thing.
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
              // Expected, not exceptional. A person may now hold several
              // active vehicles (see constants/vehicleTypes VEHICLE_LIMITS),
              // so their CARD cannot say which one they are driving. The
              // vehicle's own RFID sticker can, and is the intended lane —
              // this denial tells the guard to use it. Refusing to guess is
              // the point: granting here would log a plate nobody verified
              // into the scan log, the occupancy roster and the anomaly
              // report.
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
        } else {
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
            // Only at a vehicle gate. A sticker tapped at a walking gate is a
            // wrong_gate_type tap wearing a lapse's reason code, and must stay
            // denied in both directions.
            lapsedAtOwnGate = gate.type === 'vehicle';
          } else if (!vehicle.valid_until || vehicle.valid_until.getTime() < scan_time.getTime()) {
            // Expiry is stored as end-of-day local (see nextSchoolYearEnd), so a
            // pass valid until 2027-03-31 works for all of that day.
            //
            // `valid_until` is `required: true` on the schema, but that is
            // enforced only on write — a Vehicle row created before this field
            // existed (or restored from an older backup, or edited directly in
            // Mongo) can still have it missing. Treat a missing expiry as
            // already-expired rather than dereferencing `.getTime()` on
            // `undefined`: the latter is a raw TypeError thrown before
            // scanRepo.createLog runs below, which denies the tap AND leaves no
            // scan log, no anomaly row, nothing an auditor could find. Failing
            // closed here keeps the same fail-closed posture as the rest of
            // this function while still logging the denial.
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
            // The owner's FACE. This was missing: the owner-card path above
            // has always sent it and this one never did, so a sticker tap
            // showed a name with no face — and the sticker is now the primary
            // lane for anyone with more than one vehicle.
            photo_url: owner?.photo_url,
            plate_number: vehicle.plate_number,
            vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
            vehicle_photo_url: vehicle.photo_url,
          };
        } else {
          // Third and LAST resolution branch. Order is load-bearing: persons
          // and vehicles are the access-bearing entities and must never be
          // shadowed by a gadget lookup.
          //
          // This is the case scan.service used to say would never exist. A
          // gadget now taps in its own right so the system can record which
          // devices came in and whether they left — but it still decides
          // nothing about a human's passage. A gadget tap moves ONLY its own
          // occupancy row: the barrier is already open or shut on the strength
          // of the person's own card, tapped moments earlier.
          const gadget = await gadgetRepo.findByRfid(input.rfid_uid);
          if (gadget) {
            entity_type = 'gadget';
            entity_id = gadget._id;
            if (gate.type === 'person') {
              // A device tap is only ever the SECOND tap of a sequence someone
              // just started at this exact gate — never the first. Without
              // this, a bare gadget RFID at Main Entrance, the Gadget Lane, or
              // the Side Gate all granted on their own, moving occupancy for a
              // device no person's card had just vouched for. See
              // gateSession.store.ts for when a session opens.
              const sessionPersonId = gateSessionStore.activePerson(String(gate._id));
              if (!sessionPersonId) {
                access_result = 'denied';
                reason = 'gadget_requires_person_tap';
              } else if (sessionPersonId !== String(gadget.owner_person_id)) {
                // The device is real and active, but the person who opened
                // this gate's session just now is not who it belongs to —
                // someone else's laptop offered on someone else's tap.
                access_result = 'denied';
                reason = 'gadget_owner_mismatch';
              } else if (gadget.status === 'active') {
                access_result = 'granted';
                reason = null;
                // Slides the session forward so checking several devices in a
                // row is never cut off mid-list by the first tap's clock.
                gateSessionStore.touch(String(gate._id));
              } else {
                access_result = 'denied';
                reason = 'inactive_id';
                // lapsedAtOwnGate stays false: the egress override exists to
                // stop a person being trapped inside, and a laptop cannot be
                // trapped. A deactivated device simply does not tap out, and
                // its row is cleared by the nightly boundary.
              }
            } else {
              // Not a person gate — there is no session to check because one
              // can never open here (see gateSession.store.ts's two call
              // sites). Left exactly as before: the wrong_gate_type guard
              // below is what denies this, same as it always has.
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

    // A gate has a fixed type, so a person card must not open the parking
    // barrier and a vehicle tag must not register attendance at a walking gate.
    //
    // Gadgets needed a carve-out here rather than a widening, because a gate's
    // type is only ever 'person' or 'vehicle': there is no gadget gate and
    // there should not be one, so 'gadget' matches neither by construction and
    // every device tap would otherwise be denied wrong_gate_type.
    //
    // The carve-out is narrow on purpose. Gadgets are exempt at PERSON gates
    // ONLY, not universally. A device accompanies whoever carries it through a
    // walking gate, which is why it cannot be held to a gate type of its own —
    // but a laptop tag at the parking barrier is a genuine wrong-gate tap, and
    // showing the guard GRANTED for it is the opposite of useful. Gadget Lane
    // is seeded type: 'person' (seed.ts:18); no vehicle gate ever expects a
    // device.
    const gadgetAtPersonGate = entity_type === 'gadget' && gate.type === 'person';
    if (access_result === 'granted' && !gadgetAtPersonGate && entity_type !== gate.type) {
      access_result = 'denied';
      reason = 'wrong_gate_type';
      personView = undefined;
    }

    // Egress is never blocked by a lapsed registration.
    //
    // A pass can lapse — deactivated by a clerk, or valid_until simply passing
    // — while the holder is standing INSIDE the campus. Refusing their ENTRY
    // after that is the point of the feature. Refusing their EXIT is a
    // different thing entirely, and it was trapping them: occupancy only ever
    // moves on a granted tap, so a refused exit leaves the row `inside` for the
    // rest of the occupancy window, and every tap after the pass is restored
    // comes back `already_inside` with no way to resolve it at the gate. That
    // is the defect this block closes — observed on 2026-08-06, where a car
    // admitted at 03:07, deactivated, then reactivated could not get back in.
    //
    // The tap is GRANTED but keeps its reason, so nothing is hidden: the guard
    // sees "ID inactive" on the terminal, the scan log records why the barrier
    // opened, and reports.anomalies surfaces the row. This is the same
    // granted-with-a-reason shape that `exit_without_entry` and
    // `occupancy_unavailable` already use.
    //
    // Placed AFTER the wrong_gate_type guard so a card at the wrong barrier
    // cannot be overridden into an exit there, and BEFORE the anti-passback
    // block so the override actually releases the occupancy row — releasing it
    // is the entire purpose. `lapsedAtOwnGate` is set only where the card is
    // known to belong at this gate; see its declaration.
    //
    // Deliberately NOT extended to `card_blocked` or `unregistered_uid`: a
    // blocked card is refused before identity is resolved because it may be in
    // the wrong hands, and an unregistered UID has no occupancy row to free, so
    // neither can be trapped by this mechanism in the first place.
    let lapsedEgress = false;
    if (input.direction === 'exit' && access_result === 'denied' && lapsedAtOwnGate && entity_id) {
      access_result = 'granted';
      lapsedEgress = true;
      // `reason` is deliberately left as-is.
    }

    // Anti-passback. Runs only on taps that are otherwise granted, so a denied
    // card can never move anyone's state — including a stranger repeatedly
    // tapping a stolen inactive card.
    if (access_result === 'granted' && entity_id) {
      // gate._id is the same ObjectId as input.gate_id: gateRepo.findById above
      // resolved it from this exact string, so reuse it instead of
      // reconstructing a third ObjectId from the same source string.
      const gateOid = gate._id;
      // Shared by both branches so entry and exit agree on exactly the same
      // reset boundary for this tap, rather than each computing it separately.
      const boundary = lastResetBoundary(scan_time);
      if (input.direction === 'entry') {
        const outcome = await occupancyRepo.enter(entity_type, entity_id, gateOid, boundary);
        if (outcome === 'already_inside') {
          access_result = 'denied';
          reason = 'already_inside';
          // personView is deliberately KEPT: a guard needs to see who the
          // system thinks is inside in order to resolve it.
        } else if (companionPersonId) {
          // BEST-EFFORT, and deliberately second. The vehicle row above is
          // authoritative and is what the anti-passback check runs on. There
          // is no transaction here (standalone Mongo), so these two writes
          // cannot be atomic — and denying on a failure would be worse than
          // tolerating one, because the deny happens AFTER the vehicle row
          // already moved: it would record a car inside the lot while
          // keeping the barrier shut, and unwinding needs a compensating
          // release that can itself fail. Worst case here is a car correctly
          // in the lot whose driver's attendance is missing, which this log
          // line surfaces.
          //
          // 'already_inside' is benign, not an error: the person may have
          // walked in through a person gate earlier.
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
        // Egress is never blocked, including when occupancy itself is
        // unavailable: a stuck exit gate is a physical safety problem, while a
        // failed release only leaves a stale roster row that the nightly
        // boundary clears. Entry deliberately still fails closed.
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
          // Only when nothing more specific was recorded. On a lapsed egress
          // the reason is already the lapse — the fact the guard needs, and the
          // fact that explains why the barrier opened at all. Overwriting it
          // here would report a card that left on a revoked pass as an ordinary
          // missed tap-in, which is the milder of the two anomalies.
          reason = 'exit_without_entry';
        }
        if (companionPersonId) {
          // Best-effort, same reasoning as entry. A person already outside is
          // SILENT rather than an anomaly: they may have walked out through a
          // person gate and returned on foot. The vehicle release above
          // carries the anomaly signal for this tap.
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

    // Registered items are withheld on EVERY denial. A guard resolving a denial
    // needs to know who, not what that person owns, and a denied tap is the case
    // most likely to involve someone holding a card that is not theirs. This is
    // enforced here rather than by the UI declining to render it: a field the
    // server sends is a field that exists in the response, whoever is looking.
    //
    // Placed after wrong_gate_type (which clears personView entirely) and after
    // the anti-passback block, so it can never resurrect identity on a denial
    // that deliberately withheld it, nor attach on an already_inside denial.
    // `!lapsedEgress` keeps the withholding rule intact. That override turns a
    // denial into a grant so the barrier opens, but the tap is still a refused
    // registration, and a deactivated ID is precisely the case most likely to
    // involve a card in the wrong hands — the reason this data is withheld on
    // denials at all. Testing `access_result` alone would hand exactly that
    // person the cardholder's vehicle and laptop-serial list.
    //
    // Hoisted into a named condition because the rule now has two arms: the
    // person arm below, which withholds by never ATTACHING the lists, and the
    // gadget arm just after it, which has to REMOVE one. Both must always
    // agree on what "withheld" means, and two copies of the predicate would
    // eventually stop agreeing.
    const identityWithheld = access_result !== 'granted' || lapsedEgress;

    if (!identityWithheld && entity_type === 'person' && entity_id && personView) {
      const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
      personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));
      // Registered devices, for the exit ownership check: the guard compares
      // the serial on this screen against the laptop in the person's hands.
      //
      // This is the ENTIRE gate-side footprint of the gadget registry, and it
      // lives inside this block rather than anywhere else for four reasons,
      // each of which is a property the placement guarantees rather than a rule
      // something else has to enforce:
      //
      //   1. It cannot deny. access_result and reason are already final by the
      //      time this runs, and nothing above reads `gadgets`. There is no
      //      path from a laptop registration to a refused tap — which is the
      //      whole design: the check answers "is this device yours", never "may
      //      you leave". Those are different questions and the second is
      //      already answered, independently, by the person's own card.
      //   2. It is withheld on every denial, by the same `granted` condition
      //      that withholds `registered` above — see that comment. A denied tap
      //      is the case most likely to involve someone holding a card that is
      //      not theirs, and handing that person a list of the cardholder's
      //      laptop serials inverts the point of the feature entirely.
      //   3. Vehicle gates are unaffected. The single-card owner path sets
      //      entity_type = 'vehicle' before this point, so the condition does
      //      not hold there. The parking barrier does not prompt for a laptop.
      //   4. It stays a DISPLAY field even though a gadget is now a full
      //      entity_type in its own right. That widening is what this list
      //      item used to deny, and each consequence of it is handled
      //      elsewhere, on purpose, rather than here: the wrong_gate_type
      //      guard needed the `gadgetAtPersonGate` carve-out (there is no
      //      gadget gate type, so a device would otherwise be refused at every
      //      barrier); a gadget tap moves its OWN occupancy row and is
      //      therefore subject to anti-passback like anything else that has
      //      one; and it writes its own ScanLog rows, which is the entire
      //      point of the feature. What remains true is attendance: a gadget
      //      tap writes none, because `attendancePersonId` is null for it —
      //      attendance is keyed by person and a device is not a person. This
      //      block still adds no reason codes of its own.
      const devices = await gadgetRepo.findActiveByOwner(entity_id);
      personView.gadgets = devices.map((g) => ({
        id: String(g._id),
        gadget_type: g.gadget_type,
        brand_model: g.brand_model,
        serial_number: g.serial_number,
        photo_url: g.photo_url,
      }));

      // On EXIT only, narrow that list to the devices whose occupancy row is
      // still `inside` — the ones the terminal must see tapped out. Entry
      // returns nothing here: the devices have not been tapped in yet, so an
      // "expected" list at entry would be a list of things nobody promised.
      //
      // Reuses the same `boundary` rule occupancy itself applies, so a device
      // stranded inside from before the nightly reset is not demanded back
      // today. Without that, one forgotten tap-out would haunt every
      // subsequent exit for that person until an admin cleared the row.
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
          }));
      }

      // Opens this gate's device-tap window — see gateSession.store.ts. Only
      // the two cases that actually expect a device next open one: the
      // Gadget Lane on entry, and an exit that is actually owed devices back.
      // A plain entry (Main Entrance) or an exit with nothing left inside
      // never opens one, so a gadget tapped at either keeps failing
      // gateSessionStore.activePerson's check no matter what — "one person
      // rfid, nothing else" stays true for those gates by construction, not
      // by convention.
      //
      // 'Gadget Lane' must match the seeded gate name exactly — see the same
      // requirement on GATE_ROUTES in userpage/lib/gateTerminal.ts, which
      // this mirrors from the server side.
      if (input.direction === 'entry' && gate.name === 'Gadget Lane') {
        gateSessionStore.open(String(gate._id), String(entity_id));
      } else if (input.direction === 'exit' && (personView.gadgets_inside?.length ?? 0) > 0) {
        gateSessionStore.open(String(gate._id), String(entity_id));
      }
    }

    // The same rule, second arm — see identityWithheld above.
    //
    // A gadget tap is the one path that reaches here with `gadgets` ALREADY
    // populated: the third resolution branch builds personView from the device
    // and its owner before the grant/deny decision exists, so withholding here
    // means removing the list rather than declining to add it. Without this, a
    // retired or deactivated sticker tapped at the Gadget Lane answers its own
    // inactive_id denial with the owner's full name, department AND the device
    // serial — precisely the "someone holding a credential that is not theirs"
    // case the rule above exists for, arriving through the one branch that
    // never passed through it.
    //
    // personView itself SURVIVES, matching the vehicle branch's posture: a
    // guard resolving a denial still needs the minimum to act on it, and the
    // owner's name on a denied device tag is what tells them whose desk to
    // walk the laptop back to. Only the device list goes.
    if (identityWithheld && entity_type === 'gadget' && personView) {
      delete personView.gadgets;
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

    // The person this tap is attributable to: the cardholder on a person tap,
    // or the owner whose card opened a vehicle gate. A vehicle TAG tap has
    // neither and correctly writes no attendance.
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
        // A lapsed egress reaches here as a grant, and should: the person did
        // leave, and the time-out is the truthful record of it. Only the exit
        // side is reachable that way — the override never fires on entry — so a
        // revoked ID can still never mark itself present.
        await attendanceRepo.upsertTimeOut(String(attendancePersonId), key, scan_time);
      }
    }

    // Wakes every connected Overview/Records console. Deliberately the LAST
    // thing before the return and deliberately not awaited: it schedules a
    // broadcast rather than performing one, so the person standing at the
    // barrier never waits on a dashboard query. Placed here, after the log and
    // attendance writes, so a console that reacts instantly still reads a
    // database that already has this tap in it.
    liveHub.notifyScan();

    return { access_result, reason, scan_time, person: personView };
  },

  /**
   * Records that a person left with devices still inside.
   *
   * Writes a SECOND scan-log row rather than amending the exit row, which was
   * already written when they tapped. Two rows for one exit is correct here:
   * the first records that the person left, the second records what they left
   * without. occupancyService.clear writes its own append-only row for the
   * same reason — the state it describes is overwritten by the next tap.
   *
   * Deliberately touches NO occupancy state. The devices genuinely are still
   * inside; their rows must stay `inside` so tomorrow's roster shows them and
   * the nightly boundary is what eventually clears them.
   *
   * access_result is 'granted', not 'denied'. Nothing was refused — the person
   * is already outside. A denial here would be the first path in the system
   * from a laptop to a refused tap, which scan.service.ts:466 forbids.
   */
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

    await scanRepo.createLog({
      // The person's own card UID, so the row sits alongside their exit in any
      // per-card view. Falls back to the empty string only for a cardless
      // person, who cannot have tapped an exit in the first place.
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
      // Mongoose does NOT cast $match in an aggregation pipeline, so a raw
      // string here would compare against ObjectIds and match nothing —
      // silently returning an empty page instead of an error. Validate and
      // convert, and reject a malformed id with 422 rather than letting a BSON
      // error surface as a 500 with an internal message.
      if (!Types.ObjectId.isValid(query.gate_id)) {
        throw new ApiError('VALIDATION_ERROR', 'gate_id is not a valid id');
      }
      match.gate_id = new Types.ObjectId(query.gate_id);
    }
    if (query.direction) match.direction = query.direction;
    if (query.access_result) match.access_result = query.access_result;
    if (query.from || query.to) {
      // Callers pass local-time boundaries. Never derive these with
      // toISOString() or a bare `new Date(str)`: the server buckets
      // attendance and the occupancy reset boundary by LOCAL Date
      // components, and a UTC-parsed day queries the wrong bucket for part
      // of every day outside UTC+0. parseLocalDateRange also makes `to`
      // an EXCLUSIVE next-day boundary so the selected day is fully
      // included, not cut off at its own midnight.
      match.scan_time = parseLocalDateRange(query.from, query.to);
    }

    const pipeline = [
      { $match: match },
      { $sort: { scan_time: -1 as const } },
      { $skip: p.skip },
      { $limit: p.limit },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
      // The third entity_type. Without it every device tap — and the Gadget
      // Lane roughly doubles tap volume — renders `subject: null` in the
      // Records console, indistinguishable from an unregistered card.
      { $lookup: { from: 'gadgets', localField: 'entity_id', foreignField: '_id', as: 'gadget' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gateDoc' } },
      {
        // Projection is a whitelist and the joined arrays are never projected
        // themselves, so no field from a joined collection can leak.
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
              // null on manual occupancy overrides, which write gate_id: null.
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
                      // A gadget has neither a name nor a plate: brand/model
                      // goes where the name goes and the SERIAL where the
                      // id/plate goes, matching what
                      // occupancy.repository.listInside already projects for
                      // the roster. Ordered LAST, after person and vehicle,
                      // for the same reason tap resolution is: the
                      // access-bearing entities must never be shadowed by a
                      // gadget.
                      {
                        full_name: { $first: '$gadget.brand_model' },
                        id_number: { $first: '$gadget.serial_number' },
                      },
                      // null when the UID matched nothing — an unregistered
                      // card has no entity to resolve.
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

    // truncated sits beside buildMeta()'s pagination rather than replacing
    // it, so this endpoint's meta shape stays consistent with every other
    // list endpoint (/api/users, /api/persons, ...). It's added because a
    // silently truncated list is indistinguishable from a short one: without
    // it a caller can't tell "these are all the rows" from "there's a next
    // page".
    return {
      items,
      meta: { ...buildMeta(total, p.page, p.limit), truncated: total > p.limit },
    };
  },
};