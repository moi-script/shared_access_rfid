import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  // The floor matches users.schema.ts. currentPassword deliberately has no
  // minimum: it is compared against a stored hash, and rejecting a short one
  // early would tell an attacker something about the existing password.
  newPassword: z.string().min(8),
});
