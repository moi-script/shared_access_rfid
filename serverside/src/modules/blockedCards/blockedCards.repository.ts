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
};
