import { Schema, model, Document, Types } from 'mongoose';

/**
 * A permanently retired card UID. Rows here are never removed by application
 * code — there is no unblock endpoint, no force flag, no override. Once a UID
 * lands in this collection it is dead forever; see the module's callers for
 * why (card_replaced from persons.service.reassignRfid, person_deleted from
 * the delete cascade in Task 3).
 */
export interface IBlockedCard extends Document {
  rfid_uid: string;
  // Derived from the action that retired the card — never an operator's
  // free-text choice. There is deliberately no "reason" prompt anywhere in
  // this feature.
  source: 'card_replaced' | 'person_deleted';
  previous_person_id: Types.ObjectId | null;
  blocked_by: Types.ObjectId;
  blocked_at: Date;
}

const blockedCardSchema = new Schema<IBlockedCard>({
  rfid_uid: { type: String, required: true, unique: true, index: true },
  source: { type: String, enum: ['card_replaced', 'person_deleted'], required: true },
  previous_person_id: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
  blocked_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  blocked_at: { type: Date, default: Date.now },
});

export const BlockedCardModel = model<IBlockedCard>('BlockedCard', blockedCardSchema);
