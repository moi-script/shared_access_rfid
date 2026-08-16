import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../modules/auth/auth.tokens';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new ApiError('UNAUTHORIZED'));
    return;
  }
  const token = header.slice(7);
  try {
    const decoded = verifyAccessToken(token);
    req.user = { userId: decoded.sub, role: decoded.role, personId: decoded.personId };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      next(new ApiError('TOKEN_EXPIRED'));
      return;
    }
    next(new ApiError('TOKEN_INVALID'));
  }
}
