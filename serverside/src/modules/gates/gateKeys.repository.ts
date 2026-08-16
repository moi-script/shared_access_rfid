import { Types } from 'mongoose';
import { GateKeyModel, IGateKey } from './gateKeys.model';

export const gateKeyRepo = {
  create: (doc: {
    gate_id: Types.ObjectId;
    key_hash: string;
    key_prefix: string;
    created_by: Types.ObjectId;
  }) => GateKeyModel.create(doc),

  findActiveByPrefix: (prefix: string) =>
    GateKeyModel.findOne({ key_prefix: prefix, is_active: true }).lean<IGateKey | null>(),

  /** Keys are never deleted — which key a scan ran under stays auditable. */
  deactivateForGate: (gateId: Types.ObjectId) =>
    GateKeyModel.updateMany({ gate_id: gateId, is_active: true }, { $set: { is_active: false } }),

  touch: (id: Types.ObjectId) =>
    GateKeyModel.updateOne({ _id: id }, { $set: { last_used_at: new Date() } }),
};
