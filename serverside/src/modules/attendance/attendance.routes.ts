import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { attendanceController } from './attendance.controller';

export const attendanceRoutes = Router();

attendanceRoutes.use(authenticate);
attendanceRoutes.get('/', authorize(ROLES.SUPERADMIN, ROLES.STAFF, ROLES.STUDENT), attendanceController.list);
attendanceRoutes.get('/summary/:person_id', authorize(ROLES.SUPERADMIN), attendanceController.summary);
