/**
 * True when Mongo rejected a write because it collided with a unique index.
 *
 * Two callers rely on this: the attendance rollup, where a collision means the
 * day's row already exists, and the occupancy entry transition, where it means
 * the card is already inside — i.e. a passback.
 */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
