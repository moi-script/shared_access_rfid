import { FilterQuery } from 'mongoose';
import { PersonModel, IPerson } from './persons.model';
import { PaginationParams } from '../../utils/pagination';

/**
 * Every read here excludes soft-deleted people, in this file rather than at the
 * call sites, for the same reason userRepo.buildFilter pins deleted_at there:
 * one of these reads is findByRfid, which scan.service.tap uses to resolve a
 * tapped card. A call site that forgot the condition would let a deleted
 * person's card open a barrier while the directory showed them as gone — the
 * feature would look finished and would not be.
 */
const notDeleted = { deleted_at: null } as const;

export const personRepo = {
  create: (data: Partial<IPerson>) => PersonModel.create(data),

  async findPaginated(filter: FilterQuery<IPerson>, p: PaginationParams) {
    const scoped = { ...filter, ...notDeleted };
    const [items, total] = await Promise.all([
      PersonModel.find(scoped).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      PersonModel.countDocuments(scoped),
    ]);
    return { items, total };
  },

  findAll: (filter: FilterQuery<IPerson>) =>
    PersonModel.find({ ...filter, ...notDeleted }).sort({ createdAt: -1 }).lean(),

  async distinctSections(type?: string): Promise<string[]> {
    const filter: FilterQuery<IPerson> = { ...notDeleted };
    if (type) filter.type = type;
    const values = (await PersonModel.distinct('department_section', filter)) as (string | null)[];
    return values.filter((v): v is string => Boolean(v)).sort();
  },

  findById: (id: string) => PersonModel.findOne({ _id: id, ...notDeleted }).lean(),
  findByRfid: (rfid_uid: string) => PersonModel.findOne({ rfid_uid, ...notDeleted }),

  /**
   * The deliberate counterpart to `notDeleted` above, and the only read in
   * this file that returns soft-deleted rows. It exists so a superadmin has
   * a way to find someone to hand to POST /:id/restore — without it, restore
   * is an endpoint nobody can reach once the deleting page is reloaded.
   * Like findPaginated, `deleted_at` is spread last so no caller-supplied
   * filter can widen this back to "everyone."
   */
  async findDeletedPaginated(filter: FilterQuery<IPerson>, p: PaginationParams) {
    const scoped = { ...filter, deleted_at: { $ne: null } };
    const [items, total] = await Promise.all([
      PersonModel.find(scoped).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      PersonModel.countDocuments(scoped),
    ]);
    return { items, total };
  },

  /**
   * Deliberately does NOT exclude soft-deleted rows. Its only caller is the
   * duplicate check in personService.create, and id_number is never cleared
   * on delete (a student number should not be recycled) — the unique index
   * still contains deleted rows. Filtering here would let the service's own
   * check pass for a deleted person's number, and Mongo's unique index would
   * then reject the insert with a raw E11000, which errorHandler turns into
   * a generic 409 DUPLICATE_KEY instead of the clean DUPLICATE_ID this is
   * meant to produce.
   *
   * findByRfid above is the opposite case: delete DOES clear rfid_uid, so a
   * deleted person holds no UID left to clash with, and it is safe (in fact
   * required, for the gate) to filter there. That asymmetry — one field
   * cleared on delete, the other not — is intentional; do not "fix" it into
   * matching behavior.
   */
  findByIdNumber: (id_number: string) => PersonModel.findOne({ id_number }),

  updateById: (id: string, data: Partial<IPerson>) =>
    PersonModel.findByIdAndUpdate(id, data, { new: true }).lean(),
};
