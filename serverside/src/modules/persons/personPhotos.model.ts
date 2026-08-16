import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

export interface IPersonPhoto extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const personPhotoSchema = new Schema<IPersonPhoto>(
  {
    // Unique: a second upload replaces the first rather than orphaning it.
    person_id: {
      type: Schema.Types.ObjectId,
      ref: 'Person',
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

export const PersonPhotoModel = model<IPersonPhoto>('PersonPhoto', personPhotoSchema);
