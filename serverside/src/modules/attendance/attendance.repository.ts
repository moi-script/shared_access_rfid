import { FilterQuery } from 'mongoose';
import { AttendanceModel, IAttendance } from './attendance.model';
import { PaginationParams } from '../../utils/pagination';
import { isDuplicateKey } from '../../utils/isDuplicateKey';

export const attendanceRepo = {
  findByPersonAndDate: (person_id: string, date: string) =>
    AttendanceModel.findOne({ person_id, date }),

  upsertTimeIn: async (person_id: string, date: string, when: Date, status: 'present' | 'late') => {
    try {
      return await AttendanceModel.findOneAndUpdate(
        { person_id, date, $or: [{ time_in: null }, { time_in: { $exists: false } }] },
        { $set: { time_in: when, status } },
        { upsert: true, new: true }
      );
    } catch (err: unknown) {
      // A row already exists WITH a time_in (filter didn't match) → that's fine, return it.
      if (isDuplicateKey(err)) {
        return AttendanceModel.findOne({ person_id, date });
      }
      throw err;
    }
  },

  upsertTimeOut: (person_id: string, date: string, when: Date) =>
    AttendanceModel.findOneAndUpdate(
      { person_id, date },
      { $set: { time_out: when } },
      { upsert: true, new: true }
    ),

  async findPaginated(filter: FilterQuery<IAttendance>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      AttendanceModel.find(filter).sort({ date: -1 }).skip(p.skip).limit(p.limit).lean(),
      AttendanceModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  findSummary: (person_id: string) =>
    AttendanceModel.find({ person_id }).sort({ date: -1 }).limit(30).lean(),
};
