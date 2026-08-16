import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { requestLogger } from './middlewares/requestLogger';
import { globalLimiter } from './middlewares/rateLimiter';
import { notFound } from './middlewares/notFound';
import { errorHandler } from './middlewares/errorHandler';

import { authRoutes } from './modules/auth/auth.routes';
import { personRoutes } from './modules/persons/persons.routes';
import { vehicleRoutes } from './modules/vehicles/vehicles.routes';
import { vehicleApplicationRoutes } from './modules/vehicleApplications/vehicleApplications.routes';
import { gadgetRoutes } from './modules/gadgets/gadgets.routes';
import { gateRoutes } from './modules/gates/gates.routes';
import { scanRoutes } from './modules/scan/scan.routes';
import { attendanceRoutes } from './modules/attendance/attendance.routes';
import { userRoutes } from './modules/users/users.routes';
import { logRoutes } from './modules/logs/logs.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { reportRoutes } from './modules/reports/reports.routes';
import { occupancyRoutes } from './modules/occupancy/occupancy.routes';

export function createApp(): Express {
  const app = express();

  // Behind Render/Railway/nginx the client address only exists in
  // X-Forwarded-For. Without this the rate limiters bucket every request in
  // the world under the proxy's IP. The value is a hop count, not a boolean:
  // `true` would trust the whole chain and let a client spoof its own IP past
  // the login limiter.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS_LIST,
      credentials: true,
    })
  );
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(express.json());
  app.use(requestLogger);
  app.use(globalLimiter);

  app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

  const prefix = env.API_PREFIX;
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/persons`, personRoutes);
  app.use(`${prefix}/vehicles`, vehicleRoutes);
  app.use(`${prefix}/vehicle-applications`, vehicleApplicationRoutes);
  app.use(`${prefix}/gadgets`, gadgetRoutes);
  app.use(`${prefix}/gates`, gateRoutes);
  app.use(`${prefix}/scan`, scanRoutes);
  app.use(`${prefix}/occupancy`, occupancyRoutes);
  app.use(`${prefix}/attendance`, attendanceRoutes);
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/logs`, logRoutes);
  app.use(`${prefix}/dashboard`, dashboardRoutes);
  app.use(`${prefix}/reports`, reportRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
