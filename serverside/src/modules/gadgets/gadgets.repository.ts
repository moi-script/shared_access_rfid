import { FilterQuery, Types } from 'mongoose';
import { GadgetModel, IGadget } from './gadgets.model';
import { PaginationParams } from '../../utils/pagination';

export const gadgetRepo = {
  create: (data: Partial<IGadget>) => GadgetModel.create(data),

  async findPaginated(filter: FilterQuery<IGadget>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      GadgetModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      GadgetModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  findById: (id: string) => GadgetModel.findById(id).lean(),

  /**
   * Callers MUST pass an already-normalized serial (normalizeSerial). Doing it
   * here instead would split the normalization across two layers, and the one
   * guarantee that matters is that the value compared against the unique index
   * and the value written are produced by the same expression.
   */
  findBySerial: (serial_number: string) => GadgetModel.findOne({ serial_number }),

  updateById: (id: string, data: Partial<IGadget>) =>
    GadgetModel.findByIdAndUpdate(id, data, { new: true }).lean(),

  /**
   * Every gadget this person may currently claim: active ones.
   *
   * Takes no `asOf`, unlike vehicleRepo.findActiveByOwner. Gadgets have no
   * expiry to evaluate against a tap's scan_time — status is the whole filter.
   *
   * Two consumers share this ONE method and its projection: the per-person
   * limit check in gadgets.service, and the gate display attached in
   * scan.service. Keep it single — a second lookup with a drifting filter is
   * how a gadget gets counted against the limit by one caller and hidden from
   * the guard by the other.
   */
  findActiveByOwner: (owner_person_id: Types.ObjectId) =>
    GadgetModel.find({ owner_person_id, status: 'active' })
      .select('gadget_type brand_model serial_number')
      .sort({ createdAt: -1 })
      .lean(),
};
