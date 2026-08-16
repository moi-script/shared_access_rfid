import { Types } from 'mongoose';
import { vehiclePhotoRepo } from './vehiclePhotos.repository';
import { VehicleModel } from './vehicles.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Actor, assertCanWrite } from '../../utils/authority';

const INTERNAL_PHOTO_URL = (id: string) => `/vehicles/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Vehicle not found');
}

export const vehiclePhotoService = {
  async upload(vehicleId: string, actor: Actor, file: Express.Multer.File | undefined) {
    assertValidId(vehicleId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId);
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await vehiclePhotoRepo.upsert(vehicleId, file.buffer, mime);
    vehicle.photo_url = INTERNAL_PHOTO_URL(vehicleId);
    await vehicle.save();

    return { photo_url: vehicle.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  /**
   * No actor argument, unlike personPhotoService.get. A person photo needs an
   * ownership check because a student may fetch their own face and nobody
   * else's; a vehicle has no such self-service surface, so any caller the
   * route already authenticated — staff session or gate device key — may read
   * it. The route is what restricts this, not the service.
   */
  async get(vehicleId: string) {
    assertValidId(vehicleId);
    const photo = await vehiclePhotoRepo.findByVehicleId(vehicleId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(vehicleId: string, actor: Actor) {
    assertValidId(vehicleId);
    assertCanWrite(actor, 'vehicle');
    const vehicle = await VehicleModel.findById(vehicleId);
    if (!vehicle) throw new ApiError('NOT_FOUND', 'Vehicle not found');

    await vehiclePhotoRepo.deleteByVehicleId(vehicleId);

    // Only clear photo_url when it points at us. An externally hosted URL is
    // not ours to erase.
    if (vehicle.photo_url === INTERNAL_PHOTO_URL(vehicleId)) {
      vehicle.photo_url = undefined;
      await vehicle.save();
    }
    return { photo_url: vehicle.photo_url ?? null };
  },
};
