import { Schema, model, Document, Types } from 'mongoose';

export interface IAttendance extends Document {
  _id: Types.ObjectId;
  person_id: Types.ObjectId;
  date: string; // YYYY-MM-DD
  time_in: Date | null;
  time_out: Date | null;
  status: 'present' | 'late' | 'absent';
}

const attendanceSchema = new Schema<IAttendance>({
  person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
  date: { type: String, required: true },
  time_in: { type: Date, default: null },
  time_out: { type: Date, default: null },
  status: { type: String, enum: ['present', 'late', 'absent'], default: 'present' },
});

attendanceSchema.index({ person_id: 1, date: 1 }, { unique: true });

export const AttendanceModel = model<IAttendance>('AttendanceSummary', attendanceSchema);
