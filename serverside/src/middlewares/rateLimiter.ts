import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests' });

/**
 * Rate limiting is a real defence and stays on in every environment. This is a
 * narrow opt-out for the verification harnesses, which issue far more requests
 * per minute than any human client and would otherwise be un-runnable as a
 * suite.
 *
 * Three independent conditions must ALL hold, so the default and the
 * production configuration both fail closed:
 *   - not production
 *   - a non-empty token is configured
 *   - the request presents exactly that token
 */
export function shouldBypassRateLimit(
  isProd: boolean,
  configuredToken: string | undefined,
  headerValue: string | undefined
): boolean {
  if (isProd) return false;
  if (!configuredToken) return false;
  if (!headerValue) return false;
  return headerValue === configuredToken;
}

const skip = (req: { get: (name: string) => string | undefined }): boolean =>
  shouldBypassRateLimit(env.isProd, env.VERIFY_BYPASS_TOKEN, req.get('X-Verify-Bypass'));

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  skip,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  skip,
});

export const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.SCAN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  skip,
});
