import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Role } from '../../constants/roles';

export interface TokenPayload {
  sub: string;
  role: Role;
  personId: string | null;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): TokenPayload & jwt.JwtPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload & jwt.JwtPayload;
}

export function verifyRefreshToken(token: string): TokenPayload & jwt.JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload & jwt.JwtPayload;
}
