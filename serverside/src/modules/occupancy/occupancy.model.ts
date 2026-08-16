import { Schema, model, Document, Types } from 'mongoose';

export interface IOccupancy extends Document {
  _id: Types.ObjectId;
  entity_type: 'person' | 'vehicle';
  entity_id: Types.ObjectId;
  state: 'inside' | 'outside';
  since: Date;
  last_gate_id: Types.ObjectId | null;
  cleared_by: Types.ObjectId | null;
  cleared_at: Date | null;
}

const occupancySchema = new Schema<IOccupancy>({
  entity_type: { type: String, enum: ['person', 'vehicle'], required: true },
  entity_id: { type: Schema.Types.ObjectId, required: true },
  state: { type: String, enum: ['inside', 'outside'], required: true },
  since: { type: Date, required: true },
  last_gate_id: { type: Schema.Types.ObjectId, ref: 'Gate', default: null },
  cleared_by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  cleared_at: { type: Date, default: null },
});

// Load-bearing, not an optimisation. This index is what serialises two
// simultaneous entry taps on the same card: the loser gets E11000, which is how
// a passback is detected. Removing it silently breaks the feature.
occupancySchema.index({ entity_type: 1, entity_id: 1 }, { unique: true });

export const OccupancyModel = model<IOccupancy>('Occupancy', occupancySchema);
