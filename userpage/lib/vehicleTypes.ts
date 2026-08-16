/**
 * Mirror of serverside/src/constants/vehicleTypes.ts. The two projects are
 * separate deployables and cannot share an import — the server file is
 * authoritative, and both must be changed together.
 */
export const VEHICLE_TYPES = [
  "motorcycle",
  "multicab",
  "van",
  "pickup",
  "auv",
  "truck",
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Per-person allowance, counted over active and unexpired vehicles only. */
export const VEHICLE_LIMITS: Record<VehicleType, number> = {
  motorcycle: 1,
  multicab: 3,
  van: 3,
  pickup: 3,
  auv: 1,
  truck: 1,
};
