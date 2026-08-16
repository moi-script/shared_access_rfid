import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { gateController } from './gates.controller';

export const gateRoutes = Router();

gateRoutes.use(authenticate);
gateRoutes.get('/', gateController.list);
gateRoutes.get('/:id', gateController.get);
// Superadmin only — provisioning a terminal is not a registrar action.
gateRoutes.post('/:id/key', authorize(ROLES.SUPERADMIN), gateController.mintKey);
