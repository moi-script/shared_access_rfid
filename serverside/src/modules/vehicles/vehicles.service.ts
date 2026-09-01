import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle, VehicleModel } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { personRepo } from '../persons/persons.repository';
import { assertOwnerRegistrable } from '../persons/personStatus';
import { assertUidFree } from '../../utils/assertUidFree';
import { escapeRegex } from '../../utils/escapeRegex';

interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  vehicle_type?: string;
  owner_person_id?: string;
  search?: string;
}

/** The shape findActiveByOwner projects. Not the full IVehicle. */
interface ActiveVehicle {
  _id: unknown;
  vehicle_type: string;
  plate_number?: string;
}

/**
 * Refuses a registration for an owner who already holds an active vehicle.
 *
 * One active vehicle per person, of any type. The per-type allowance this
 * replaces (VEHICLE_LIMITS) only made sense while each vehicle carried its own
 * RFID sticker: the barrier could tell two of an owner's cars apart because
 * each tag was distinct. A pass now carries the OWNER'S card, so a second
 * active vehicle would give the barrier one UID and no way to know which
 * vehicle is at it — the ambiguity scan.service's multiple_vehicles branch
 * was written for, now refused at the registration desk instead.
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
  ownerName: string,
  excludeId?: unknown
): void {
  const held = active.filter((v) => !excludeId || String(v._id) !== String(excludeId));
  if (held.length > 0) {
    throw new ApiError(
      'CONFLICT',
      `${ownerName} already has an active vehicle pass` +
        (held[0].plate_number ? ` (${held[0].plate_number})` : '') +
        '. ' +
        "A pass uses the owner's own RFID card, so one person can hold only one. " +
        'Deactivate that one first.'
    );
  }
}

/**
 * The UID a vehicle pass is issued under: its owner's person card.
 *
 * Vehicles are no longer issued a sticker of their own, so there is nothing to
 * type at the desk and nothing for a caller to get wrong — the UID is read off
 * the owner here rather than accepted from the request body. An owner with no
 * card cannot hold a pass at all: the barrier identifies a vehicle by its
 * owner's tap, and there would be nothing to tap.
 */
export function ownerCardUid(owner: { full_name: string; rfid_uid?: string }): string {
  if (!owner.rfid_uid) {
    throw new ApiError(
      'CONFLICT',
      `${owner.full_name} has no RFID card. A vehicle pass uses the owner's card, ` +
        'so assign one to them first.'
    );
  }
  return owner.rfid_uid;
}

export const vehicleService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IVehicle> = {};
    if (query.status) filter.status = query.status;
    if (query.vehicle_type) filter.vehicle_type = query.vehicle_type;
    // Mirrors the same filter on GET /gadgets. Without it this parameter was
    // accepted and silently ignored, so ErasePersonDialog's "N vehicles will
    // be deleted" preview counted every vehicle in the system rather than
    // this owner's — the one number an operator reads before confirming an
    // irreversible delete.
    if (query.owner_person_id) filter.owner_person_id = query.owner_person_id;
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
    // Existing-and-not-deleted was never the whole question. A deactivated
    // owner is refused at the barrier by scan.service.tap but was still
    // accepted here, so deactivation left the registration desk open. Runs
    // before the RFID and allowance checks so the clerk is told the real
    // reason ("this person is inactive") rather than a downstream symptom.
    assertOwnerRegistrable(owner, 'vehicle');
    // Not data.rfid_uid: the pass carries the owner's card, so the UID is read
    // off the owner and whatever the caller sent is ignored.
    const rfid_uid = ownerCardUid(owner);
    await assertUidFree(rfid_uid, undefined, String(owner._id));
    // A block enforced only at the barrier would be no block at all: a
    // retired UID could be re-registered here and would then resolve
    // normally at the gate. See scan.service.tap for the other half.
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    const existingPlate = await vehicleRepo.findByPlate(String(data.plate_number));
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');
    // One active vehicle per owner. The owner's CARD is the key again, so two
    // active passes would give the barrier no way to know which vehicle is at
    // it — see assertWithinLimit.
    if ((data.status ?? 'active') === 'active') {
      const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
      assertWithinLimit(active, owner.full_name);
    }
    return vehicleRepo.create({
      ...data,
      rfid_uid,
      valid_until: data.valid_until ?? nextSchoolYearEnd(),
    });
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
      // A pass carries its owner's card, so there is no such thing as giving
      // one a different UID: the only way to change it is to replace the
      // person's card, which carries onto the vehicle in
      // personService.reassignRfid. Re-sending the CURRENT uid is still fine —
      // an edit form that PATCHes the whole row must keep working.
      if (data.rfid_uid !== currentForRfid.rfid_uid) {
        throw new ApiError(
          'CONFLICT',
          "A vehicle pass uses its owner's RFID card and cannot be given a tag of " +
            "its own. Replace the owner's card instead."
        );
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
    // vehicle_type is listed for the same fail-closed reason, though it stopped
    // being load-bearing when the allowance went from per-type to one active
    // vehicle per person: re-running the check on a type change costs one
    // query and keeps this list matching "any field that could re-arm".
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
        // Gated on willBeActive, not on the outer branch: a PATCH that
        // DEACTIVATES or backdates a vehicle must keep working for an
        // inactive owner. Refusing those would mean a deactivated person's
        // vehicles could never be switched off — the guard would protect the
        // exact state it exists to reach.
        assertOwnerRegistrable(owner, 'vehicle');
        const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
        // current._id is excluded: an already-active vehicle must not count
        // against its own limit on a PATCH that merely re-sends its fields.
        assertWithinLimit(active, owner.full_name, current._id);
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

  /**
   * Switches off every active pass in the system, ignoring any list filters.
   *
   * Deactivate-only by design — see bulkVehicleStatusSchema for why there is
   * no bulk activate. One updateMany rather than a loop over update(): the
   * per-row path exists to run owner and allowance checks before a pass is
   * ARMED, and none of them apply in the disarming direction. Nothing at the
   * barrier can be made more permissive by this call.
   *
   * Scoped to rows that are not already inactive so `modified` reports what
   * actually changed rather than the size of the collection. Soft-deleted rows
   * are included: the model has no deleted_at, and an inactive row is inert
   * either way.
   */
  async bulkSetStatus(status: 'inactive', actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    const filter = { status: { $ne: status } };
    const matched = await VehicleModel.countDocuments(filter);
    const result = await VehicleModel.updateMany(filter, { $set: { status } });
    return { matched, modified: result.modifiedCount };
  },

};
