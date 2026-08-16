import { FilterQuery } from 'mongoose';
import { gadgetRepo } from './gadgets.repository';
import { IGadget } from './gadgets.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { personRepo } from '../persons/persons.repository';
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

    const patch: Partial<IGadget> = { ...data };
    if (data.serial_number !== undefined) {
      patch.serial_number = await takeSerial(String(data.serial_number), id);
    }

    // Two fields can put this gadget into a counted slot it was not in before:
    // status (inactive -> active) and gadget_type (moving between allowances).
    //
    // gadget_type is inert TODAY — GADGET_TYPES has one element, so a type
    // change cannot cross an allowance boundary. It is checked anyway because
    // the moment a second type is added it stops being inert, and the failure
    // mode is silent: a PATCH changing only the type on an already-active row
    // touches neither status nor owner, so without this it would skip the
    // allowance check entirely. That is not hypothetical — it is exactly the
    // defect vehicles.service.update's `vehicle_type` clause was added to fix,
    // after per-type limits made that field load-bearing.
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
};
