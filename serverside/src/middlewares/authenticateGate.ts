import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { gateKeyService } from '../modules/gates/gateKeys.service';

export const GATE_KEY_HEADER = 'x-gate-key';

/** Authenticates a gate terminal by its device key. Requires the header. */
export function authenticateGate(req: Request, _res: Response, next: NextFunction): void {
  const presented = req.headers[GATE_KEY_HEADER];
  if (typeof presented !== 'string' || !presented) {
    next(new ApiError('UNAUTHORIZED'));
    return;
  }
  gateKeyService
    .authenticate(presented)
    .then((gate) => {
      if (!gate) {
        next(new ApiError('UNAUTHORIZED', 'Invalid or revoked gate key'));
        return;
      }
      req.gate = gate;
      next();
    })
    .catch(next);
}
