import { Schema, model, Document, Types } from 'mongoose';

export interface IGateKey extends Document {
  _id: Types.ObjectId;
  gate_id: Types.ObjectId;
  key_hash: string;
  /** The 8-char lookup segment. Bcrypt hashes are not searchable. */
  key_prefix: string;
  is_active: boolean;
  last_used_at: Date | null;
  created_by: Types.ObjectId;
  createdAt: Date;
}

const gateKeySchema = new Schema<IGateKey>(
  {
    gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', required: true, index: true },
    key_hash: { type: String, required: true },
    key_prefix: { type: String, required: true, unique: true, index: true },
    is_active: { type: Boolean, default: true, index: true },
    last_used_at: { type: Date, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const GateKeyModel = model<IGateKey>('GateKey', gateKeySchema);
