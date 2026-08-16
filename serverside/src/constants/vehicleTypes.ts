/**
 * The vehicle types the OSS office registers, and how many of each one
 * person may hold at once.
 *
 * This is the ONLY place the list lives on the server. The Mongoose enums on
 * Vehicle and VehicleApplication, both zod schemas, and the limit check in
 * vehicles.service all read from here — the list used to be repeated at eight
 * sites, which is how a model and its schema drift apart and start accepting
 * values the other rejects.
 *
 * `userpage/lib/vehicleTypes.ts` mirrors this for the browser; the two are
 * separate deployables and cannot share an import. Change both together.
 */
export const VEHICLE_TYPES = [
  'motorcycle',
  'multicab',
  'van',
  'pickup',
  'auv',
  'truck',
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * Per-person allowance, counted over ACTIVE and UNEXPIRED vehicles only (see
 * vehicleRepo.findActiveByOwner). Deactivating a pass or letting it expire
 * frees the slot, so a person who replaces a van three times is not locked
 * out — the old rows survive for history without consuming the allowance.
 *
 * There is deliberately no TOTAL constant. The total is the sum of these
 * numbers; a second figure that has to agree with the first is a defect
 * waiting for someone to edit one and not the other.
 */
export const VEHICLE_LIMITS: Record<VehicleType, number> = {
  motorcycle: 1,
  multicab: 3,
  van: 3,
  pickup: 3,
  auv: 1,
  truck: 1,
};

/** Plural for an error message: 1 van, 3 vans. */
export function pluralizeType(type: VehicleType, count: number): string {
  return count === 1 ? type : `${type}s`;
}
