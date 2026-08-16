import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { Role } from '../constants/roles';

export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError('UNAUTHORIZED'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ApiError('FORBIDDEN'));
      return;
    }
    next();
  };
