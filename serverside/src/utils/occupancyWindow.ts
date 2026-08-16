import { env } from '../config/env';

/**
 * The most recent occurrence of `resetTime` at or before `now`.
 *
 * Occupancy older than this boundary is treated as stale and cleared on read,
 * so a missed exit tap never becomes a next-morning lockout. Uses the SERVER'S
 * LOCAL clock, the same as scanService.dateKey() — see the timezone limitation
 * in the design doc.
 */
export function lastResetBoundary(
  now: Date,
  resetTime: string = env.OCCUPANCY_RESET_TIME
): Date {
  const [h, m] = resetTime.split(':').map((n) => parseInt(n, 10));
  const boundary = new Date(now);
  boundary.setHours(h, m, 0, 0);
  // Today's occurrence hasn't happened yet, so the most recent one was yesterday.
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}
