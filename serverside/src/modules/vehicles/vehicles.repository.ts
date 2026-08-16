import { FilterQuery, Types } from 'mongoose';
import { VehicleModel, IVehicle } from './vehicles.model';
import { PaginationParams } from '../../utils/pagination';

export const vehicleRepo = {
  create: (data: Partial<IVehicle>) => VehicleModel.create(data),
  async findPaginated(filter: FilterQuery<IVehicle>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      VehicleModel.find(filter)
        // The list view shows who owns each vehicle; without this the browser
        // gets a bare ObjectId and would need a second round trip per page.
        // findActiveByOwner deliberately does NOT get this join — it feeds the
        // gate terminal, which needs the narrow projection it already has.
        .populate('owner_person_id', 'full_name id_number type')
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
      VehicleModel.countDocuments(filter),
    ]);
    return { items, total };
  },
  findById: (id: string) => VehicleModel.findById(id).lean(),
  findByRfid: (rfid_uid: string) => VehicleModel.findOne({ rfid_uid }),
  findByPlate: (plate_number: string) => VehicleModel.findOne({ plate_number }),
  updateById: (id: string, data: Partial<IVehicle>) =>
    VehicleModel.findByIdAndUpdate(id, data, { new: true }).lean(),

  /**
   * Every vehicle this person may currently use: active, and not past its
   * expiry as of `asOf`.
   *
   * Deliberately NOT a revival of findByOwner, which was removed when the
   * one-vehicle-per-person rule was dropped. This one is scoped to what a gate
   * should display: showing an expired pass would tell a guard the opposite of
   * the truth. `asOf` is passed in rather than read from the clock here so the
   * caller compares against the tap's own scan_time, in local time.
   */
  findActiveByOwner: (owner_person_id: Types.ObjectId, asOf: Date) =>
    VehicleModel.find({
      owner_person_id,
      status: 'active',
      valid_until: { $gte: asOf },
    })
      // Projection is shared by two consumers: the monitor's `registered[]`
      // list (vehicle_type + make) and the single-card gate path, which also
      // needs _id for the occupancy write and plate_number for the scan log.
      // `_id` is included by default. Keep this ONE method — a second lookup
      // with a drifting filter is how a vehicle gets granted by one caller
      // and rejected by another.
      // photo_url joins the projection for the gate terminal's vehicle frame.
      // Without it the single-card grant path in scan.service reads
      // `v.photo_url` as undefined and the terminal shows a placeholder for a
      // vehicle that does have a photo.
      .select('vehicle_type make plate_number photo_url')
      .sort({ createdAt: -1 })
      .lean(),
};
