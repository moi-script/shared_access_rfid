import { Types } from 'mongoose';
import {
  VehicleExtraPhotoModel,
  IVehicleExtraPhoto,
  ExtraPhotoSlot,
} from './vehicleExtraPhotos.model';
import { ImageMime } from '../../utils/imageType';

export const vehicleExtraPhotoRepo = {
  findOne: async (vehicleId: string, slot: ExtraPhotoSlot) => {
    const photo = await VehicleExtraPhotoModel.findOne({
      vehicle_id: new Types.ObjectId(vehicleId),
      slot,
    }).lean<IVehicleExtraPhoto | null>();
    // Same BSON Binary unwrap vehiclePhotos.repository does, for the same
    // reason: lean() hands back a Binary wrapper, res.send() only recognises a
    // real Buffer, and the mismatch ships JSON where image bytes belong.
    if (photo && !Buffer.isBuffer(photo.data)) {
      photo.data = Buffer.from((photo.data as unknown as { buffer: Buffer }).buffer);
    }
    return photo;
  },

  /** Which slots a vehicle currently has filled, ascending. Bytes excluded —
   *  callers only need this to rebuild the vehicle's extra_photo_urls list. */
  listSlots: async (vehicleId: string): Promise<ExtraPhotoSlot[]> => {
    const rows = await VehicleExtraPhotoModel.find({
      vehicle_id: new Types.ObjectId(vehicleId),
    })
      .select('slot')
      .sort({ slot: 1 })
      .lean<{ slot: ExtraPhotoSlot }[]>();
    return rows.map((r) => r.slot);
  },

  upsert: (vehicleId: string, slot: ExtraPhotoSlot, data: Buffer, mime: ImageMime) =>
    VehicleExtraPhotoModel.findOneAndUpdate(
      { vehicle_id: new Types.ObjectId(vehicleId), slot },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IVehicleExtraPhoto>(),

  deleteOne: (vehicleId: string, slot: ExtraPhotoSlot) =>
    VehicleExtraPhotoModel.deleteOne({ vehicle_id: new Types.ObjectId(vehicleId), slot }),
};
