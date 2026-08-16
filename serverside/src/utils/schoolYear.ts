import { env } from '../config/env';

/**
 * The next occurrence of SCHOOL_YEAR_END_MMDD, at the end of that day, in
 * LOCAL time.
 *
 * Local, not UTC, for the same reason scanService.dateKey() and
 * lastResetBoundary() are: this codebase buckets by the server's local
 * calendar, and a UTC-derived boundary lands on the wrong day for part of
 * every day outside UTC+0. That has caused two real defects here already.
 *
 * End-of-day rather than midnight so a pass valid until 2027-03-31 works for
 * all of that day, rather than expiring as it begins.
 */
export function nextSchoolYearEnd(from: Date = new Date()): Date {
  const [mm, dd] = env.SCHOOL_YEAR_END_MMDD.split('-').map((n) => parseInt(n, 10));
  const candidate = new Date(from.getFullYear(), mm - 1, dd, 23, 59, 59, 999);
  if (candidate.getTime() >= from.getTime()) return candidate;
  return new Date(from.getFullYear() + 1, mm - 1, dd, 23, 59, 59, 999);
}
