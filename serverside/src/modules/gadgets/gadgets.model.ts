import { Schema, model, Document, Types } from 'mongoose';
import { GADGET_TYPES, GadgetType } from '../../constants/gadgetTypes';

export interface IGadget extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  gadget_type: GadgetType;
  brand_model: string;
  serial_number: string;
  /**
   * The gadget's own RFID sticker.
   *
   * This REVERSES the "Deliberately absent" note this file used to carry. A
   * gadget is no longer identified only through its owner's card: it taps in
   * its own right at the Gadget Lane, so that the system records which devices
   * came in and whether they left. See
   * docs/superpowers/specs/2026-08-28-gadget-rfid-carry-tracking-design.md.
   *
   * Sparse for the same reason Person.rfid_uid is: a gadget registered before
   * a sticker was assigned holds `null`, and a unique index without `sparse`
   * would let exactly one such gadget exist.
   */
  rfid_uid?: string;
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
    rfid_uid: { type: String, unique: true, sparse: true },
    photo_url: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

// `valid_until` remains deliberately absent. A gadget registration confers no
// access, so an expiry would deny nothing and grant nothing; `status` is the
// whole of revocation.
//
// `rfid_uid` USED to be absent for a parallel reason, and is not any more — see
// the field's own comment above. A gadget now shares the UID namespace with
// persons and vehicles, which is why every issue point calls assertUidFree()
// rather than checking two registries by hand.
export const GadgetModel = model<IGadget>('Gadget', gadgetSchema);
