import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateGate, GATE_KEY_HEADER } from '../../middlewares/authenticateGate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { scanLimiter } from '../../middlewares/rateLimiter';
import { ROLES } from '../../constants/roles';
import { scanController } from './scan.controller';
import {
  tapSchema,
  tapDeviceSchema,
  gadgetSessionSchema,
  gadgetSessionDeviceSchema,
} from './scan.schema';

export const scanRoutes = Router();

/**
 * A tap arrives either from a gate terminal holding a device key, or from a
 * logged-in user (the role harness taps this way). The credential decides
 * which validation applies, so the blanket `authenticate` this router used to
 * carry has been replaced with per-route middleware.
 */
function tapAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.headers[GATE_KEY_HEADER]) {
    authenticateGate(req, res, next);
    return;
  }
  authenticate(req, res, next);
}

function tapValidate(req: Request, res: Response, next: NextFunction): void {
  const schema = req.gate ? tapDeviceSchema : tapSchema;
  validate(schema)(req, res, next);
}

scanRoutes.post('/tap', scanLimiter, tapAuth, tapValidate, scanController.tap);

function gadgetSessionValidate(req: Request, res: Response, next: NextFunction): void {
  const schema = req.gate ? gadgetSessionDeviceSchema : gadgetSessionSchema;
  validate(schema)(req, res, next);
}

// Shares tapAuth and scanLimiter with /tap: it comes from the same terminals,
// at the same rate, on the same credentials.
scanRoutes.post(
  '/gadget-session',
  scanLimiter,
  tapAuth,
  gadgetSessionValidate,
  scanController.gadgetSession
);

scanRoutes.get('/logs', authenticate, authorize(ROLES.SUPERADMIN), scanController.logs);
