import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError('NOT_FOUND', 'Endpoint not found'));
}
