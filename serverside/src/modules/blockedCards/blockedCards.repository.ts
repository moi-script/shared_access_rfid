import { Types } from 'mongoose';
import { BlockedCardModel } from './blockedCards.model';

export const blockedCardRepo = {
  isBlocked: async (rfid_uid: string): Promise<boolean> => {
    const row = await BlockedCardModel.findOne({ rfid_uid }).select('_id').lean();
    return row !== null;
  },

  block: (params: {
    rfid_uid: string;
    source: 'card_replaced' | 'person_deleted';
    previous_person_id: Types.ObjectId | string | null;
    blocked_by: Types.ObjectId | string;
  }) =>
    BlockedCardModel.create({
      rfid_uid: params.rfid_uid,
      source: params.source,
      previous_person_id: params.previous_person_id
        ? new Types.ObjectId(String(params.previous_person_id))
        : null,
      blocked_by: new Types.ObjectId(String(params.blocked_by)),
    }),

  /**
   * The sole exception to "rows here are never removed by application code"
   * (see the model's own docstring, and `block`'s comment above it). Reached
   * only from personService.purgeForTesting, which is itself refused outside
   * a non-production environment before this is ever called — that guard is
   * what keeps the blockedCards ruling intact for real deployments, not
   * anything in this method.
   *
   * Deletes every block row for this UID, not just one — a card that was
   * already blocked by an earlier soft-delete or card-replace in the same
   * test run must come back fully usable, not just partially.
   */
  purgeByRfid: (rfid_uid: string) => BlockedCardModel.deleteMany({ rfid_uid }),
};
