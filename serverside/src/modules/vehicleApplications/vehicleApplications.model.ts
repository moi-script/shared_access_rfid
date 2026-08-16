import { Schema, model, Document, Types } from 'mongoose';
import { VEHICLE_TYPES, VehicleType } from '../../constants/vehicleTypes';

export interface IVehicleApplication extends Document {
  _id: Types.ObjectId;

  // Classification
  category: 'new' | 'renewal';
  applicant_type: 'student' | 'employee';
  vehicle_type: VehicleType;

  // Links
  owner_person_id: Types.ObjectId; // ref Person, required
  vehicle_id: Types.ObjectId | null; // set exactly once, by the service

  // Applicant snapshot — frozen as written on the paper
  id_number: string;
  last_name: string;
  first_name: string;
  middle_name?: string;
  year_level?: string;
  school_year: string; // "26-27"
  email?: string;
  mobile_no?: string;
  tel_no?: string;
  permanent_address?: string;

  // Driver
  driver_name?: string;
  driver_license_no?: string;

  // LTO
  lto_cr_no?: string;
  lto_cr_date?: Date;
  lto_or_no?: string;
  lto_or_date?: Date;

  // Vehicle
  plate_no: string;
  mv_file_no?: string;
  make: string;
  // Named `vehicle_model`, not `model`: a bare `model` property collides with
  // mongoose Document's own `.model()` method and fails to typecheck. Mirrors
  // the name Vehicle already uses for the same value and the same reason
  // (see vehicles.model.ts). The wire-level field (request body, paper form)
  // stays `model`; only the persisted column is renamed.
  vehicle_model?: string;
  year?: string;
  color?: string;

  // Ownership
  registered_owner_name: string;
  relationship?: string;

  // Authorization
  signed_name: string;
  signed_date: Date;

  created_by: Types.ObjectId; // ref User — the OSS clerk
  createdAt: Date;
}

const vehicleApplicationSchema = new Schema<IVehicleApplication>(
  {
    category: { type: String, enum: ['new', 'renewal'], required: true },
    applicant_type: { type: String, enum: ['student', 'employee'], required: true },
    vehicle_type: {
      type: String,
      enum: [...VEHICLE_TYPES],
      required: true,
    },

    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    // The one system-set exception to immutability. Every human-entered field
    // above and below is frozen forever; this is set exactly once, by
    // vehicleApplicationRepo.linkVehicle's atomic conditional filter.
    vehicle_id: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },

    id_number: { type: String, required: true },
    last_name: { type: String, required: true },
    first_name: { type: String, required: true },
    middle_name: { type: String },
    year_level: { type: String },
    school_year: { type: String, required: true, index: true },
    email: { type: String },
    mobile_no: { type: String },
    tel_no: { type: String },
    permanent_address: { type: String },

    driver_name: { type: String },
    driver_license_no: { type: String },

    lto_cr_no: { type: String },
    lto_cr_date: { type: Date },
    lto_or_no: { type: String },
    lto_or_date: { type: Date },

    plate_no: { type: String, required: true, index: true },
    mv_file_no: { type: String },
    make: { type: String, required: true },
    vehicle_model: { type: String },
    year: { type: String },
    color: { type: String },

    registered_owner_name: { type: String, required: true },
    relationship: { type: String },

    signed_name: { type: String, required: true },
    signed_date: { type: Date, required: true },

    created_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// None unique — the same plate legitimately recurs across school years as
// renewals, and an application is a document, not a constraint.
vehicleApplicationSchema.index({ createdAt: -1 });

export const VehicleApplicationModel = model<IVehicleApplication>(
  'VehicleApplication',
  vehicleApplicationSchema
);
