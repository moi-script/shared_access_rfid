import { Types } from 'mongoose';
import { PersonPhotoModel, IPersonPhoto } from './personPhotos.model';
import { ImageMime } from '../../utils/imageType';

export const personPhotoRepo = {
  findByPersonId: async (personId: string) => {
    const photo = await PersonPhotoModel.findOne({
      person_id: new Types.ObjectId(personId),
    }).lean<IPersonPhoto | null>();
    // The MongoDB driver hands lean() reads back as a raw BSON Binary, not a
    // Node Buffer — left as-is, Express's res.send() fails Buffer.isBuffer()
    // and silently JSON-serializes the wrapper instead of sending image bytes.
    if (photo && !Buffer.isBuffer(photo.data)) {
      photo.data = Buffer.from((photo.data as unknown as { buffer: Buffer }).buffer);
    }
    return photo;
  },

  /** Upsert keeps the unique person_id index satisfied on re-upload. */
  upsert: (personId: string, data: Buffer, mime: ImageMime) =>
    PersonPhotoModel.findOneAndUpdate(
      { person_id: new Types.ObjectId(personId) },
      { data, mime, byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IPersonPhoto>(),

  deleteByPersonId: (personId: string) =>
    PersonPhotoModel.deleteOne({ person_id: new Types.ObjectId(personId) }),
};
