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
  /**
   * When this person's status last BECAME 'active' — never when it was merely
   * re-saved while already active.
   *
   * `updatedAt` cannot answer this and must not be used for it: it moves on
   * every write, including a photo upload, a card reassignment, or a name
   * correction. This field exists because the status export needs a date that
   * means one specific thing.
   *
   * `null` means no activation has been RECORDED, which is not the same as
   * "never activated" — every person who predates this field is null until
   * their status is next touched. `npm run migrate:activation-dates` fills
   * those in from createdAt as a stated approximation.
   */
  last_activated_at: Date | null;
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
    last_activated_at: { type: Date, default: null },
    deleted_at: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

export const PersonModel = model<IPerson>('Person', personSchema);
