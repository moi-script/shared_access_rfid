import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { occupancyController } from './occupancy.controller';

export const occupancyRoutes = Router();

// Superadmin only. The registrar is denied scan-derived data everywhere else in
// this API (see dashboardService.registrarView) and occupancy is scan-derived.
occupancyRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));
occupancyRoutes.get('/', occupancyController.list);
occupancyRoutes.post('/:id/clear', occupancyController.clear);
