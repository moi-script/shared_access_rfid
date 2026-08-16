import { FilterQuery, Types } from 'mongoose';
import { VehicleApplicationModel, IVehicleApplication } from './vehicleApplications.model';
import { PaginationParams } from '../../utils/pagination';
import { ApiError } from '../../utils/ApiError';

export const vehicleApplicationRepo = {
  create: (data: Partial<IVehicleApplication>) => VehicleApplicationModel.create(data),

  async findPaginated(filter: FilterQuery<IVehicleApplication>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      VehicleApplicationModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      VehicleApplicationModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  findById: (id: string) => VehicleApplicationModel.findById(id).lean(),

  /**
   * vehicle_id is the ONLY mutable field on an application, and it is settable
   * exactly once. Everything a human entered is frozen; a system link written
   * by the service that created the vehicle is not part of the signed document.
   */
  async linkVehicle(applicationId: string, vehicleId: Types.ObjectId) {
    const updated = await VehicleApplicationModel.findOneAndUpdate(
      { _id: applicationId, vehicle_id: null },
      { $set: { vehicle_id: vehicleId } },
      { new: true }
    );
    if (!updated) throw new ApiError('CONFLICT', 'This application is already linked to a vehicle');
    return updated;
  },
};
