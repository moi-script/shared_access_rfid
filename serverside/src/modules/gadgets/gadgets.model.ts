import { Schema, model, Document, Types } from 'mongoose';
import { GADGET_TYPES, GadgetType } from '../../constants/gadgetTypes';

export interface IGadget extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  gadget_type: GadgetType;
  brand_model: string;
  serial_number: string;
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

const gadgetSchema = new Schema<IGadget>(
  {
    // NOT unique, for the same reason Vehicle.owner_person_id is not: a
    // replaced laptop is deactivated rather than deleted so its history
    // survives, and the old row must not consume the owner's slot forever.
    // serial_number is what actually prevents duplicates; the per-person
    // allowance is enforced in the service against ACTIVE rows only.
    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    gadget_type: {
      type: String,
      // Spread to a mutable array: `as const` gives a readonly tuple, which
      // Mongoose's enum option does not accept.
      enum: [...GADGET_TYPES],
      required: true,
    },
    brand_model: { type: String, required: true },
    // Unique, and stored normalized (see normalizeSerial in
    // constants/gadgetTypes). This index is the anti-theft anchor: it is what
    // makes "the same physical device cannot be registered to two people" true.
    serial_number: { type: String, required: true, unique: true },
    photo_url: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

// Deliberately absent: `rfid_uid` and `valid_until`.
//
// A gadget is identified at the gate through its OWNER'S person card, so it
// never enters the RFID namespace that persons and vehicles share — which is
// why this module adds no third branch to scan.service.tap and needs no
// cross-entity UID check. And because a registration confers no access, an
// expiry would deny nothing and grant nothing; `status` is the whole of
// revocation. See docs/superpowers/specs/2026-08-05-gadget-registry-design.md.
export const GadgetModel = model<IGadget>('Gadget', gadgetSchema);
