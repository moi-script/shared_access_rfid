import { z } from 'zod';
import { VEHICLE_TYPES } from '../../constants/vehicleTypes';

export const createVehicleSchema = z.object({
  owner_person_id: z.string().min(1),
  plate_number: z.string().min(1),
  // Matches tapSchema's constraint (scan.schema.ts): 6-32 hex characters, what
  // real readers emit. A UID accepted here but rejected by tapSchema at the
  // gate would register a vehicle whose pass can never tap in.
  // Uppercased at the boundary so every NEW row stores one spelling of a hex
  // UID. Casing is the CAV 8832 clash vector: `abcdef` and `ABCDEF` are the
  // same physical card and used to register as two rows. assertUidFree now
  // catches that clash regardless of stored casing (it is what protects the
  // pre-existing mixed-case rows, which are deliberately not migrated); this
  // stops new ones being created.
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters')
    .transform((v) => v.toUpperCase()),
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

/**
 * The whole-fleet switch-off. Deliberately accepts ONLY 'inactive'.
 *
 * There is no bulk activate twin (accounts have one): a blanket updateMany
 * cannot run the per-owner check that vehicleService.update runs, so
 * re-arming every pass at once would hand any owner with two rows two active
 * passes — the state the one-active-vehicle-per-person rule exists to
 * prevent, since a pass is keyed on the owner's card. Re-activation stays on
 * the per-row toggle, which goes through update() and gets that check.
 */
export const bulkVehicleStatusSchema = z.object({ status: z.literal('inactive') });

