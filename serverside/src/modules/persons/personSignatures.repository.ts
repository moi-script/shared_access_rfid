import { Types } from 'mongoose';
import { PersonSignatureModel, IPersonSignature } from './personSignatures.model';

export const personSignatureRepo = {
  findByPersonId: async (personId: string) => {
    const signature = await PersonSignatureModel.findOne({
      person_id: new Types.ObjectId(personId),
    }).lean<IPersonSignature | null>();
    // The MongoDB driver hands lean() reads back as a raw BSON Binary, not a
    // Node Buffer — left as-is, Express's res.send() fails Buffer.isBuffer()
    // and silently JSON-serializes the wrapper instead of sending image bytes.
    if (signature && !Buffer.isBuffer(signature.data)) {
      signature.data = Buffer.from((signature.data as unknown as { buffer: Buffer }).buffer);
    }
    return signature;
  },

  /** Upsert keeps the unique person_id index satisfied on re-signing. */
  upsert: (personId: string, data: Buffer) =>
    PersonSignatureModel.findOneAndUpdate(
      { person_id: new Types.ObjectId(personId) },
      { data, mime: 'image/png', byte_size: data.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<IPersonSignature>(),

  deleteByPersonId: (personId: string) =>
    PersonSignatureModel.deleteOne({ person_id: new Types.ObjectId(personId) }),
};
