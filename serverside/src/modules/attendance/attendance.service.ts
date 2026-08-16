import { FilterQuery } from 'mongoose';
import { attendanceRepo } from './attendance.repository';
import { IAttendance } from './attendance.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, Role } from '../../constants/roles';

interface ListQuery {
  page?: string;
  limit?: string;
  person_id?: string;
  from?: string;
  to?: string;
  status?: string;
}

export const attendanceService = {
  async list(query: ListQuery, actor: { role: Role; personId: string | null }) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IAttendance> = {};

    if (actor.role === ROLES.SUPERADMIN) {
      if (query.person_id) filter.person_id = query.person_id;
    } else {
      if (!actor.personId) throw new ApiError('FORBIDDEN', 'Account not linked to a person');
      filter.person_id = actor.personId;
    }

    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }

    const { items, total } = await attendanceRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  summary(person_id: string) {
    return attendanceRepo.findSummary(person_id);
  },
};
