import { Types } from 'mongoose';
import { VehiclePhotoModel, IVehiclePhoto } from './vehiclePhotos.model';
import { ImageMime } from '../../utils/imageType';

export const vehiclePhotoRepo = {
  findByVehicleId: async (vehicleId: string) => {
    const photo = await VehiclePhotoModel.findOne({
      vehicle_id: new Types.ObjectId(vehicleId),
    }).lean<IVehiclePhoto | null>();
    // The MongoDB driver hands lean() reads back as a raw BSON Binary, not a
    // Node Buffer — left as-is, Express's res.send() fails Buffer.isBuffer()
    // and silently JSON-serializes the wrapper instead of sending image bytes.
    // Same fix as personPhotos.repository, same reason.
    if (photo && !Buffer.isBuffer(photo.data)) {
      photo.data = Buffer.from((photo.data as unknown as { buffer: Buffer }).buffer);
    }
    return photo;
  },

  /** Upsert keeps the unique vehicle_id index satisfied on re-upload. */
  upsert: (vehicleId: string, data: Buffer, mime: ImageMime) =>
    VehiclePhotoModel.findOneAndUpdate(
      { vehicle_id: new Types.ObjectId(vehicleId) },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IVehiclePhoto>(),

  deleteByVehicleId: (vehicleId: string) =>
    VehiclePhotoModel.deleteOne({ vehicle_id: new Types.ObjectId(vehicleId) }),
};
