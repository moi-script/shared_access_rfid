import { z } from 'zod';
import { VEHICLE_TYPES } from '../../constants/vehicleTypes';

// Required list mirrors the design spec exactly: the client's real paper form
// left Email, Tel No, Driver's License No, LTO CR, and Relationship blank,
// with OR No as `~`. Everything not in this required list stays optional so a
// real, mostly-blank application is still accepted.
//
// 2026-08-18: the OSS form was reduced to nine fields (see
// userpage/docs/superpowers/specs/2026-08-18-vehicle-registration-simplification-design.md).
// last_name, first_name, make, signed_name and signed_date are no longer
// collected and so were relaxed from .min(1) to .optional() — relaxed, not
// removed, because the form only stopped sending them and older applications
// still carry real values. Everything still marked required below is still
// genuinely sent by the form; do not relax further without checking that.
export const createApplicationSchema = z.object({
  category: z.enum(['new', 'renewal']),
  applicant_type: z.enum(['student', 'employee']),
  // Spread and re-asserted for the same reason as vehicles.schema.ts: zod's
  // enum needs a mutable [string, ...string[]] tuple, not a readonly one.
  vehicle_type: z.enum([...VEHICLE_TYPES] as [string, ...string[]]),
  owner_person_id: z.string().min(1),
  id_number: z.string().min(1),
  // No longer collected: the form resolves the applicant from id_number and
  // sends registered_owner_name from the person's full_name instead.
  last_name: z.string().optional(),
  first_name: z.string().optional(),
  middle_name: z.string().optional(),
  year_level: z.string().optional(),
  school_year: z.string().min(1),
  email: z.string().optional(),
  mobile_no: z.string().optional(),
  tel_no: z.string().optional(),
  permanent_address: z.string().optional(),

  driver_name: z.string().optional(),
  driver_license_no: z.string().optional(),

  lto_cr_no: z.string().optional(),
  lto_cr_date: z.string().optional(),
  lto_or_no: z.string().optional(),
  lto_or_date: z.string().optional(),

  // No format regex: Philippine plates, MV file numbers and temporary plates
  // vary too much for a naive pattern to survive contact with real paperwork.
  plate_no: z.string().min(1).transform((v) => v.trim().toUpperCase()),
  mv_file_no: z.string().optional(),
  // No longer collected. VehicleModel already declared make/vehicle_model/
  // color optional, and every reader of them is null-guarded.
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.string().optional(),
  color: z.string().optional(),

  registered_owner_name: z.string().min(1),
  relationship: z.string().optional(),

  // No longer collected: signature capture was removed from the form. The
  // applicationSignatures module stays live, so an application signed before
  // this change keeps its signature and GET /:id/signature still serves it.
  signed_name: z.string().optional(),
  signed_date: z.string().optional(),

  // Matches tapSchema's existing constraint (scan.schema.ts): 6-32 hex
  // characters, what real readers emit. A UID accepted here but rejected by
  // tapSchema at the gate would issue a sticker for a pass that can never
  // tap in — the gate would 422 before scanService.tap ever runs.
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters'),

  valid_until: z.string().datetime().optional(),
});
