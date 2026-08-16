import { Types } from 'mongoose';
import { GadgetPhotoModel, IGadgetPhoto } from './gadgetPhotos.model';
import { ImageMime } from '../../utils/imageType';

export const gadgetPhotoRepo = {
  findByGadgetId: async (gadgetId: string) => {
    const photo = await GadgetPhotoModel.findOne({
      gadget_id: new Types.ObjectId(gadgetId),
    }).lean<IGadgetPhoto | null>();
    // The MongoDB driver hands lean() reads back as a raw BSON Binary, not a
    // Node Buffer — left as-is, Express's res.send() fails Buffer.isBuffer()
    // and silently JSON-serializes the wrapper instead of sending image bytes.
    // Same fix as personPhotos and vehiclePhotos repositories, same reason.
    if (photo && !Buffer.isBuffer(photo.data)) {
      photo.data = Buffer.from((photo.data as unknown as { buffer: Buffer }).buffer);
    }
    return photo;
  },

  /** Upsert keeps the unique gadget_id index satisfied on re-upload. */
  upsert: (gadgetId: string, data: Buffer, mime: ImageMime) =>
    GadgetPhotoModel.findOneAndUpdate(
      { gadget_id: new Types.ObjectId(gadgetId) },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IGadgetPhoto>(),

  deleteByGadgetId: (gadgetId: string) =>
    GadgetPhotoModel.deleteOne({ gadget_id: new Types.ObjectId(gadgetId) }),
};
