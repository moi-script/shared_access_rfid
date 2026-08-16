import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

export interface IVehiclePhoto extends Document {
  _id: Types.ObjectId;
  vehicle_id: Types.ObjectId;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const vehiclePhotoSchema = new Schema<IVehiclePhoto>(
  {
    // Unique: a second upload replaces the first rather than orphaning it.
    vehicle_id: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
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

export const VehiclePhotoModel = model<IVehiclePhoto>('VehiclePhoto', vehiclePhotoSchema);
