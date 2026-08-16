import { z } from 'zod';

export const createPersonSchema = z.object({
  full_name: z.string().min(1),
  type: z.enum(['student', 'staff', 'employee']),
  id_number: z.string().min(1),
  department_section: z.string().optional(),
  contact_email: z.string().email().optional(),
  photo_url: z.string().url().optional(),
  rfid_uid: z
    .string()
    .regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters')
    .optional(),
  status: z.enum(['active', 'inactive', 'pending']).optional(),
  // Optional here, required by the registration form. Bulk import shares this
  // schema and has no password column, so a mandatory field would break it —
  // and the alternative, plaintext passwords in a CSV, is worse than leaving
  // imported rows login-less. See importPersonsSchema below.
  password: z.string().min(8).optional(),
});

// Both fields are omitted from PATCH for different reasons:
//  - rfid_uid: replacing a card is its own dedicated action (its own
//    uniqueness/blocklist checks live in reassignRfidSchema), not a
//    plain field edit.
//  - id_number: it is also the linked User's login username. Letting it
//    change here would desync the person record from the login, so it
//    stays read-only outside of a dedicated (currently nonexistent)
//    rename flow. Zod strips unknown keys by default, so an id_number
//    sent in a PATCH body is silently dropped rather than rejected.
export const updatePersonSchema = createPersonSchema
  .partial()
  .omit({ rfid_uid: true, id_number: true });
export const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });
export const reassignRfidSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]{6,32}$/, 'rfid_uid must be 6-32 hex characters'),
});

export const importPersonsSchema = z.object({
  rows: z.array(createPersonSchema.omit({ password: true })).min(1).max(500),
});
