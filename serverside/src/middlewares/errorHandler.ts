import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return;
  }

  // Mongoose duplicate key
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    res.status(409).json({ success: false, code: 'DUPLICATE_KEY', message: 'Duplicate value' });
    return;
  }

  // Mongoose CastError (malformed ObjectId in a route param)
  if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'CastError') {
    res.status(422).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid identifier' });
    return;
  }

  console.error('[error]', err);
  const message = env.isProd ? 'Internal server error' : String((err as Error)?.message ?? err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message });
}
