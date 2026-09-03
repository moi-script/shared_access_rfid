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

/**
 * The fallback credential: the number printed on the ID itself.
 *
 * Not `rfid`-shaped and deliberately not hex — a student number is whatever
 * the registrar typed at enrolment, so this only bounds the length and
 * uppercases it, matching how persons.schema stores it. Case is normalized for
 * the same reason UIDs are: an exact-match lookup that misses because someone
 * typed lowercase is a real student standing at a real barrier.
 */
const idNumber = z
  .string()
  .trim()
  .min(3, 'id_number is too short')
  .max(32, 'id_number is too long')
  .transform((v) => v.toUpperCase());

/**
 * A tap carries EITHER a scanned UID or a hand-typed ID number, never both and
 * never neither.
 *
 * The manual path exists for a student whose card is lost or broken and who has
 * to settle it with OSS — the barrier still admits them, and the scan log
 * records that it was a hand-typed entry. Enforced here rather than in the
 * service so a malformed body is a 400 instead of an ambiguous tap.
 */
const oneCredential = <T extends { rfid_uid?: string; id_number?: string }>(v: T, ctx: z.RefinementCtx) => {
  if (!v.rfid_uid === !v.id_number) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Send exactly one of rfid_uid or id_number',
    });
  }
};

/** JWT callers name the gate themselves. */
export const tapSchema = z
  .object({
    rfid_uid: rfid.optional(),
    id_number: idNumber.optional(),
    gate_id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid gate_id'),
    direction: z.enum(['entry', 'exit']),
  })
  .superRefine(oneCredential);

/**
 * Device callers send only the credential. Gate and direction come from the
 * key, so any gate_id or direction in the body is stripped rather than trusted.
 */
export const tapDeviceSchema = z
  .object({ rfid_uid: rfid.optional(), id_number: idNumber.optional() })
  .superRefine(oneCredential)
  .transform((v) => ({ rfid_uid: v.rfid_uid, id_number: v.id_number }));

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
