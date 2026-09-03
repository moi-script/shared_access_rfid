import { Types } from 'mongoose';
import { vehicleExtraPhotoRepo } from './vehicleExtraPhotos.repository';
import { ExtraPhotoSlot, isExtraPhotoSlot } from './vehicleExtraPhotos.model';
import { VehicleModel } from './vehicles.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Actor, assertCanWrite } from '../../utils/authority';

export const extraPhotoUrl = (vehicleId: string, slot: number) =>
  `/vehicles/${vehicleId}/photos/${slot}`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Vehicle not found');
}

/** Slots arrive as a path segment, so they are strings until proven otherwise. */
function parseSlot(raw: string): ExtraPhotoSlot {
  const slot = Number(raw);
  if (!Number.isInteger(slot) || !isExtraPhotoSlot(slot)) {
    throw new ApiError('VALIDATION_ERROR', 'Photo slot must be 1, 2, 3, or 4');
  }
  return slot;
}

/**
 * Recomputes the vehicle's extra_photo_urls from what is actually stored.
 *
 * Derived rather than appended to: the list is a cache of the photo collection,
 * and rebuilding it from a query is what keeps a failed upload or a deleted
 * slot from leaving a URL behind that 404s when the profile renders it.
 */
async function syncUrls(vehicleId: string): Promise<string[]> {
  const slots = await vehicleExtraPhotoRepo.listSlots(vehicleId);
  const urls = slots.map((slot) => extraPhotoUrl(vehicleId, slot));
  await VehicleModel.updateOne({ _id: vehicleId }, { $set: { extra_photo_urls: urls } });
  return urls;
}

export const vehicleExtraPhotoService = {
  async upload(
    vehicleId: string,
    rawSlot: string,
    actor: Actor,
    file: Express.Multer.File | undefined
  ) {
    assertValidId(vehicleId);
    const slot = parseSlot(rawSlot);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId).select('_id');
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await vehicleExtraPhotoRepo.upsert(vehicleId, slot, file.buffer, mime);
    const extra_photo_urls = await syncUrls(vehicleId);

    return {
      slot,
      photo_url: extraPhotoUrl(vehicleId, slot),
      extra_photo_urls,
      mime: saved.mime,
      byte_size: saved.byte_size,
    };
  },

  /** No actor argument, for the same reason vehiclePhotoService.get has none:
   *  the route decides who may read a vehicle's photos. */
  async get(vehicleId: string, rawSlot: string) {
    assertValidId(vehicleId);
    const slot = parseSlot(rawSlot);
    const photo = await vehicleExtraPhotoRepo.findOne(vehicleId, slot);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(vehicleId: string, rawSlot: string, actor: Actor) {
    assertValidId(vehicleId);
    const slot = parseSlot(rawSlot);
    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId).select('_id');
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    await vehicleExtraPhotoRepo.deleteOne(vehicleId, slot);
    return { extra_photo_urls: await syncUrls(vehicleId) };
  },
};
