import { Types } from 'mongoose';
import { ApplicationSignatureModel, IApplicationSignature } from './applicationSignatures.model';

export const applicationSignatureRepo = {
  findByApplicationId: async (applicationId: string) => {
    const signature = await ApplicationSignatureModel.findOne({
      application_id: new Types.ObjectId(applicationId),
    }).lean<IApplicationSignature | null>();
    // Same lean()-hands-back-raw-BSON-Binary quirk as personSignatures: left
    // unconverted, Express's res.send() fails Buffer.isBuffer() and silently
    // JSON-serializes the wrapper instead of sending image bytes.
    if (signature && !Buffer.isBuffer(signature.data)) {
      signature.data = Buffer.from((signature.data as unknown as { buffer: Buffer }).buffer);
    }
    return signature;
  },

  /**
   * Plain insert, not upsert: there is no route that replaces an existing
   * signature, so a second insert for the same application_id must fail on
   * the unique index rather than overwrite. The service checks for an
   * existing row first so it can return a clean CONFLICT instead of letting
   * a raw E11000 surface.
   */
  create: (applicationId: string, data: Buffer) =>
    ApplicationSignatureModel.create({
      application_id: new Types.ObjectId(applicationId),
      data,
      mime: 'image/png',
      byte_size: data.length,
    }),
};
