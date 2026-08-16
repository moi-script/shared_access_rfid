import { Schema, model, Document, Types } from 'mongoose';

export interface IScanLog extends Document {
  _id: Types.ObjectId;
  rfid_uid: string;
  entity_type: 'person' | 'vehicle';
  entity_id: Types.ObjectId | null;
  gate_id: Types.ObjectId | null;
  direction: 'entry' | 'exit';
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  actor_user_id: Types.ObjectId | null;
}

const TWO_YEARS_SECONDS = 60 * 60 * 24 * 365 * 2;

const scanLogSchema = new Schema<IScanLog>({
  rfid_uid: { type: String, required: true, index: true },
  entity_type: { type: String, enum: ['person', 'vehicle'], required: true },
  entity_id: { type: Schema.Types.ObjectId, default: null },
  // Nullable because a manual override is a real scan-log event with no gate.
  gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', default: null },
  direction: { type: String, enum: ['entry', 'exit'], required: true },
  access_result: { type: String, enum: ['granted', 'denied'], required: true },
  reason: { type: String, default: null },
  scan_time: { type: Date, required: true, index: { expireAfterSeconds: TWO_YEARS_SECONDS } },
  // Null for ordinary gate taps — a card tap has no operator. Set only when a
  // human performed the action, e.g. a superadmin clearing occupancy state.
  // This is what makes an override permanently attributable: occupancy's
  // cleared_by is wiped by the person's very next tap.
  actor_user_id: { type: Schema.Types.ObjectId, ref: 'User', default: null },
});

scanLogSchema.index({ entity_type: 1, entity_id: 1 });

export const ScanLogModel = model<IScanLog>('ScanLog', scanLogSchema);
