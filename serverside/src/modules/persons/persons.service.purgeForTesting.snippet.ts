// ── Add these to the top import block of persons.service.ts ──────────────
// (VehicleModel and GadgetModel are already imported there for softDelete)
import { PersonPhotoModel } from './personPhotos.model';
import { PersonSignatureModel } from './personSignatures.model';
import { VehiclePhotoModel } from '../vehicles/vehiclePhotos.model';
import { GadgetPhotoModel } from '../gadgets/gadgetPhotos.model';

// ── Add this method inside the personService object, after restore() ─────

  /**
   * A genuinely destructive hard-delete, for clearing test data only — this
   * is NOT the production delete path (that is softDelete, above, and it is
   * untouched by this method). Where softDelete blocks the person's card
   * forever by design, this does the opposite on purpose: it removes the
   * person, every vehicle they ever registered (any status, not just active
   * — a deactivated test row must not survive to clash with the next run
   * either), every gadget the same way, and their photo/signature files,
   * completely from the database. It then clears every blockedCards row tied
   * to any UID the person, their vehicles, or their gadgets ever carried, so
   * the same physical card is immediately re-registrable.
   *
   * Refused outside a non-production environment — see
   * blockedCardRepo.purgeByRfid's comment for why that guard matters. This is
   * the only place in the codebase that undoes a blockedCards entry, and it
   * must not become reachable from a live deployment.
   *
   * Uses PersonModel.findById directly rather than personRepo.findById: the
   * repo method excludes soft-deleted rows, and a person already
   * soft-deleted in an earlier test pass must still be purgeable — otherwise
   * a superadmin has no way to fully clear them and free their UID for reuse.
   */
  async purgeForTesting(id: string, actor: Actor) {
    if (process.env.NODE_ENV === 'production') {
      throw new ApiError('FORBIDDEN', 'Test-data purge is disabled in production.');
    }
    if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Person not found');

    const person = await PersonModel.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    const vehicles = await VehicleModel.find({ owner_person_id: person._id })
      .select('_id rfid_uid')
      .lean();
    const gadgets = await GadgetModel.find({ owner_person_id: person._id })
      .select('_id rfid_uid')
      .lean();

    // Every UID this person or their equipment ever carried, regardless of
    // which of the three rows it currently sits on — all cleared from the
    // blocklist below.
    const uidsToFree = new Set<string>();
    if (person.rfid_uid) uidsToFree.add(person.rfid_uid);
    for (const v of vehicles) if (v.rfid_uid) uidsToFree.add(v.rfid_uid);
    for (const g of gadgets) if (g.rfid_uid) uidsToFree.add(g.rfid_uid);

    const vehicleIds = vehicles.map((v) => v._id);
    const gadgetIds = gadgets.map((g) => g._id);

    // Leaf records first (photos reference vehicles/gadgets/the person), so a
    // failure partway through never leaves a photo pointing at a row that's
    // already gone.
    await Promise.all([
      VehiclePhotoModel.deleteMany({ vehicle_id: { $in: vehicleIds } }),
      GadgetPhotoModel.deleteMany({ gadget_id: { $in: gadgetIds } }),
      PersonPhotoModel.deleteOne({ person_id: person._id }),
      PersonSignatureModel.deleteOne({ person_id: person._id }),
    ]);

    await VehicleModel.deleteMany({ owner_person_id: person._id });
    await GadgetModel.deleteMany({ owner_person_id: person._id });

    // NOTE: assumes a `deleteById` on userRepo alongside its existing
    // `updateById` / `findByPersonId` — I haven't seen users.repository.ts,
    // so double-check the method name/shape matches what's actually there.
    const login = await userRepo.findByPersonId(id);
    if (login) await userRepo.deleteById(String(login._id));

    await PersonModel.deleteOne({ _id: person._id });

    await Promise.all([...uidsToFree].map((uid) => blockedCardRepo.purgeByRfid(uid)));

    return {
      id,
      purged: true,
      vehiclesDeleted: vehicleIds.length,
      gadgetsDeleted: gadgetIds.length,
    };
  },
