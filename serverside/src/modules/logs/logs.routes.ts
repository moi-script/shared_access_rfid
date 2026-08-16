import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { logController } from './logs.controller';

export const logRoutes = Router();

logRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));
logRoutes.get('/', logController.list);
