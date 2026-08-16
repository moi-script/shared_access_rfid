import { z } from 'zod';
import { VEHICLE_TYPES } from '../../constants/vehicleTypes';

export const createVehicleSchema = z.object({
  owner_person_id: z.string().min(1),
  plate_number: z.string().min(1),
  // Matches tapSchema's constraint (scan.schema.ts): 6-32 hex characters, what
  // real readers emit. A UID accepted here but rejected by tapSchema at the
  // gate would register a vehicle whose pass can never tap in.
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters'),
  // zod's enum needs a mutable [string, ...string[]] tuple, so the readonly
  // const array is spread and re-asserted. This is the whole cost of having
  // one list instead of two.
  vehicle_type: z.enum([...VEHICLE_TYPES] as [string, ...string[]]),
  make: z.string().optional(),
  vehicle_model: z.string().optional(),
  color: z.string().optional(),
  valid_until: z.string().datetime().optional(),
  photo_url: z.string().url().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const updateVehicleSchema = createVehicleSchema.partial();
export const vehicleStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
