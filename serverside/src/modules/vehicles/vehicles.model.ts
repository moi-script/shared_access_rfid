import { Schema, model, Document, Types } from 'mongoose';
import { VEHICLE_TYPES, VehicleType } from '../../constants/vehicleTypes';

export interface IVehicle extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: VehicleType;
  make?: string;
  vehicle_model?: string;
  color?: string;
  valid_until: Date;
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}

const vehicleSchema = new Schema<IVehicle>(
  {
    // NOT unique: a person may hold several passes at once (a car and a
    // motorcycle), and a replaced vehicle is deactivated rather than deleted so
    // its history survives. plate_number and rfid_uid are what actually prevent
    // duplicates.
    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    plate_number: { type: String, required: true, unique: true },
    rfid_uid: { type: String, required: true, unique: true },
    vehicle_type: {
      type: String,
      // Spread to a mutable array: `as const` gives a readonly tuple, which
      // Mongoose's enum option does not accept.
      enum: [...VEHICLE_TYPES],
      required: true,
    },
    make: { type: String },
    // Keeps its existing name deliberately: renaming to `model` would touch six
    // call sites across both repos including the user-facing ProfileView, for
    // cosmetic gain.
    vehicle_model: { type: String },
    color: { type: String },
    valid_until: { type: Date, required: true, index: true },
    photo_url: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const VehicleModel = model<IVehicle>('Vehicle', vehicleSchema);
