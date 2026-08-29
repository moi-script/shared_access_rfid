import { z } from 'zod';

// Uppercased at the boundary, exactly mirroring the registration-side
// normalization in persons/vehicles/gadgets schemas. These two boundaries are
// one mechanism and must be changed together or not at all: registration
// stores `A1B2C3`, so a tap that arrives as `a1b2c3` and is looked up verbatim
// misses all four exact-match lookups (person, vehicle, gadget, blocked card)
// and comes back `unregistered_uid`. That is not a cosmetic mismatch — it is a
// real person standing at a real barrier whose working card silently stopped
// opening it. Normalizing here also means the `scanRepo.createLog` row records
// the same spelling the registry holds, so the log can be joined back to the
// card it belongs to.
const rfid = z
  .string()
  .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters')
  .transform((v) => v.toUpperCase());

/** JWT callers name the gate themselves. */
export const tapSchema = z.object({
  rfid_uid: rfid,
  gate_id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid gate_id'),
  direction: z.enum(['entry', 'exit']),
});

/**
 * Device callers send only the UID. Gate and direction come from the key, so
 * any gate_id or direction in the body is stripped rather than trusted.
 */
export const tapDeviceSchema = z
  .object({ rfid_uid: rfid })
  .transform((v) => ({ rfid_uid: v.rfid_uid }));

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid id');

/**
 * Closing an exit prompt that ended with devices unticked.
 *
 * This is a separate call, not a field on the tap, because the person's exit
 * is logged the moment they tap — before anyone knows whether the devices will
 * be presented. Scan logs are append-only, so the outcome cannot be written
 * back onto that row; it becomes a second row. See the spec's "Closing an
 * incomplete exit prompt".
 */
export const gadgetSessionSchema = z.object({
  gate_id: objectId,
  person_id: objectId,
  missing_gadget_ids: z.array(objectId).min(1),
});

/** Device callers get the gate from their key, exactly like tapDeviceSchema. */
export const gadgetSessionDeviceSchema = z
  .object({
    person_id: objectId,
    missing_gadget_ids: z.array(objectId).min(1),
  })
  .transform((v) => ({ person_id: v.person_id, missing_gadget_ids: v.missing_gadget_ids }));
