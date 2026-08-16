import { Schema, model, Document, Types } from 'mongoose';

export interface IApplicationSignature extends Document {
  _id: Types.ObjectId;
  application_id: Types.ObjectId;
  data: Buffer;
  mime: 'image/png';
  byte_size: number;
  createdAt: Date;
}

const applicationSignatureSchema = new Schema<IApplicationSignature>(
  {
    // Unique: one application has one signature. Unlike personSignatures,
    // there is no upsert path — immutability comes from there being no route
    // that replaces an existing row, not from this constraint alone. The
    // constraint exists so a second insert attempt fails loudly (E11000)
    // rather than silently duplicating.
    application_id: {
      type: Schema.Types.ObjectId,
      ref: 'VehicleApplication',
      required: true,
      unique: true,
      index: true,
    },
    data: { type: Buffer, required: true },
    // PNG only, same reason as personSignatures: only PNG carries the
    // transparent background the capture canvas exports.
    mime: { type: String, enum: ['image/png'], required: true },
    byte_size: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const ApplicationSignatureModel = model<IApplicationSignature>(
  'ApplicationSignature',
  applicationSignatureSchema
);
