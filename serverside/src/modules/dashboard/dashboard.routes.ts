import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { dashboardController } from './dashboard.controller';

export const dashboardRoutes = Router();

dashboardRoutes.use(authenticate);
dashboardRoutes.get('/', dashboardController.get);
