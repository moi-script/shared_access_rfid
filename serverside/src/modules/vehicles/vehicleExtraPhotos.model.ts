import { Schema, model, Document, Types } from 'mongoose';
import { ImageMime } from '../../utils/imageType';

/**
 * How many extra photos a vehicle may carry, and under which slot numbers.
 *
 * Slot 0 is deliberately absent: the main photo — the one the gate terminal
 * shows the guard at the barrier — still lives in its own VehiclePhoto
 * collection, untouched, so nothing about the entry/exit path changes. These
 * are the additional angles a clerk captures at registration, numbered rather
 * than named — what belongs in each slot is the desk's call, not the schema's
 * — and only the profile screen reads them.
 */
export const EXTRA_PHOTO_SLOTS = [1, 2, 3, 4] as const;
export type ExtraPhotoSlot = (typeof EXTRA_PHOTO_SLOTS)[number];

export function isExtraPhotoSlot(value: number): value is ExtraPhotoSlot {
  return (EXTRA_PHOTO_SLOTS as readonly number[]).includes(value);
}

export interface IVehicleExtraPhoto extends Document {
  _id: Types.ObjectId;
  vehicle_id: Types.ObjectId;
  slot: ExtraPhotoSlot;
  data: Buffer;
  mime: ImageMime;
  byte_size: number;
  updatedAt: Date;
}

const vehicleExtraPhotoSchema = new Schema<IVehicleExtraPhoto>(
  {
    // Not unique on its own, unlike VehiclePhoto's vehicle_id: a vehicle holds
    // up to four of these at once. The compound index below is what keeps a
    // re-upload replacing a slot rather than orphaning the photo already in it.
    vehicle_id: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: true,
      index: true,
    },
    slot: { type: Number, enum: [...EXTRA_PHOTO_SLOTS], required: true },
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

vehicleExtraPhotoSchema.index({ vehicle_id: 1, slot: 1 }, { unique: true });

export const VehicleExtraPhotoModel = model<IVehicleExtraPhoto>(
  'VehicleExtraPhoto',
  vehicleExtraPhotoSchema
);
