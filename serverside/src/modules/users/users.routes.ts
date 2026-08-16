import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { userController } from './users.controller';
import {
  createUserSchema,
  resetPasswordSchema,
  userStatusSchema,
  bulkStatusSchema,
  bulkFilterSchema,
} from './users.schema';

export const userRoutes = Router();

userRoutes.use(authenticate);

const STAFF_SIDE_GUARD = authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS);

userRoutes.get('/', STAFF_SIDE_GUARD, userController.list);
userRoutes.post('/', STAFF_SIDE_GUARD, validate(createUserSchema), userController.create);

// Superadmin only: deletion was not granted to admins, and superadmins are
// promoted by `npm run grant:superadmin`, never over the API.
userRoutes.patch(
  '/:id/password',
  authorize(ROLES.SUPERADMIN),
  validate(resetPasswordSchema),
  userController.resetPassword
);
userRoutes.delete('/:id', authorize(ROLES.SUPERADMIN), userController.remove);

// Bulk routes stay above `/:id/status` — Express matches in declaration
// order, and `bulk-status` would otherwise be captured by `:id`.
userRoutes.get(
  '/bulk-status/preview',
  STAFF_SIDE_GUARD,
  validate(bulkFilterSchema, 'query'),
  userController.bulkPreview
);
userRoutes.post(
  '/bulk-status',
  STAFF_SIDE_GUARD,
  validate(bulkStatusSchema),
  userController.bulkSetStatus
);

userRoutes.patch(
  '/:id/status',
  STAFF_SIDE_GUARD,
  validate(userStatusSchema),
  userController.setStatus
);
