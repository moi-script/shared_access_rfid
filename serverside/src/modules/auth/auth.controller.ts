import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import * as authService from './auth.service';

const REFRESH_COOKIE = 'refreshToken';
// Both flags are environment-driven because the same code serves two
// topologies: a same-origin dev setup (strict, insecure over localhost) and a
// split-host production deployment where the client is on a different site
// from the API and the cookie only travels as SameSite=None; Secure. See the
// COOKIE_SAMESITE comment in config/env.ts.
const cookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const loginController = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const result = await authService.login(username, password);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken, user: result.user });
});

export const refreshController = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new ApiError('TOKEN_INVALID', 'No refresh token');
  const result = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken });
});

export const logoutController = asyncHandler(async (req: Request, res: Response) => {
  if (req.user) await authService.logout(req.user.userId);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  sendSuccess(res, { message: 'Logged out' });
});

export const changePasswordController = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Authentication required');
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user.userId, currentPassword, newPassword);
  // The refresh cookie is now dead server-side; clear it so the browser stops
  // sending a token that can only fail.
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  sendSuccess(res, { message: 'Password changed' });
});
