import { ApiError } from './ApiError';
import { PersonModel } from '../modules/persons/persons.model';
import { VehicleModel } from '../modules/vehicles/vehicles.model';
import { GadgetModel } from '../modules/gadgets/gadgets.model';

type Kind = 'person' | 'vehicle' | 'gadget';

/**
 * An RFID UID belongs to exactly one person, vehicle, or gadget.
 *
 * This exists as ONE function rather than as hand-written pairs at each issue
 * point. It used to be pairwise — persons checked vehicles, vehicles checked
 * persons — and the moment gadgets joined the namespace that shape became five
 * separate places to forget a check. A forgotten check does not fail loudly: it
 * writes a UID that resolves to the wrong entity, or to nothing, and the card
 * is then permanently unscannable at the barrier. That is the CAV 8832 defect,
 * and it is invisible until someone stands at a gate holding a card that does
 * not work.
 *
 * `self` is the record being edited, excluded from its own check so a PATCH
 * that re-sends a row's current UID does not reject itself — the same exclusion
 * assertWithinLimit takes `excludeId` for. Omit it on create.
 *
 * Deliberately queries the MODELS rather than the repositories: personRepo and
 * vehicleRepo filter soft-deleted rows out, and a deleted person's UID is still
 * occupied as far as the unique index is concerned. Handing that UID to a
 * gadget would produce a duplicate-key error at write time instead of this
 * explanatory 409.
 */
export async function assertUidFree(
  uid: string,
  self?: { kind: Kind; id: string }
): Promise<void> {
  const skip = (kind: Kind, id: unknown) =>
    self?.kind === kind && String(id) === String(self.id);

  const person = await PersonModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (person && !skip('person', person._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
  }

  const vehicle = await VehicleModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (vehicle && !skip('vehicle', vehicle._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
  }

  const gadget = await GadgetModel.findOne({ rfid_uid: uid }).select('_id').lean();
  if (gadget && !skip('gadget', gadget._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a gadget');
  }
}
