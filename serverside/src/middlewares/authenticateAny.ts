import { Request, Response, NextFunction } from 'express';
import { authenticate } from './authenticate';
import { authenticateGate, GATE_KEY_HEADER } from './authenticateGate';

/**
 * Accepts a gate device key or a user JWT. Used by the photo endpoint: a gate
 * terminal has no user session but is the main consumer of face photos.
 */
export function authenticateAny(req: Request, res: Response, next: NextFunction): void {
  if (req.headers[GATE_KEY_HEADER]) {
    authenticateGate(req, res, next);
    return;
  }
  authenticate(req, res, next);
}
