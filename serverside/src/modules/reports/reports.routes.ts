import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { reportController } from './reports.controller';

export const reportRoutes = Router();

reportRoutes.use(authenticate, authorize(ROLES.SUPERADMIN));
reportRoutes.get('/attendance', reportController.attendance);
reportRoutes.get('/gate-activity', reportController.gateActivity);
reportRoutes.get('/anomalies', reportController.anomalies);
