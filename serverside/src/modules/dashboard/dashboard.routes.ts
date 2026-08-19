import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { ROLES } from '../../constants/roles';
import { dashboardController } from './dashboard.controller';

export const dashboardRoutes = Router();

dashboardRoutes.use(authenticate);
dashboardRoutes.get('/', dashboardController.get);

// Superadmin only, matching occupancy.routes.ts. `/` fans out by role because
// every role has a dashboard; this one returns occupancy and raw scan rows,
// which is exactly the scan-derived data registrarView is defined by
// withholding — so it is gated rather than shaped per role.
dashboardRoutes.get('/live', authorize(ROLES.SUPERADMIN), dashboardController.live);

// The push transport for the same data. `/live` above is kept as the client's
// fallback: a proxy that eats event-streams degrades the console to polling
// rather than breaking it.
dashboardRoutes.get('/live/stream', authorize(ROLES.SUPERADMIN), dashboardController.stream);
