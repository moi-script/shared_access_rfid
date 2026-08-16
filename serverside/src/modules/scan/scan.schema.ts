import { z } from 'zod';

const rfid = z
  .string()
  .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters');

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
