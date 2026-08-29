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
 * `ownerPersonId` is the ONE deliberate hole in "exactly one entity". A
 * vehicle pass is not issued its own sticker any more: it carries its owner's
 * person card, so the owner's own person row is an expected match rather than
 * a clash. Pass the owner's id from the vehicle issue points and nowhere else
 * — a UID held by any OTHER person is still refused, and gadgets and other
 * vehicles are still refused outright.
 *
 * Deliberately queries the MODELS rather than the repositories: personRepo and
 * vehicleRepo filter soft-deleted rows out, and a deleted person's UID is still
 * occupied as far as the unique index is concerned. Handing that UID to a
 * gadget would produce a duplicate-key error at write time instead of this
 * explanatory 409.
 */
export async function assertUidFree(
  uid: string,
  self?: { kind: Kind; id: string },
  ownerPersonId?: string
): Promise<void> {
  const skip = (kind: Kind, id: unknown) =>
    self?.kind === kind && String(id) === String(self.id);

  // Anchored and case-INSENSITIVE, because a UID is hex and hex has two
  // spellings of every value. The check used to be an exact-match findOne, so
  // registering a person `abcdef` and a gadget `ABCDEF` raised no clash at
  // all: two rows, one physical namespace, and whichever card the reader's
  // casing did not match was then permanently `unregistered_uid` at the
  // barrier — the CAV 8832 defect this file's docblock is about, reintroduced
  // by casing alone. Schema-level uppercasing (persons/vehicles/gadgets
  // .schema.ts) keeps NEW rows consistent; this is what catches the ones
  // already stored in mixed case, which are deliberately not migrated.
  //
  // A regex, not a collation: a case-insensitive collation has to be
  // configured on the collection or passed on every query, and one forgotten
  // call site silently restores the old behavior. Deliberately NOT an
  // unanchored regex either — an unanchored `ABCD` would match `12ABCD34` and
  // refuse a UID that is genuinely free.
  //
  // The input is user-supplied and reaches RegExp, so it is escaped first.
  // tapSchema and the create schemas already constrain it to hex, but this
  // helper must not depend on every future caller having validated first: an
  // unescaped `.*` here would report a clash against any UID at all.
  const escaped = uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anyCase = new RegExp(`^${escaped}$`, 'i');

  const person = await PersonModel.findOne({ rfid_uid: anyCase }).select('_id').lean();
  const isOwnCard = !!person && !!ownerPersonId && String(person._id) === String(ownerPersonId);
  if (person && !skip('person', person._id) && !isOwnCard) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
  }

  const vehicle = await VehicleModel.findOne({ rfid_uid: anyCase }).select('_id').lean();
  if (vehicle && !skip('vehicle', vehicle._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
  }

  const gadget = await GadgetModel.findOne({ rfid_uid: anyCase }).select('_id').lean();
  if (gadget && !skip('gadget', gadget._id)) {
    throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a gadget');
  }
}
