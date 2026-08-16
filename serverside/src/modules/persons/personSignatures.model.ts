import { Schema, model, Document, Types } from 'mongoose';

export interface IPersonSignature extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;
  data: Buffer;
  mime: 'image/png';
  byte_size: number;
  updatedAt: Date;
}

const personSignatureSchema = new Schema<IPersonSignature>(
  {
    // Unique: re-signing replaces the previous drawing rather than orphaning it.
    person_id: {
      type: Schema.Types.ObjectId,
      ref: 'Person',
      required: true,
      unique: true,
      index: true,
    },
    data: { type: Buffer, required: true },
    // Unlike a photo, a signature is only ever produced by our own canvas
    // export, which emits PNG so the transparent background survives.
    mime: { type: String, enum: ['image/png'], required: true },
    byte_size: { type: Number, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const PersonSignatureModel = model<IPersonSignature>(
  'PersonSignature',
  personSignatureSchema
);
