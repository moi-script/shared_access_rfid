import { Types } from 'mongoose';
import { OccupancyModel, IOccupancy } from './occupancy.model';
import { isDuplicateKey } from '../../utils/isDuplicateKey';
import { PaginationParams } from '../../utils/pagination';

export type EntityType = 'person' | 'vehicle';
export type EnterResult = 'admitted' | 'already_inside';
export type ExitResult = 'released' | 'exit_without_entry';

/** The projected shape of one `listInside` row, after the person/vehicle/gate lookups. */
export interface OccupancyListRow {
  _id: Types.ObjectId;
  entity_type: EntityType;
  since: Date;
  name: string | null;
  id_number: string | null;
  gate: string;
}

export const occupancyRepo = {
  /**
   * Flips the entity to `inside` only if it is currently outside, or if its
   * state predates `boundary` and is therefore stale.
   *
   * The filter and the write are ONE operation on purpose. If the document
   * exists and is genuinely fresh-inside, the filter matches nothing, the
   * upsert attempts an insert, and the unique index rejects it — that E11000
   * is the passback. Splitting this into a read then a write reintroduces the
   * race the whole feature exists to close.
   */
  async enter(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId,
    boundary: Date
  ): Promise<EnterResult> {
    try {
      await OccupancyModel.findOneAndUpdate(
        {
          entity_type,
          entity_id,
          $or: [{ state: 'outside' }, { since: { $lt: boundary } }],
        },
        {
          $set: {
            state: 'inside',
            since: new Date(),
            last_gate_id: gate_id,
            cleared_by: null,
            cleared_at: null,
          },
        },
        { upsert: true }
      );
      return 'admitted';
    } catch (err: unknown) {
      // This collection has exactly one unique index besides `_id`
      // (`entity_type_1_entity_id_1`), so an E11000 here can only mean a
      // passback. If a second unique index is ever added to this collection,
      // this branch must start checking which index was violated before
      // treating every E11000 as "already inside".
      if (isDuplicateKey(err)) return 'already_inside';
      throw err;
    }
  },

  /**
   * Exit never fails. A miss means they were not inside, which is an anomaly,
   * not a denial.
   *
   * Applies the same staleness rule as `enter`/`listInside`: a row stranded
   * `inside` from before `boundary` no longer counts as a real entry. Without
   * this, a card that entered before the nightly reset and never tapped out
   * would match here on its next exit tap and silently report `released`,
   * even though there was no entry within the current occupancy window — the
   * correct signal is `exit_without_entry`, so the anomaly report can see it.
   */
  async release(
    entity_type: EntityType,
    entity_id: Types.ObjectId,
    gate_id: Types.ObjectId,
    boundary: Date
  ): Promise<ExitResult> {
    const doc = await OccupancyModel.findOneAndUpdate(
      { entity_type, entity_id, state: 'inside', since: { $gte: boundary } },
      { $set: { state: 'outside', since: new Date(), last_gate_id: gate_id } }
    );
    return doc ? 'released' : 'exit_without_entry';
  },

  /**
   * Deliberately permissive: matches on `state: 'inside'` alone, with no
   * staleness check. This is intentional, not an oversight — a superadmin
   * must always be able to clear a stuck row through this API, even a stale
   * one, so gating this on freshness (like `release`/`enter`/`listInside`)
   * would leave an admin unable to fix a stale row at all. Do not
   * "harmonise" this with `release`'s boundary check.
   */
  clearById(id: string, clearedBy: Types.ObjectId): Promise<IOccupancy | null> {
    return OccupancyModel.findOneAndUpdate(
      { _id: id, state: 'inside' },
      { $set: { state: 'outside', since: new Date(), cleared_by: clearedBy, cleared_at: new Date() } },
      { new: false }
    ).lean<IOccupancy | null>();
  },

  /**
   * The presence roster. Applies the same staleness rule as `enter`, so a
   * stranded row never shows up as somebody standing on campus.
   */
  async listInside(boundary: Date, p: PaginationParams): Promise<{ items: OccupancyListRow[]; total: number }> {
    const filter = { state: 'inside', since: { $gte: boundary } };
    const [items, total] = await Promise.all([
      OccupancyModel.aggregate<OccupancyListRow>([
        { $match: filter },
        { $sort: { since: -1 } },
        { $skip: p.skip },
        { $limit: p.limit },
        { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
        { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
        { $lookup: { from: 'gates', localField: 'last_gate_id', foreignField: '_id', as: 'gate' } },
        {
          $project: {
            _id: 1,
            entity_type: 1,
            since: 1,
            name: {
              $ifNull: [
                { $arrayElemAt: ['$person.full_name', 0] },
                { $arrayElemAt: ['$vehicle.plate_number', 0] },
              ],
            },
            id_number: { $arrayElemAt: ['$person.id_number', 0] },
            gate: { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
          },
        },
      ]),
      OccupancyModel.countDocuments(filter),
    ]);
    return { items, total };
  },
};
