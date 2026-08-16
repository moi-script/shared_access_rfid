import { Schema, model, Document, Types } from 'mongoose';

export interface IPerson extends Document {
  _id: Types.ObjectId;
  full_name: string;
  type: 'student' | 'staff' | 'employee';
  id_number: string;
  department_section: string;
  contact_email?: string;
  photo_url?: string;
  signature_url?: string;
  rfid_uid?: string;
  status: 'active' | 'inactive' | 'pending';
  deleted_at: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const personSchema = new Schema<IPerson>(
  {
    full_name: { type: String, required: true },
    type: { type: String, enum: ['student', 'staff', 'employee'], required: true },
    id_number: { type: String, required: true, unique: true, index: true },
    department_section: { type: String },
    contact_email: { type: String },
    photo_url: { type: String },
    signature_url: { type: String },
    rfid_uid: { type: String, unique: true, sparse: true },
    status: {
      type: String,
      enum: ['active', 'inactive', 'pending'],
      default: 'active',
      index: true,
    },
    deleted_at: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

export const PersonModel = model<IPerson>('Person', personSchema);
