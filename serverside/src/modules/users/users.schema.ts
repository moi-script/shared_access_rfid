import { z } from 'zod';
import { ALL_ROLES } from '../../constants/roles';

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(ALL_ROLES as unknown as [string, ...string[]]),
  person_id: z.string().nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
});

export const userStatusSchema = z.object({
  active: z.boolean(),
});

// Shared by the bulk mutation body (`filter`) and the bulk preview query
// string, so both entry points admit exactly one shape. `z.string()` on each
// field rejects the array/object shapes Express's extended query parser
// produces for repeated keys (`?type=a&type=b`) or bracket syntax
// (`?type[$ne]=x`) — the preview cannot resolve a filter the mutation
// can't express.
export const bulkFilterSchema = z.object({
  type: z.string().optional(),
  department_section: z.string().optional(),
  search: z.string().optional(),
});

export const bulkStatusSchema = z.object({
  active: z.boolean(),
  filter: bulkFilterSchema.default({}),
});
