import { FilterQuery, Types } from 'mongoose';
import { UserModel, IUser } from './users.model';
import { PersonModel } from '../persons/persons.model';
import { PaginationParams } from '../../utils/pagination';

const SAFE_FIELDS = '-password_hash -refreshTokenHash';

export interface UserListQuery {
  type?: string;
  department_section?: string;
  search?: string;
}

export interface UserWithPerson {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  deactivated_at: Date | null;
  person: {
    id: string;
    full_name: string;
    type: string;
    department_section: string;
    rfid_uid: string | null;
    status: string;
  } | null;
}

export const userRepo = {
  create: (data: Partial<IUser>) => UserModel.create(data),
  findByUsername: (username: string) => UserModel.findOne({ username }),
  findById: (id: string) => UserModel.findById(id),
  /**
   * Used by personService.update (Critical 2) to check whether a person being
   * reactivated has a linked login that a superadmin already deleted. Not
   * scoped to `deleted_at: null` like userRepo.buildFilter's base filter —
   * this lookup exists specifically to FIND a deleted user, not to exclude one.
   */
  findByPersonId: (personId: string) => UserModel.findOne({ person_id: personId }),
  updateById: (id: string, data: Partial<IUser>) =>
    UserModel.findByIdAndUpdate(id, data, { new: true }).select(SAFE_FIELDS).lean(),

  /**
   * Resolves a person-oriented query into a user filter.
   *
   * `type` and `department_section` describe people, not logins, so they are
   * resolved to person ids first. A query naming either one can only ever match
   * users that have a linked person — accounts without one (superadmin,
   * registrar) drop out, which is what the Accounts view wants.
   *
   * Shared by list, bulk preview, and bulk mutate so all three agree.
   */
  async buildFilter(q: UserListQuery): Promise<FilterQuery<IUser>> {
    // Deleted users are excluded everywhere this filter is used — the list, the bulk
    // preview, and the bulk mutation. Putting it here is what stops "Activate All"
    // from resurrecting them.
    const base: FilterQuery<IUser> = { deleted_at: null };

    const personFilter: FilterQuery<Record<string, unknown>> = {};
    if (q.type) personFilter.type = q.type;
    if (q.department_section) personFilter.department_section = q.department_section;
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      personFilter.$or = [{ full_name: rx }, { id_number: rx }, { rfid_uid: rx }];
    }

    if (Object.keys(personFilter).length === 0) return base;

    // deleted_at: null here, not just on the User side above: a type/section/
    // search filter must not resolve through to a soft-deleted person's id,
    // or a query as ordinary as `type: 'student'` becomes a way to reach a
    // login the delete cascade deliberately killed. Without this, "Activate
    // All Students" reactivates a deleted student's login the moment a
    // registrar runs it against the whole roster.
    const personIds = (
      await PersonModel.find({ ...personFilter, deleted_at: null }).select('_id').lean()
    ).map((p) => p._id as Types.ObjectId);
    return { ...base, person_id: { $in: personIds } };
  },

  async findPaginatedWithPerson(filter: FilterQuery<IUser>, p: PaginationParams) {
    const [docs, total] = await Promise.all([
      UserModel.find(filter)
        .select(SAFE_FIELDS)
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .populate('person_id', 'full_name type department_section rfid_uid status')
        .lean(),
      UserModel.countDocuments(filter),
    ]);

    const items: UserWithPerson[] = docs.map((d) => {
      const raw = d as unknown as {
        _id: Types.ObjectId;
        username: string;
        role: string;
        is_active: boolean;
        deactivated_at: Date | null;
        person_id:
          | {
              _id: Types.ObjectId;
              full_name: string;
              type: string;
              department_section: string;
              rfid_uid?: string;
              status: string;
            }
          | null;
      };
      return {
        id: String(raw._id),
        username: raw.username,
        role: raw.role,
        is_active: raw.is_active,
        deactivated_at: raw.deactivated_at ?? null,
        person: raw.person_id
          ? {
              id: String(raw.person_id._id),
              full_name: raw.person_id.full_name,
              type: raw.person_id.type,
              department_section: raw.person_id.department_section,
              rfid_uid: raw.person_id.rfid_uid ?? null,
              status: raw.person_id.status,
            }
          : null,
      };
    });

    return { items, total };
  },
};
