import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { personRepo } from '../persons/persons.repository';
import { VEHICLE_LIMITS, VehicleType, pluralizeType } from '../../constants/vehicleTypes';
import { escapeRegex } from '../../utils/escapeRegex';

interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  vehicle_type?: string;
  search?: string;
}

/** The shape findActiveByOwner projects. Not the full IVehicle. */
interface ActiveVehicle {
  _id: unknown;
  vehicle_type: string;
}

/**
 * Refuses a registration that would put an owner over their allowance for
 * that vehicle type.
 *
 * `active` must come from vehicleRepo.findActiveByOwner, which already scopes
 * to status 'active' AND valid_until >= now — the exact definition of "a
 * vehicle this person may currently use". Counting all rows instead would
 * mean a replaced van consumes its slot forever.
 *
 * `excludeId` is the vehicle being updated. Without it, a no-op PATCH that
 * resends an already-active vehicle's own fields counts that vehicle against
 * its own limit and rejects itself.
 *
 * Exported so vehicleApplications.service can pre-check with identical
 * wording before it writes its immutable application row.
 */
export function assertWithinLimit(
  active: ActiveVehicle[],
  type: VehicleType,
  ownerName: string,
  excludeId?: unknown
): void {
  const limit = VEHICLE_LIMITS[type];
  const used = active.filter(
    (v) => v.vehicle_type === type && (!excludeId || String(v._id) !== String(excludeId))
  ).length;
  if (used >= limit) {
    throw new ApiError(
      'CONFLICT',
      `${ownerName} already has ${limit} active ${pluralizeType(type, limit)} (the limit). ` +
        'Deactivate one first.'
    );
  }
}

export const vehicleService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IVehicle> = {};
    if (query.status) filter.status = query.status;
    if (query.vehicle_type) filter.vehicle_type = query.vehicle_type;
    if (query.search) {
      // Plate and sticker UID only. Owner name is not searchable here: it would
      // need a $lookup pipeline, and the directory already answers "what does
      // this person drive" from the person's side. These two are what a clerk
      // standing next to the vehicle actually has in hand.
      const rx = { $regex: escapeRegex(query.search), $options: 'i' };
      filter.$or = [{ plate_number: rx }, { rfid_uid: rx }];
    }
    const { items, total } = await vehicleRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
  async get(id: string) {
    const v = await vehicleRepo.findById(id);
    if (!v) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return v;
  },
  async create(data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    // Mirrors vehicleApplicationService.create's owner check: personRepo.findById
    // is deleted-filtered, so a deleted (or dangling) owner_person_id is refused
    // here rather than silently accepted and only discovered later at the
    // barrier, where scan.service.tap would grant the vehicle on status/expiry
    // alone and then find no owner to show on the terminal.
    const owner = await personRepo.findById(String(data.owner_person_id));
    if (!owner) throw new ApiError('NOT_FOUND', 'Vehicle owner not found');
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // A UID belongs to a person OR a vehicle, never both. scan.service.tap
    // resolves person first, so a vehicle holding a person's UID is
    // permanently unscannable — it would be accepted here and then silently
    // never work at the barrier. This is how CAV 8832 was created.
    if (data.rfid_uid) {
      const personWithRfid = await personRepo.findByRfid(String(data.rfid_uid));
      if (personWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
      }
    }
    // A block enforced only at the barrier would be no block at all: a
    // retired UID could be re-registered here and would then resolve
    // normally at the gate. See scan.service.tap for the other half.
    if (await blockedCardRepo.isBlocked(String(data.rfid_uid))) throw new ApiError('CARD_BLOCKED');
    const existingPlate = await vehicleRepo.findByPlate(String(data.plate_number));
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');
    // Per-type allowance, replacing the old one-active-vehicle-per-owner
    // rule. That rule existed because the owner's CARD was the only key, so
    // two active passes gave the barrier no way to know which car was being
    // driven. Each vehicle now carries its own RFID sticker, so the barrier
    // identifies the vehicle directly and several active passes are fine.
    // scan.service.tap still denies an owner-CARD tap on a multi-vehicle
    // owner — see the multiple_vehicles branch there.
    if ((data.status ?? 'active') === 'active') {
      const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
      assertWithinLimit(active, data.vehicle_type as VehicleType, owner.full_name);
    }
    return vehicleRepo.create({ ...data, valid_until: data.valid_until ?? nextSchoolYearEnd() });
  },
  async update(id: string, data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    // updateVehicleSchema is createVehicleSchema.partial(), so PATCH
    // /vehicles/:id can carry rfid_uid with no check at all unless one is
    // done here — recreating the exact CAV 8832 defect (a vehicle holding a
    // person's UID, permanently unscannable) through the update path instead
    // of create. Mirrors create's three checks, same order, same codes.
    // Excludes this vehicle from the vehicle-clash check so a no-op PATCH
    // that resends the current rfid_uid does not reject itself.
    if (data.rfid_uid) {
      const currentForRfid = await vehicleRepo.findById(id);
      if (!currentForRfid) throw new ApiError('NOT_FOUND', 'Vehicle not found');
      if (data.rfid_uid !== currentForRfid.rfid_uid) {
        const existingRfid = await vehicleRepo.findByRfid(data.rfid_uid);
        if (existingRfid && String(existingRfid._id) !== String(currentForRfid._id)) {
          throw new ApiError('DUPLICATE_RFID');
        }
        const personWithRfid = await personRepo.findByRfid(data.rfid_uid);
        if (personWithRfid) {
          throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
        }
        if (await blockedCardRepo.isBlocked(data.rfid_uid)) throw new ApiError('CARD_BLOCKED');
      }
    }
    // Fail closed whenever the barrier's arming state could change: either
    // the vehicle is being activated, OR its owner is being reassigned.
    // updateVehicleSchema is createVehicleSchema.partial(), so PATCH
    // /vehicles/:id can patch owner_person_id on its own, with no status
    // field at all — on an ALREADY-active vehicle that path used to skip
    // this check entirely (status stays 'active', valid_until stays ahead),
    // reaching the exact barrier the activating-path guard was meant to
    // close, just through a different field. Deactivating, or editing an
    // already-inactive vehicle with no owner change, needs no owner check —
    // nothing at the barrier is being re-armed.
    //
    // valid_until is a THIRD re-arming field, alongside status and
    // owner_person_id: vehicleRepo.findActiveByOwner filters on status
    // 'active' AND valid_until >= now, so an already-active-but-EXPIRED
    // vehicle does not count as "active" for the guard above, and a PATCH
    // that only extends valid_until on it re-arms the barrier without ever
    // touching status or owner_person_id — skipping this check entirely if
    // it were not listed here too.
    //
    // vehicle_type is a FOURTH re-arming field, and a new one: it became
    // load-bearing the moment limits went per-type. A PATCH that only changes
    // vehicle_type on an already-active vehicle touches neither status,
    // owner, nor valid_until — so without it listed here, moving a vehicle
    // from `van` (limit 3) to `truck` (limit 1) would skip the allowance
    // check entirely and hand an owner a second active truck.
    if (
      data.status === 'active' ||
      data.owner_person_id ||
      data.valid_until ||
      data.vehicle_type
    ) {
      const current = await vehicleRepo.findById(id);
      if (!current) throw new ApiError('NOT_FOUND', 'Vehicle not found');
      const ownerId = data.owner_person_id ?? current.owner_person_id;
      const owner = await personRepo.findById(String(ownerId));
      if (!owner) {
        throw new ApiError('NOT_FOUND', 'Vehicle owner not found or deleted; cannot activate');
      }
      // Same per-type allowance as create, on both re-arming paths:
      // activating this vehicle, and reassigning it to an owner who is
      // already at their limit for this type. Excludes this vehicle so a
      // no-op PATCH on an already-active row does not reject itself.
      //
      // A type CHANGE is a re-arming path too — moving a vehicle from `van`
      // to `truck` is checked against the truck allowance, which is why the
      // check reads `data.vehicle_type ?? current.vehicle_type` rather than
      // the stored type alone.
      //
      // "Will be active" mirrors findActiveByOwner's own definition — status
      // 'active' AND valid_until >= now — not status alone. Status alone
      // would also fire this check on a PATCH that only BACKDATES
      // valid_until (expiring the vehicle rather than re-arming it): the
      // vehicle's status is untouched and stays 'active', so a status-only
      // test would see "already active" and demand no conflicting owner,
      // even though the vehicle is being made LESS able to grant, not more.
      // That direction needs no guard at all — nothing at the barrier is
      // being re-armed — so the effective valid_until has to be checked too.
      const willBeStatusActive = data.status ? data.status === 'active' : current.status === 'active';
      const effectiveValidUntil = data.valid_until ?? current.valid_until;
      const willBeActive = willBeStatusActive && new Date(effectiveValidUntil) >= new Date();
      if (willBeActive) {
        const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
        const effectiveType = (data.vehicle_type ?? current.vehicle_type) as VehicleType;
        // current._id is excluded: an already-active vehicle must not count
        // against its own limit on a PATCH that merely re-sends its fields.
        assertWithinLimit(active, effectiveType, owner.full_name, current._id);
      }
    }
    const updated = await vehicleRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return updated;
  },
  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    return this.update(id, { status }, actor);
  },
};
