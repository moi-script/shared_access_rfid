/**
 * Parses `<input type="date">`-shaped `"YYYY-MM-DD"` boundaries as LOCAL
 * calendar days, matching the local-time convention this codebase uses
 * everywhere else for bucketing (scanService.dateKey, lastResetBoundary).
 *
 * `new Date("2026-07-30")` parses as UTC midnight per the ECMA-262
 * date-time string format, NOT local midnight. In any timezone ahead of UTC
 * (e.g. UTC+8) that boundary lands hours into the selected day, so a
 * `from=to=today` query silently excludes the whole day's rows. Building
 * the Date via the (year, month, day) numeric constructor instead parses in
 * the LOCAL timezone, matching every other local-date computation here.
 *
 * `to` is inclusive from the caller's point of view (the selected day) but
 * is converted to an EXCLUSIVE upper bound at the next local midnight, so
 * the query should use `$lt`, not `$lte` — an inclusive `$lte` on midnight
 * would exclude everything after 00:00:00.000 on the selected day itself.
 */
export function parseLocalDateRange(
  from?: string,
  to?: string
): { $gte?: Date; $lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const range: { $gte?: Date; $lt?: Date } = {};
  if (from) range.$gte = parseLocalDayStart(from);
  if (to) range.$lt = parseLocalDayEnd(to);
  return range;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight at the start of `s`. Falls back to native parsing for any input that isn't a bare "YYYY-MM-DD" date. */
function parseLocalDayStart(s: string): Date {
  const m = DATE_ONLY.exec(s);
  if (!m) return new Date(s);
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
}

/** Local midnight at the start of the day AFTER `s` — the exclusive upper bound for including all of `s`. */
function parseLocalDayEnd(s: string): Date {
  const m = DATE_ONLY.exec(s);
  if (!m) return new Date(s);
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d) + 1, 0, 0, 0, 0);
}
