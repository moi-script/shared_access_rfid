import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { authenticate } from '../../middlewares/authenticate';
import { loginLimiter } from '../../middlewares/rateLimiter';
import { changePasswordSchema, loginSchema } from './auth.schema';
import {
  loginController,
  refreshController,
  logoutController,
  changePasswordController,
} from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiter, validate(loginSchema), loginController);
authRoutes.post('/refresh', loginLimiter, refreshController);
authRoutes.post('/logout', authenticate, logoutController);

// loginLimiter, not the global limiter: this endpoint accepts a password guess,
// so it belongs with the other credential-guessing surface.
authRoutes.post(
  '/change-password',
  loginLimiter,
  authenticate,
  validate(changePasswordSchema),
  changePasswordController
);
