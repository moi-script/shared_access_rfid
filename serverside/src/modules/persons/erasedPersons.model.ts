import { Schema, model, Document, Types } from 'mongoose';

/**
 * What is left of a person after personService.erase removed them.
 *
 * Erasing hard-deletes the person row, but deliberately does NOT delete their
 * scan logs or attendance — the record that a card passed a gate is the point
 * of the whole system, and it must survive the holder being removed. Those
 * rows keep pointing at an _id that no longer resolves, so this collection
 * holds the name they used to resolve to. Reads join to it as the last link
 * in the $ifNull chain that already falls back person -> vehicle -> gadget
 * (see reports.service.ts and dashboard.service.ts), which is why _id here is
 * NOT generated: it is the erased person's original _id, so a lookup on the
 * same entity_id/person_id field finds it with no extra bookkeeping.
 *
 * It is also the audit record of the erasure itself. Nothing else records
 * that the erasure happened: the person row is gone, and the blockedCards
 * rows that would have shown the card's history are cleared by the same
 * operation. `erased_by` and `rfid_uids` are what make an unblocked card
 * traceable afterwards.
 *
 * Rows here are never removed by application code.
 */
export interface IErasedPerson extends Document {
  _id: Types.ObjectId;
  full_name: string;
  id_number: string;
  type: string;
  department_section: string | null;
  /** Every UID the person, their vehicles, or their gadgets carried, freed by the erase. */
  rfid_uids: string[];
  vehicles_deleted: number;
  gadgets_deleted: number;
  erased_at: Date;
  erased_by: Types.ObjectId;
}

const erasedPersonSchema = new Schema<IErasedPerson>({
  // Not auto-generated: this is the erased person's own _id. See the docstring.
  _id: { type: Schema.Types.ObjectId, required: true },
  full_name: { type: String, required: true },
  id_number: { type: String, required: true },
  type: { type: String, required: true },
  department_section: { type: String, default: null },
  rfid_uids: { type: [String], default: [] },
  vehicles_deleted: { type: Number, required: true },
  gadgets_deleted: { type: Number, required: true },
  erased_at: { type: Date, required: true },
  erased_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
});

// A freed card is the one thing an auditor searches by: it is the only handle
// that outlives the person and can turn up on someone else's record later.
erasedPersonSchema.index({ rfid_uids: 1 });

// Collection name pinned rather than left to Mongoose's pluralizer, which
// turns Person into 'people' and would make this 'erasedpeople'. The $lookup
// stages that resolve erased names name this string literally, so it must not
// depend on how the pluralizer feels about the word.
export const ErasedPersonModel = model<IErasedPerson>(
  'ErasedPerson',
  erasedPersonSchema,
  'erasedpersons'
);
