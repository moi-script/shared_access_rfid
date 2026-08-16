import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

export interface IGadgetPhoto extends Document {
  _id: Types.ObjectId;
  gadget_id: Types.ObjectId;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const gadgetPhotoSchema = new Schema<IGadgetPhoto>(
  {
    // Unique: a second upload replaces the first rather than orphaning it.
    gadget_id: {
      type: Schema.Types.ObjectId,
      ref: 'Gadget',
      required: true,
      unique: true,
      index: true,
    },
    data: { type: Buffer, required: true },
    mime: {
      type: String,
      enum: ['image/jpeg', 'image/png', 'image/webp'],
      required: true,
    },
    byte_size: { type: Number, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const GadgetPhotoModel = model<IGadgetPhoto>('GadgetPhoto', gadgetPhotoSchema);
