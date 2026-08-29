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
  "car",
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

