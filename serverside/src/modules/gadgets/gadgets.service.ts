import { FilterQuery } from 'mongoose';
import { gadgetRepo } from './gadgets.repository';
import { IGadget } from './gadgets.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { personRepo } from '../persons/persons.repository';
import { assertOwnerRegistrable } from '../persons/personStatus';
import { assertUidFree } from '../../utils/assertUidFree';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import {
  GADGET_LIMITS,
  GadgetType,
  normalizeSerial,
  pluralizeGadget,
} from '../../constants/gadgetTypes';

interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  gadget_type?: string;
  owner_person_id?: string;
}

/** The shape findActiveByOwner projects. Not the full IGadget. */
interface ActiveGadget {
  _id: unknown;
  gadget_type: string;
}

/**
 * Refuses a registration that would put an owner over their allowance for that
 * gadget type.
 *
 * `active` must come from gadgetRepo.findActiveByOwner, which scopes to status
 * 'active' — the exact definition of "a device this person may currently
 * claim". Counting all rows instead would mean a replaced laptop consumes its
 * slot forever.
 *
 * `excludeId` is the gadget being updated. Without it, a no-op PATCH that
 * resends an already-active gadget's own fields counts that gadget against its
 * own limit and rejects itself. Modelled on assertWithinLimit in
 * vehicles.service, including that parameter and the reason for it.
 */
export function assertWithinGadgetLimit(
  active: ActiveGadget[],
  type: GadgetType,
  ownerName: string,
  excludeId?: unknown
): void {
  const limit = GADGET_LIMITS[type];
  const used = active.filter(
    (g) => g.gadget_type === type && (!excludeId || String(g._id) !== String(excludeId))
  ).length;
  if (used >= limit) {
    throw new ApiError(
      'CONFLICT',
      `${ownerName} already has ${limit} active ${pluralizeGadget(type, limit)} registered (the limit). ` +
        'Deactivate one first.'
    );
  }
}

/**
 * Normalizes the serial and refuses one already held by another gadget.
 *
 * Both halves belong together and neither is optional. Normalizing without
 * checking writes a clean value past a stale comparison; checking without
 * normalizing compares a raw value against a normalized index and finds
 * nothing. Returns the normalized serial so the caller writes the same string
 * that was just checked.
 */
async function takeSerial(raw: string, excludeId?: string): Promise<string> {
  const serial = normalizeSerial(raw);
  if (!serial) throw new ApiError('VALIDATION_ERROR', 'serial_number cannot be blank');
  const existing = await gadgetRepo.findBySerial(serial);
  if (existing && (!excludeId || String(existing._id) !== String(excludeId))) {
    throw new ApiError('DUPLICATE_SERIAL');
  }
  return serial;
}

export const gadgetService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IGadget> = {};
    if (query.status) filter.status = query.status;
    if (query.gadget_type) filter.gadget_type = query.gadget_type;
    if (query.owner_person_id) filter.owner_person_id = query.owner_person_id;
    const { items, total } = await gadgetRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async get(id: string) {
    const g = await gadgetRepo.findById(id);
    if (!g) throw new ApiError('NOT_FOUND', 'Gadget not found');
    return g;
  },

  async create(data: Partial<IGadget>, actor: Actor) {
    assertCanWrite(actor, 'gadget');
    // Mirrors vehicleService.create's owner check: personRepo.findById is
    // deleted-filtered, so a deleted (or dangling) owner_person_id is refused
    // here rather than silently accepted and only discovered at the gate, where
    // the guard would be shown a serial with no name attached to it.
    const owner = await personRepo.findById(String(data.owner_person_id));
    if (!owner) throw new ApiError('NOT_FOUND', 'Gadget owner not found');
    // Same reasoning as vehicleService.create: existing-and-not-deleted was
    // never the whole question. Refused before takeSerial so a rejected
    // registration does not burn a serial number on its way out.
    assertOwnerRegistrable(owner, 'gadget');

    // A gadget now shares the UID namespace with persons and vehicles, so this
    // is a three-way check, not a new one-way check. Runs before takeSerial so
    // a rejected registration does not burn a serial number.
    if (data.rfid_uid) {
      await assertUidFree(data.rfid_uid);
      if (await blockedCardRepo.isBlocked(data.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    }

    const serial_number = await takeSerial(String(data.serial_number));

    if ((data.status ?? 'active') === 'active') {
      const active = await gadgetRepo.findActiveByOwner(owner._id);
      assertWithinGadgetLimit(active, data.gadget_type as GadgetType, owner.full_name);
    }

    return gadgetRepo.create({ ...data, serial_number });
  },

  async update(id: string, data: Partial<IGadget>, actor: Actor) {
    assertCanWrite(actor, 'gadget');

    // A gadget cannot change hands. Refused rather than stripped: a stripped
    // field returns 200 and the caller believes the transfer happened. See the
    // note on updateGadgetSchema for why the field reaches this line at all.
    if (data.owner_person_id !== undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'A gadget cannot be transferred. Deactivate this registration and create a new one, ' +
          'so the change is visible in the record.'
      );
    }

    const current = await gadgetRepo.findById(id);
    if (!current) throw new ApiError('NOT_FOUND', 'Gadget not found');

    if (data.rfid_uid && data.rfid_uid !== current.rfid_uid) {
      await assertUidFree(data.rfid_uid, { kind: 'gadget', id });
      if (await blockedCardRepo.isBlocked(data.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    }

    const patch: Partial<IGadget> = { ...data };
    if (data.serial_number !== undefined) {
      patch.serial_number = await takeSerial(String(data.serial_number), id);
    }

    // Two fields can put this gadget into a counted slot it was not in before:
    // status (inactive -> active) and gadget_type (moving between allowances).
    //
    // gadget_type is LIVE as of 2026-08-18. It used to be inert — GADGET_TYPES
    // had one element, so a type change could not cross an allowance boundary —
    // and was checked anyway against the day a second type appeared. `tablet`
    // is that day, and this clause is now doing real work rather than standing
    // by: laptop is capped at 1 and tablet is uncapped, so a PATCH moving an
    // active row between them genuinely changes which allowance it consumes.
    //
    // The failure mode it prevents is silent: a PATCH changing only the type on
    // an already-active row touches neither status nor owner, so without this
    // it would skip the allowance check entirely. That is not hypothetical — it
    // is exactly the defect vehicles.service.update's `vehicle_type` clause was
    // added to fix, after per-type limits made that field load-bearing.
    //
    // The contrast with that four-field guard is otherwise instructive: a
    // vehicle also has a mutable owner and an expiry, two more ways to become
    // grant-capable without touching status. A gadget has neither, which is
    // what keeps this to two fields. Reintroduce either and this must grow.
    const willBeActive = (data.status ?? current.status) === 'active';
    const becomingActive = willBeActive && current.status !== 'active';
    const changingType =
      data.gadget_type !== undefined && data.gadget_type !== current.gadget_type;
    if (willBeActive && (becomingActive || changingType)) {
      const owner = await personRepo.findById(String(current.owner_person_id));
      if (!owner) {
        throw new ApiError('NOT_FOUND', 'Gadget owner not found or deleted; cannot activate');
      }
      // Inside the willBeActive branch, so DEACTIVATING a gadget still works
      // for an inactive owner — otherwise a deactivated person's gadgets
      // could never be switched off. Mirrors vehicles.service.
      assertOwnerRegistrable(owner, 'gadget');
      const active = await gadgetRepo.findActiveByOwner(owner._id);
      // current._id is excluded so an already-active row does not count against
      // its own limit on a PATCH that merely re-sends its fields.
      const effectiveType = (data.gadget_type ?? current.gadget_type) as GadgetType;
      assertWithinGadgetLimit(active, effectiveType, owner.full_name, current._id);
    }

    const updated = await gadgetRepo.updateById(id, patch);
    if (!updated) throw new ApiError('NOT_FOUND', 'Gadget not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    assertCanWrite(actor, 'gadget');
    return this.update(id, { status }, actor);
  },

  /**
   * Replaces a gadget's sticker and retires the old one.
   *
   * Mirrors personService.reassignRfid, including its deliberate fail-open: the
   * swap is written FIRST and the old tag blocked second. Blocking first would
   * kill the old sticker even if the swap then failed, leaving the device with
   * no working tag at all. If the block throws afterwards the old UID is off
   * this gadget AND off the blocklist — back in the pool and re-registrable —
   * so it is logged at error level rather than swallowed.
   */
  async reassignRfid(id: string, rfid_uid: string, actor: Actor) {
    assertCanWrite(actor, 'gadget');
    const existing = await gadgetRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Gadget not found');
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    await assertUidFree(rfid_uid, { kind: 'gadget', id });

    const updated = await gadgetRepo.updateById(id, { rfid_uid });
    if (!updated) throw new ApiError('NOT_FOUND', 'Gadget not found');

    if (existing.rfid_uid && existing.rfid_uid !== rfid_uid) {
      try {
        await blockedCardRepo.block({
          rfid_uid: existing.rfid_uid,
          source: 'card_replaced',
          previous_person_id: existing.owner_person_id,
          blocked_by: actor.id,
        });
      } catch (err) {
        console.error(
          `[gadgets] FAILED to block retired tag ${existing.rfid_uid} after reassignRfid ` +
            `for gadget ${id} — this UID is now unassigned AND unblocked, and is ` +
            're-registrable until manually blocked.',
          err
        );
      }
    }
    return updated;
  },
};
